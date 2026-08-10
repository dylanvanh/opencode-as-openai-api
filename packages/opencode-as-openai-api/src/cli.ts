#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGateway,
  type GatewayBackend,
  type GatewayConfiguration,
} from "./server.js";
import { splitModel, type OpenCodeRequestBody } from "./translate.js";

const VERSION = "0.1.0";
const DEFAULT_GATEWAY_PORT = 8_787;
const MIN_GATEWAY_PORT = 0;
const MAX_GATEWAY_PORT = 65_535;
const DEFAULT_MAX_CONCURRENCY = 1;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = Number.MAX_SAFE_INTEGER;
const GENERATED_TOKEN_RANDOM_BYTES = 32;
const BACKEND_START_ATTEMPTS = 100;
const BACKEND_RETRY_DELAY_100_MS = 100;
const BACKEND_START_TIMEOUT_30_SECONDS_MS = 30_000;
const BACKEND_CLEANUP_TIMEOUT_5_SECONDS_MS = 5_000;
const CHILD_STOP_TIMEOUT_5_SECONDS_MS = 5_000;
const NO_CONTENT_STATUS = 204;
const TUNNEL_OUTPUT_MAX_CHARACTERS = 16_000;
const TUNNEL_START_TIMEOUT_30_SECONDS_MS = 30_000;
const MINIMUM_OPENCODE_VERSION = { major: 1, minor: 18, patch: 4 };
const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
const DENIED_PERMISSIONS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill",
];

type UnknownRecord = Record<string, unknown>;

export interface GatewayOptions {
  readonly model: string;
  readonly port: number;
  readonly maxConcurrency: number;
  readonly tunnel: "quick" | null;
  readonly variant?: string;
  readonly directory?: string;
}

export type CliAction =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "serve"; readonly options: GatewayOptions };

interface MutableCliOptions {
  port: number;
  maxConcurrency: number;
  tunnel: string | null;
  model?: string;
  variant?: string;
  directory?: string;
  help?: boolean;
  version?: boolean;
}

export function parseCliArguments(argv: readonly string[]): CliAction {
  const options: MutableCliOptions = {
    port: DEFAULT_GATEWAY_PORT,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    tunnel: null,
  };

  let argumentIndex = 0;
  while (argumentIndex < argv.length) {
    const argument = argv[argumentIndex];
    argumentIndex += 1;
    if (argument === undefined) break;
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--version") {
      options.version = true;
      continue;
    }

    const value = argv[argumentIndex];
    if (!value || value.startsWith("--")) {
      if (isValueOption(argument)) throw new Error(`${argument} requires a value`);
      throw new Error(`unknown option: ${argument}`);
    }
    argumentIndex += 1;
    switch (argument) {
      case "--model":
        options.model = value;
        break;
      case "--variant":
        options.variant = value;
        break;
      case "--directory":
        options.directory = value;
        break;
      case "--port":
        options.port = Number(value);
        break;
      case "--max-concurrency":
        options.maxConcurrency = Number(value);
        break;
      case "--tunnel":
        options.tunnel = value;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }

  if (options.help) return { kind: "help" };
  if (options.version) return { kind: "version" };
  const model = options.model;
  if (!model) throw new Error("--model is required");
  splitModel(model);
  if (!Number.isInteger(options.port) || options.port < MIN_GATEWAY_PORT || options.port > MAX_GATEWAY_PORT) {
    throw new Error(`--port must be from ${MIN_GATEWAY_PORT} to ${MAX_GATEWAY_PORT}`);
  }
  if (
    !Number.isSafeInteger(options.maxConcurrency)
    || options.maxConcurrency < MIN_CONCURRENCY
    || options.maxConcurrency > MAX_CONCURRENCY
  ) {
    throw new Error("--max-concurrency must be a positive integer");
  }
  if (options.tunnel !== null && options.tunnel !== "quick") throw new Error("--tunnel only supports quick");
  return {
    kind: "serve",
    options: {
      model,
      port: options.port,
      maxConcurrency: options.maxConcurrency,
      tunnel: options.tunnel,
      ...(options.variant === undefined ? {} : { variant: options.variant }),
      ...(options.directory === undefined ? {} : { directory: resolve(options.directory) }),
    },
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const action = parseCliArguments(argv);
  if (action.kind === "help") {
    console.log(usage());
    return;
  }
  if (action.kind === "version") {
    console.log(VERSION);
    return;
  }

  const options = action.options;
  const selectedModel = options.model;
  let temporaryDirectory: string | undefined;
  let openCodeChild: ChildProcess | undefined;
  let gateway: Server | undefined;
  let tunnel: ChildProcess | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let isGatewayReady = false;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      await Promise.all([
        ...(openCodeChild ? [stopChildProcess(openCodeChild)] : []),
        ...(tunnel ? [stopChildProcess(tunnel)] : []),
      ]);
      const runningGateway = gateway;
      if (runningGateway?.listening) {
        await new Promise<void>((resolveClose) => runningGateway.close(() => resolveClose()));
      }
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  for (const signal of TERMINATION_SIGNALS) {
    process.once(signal, async () => {
      await cleanup();
      process.exit(0);
    });
  }

  try {
    if (options.directory) await validateOpenCodeDirectory(options.directory);
    const openCodeVersion = readAndValidateOpenCodeVersion();
    temporaryDirectory = options.directory
      ? undefined
      : await mkdtemp(join(tmpdir(), "opencode-as-openai-api-"));
    const directory = options.directory ?? temporaryDirectory;
    if (!directory) throw new Error("Could not create an OpenCode configuration directory");
    const upstreamPort = await selectFreeTcpPort();
    const config = {
      agent: {
        "opencode-as-openai-api": {
          description: "Restricted OpenAI-compatible API adapter",
          mode: "primary",
          prompt: "Answer the supplied API conversation. Do not access local resources.",
          permission: Object.fromEntries(DENIED_PERMISSIONS.map((permission) => [permission, "deny"])),
        },
      },
    };
    const child = spawn(
      "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", String(upstreamPort), "--pure"],
      {
        cwd: directory,
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    openCodeChild = child;
    let didOpenCodeExit = false;
    let openCodeExitDetail = "unknown status";
    child.once("exit", async (exitCode, exitSignal) => {
      didOpenCodeExit = true;
      openCodeExitDetail = exitSignal ?? `code ${String(exitCode)}`;
      if (!isGatewayReady || cleanupPromise) return;
      console.error(`OpenCode stopped with ${openCodeExitDetail}`);
      await cleanup();
      process.exit(1);
    });
    const backend = new OpenCodeHttpBackend(`http://127.0.0.1:${upstreamPort}`);
    await waitForBackend(backend, selectedModel, child);
    if (didOpenCodeExit) throw new Error(`OpenCode exited with ${openCodeExitDetail}`);
    isGatewayReady = true;
    const token = process.env["OPENCODE_API_TOKEN"]
      || `oca_${randomBytes(GENERATED_TOKEN_RANDOM_BYTES).toString("hex")}`;
    const gatewayConfiguration: GatewayConfiguration = {
      model: process.env["OPENCODE_API_MODEL"] || selectedModel,
      upstreamModel: selectedModel,
      token,
      backend,
      maxConcurrency: options.maxConcurrency,
      quickTunnel: options.tunnel === "quick",
    };
    if (options.variant) gatewayConfiguration.variant = options.variant;
    gateway = createGateway(gatewayConfiguration);

    const gatewayPort = await listen(gateway, options.port);
    const localUrl = `http://127.0.0.1:${gatewayPort}/v1`;
    console.log(`Ready\nOpenCode: ${openCodeVersion}\nModel: ${selectedModel}\nBase URL: ${localUrl}\nAPI token: ${token}`);
    console.log(`\nClient configuration:\nOPENAI_BASE_URL=${localUrl}\nOPENAI_API_KEY=${token}`);
    if (options.tunnel === "quick") {
      const quickTunnel = startQuickTunnel(`http://127.0.0.1:${gatewayPort}`);
      tunnel = quickTunnel.child;
      console.log(`\nPublic URL: ${await quickTunnel.url}/v1\nPublic streaming: unavailable`);
    }
  } catch (error: unknown) {
    await cleanup();
    throw error;
  }
}

class OpenCodeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeProtocolError";
  }
}

class OpenCodeHttpBackend implements GatewayBackend {
  readonly url: string;
  toolIds: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  async ready(model: string, signal: AbortSignal): Promise<void> {
    await this.request("/global/health", {}, signal);
    this.toolIds = toolIdsFrom(await this.request("/experimental/tool/ids", {}, signal));
    const providers = await this.request("/config/providers", {}, signal);
    if (!hasModel(providers, model)) throw new Error(`OpenCode model is not connected: ${model}`);
  }

  async run(body: OpenCodeRequestBody, signal: AbortSignal): Promise<unknown> {
    const session = await this.request("/session", {
      method: "POST",
      body: JSON.stringify({
        title: "opencode-as-openai-api request",
        permission: DENIED_PERMISSIONS.map((permission) => ({ permission, pattern: "*", action: "deny" })),
      }),
    }, signal);
    const sessionId = sessionIdFrom(session);
    try {
      return await this.request(
        `/session/${encodeURIComponent(sessionId)}/message`,
        { method: "POST", body: JSON.stringify(body) },
        signal,
      );
    } finally {
      if (signal.aborted) {
        try {
          await this.request(
            `/session/${encodeURIComponent(sessionId)}/abort`,
            { method: "POST" },
            AbortSignal.timeout(BACKEND_CLEANUP_TIMEOUT_5_SECONDS_MS),
          );
        } catch {
          // Best effort abort.
        }
      }
      try {
        await this.request(
          `/session/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
          AbortSignal.timeout(BACKEND_CLEANUP_TIMEOUT_5_SECONDS_MS),
        );
      } catch {
        // Best effort cleanup.
      }
    }
  }

  private async request(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const headers = new Headers(options.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const requestOptions: RequestInit = { ...options, headers };
    if (signal) requestOptions.signal = signal;
    const response = await fetch(`${this.url}${path}`, requestOptions);
    if (!response.ok) throw new Error(`OpenCode ${response.status}`);
    if (response.status === NO_CONTENT_STATUS) return null;
    const responseBody: unknown = await response.json();
    return responseBody;
  }
}

function usage(): string {
  return `opencode-as-openai-api ${VERSION}\n\nUsage:\n  opencode-as-openai-api --model <provider/model> [options]\n\nOptions:\n  --model <provider/model>    Model exposed by the gateway\n  --variant <id>              Fixed OpenCode model variant\n  --directory <path>          OpenCode configuration directory\n  --port <number>             Gateway port (default: ${DEFAULT_GATEWAY_PORT}; 0 selects a free port)\n  --max-concurrency <number>  Concurrent requests (default: ${DEFAULT_MAX_CONCURRENCY})\n  --tunnel quick              Start a TryCloudflare tunnel\n  --help                      Show help\n  --version                   Show version`;
}

function isValueOption(argument: string): boolean {
  return ["--model", "--variant", "--directory", "--port", "--max-concurrency", "--tunnel"].includes(argument);
}

async function validateOpenCodeDirectory(directory: string): Promise<void> {
  let directoryStats: Awaited<ReturnType<typeof stat>>;
  try {
    directoryStats = await stat(directory);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") throw new Error(`OpenCode directory does not exist: ${directory}`);
    throw error;
  }
  if (!directoryStats.isDirectory()) throw new Error(`OpenCode directory is not a directory: ${directory}`);
}

function readAndValidateOpenCodeVersion(): string {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  if (errorCode(result.error) === "ENOENT") throw new Error("OpenCode is not installed or is not in PATH");
  if (result.status !== 0) throw new Error("Could not read the OpenCode version");
  const version = result.stdout.trim();
  const versionParts = version.split(".");
  const [major, minor, patch] = versionParts.map(Number);
  if (
    versionParts.length !== 3
    || major === undefined
    || minor === undefined
    || patch === undefined
    || !Number.isInteger(major)
    || !Number.isInteger(minor)
    || !Number.isInteger(patch)
    || !isSupportedVersion(major, minor, patch)
  ) {
    throw new Error(`OpenCode 1.18.4 or newer is required; found ${version}`);
  }
  return version;
}

function isSupportedVersion(major: number, minor: number, patch: number): boolean {
  if (major !== MINIMUM_OPENCODE_VERSION.major) return major > MINIMUM_OPENCODE_VERSION.major;
  if (minor !== MINIMUM_OPENCODE_VERSION.minor) return minor > MINIMUM_OPENCODE_VERSION.minor;
  return patch >= MINIMUM_OPENCODE_VERSION.patch;
}

function selectFreeTcpPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(MIN_GATEWAY_PORT, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not select a free port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

function toolIdsFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((tool, index) => {
      if (typeof tool === "string" && tool) return tool;
      if (isRecord(tool) && typeof tool["id"] === "string" && tool["id"]) return tool["id"];
      throw new OpenCodeProtocolError(`OpenCode returned an invalid tool identifier at index ${index}`);
    });
  }
  if (isRecord(value)) return Object.keys(value);
  throw new OpenCodeProtocolError("OpenCode returned invalid tool identifiers");
}

function sessionIdFrom(value: unknown): string {
  if (!isRecord(value)) throw new OpenCodeProtocolError("OpenCode did not create a session");
  const directId = value["id"];
  if (typeof directId === "string" && directId) return directId;
  const data = value["data"];
  if (isRecord(data) && typeof data["id"] === "string" && data["id"]) return data["id"];
  throw new OpenCodeProtocolError("OpenCode did not create a session");
}

function hasModel(value: unknown, selectedModel: string): boolean {
  const { providerID, modelID } = splitModel(selectedModel);
  const root = isRecord(value) ? value["providers"] ?? value : value;
  const provider = providerFrom(root, providerID);
  if (!provider) return false;
  const models = provider["models"];
  if (models === undefined) return false;
  if (Array.isArray(models)) {
    return models.some((model, index) => modelMatches(model, modelID, index));
  }
  if (isRecord(models)) return Object.hasOwn(models, modelID);
  throw new OpenCodeProtocolError("OpenCode returned invalid model configuration");
}

function providerFrom(value: unknown, providerId: string): UnknownRecord | undefined {
  if (Array.isArray(value)) {
    for (const [index, provider] of value.entries()) {
      if (!isRecord(provider)) {
        throw new OpenCodeProtocolError(`OpenCode returned an invalid provider at index ${index}`);
      }
      if (provider["id"] === providerId || provider["providerID"] === providerId) return provider;
    }
    return undefined;
  }
  if (!isRecord(value)) throw new OpenCodeProtocolError("OpenCode returned invalid provider configuration");
  const provider = value[providerId];
  if (provider === undefined) return undefined;
  if (isRecord(provider)) return provider;
  throw new OpenCodeProtocolError(`OpenCode returned an invalid provider: ${providerId}`);
}

function modelMatches(value: unknown, modelId: string, index: number): boolean {
  if (typeof value === "string") return value === modelId;
  if (isRecord(value)) return value["id"] === modelId || value["modelID"] === modelId;
  throw new OpenCodeProtocolError(`OpenCode returned an invalid model at index ${index}`);
}

async function waitForBackend(backend: OpenCodeHttpBackend, model: string, child: ChildProcess): Promise<void> {
  let lastError: unknown;
  let childStartError: Error | undefined;
  const startupSignal = AbortSignal.timeout(BACKEND_START_TIMEOUT_30_SECONDS_MS);
  const handleChildError = (error: Error): void => {
    childStartError = errorCode(error) === "ENOENT"
      ? new Error("OpenCode is not installed or is not in PATH")
      : error;
  };
  child.once("error", handleChildError);
  for (let attempt = 0; attempt < BACKEND_START_ATTEMPTS; attempt += 1) {
    if (childStartError) throw childStartError;
    if (child.exitCode != null) throw new Error(`OpenCode exited with code ${child.exitCode}`);
    if (child.signalCode != null) throw new Error(`OpenCode terminated by ${child.signalCode}`);
    if (startupSignal.aborted) throw new Error("OpenCode startup timed out");
    try {
      await backend.ready(model, startupSignal);
      return;
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, BACKEND_RETRY_DELAY_100_MS));
  }
  if (lastError != null) throw lastError;
  throw new Error("OpenCode did not start");
}

function startQuickTunnel(localUrl: string): { child: ChildProcess; url: Promise<string> } {
  const child = spawn("cloudflared", ["tunnel", "--url", localUrl], { stdio: ["ignore", "pipe", "pipe"] });
  const url = new Promise<string>((resolveUrl, reject) => {
    let output = "";
    let hasSettled = false;
    let startupTimeout: NodeJS.Timeout;
    const removeStartupListeners = (): void => {
      clearTimeout(startupTimeout);
      child.stdout?.off("data", inspect);
      child.stderr?.off("data", inspect);
      child.off("error", handleError);
      child.off("exit", handleExit);
    };
    const fail = (error: Error): void => {
      if (hasSettled) return;
      hasSettled = true;
      removeStartupListeners();
      reject(error);
    };
    const inspect = (chunk: unknown): void => {
      const chunkText = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      output = (output + chunkText).slice(-TUNNEL_OUTPUT_MAX_CHARACTERS);
      const tunnelUrl = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
      if (!tunnelUrl || hasSettled) return;
      hasSettled = true;
      removeStartupListeners();
      child.stdout?.resume();
      child.stderr?.resume();
      resolveUrl(tunnelUrl);
    };
    const handleError = (error: Error): void => {
      fail(errorCode(error) === "ENOENT" ? new Error("cloudflared is not installed or is not in PATH") : error);
    };
    const handleExit = (exitCode: number | null): void => {
      fail(new Error(`cloudflared exited with code ${exitCode}`));
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", handleError);
    child.once("exit", handleExit);
    startupTimeout = setTimeout(
      () => fail(new Error("cloudflared startup timed out")),
      TUNNEL_START_TIMEOUT_30_SECONDS_MS,
    );
  });
  return { child, url };
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not bind to a TCP port");
  return address.port;
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolveStop) => {
    let hasStopped = false;
    const finishStop = (): void => {
      if (hasStopped) return;
      hasStopped = true;
      clearTimeout(forceStopTimeout);
      child.off("exit", finishStop);
      resolveStop();
    };
    const forceStopTimeout = setTimeout(() => {
      child.kill("SIGKILL");
      finishStop();
    }, CHILD_STOP_TIMEOUT_5_SECONDS_MS);
    child.once("exit", finishStop);
    if (!child.kill("SIGTERM")) finishStop();
  });
}

function errorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["code"] === "string" ? value["code"] : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`opencode-as-openai-api: ${message}`);
    process.exitCode = 1;
  });
}
