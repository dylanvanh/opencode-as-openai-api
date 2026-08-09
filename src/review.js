import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATEWAY_START_TIMEOUT_30_SECONDS_MS = 30_000;
const GATEWAY_STOP_TIMEOUT_5_SECONDS_MS = 5_000;
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

export async function runReview(options) {
  console.error(options.prUrl ? "Fetching the GitHub PR..." : "Reading changes since the base branch...");
  const sourcePatch = options.prUrl ? await githubPrPatch(options.prUrl) : await readLocalBranchPatch(options.base);
  console.error("Starting the private OpenCode gateway...");
  const gateway = await startGateway(options);
  let temporaryDirectory;
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    try {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    } finally {
      await gateway.stop();
    }
  })();
  const stopOnSignal = () => { void cleanup().finally(() => process.exit(130)); };
  process.once("SIGINT", stopOnSignal);
  process.once("SIGTERM", stopOnSignal);
  try {
    console.error("Reducing the diff with Meat...");
    const readingPatch = await meatPatch(sourcePatch, gateway.model, gateway.baseUrl, gateway.token);
    temporaryDirectory = await mkdtemp(join(tmpdir(), "opencode-meat-review-"));
    const patchPath = join(temporaryDirectory, "reading.diff");
    await writeFile(patchPath, readingPatch);
    const args = ["review", "--patch-file", patchPath];
    console.error("Opening Plannotator...");
    await command("plannotator", args, { stdio: "inherit" });
  } finally {
    await cleanup();
    process.off("SIGINT", stopOnSignal);
    process.off("SIGTERM", stopOnSignal);
  }
}

export function parseMeatResult(output) {
  let result;
  try { result = JSON.parse(output); }
  catch { throw new Error("Meat returned invalid JSON"); }
  if (typeof result.smart_diff !== "string") throw new Error("Meat did not return smart_diff");
  return result.smart_diff;
}

export async function readLocalBranchPatch(selectedBase, cwd = process.cwd()) {
  const root = (await command("git", ["rev-parse", "--show-toplevel"], { cwd })).trim();
  const base = selectedBase ?? await defaultBase(root);
  const mergeBase = (await command("git", ["merge-base", base, "HEAD"], { cwd: root })).trim();
  const tracked = await command("git", ["diff", "--no-ext-diff", "--binary", mergeBase], { cwd: root });
  const untrackedOutput = await command("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root });
  const untrackedPaths = untrackedOutput.split("\0").filter(Boolean);
  const untracked = [];
  for (const path of untrackedPaths) {
    if ((await lstat(join(root, path))).isDirectory()) {
      console.error(`Skipping nested untracked repository: ${path}`);
      continue;
    }
    untracked.push(await command(
      "git", ["diff", "--no-index", "--binary", "--", "/dev/null", path], { cwd: root, acceptedExitCodes: [0, 1] },
    ));
  }
  const patch = [tracked, ...untracked].filter(Boolean).join("\n");
  if (!patch.trim()) throw new Error(`No changes found since ${base}`);
  return patch;
}

async function defaultBase(cwd) {
  const symbolic = await command("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd, acceptedExitCodes: [0, 1],
  });
  const candidates = [symbolic.trim(), "origin/main", "origin/master", "main", "master"].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = await command("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
      cwd, acceptedExitCodes: [0, 1],
    });
    if (resolved.trim()) return candidate;
  }
  throw new Error("Could not detect the base branch; pass --base <ref>");
}

async function githubPrPatch(prUrl) {
  const patch = await command("gh", ["pr", "diff", prUrl]);
  if (!patch.trim()) throw new Error("The GitHub PR has no changes");
  return patch;
}

async function meatPatch(patch, model, baseUrl, token) {
  const output = await command("meat", ["-json", "-model", model], {
    input: patch,
    env: { ...process.env, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: token, MEAT_MODEL: model },
  });
  return parseMeatResult(output);
}

async function startGateway(options) {
  const token = `oca_${randomBytes(32).toString("hex")}`;
  const model = `opencode-gateway/${options.model}${options.variant ? `:${options.variant}` : ""}`;
  const args = [cliPath, "--model", options.model, "--port", "0"];
  if (options.variant) args.push("--variant", options.variant);
  if (options.directory) args.push("--directory", options.directory);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, OPENCODE_API_MODEL: model, OPENCODE_API_TOKEN: token },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.setEncoding("utf8");
  let baseUrl;
  try {
    baseUrl = await new Promise((resolveBaseUrl, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Gateway startup timed out")), GATEWAY_START_TIMEOUT_30_SECONDS_MS);
      const fail = (error) => { clearTimeout(timeout); reject(error); };
      const inspect = (chunk) => {
        output += chunk;
        const match = output.match(/Base URL: (http:\/\/127\.0\.0\.1:\d+\/v1)/);
        if (!match) return;
        clearTimeout(timeout);
        child.stdout.off("data", inspect);
        child.stdout.resume();
        resolveBaseUrl(match[1]);
      };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`Gateway exited with code ${code}`)));
      child.stdout.on("data", inspect);
    });
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return { baseUrl, model, token, stop: () => stopChild(child) };
}

function stopChild(child) {
  if (child.exitCode != null) return Promise.resolve();
  if (process.platform === "win32") {
    return command("taskkill", ["/PID", String(child.pid), "/T", "/F"], { acceptedExitCodes: [0, 128] });
  }
  return new Promise((resolveStop) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), GATEWAY_STOP_TIMEOUT_5_SECONDS_MS);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

function command(executable, args, options = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? [options.input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.stdio === "inherit") {
      child.once("error", (error) => reject(commandError(executable, error)));
      child.once("close", (code) => code === 0 ? resolveCommand("") : reject(new Error(`${executable} exited with code ${code}`)));
      return;
    }
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => reject(commandError(executable, error)));
    child.once("close", (code) => {
      const acceptedExitCodes = options.acceptedExitCodes ?? [0];
      if (acceptedExitCodes.includes(code)) return resolveCommand(Buffer.concat(stdout).toString("utf8"));
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(detail || `${executable} exited with code ${code}`));
    });
    if (options.input != null) child.stdin.end(options.input);
  });
}

function commandError(executable, error) {
  return error.code === "ENOENT" ? new Error(`${executable} is not installed or is not in PATH`) : error;
}
