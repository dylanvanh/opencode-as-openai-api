#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGateway } from "./server.js";
import { splitModel } from "./translate.js";
import { selectOpenCodeServerStrategy } from "./_internal/opencode-server-strategy.js";
import { OpenCodeHttpBackend } from "./_internal/opencode-http-backend.js";

const VERSION = "0.1.0";
const DEFAULT_GATEWAY_PORT = 8_787;
const MIN_GATEWAY_PORT = 0;
const MAX_GATEWAY_PORT = 65_535;
const GENERATED_TOKEN_RANDOM_BYTES = 32;
const BACKEND_START_ATTEMPTS = 100;
const BACKEND_RETRY_DELAY_100_MS = 100;
const BACKEND_START_TIMEOUT_30_SECONDS_MS = 30_000;
const CHILD_STOP_TIMEOUT_5_SECONDS_MS = 5_000;
const MAX_UPSTREAM_URL_LENGTH = 2_048;
const MAX_DIRECTORY_LENGTH = 4_096;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;
const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

type UnknownRecord = Record<string, unknown>;

export interface GatewayOptions {
  readonly model: string;
  readonly port: number;
  readonly variant?: string;
  readonly directory?: string;
  readonly upstreamUrl?: string;
}

export type CliAction =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "serve"; readonly options: GatewayOptions };

export function parseCliArguments(argv: readonly string[]): CliAction {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      model: { type: "string" },
      variant: { type: "string" },
      directory: { type: "string" },
      "upstream-url": { type: "string" },
      port: { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const model = values.model;
  if (!model) throw new Error("--model is required");
  splitModel(model);
  const port = Number(values.port ?? DEFAULT_GATEWAY_PORT);
  if (!Number.isInteger(port) || port < MIN_GATEWAY_PORT || port > MAX_GATEWAY_PORT) {
    throw new Error(`--port must be from ${MIN_GATEWAY_PORT} to ${MAX_GATEWAY_PORT}`);
  }
  const upstreamUrl = values["upstream-url"] === undefined ? undefined : parseUpstreamUrl(values["upstream-url"]);
  const directory = parseDirectory(values.directory, upstreamUrl !== undefined);
  return {
    kind: "serve",
    options: {
      model,
      port,
      ...(values.variant === undefined ? {} : { variant: values.variant }),
      ...(directory === undefined ? {} : { directory }),
      ...(upstreamUrl === undefined ? {} : { upstreamUrl }),
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
  let cleanupPromise: Promise<void> | undefined;
  let isGatewayReady = false;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (openCodeChild) await stopChildProcess(openCodeChild);
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
    let backend: OpenCodeHttpBackend;
    let openCodeVersion: string;
    if (options.upstreamUrl) {
      backend = createBackend(options.upstreamUrl, options.directory);
      openCodeVersion = await backend.ready(selectedModel, AbortSignal.timeout(BACKEND_START_TIMEOUT_30_SECONDS_MS));
    } else {
      if (options.directory) await validateOpenCodeDirectory(options.directory);
      openCodeVersion = readOpenCodeVersion();
      const serverStrategy = selectOpenCodeServerStrategy(openCodeVersion);
      temporaryDirectory = options.directory
        ? undefined
        : await mkdtemp(join(tmpdir(), "opencode-as-openai-api-"));
      const directory = options.directory ?? temporaryDirectory;
      if (!directory) throw new Error("Could not create an OpenCode configuration directory");
      const upstreamPort = await selectFreeTcpPort();
      const launchOptions = serverStrategy.createLaunchOptions(process.env["OPENCODE_SERVER_PASSWORD"]);
      const child = spawn(
        "opencode",
        ["serve", "--hostname", "127.0.0.1", "--port", String(upstreamPort), ...launchOptions.arguments],
        {
          cwd: directory,
          env: { ...process.env, ...launchOptions.environment },
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
      backend = createBackend(`http://127.0.0.1:${upstreamPort}`, undefined, launchOptions.backendPassword);
      await waitForBackend(backend, selectedModel, child);
      if (didOpenCodeExit) throw new Error(`OpenCode exited with ${openCodeExitDetail}`);
    }
    isGatewayReady = true;
    const token = process.env["OPENCODE_API_TOKEN"]
      || `oca_${randomBytes(GENERATED_TOKEN_RANDOM_BYTES).toString("hex")}`;
    gateway = createGateway({
      model: process.env["OPENCODE_API_MODEL"] || selectedModel,
      upstreamModel: selectedModel,
      token,
      backend,
      ...(options.variant === undefined ? {} : { variant: options.variant }),
    });

    const gatewayPort = await listen(gateway, options.port);
    const localUrl = `http://127.0.0.1:${gatewayPort}/v1`;
    console.log(`Ready\nOpenCode: ${openCodeVersion}\nModel: ${selectedModel}\nBase URL: ${localUrl}\nAPI token: ${token}`);
    console.log(`\nClient configuration:\nOPENAI_BASE_URL=${localUrl}\nOPENAI_API_KEY=${token}`);
  } catch (error: unknown) {
    await cleanup();
    throw error;
  }
}

function usage(): string {
  return `opencode-as-openai-api ${VERSION}\n\nUsage:\n  opencode-as-openai-api --model <provider/model> [options]\n\nOptions:\n  --model <provider/model>    Model exposed by the gateway\n  --variant <id>              Fixed OpenCode model variant\n  --upstream-url <url>        Connect to an existing OpenCode server (V2 or V1 auto-detected)\n  --directory <path>          Configuration directory; required absolute upstream path with --upstream-url\n  --port <number>             Gateway port (default: ${DEFAULT_GATEWAY_PORT}; 0 selects a free port)\n  --help                      Show help\n  --version                   Show version\n\nEnvironment:\n  OPENCODE_API_TOKEN          Gateway bearer token (generated if unset)\n  OPENCODE_UPSTREAM_TOKEN     Upstream Bearer token (separate from gateway token)\n  OPENCODE_SERVER_PASSWORD    Upstream Basic password (cannot combine with upstream token)\n  OPENCODE_SERVER_USERNAME    Upstream Basic username (default: opencode)`;
}

function createBackend(url: string, directory?: string, privatePassword?: string): OpenCodeHttpBackend {
  const username = process.env["OPENCODE_SERVER_USERNAME"];
  const password = privatePassword ?? process.env["OPENCODE_SERVER_PASSWORD"];
  const token = privatePassword === undefined ? process.env["OPENCODE_UPSTREAM_TOKEN"] : undefined;
  return new OpenCodeHttpBackend({
    url,
    ...(directory === undefined ? {} : { directory }),
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    ...(token === undefined ? {} : { token }),
  });
}

function parseUpstreamUrl(value: string): string {
  if (value.length > MAX_UPSTREAM_URL_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`--upstream-url must be at most ${MAX_UPSTREAM_URL_LENGTH} characters with no control characters`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--upstream-url must be an absolute HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--upstream-url must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Use OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD instead of URL credentials");
  if (value.includes("?") || value.includes("#")) throw new Error("--upstream-url must not contain a query or fragment");
  if (url.port === "0") throw new Error("--upstream-url port must be from 1 to 65535");
  return url.href.replace(/\/+$/, "");
}

function parseDirectory(value: string | undefined, isUpstream: boolean): string | undefined {
  if (value === undefined) {
    if (isUpstream) throw new Error("--directory is required with --upstream-url; use an absolute path on the upstream server");
    return undefined;
  }
  if (!value.trim() || value.length > MAX_DIRECTORY_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`--directory must be a non-empty path of at most ${MAX_DIRECTORY_LENGTH} characters with no control characters`);
  }
  if (!isUpstream) return resolve(value);
  if (!posix.isAbsolute(value) && !win32.isAbsolute(value)) throw new Error("--directory must be an absolute path on the upstream server");
  return value;
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

function readOpenCodeVersion(): string {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  if (errorCode(result.error) === "ENOENT") throw new Error("OpenCode is not installed or is not in PATH");
  if (result.status !== 0) throw new Error("Could not read the OpenCode version");
  return result.stdout.trim().replace(/^(?:opencode2?\s+)?v?/, "");
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
