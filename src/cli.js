#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { createGateway } from "./server.js";
import { splitModel } from "./translate.js";

const VERSION = "0.1.0";
const DENIED_PERMISSIONS = [
  "read", "edit", "glob", "grep", "list", "bash", "task", "external_directory",
  "todowrite", "question", "webfetch", "websearch", "lsp", "doom_loop", "skill",
];

function usage() {
  return `opencode-as-openai-api ${VERSION}\n\nUsage:\n  opencode-as-openai-api --model <provider/model> [options]\n\nOptions:\n  --model <provider/model>    Model exposed by the gateway\n  --variant <id>              Fixed OpenCode model variant\n  --directory <path>          OpenCode configuration directory\n  --port <number>             Gateway port (default: 8787; 0 selects a free port)\n  --max-concurrency <number>  Concurrent requests (default: 1)\n  --tunnel quick              Start a TryCloudflare tunnel\n  --help                      Show help\n  --version                   Show version`;
}

export function parseArgs(argv) {
  const options = { port: 8787, maxConcurrency: 1, tunnel: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") options.help = true;
    else if (arg === "--version") options.version = true;
    else if (["--model", "--variant", "--directory", "--port", "--max-concurrency", "--tunnel"].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--max-concurrency") options.maxConcurrency = Number(value);
      else options[arg.slice(2)] = arg === "--port" ? Number(value) : value;
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.help && !options.version) {
    if (!options.model) throw new Error("--model is required");
    splitModel(options.model);
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("--port must be from 0 to 65535");
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) throw new Error("--max-concurrency must be a positive integer");
    if (options.tunnel && options.tunnel !== "quick") throw new Error("--tunnel only supports quick");
    if (options.directory) options.directory = resolve(options.directory);
  }
  return options;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function checkVersion() {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") throw new Error("OpenCode is not installed or is not in PATH");
  if (result.status !== 0) throw new Error("Could not read the OpenCode version");
  const version = result.stdout.trim();
  const [major, minor, patch] = version.split(".").map(Number);
  if (![major, minor, patch].every(Number.isInteger) || major < 1 || (major === 1 && minor < 18) || (major === 1 && minor === 18 && patch < 4)) {
    throw new Error(`OpenCode 1.18.4 or newer is required; found ${version}`);
  }
  return version;
}

class OpenCodeBackend {
  constructor(url) { this.url = url; this.toolIds = []; }

  async request(path, options = {}, signal) {
    const response = await fetch(`${this.url}${path}`, { ...options, signal, headers: { "content-type": "application/json", ...options.headers } });
    if (!response.ok) throw new Error(`OpenCode ${response.status}`);
    if (response.status === 204) return null;
    return response.json();
  }

  async ready(model) {
    await this.request("/global/health");
    const tools = await this.request("/experimental/tool/ids");
    this.toolIds = Array.isArray(tools) ? tools.map((tool) => typeof tool === "string" ? tool : tool.id).filter(Boolean) : Object.keys(tools ?? {});
    const providers = await this.request("/config/providers");
    if (!hasModel(providers, model)) throw new Error(`OpenCode model is not connected: ${model}`);
  }

  async run(body, signal) {
    const session = await this.request("/session", {
      method: "POST",
      body: JSON.stringify({
        title: "opencode-as-openai-api request",
        permission: DENIED_PERMISSIONS.map((permission) => ({ permission, pattern: "*", action: "deny" })),
      }),
    }, signal);
    const id = session.id ?? session.data?.id;
    if (!id) throw new Error("OpenCode did not create a session");
    try {
      return await this.request(`/session/${encodeURIComponent(id)}/message`, { method: "POST", body: JSON.stringify(body) }, signal);
    } finally {
      if (signal.aborted) {
        try { await this.request(`/session/${encodeURIComponent(id)}/abort`, { method: "POST" }); } catch { /* best effort abort */ }
      }
      try { await this.request(`/session/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch { /* best effort cleanup */ }
    }
  }
}

function hasModel(value, selected) {
  const { providerID, modelID } = splitModel(selected);
  const root = value?.providers ?? value;
  const provider = Array.isArray(root) ? root.find((item) => item?.id === providerID || item?.providerID === providerID) : root?.[providerID];
  const models = provider?.models;
  if (Array.isArray(models)) return models.some((item) => item?.id === modelID || item?.modelID === modelID || item === modelID);
  return Boolean(models && Object.hasOwn(models, modelID));
}

async function waitForBackend(backend, model, child) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode != null) throw new Error(`OpenCode exited with code ${child.exitCode}`);
    try { await backend.ready(model); return; } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw lastError ?? new Error("OpenCode did not start");
}

function startQuickTunnel(localUrl) {
  const child = spawn("cloudflared", ["tunnel", "--url", localUrl], { stdio: ["ignore", "pipe", "pipe"] });
  const url = new Promise((resolveUrl, reject) => {
    let output = "";
    const inspect = (chunk) => {
      output = (output + chunk.toString()).slice(-16000);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) resolveUrl(match[0]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => reject(error.code === "ENOENT" ? new Error("cloudflared is not installed or is not in PATH") : error));
    child.once("exit", (code) => reject(new Error(`cloudflared exited with code ${code}`)));
  });
  return { child, url };
}

async function listen(server, port) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server.address().port;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return console.log(usage());
  if (options.version) return console.log(VERSION);
  const openCodeVersion = checkVersion();
  const temporaryDirectory = options.directory ? null : await mkdtemp(join(tmpdir(), "opencode-as-openai-api-"));
  const directory = options.directory ?? temporaryDirectory;
  const upstreamPort = await freePort();
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
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(upstreamPort), "--pure"], {
    cwd: directory,
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let gateway;
  let tunnel;
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    if (tunnel && tunnel.exitCode == null) tunnel.kill("SIGTERM");
    if (gateway?.listening) await new Promise((resolveClose) => gateway.close(resolveClose));
    if (child.exitCode == null) child.kill("SIGTERM");
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  };
  try {
    const backend = new OpenCodeBackend(`http://127.0.0.1:${upstreamPort}`);
    await waitForBackend(backend, options.model, child);
    const token = process.env.OPENCODE_API_TOKEN || `oca_${randomBytes(32).toString("hex")}`;
    gateway = createGateway({ model: options.model, variant: options.variant, token, backend, maxConcurrency: options.maxConcurrency, quickTunnel: options.tunnel === "quick" });
    const port = await listen(gateway, options.port);
    const localUrl = `http://127.0.0.1:${port}/v1`;
    console.log(`Ready\nOpenCode: ${openCodeVersion}\nModel: ${options.model}\nBase URL: ${localUrl}\nAPI token: ${token}`);
    console.log(`\nClient configuration:\nOPENAI_BASE_URL=${localUrl}\nOPENAI_API_KEY=${token}`);
    if (options.tunnel === "quick") {
      const quick = startQuickTunnel(`http://127.0.0.1:${port}`);
      tunnel = quick.child;
      console.log(`\nPublic URL: ${await quick.url}/v1\nPublic streaming: unavailable`);
    }
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await cleanup(); process.exit(0); });
    child.once("exit", async (code) => { if (!cleaning) { console.error(`OpenCode stopped with code ${code}`); await cleanup(); process.exit(1); } });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(`opencode-as-openai-api: ${error.message}`); process.exitCode = 1; });
}
