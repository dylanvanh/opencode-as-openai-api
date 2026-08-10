import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { createCommandSpawnError, runCommand } from "./_internal/run-command.js";

const GATEWAY_START_TIMEOUT_30_SECONDS_MS = 30_000;
const GATEWAY_STOP_TIMEOUT_15_SECONDS_MS = 15_000;
const GATEWAY_TOKEN_RANDOM_BYTE_LENGTH = 32;
const SIGINT_EXIT_CODE = 130;
const SIGTERM_EXIT_CODE = 143;
const FILE_NOT_FOUND_ERROR_CODE = "ENOENT";
const GATEWAY_BASE_URL_PATTERN = /Base URL: (http:\/\/127\.0\.0\.1:\d+\/v1)/;

type ShutdownSignal = "SIGINT" | "SIGTERM";
type GatewayChildProcess = ChildProcessByStdio<null, Readable, null>;

export interface ReviewOptions {
  readonly openCodeModel: string;
  readonly openCodeVariant?: string;
  readonly openCodeDirectory?: string;
  readonly baseRef?: string;
  readonly pullRequestUrl?: string;
}

export class MeatResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeatResultError";
  }
}

export async function runReview(options: ReviewOptions): Promise<void> {
  const workflowAbortController = new AbortController();
  let temporaryDirectory: string | undefined;
  let privateGateway: PrivateGatewayHandle | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let interruptedExitCode: number | undefined;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise === undefined) {
      cleanupPromise = cleanupReview(temporaryDirectory, privateGateway);
    }

    return cleanupPromise;
  };
  const stopOnSignal = (signal: ShutdownSignal): void => {
    interruptedExitCode = exitCodeForSignal(signal);
    workflowAbortController.abort();
  };
  const stopOnSigint = (): void => stopOnSignal("SIGINT");
  const stopOnSigterm = (): void => stopOnSignal("SIGTERM");
  process.once("SIGINT", stopOnSigint);
  process.once("SIGTERM", stopOnSigterm);

  try {
    console.error(options.pullRequestUrl ? "Fetching the GitHub PR..." : "Reading changes since the base branch...");
    const sourcePatch = options.pullRequestUrl === undefined
      ? await readLocalBranchPatch(options.baseRef, process.cwd(), workflowAbortController.signal)
      : await readGitHubPullRequestPatch(options.pullRequestUrl, workflowAbortController.signal);
    console.error("Starting the private OpenCode gateway...");
    privateGateway = await startPrivateGateway(options, workflowAbortController.signal);
    console.error("Reducing the diff with Meat...");
    const readingPatch = await createReadingPatchWithMeat(
      sourcePatch,
      privateGateway.gatewayModel,
      privateGateway.gatewayBaseUrl,
      privateGateway.gatewayToken,
      workflowAbortController.signal,
    );
    temporaryDirectory = await mkdtemp(join(tmpdir(), "meat-plannotator-review-"));
    const patchPath = join(temporaryDirectory, "reading.diff");
    await writeFile(patchPath, readingPatch);
    const plannotatorArguments = ["review", "--patch-file", patchPath];
    console.error("Opening Plannotator...");
    await runCommand("plannotator", plannotatorArguments, {
      stdio: "inherit",
      signal: workflowAbortController.signal,
    });
  } catch (error: unknown) {
    if (interruptedExitCode === undefined) throw error;
    process.exitCode = interruptedExitCode;
  } finally {
    await cleanup();
    if (interruptedExitCode !== undefined) process.exitCode = interruptedExitCode;
    process.off("SIGINT", stopOnSigint);
    process.off("SIGTERM", stopOnSigterm);
  }
}

export function parseMeatResult(output: string): string {
  let result: unknown;
  try {
    result = JSON.parse(output);
  } catch {
    throw new MeatResultError("Meat returned invalid JSON");
  }
  if (!isMeatResult(result)) {
    throw new MeatResultError("Meat did not return smart_diff");
  }

  return result.smart_diff;
}

export async function readLocalBranchPatch(
  selectedBaseRef?: string,
  workingDirectory = process.cwd(),
  signal?: AbortSignal,
): Promise<string> {
  const repositoryRoot = (await runCommand("git", ["rev-parse", "--show-toplevel"], {
    workingDirectory,
    signal,
  })).trim();
  const baseRef = selectedBaseRef ?? await detectDefaultBaseRef(repositoryRoot, signal);
  const mergeBaseCommit = (await runCommand("git", ["merge-base", baseRef, "HEAD"], {
    workingDirectory: repositoryRoot,
    signal,
  })).trim();
  const trackedPatch = await runCommand("git", ["diff", "--no-ext-diff", "--binary", mergeBaseCommit], {
    workingDirectory: repositoryRoot,
    signal,
  });
  const untrackedOutput = await runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { workingDirectory: repositoryRoot, signal },
  );
  const untrackedPaths = untrackedOutput.split("\0").filter(Boolean);
  const untrackedPatches: string[] = [];
  for (const untrackedPath of untrackedPaths) {
    const untrackedPatch = await readUntrackedPatch(repositoryRoot, untrackedPath, signal);
    if (untrackedPatch.length > 0) {
      untrackedPatches.push(untrackedPatch);
    }
  }

  const combinedPatch = [trackedPatch, ...untrackedPatches].filter(Boolean).join("\n");
  if (!combinedPatch.trim()) {
    throw new Error(`No changes found since ${baseRef}`);
  }

  return combinedPatch;
}

interface PrivateGatewayHandle {
  readonly gatewayBaseUrl: string;
  readonly gatewayModel: string;
  readonly gatewayToken: string;
  readonly stop: () => Promise<void>;
}

function isMeatResult(value: unknown): value is { readonly smart_diff: string } {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "smart_diff" in value
    && typeof value.smart_diff === "string";
}

async function cleanupReview(
  temporaryDirectory: string | undefined,
  privateGateway: PrivateGatewayHandle | undefined,
): Promise<void> {
  try {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  } finally {
    await privateGateway?.stop();
  }
}

function exitCodeForSignal(signal: ShutdownSignal): number {
  return signal === "SIGINT" ? SIGINT_EXIT_CODE : SIGTERM_EXIT_CODE;
}

async function readUntrackedPatch(
  repositoryRoot: string,
  untrackedPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const absolutePath = join(repositoryRoot, untrackedPath);
  const fileStats = await lstatIfPresent(absolutePath);
  if (fileStats === undefined) {
    return "";
  }
  if (fileStats.isDirectory()) {
    console.error(`Skipping nested untracked repository: ${untrackedPath}`);
    return "";
  }

  try {
    return await runCommand(
      "git",
      ["diff", "--no-index", "--binary", "--", "/dev/null", untrackedPath],
      { workingDirectory: repositoryRoot, acceptedExitCodes: [0, 1], signal },
    );
  } catch (error: unknown) {
    if (await lstatIfPresent(absolutePath) === undefined) {
      return "";
    }

    throw error;
  }
}

async function lstatIfPresent(filePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(filePath);
  } catch (error: unknown) {
    if (hasErrorCode(error, FILE_NOT_FOUND_ERROR_CODE)) {
      return undefined;
    }

    throw error;
  }
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return error instanceof Error && "code" in error && error.code === expectedCode;
}

async function detectDefaultBaseRef(repositoryRoot: string, signal?: AbortSignal): Promise<string> {
  const symbolicOriginHead = await runCommand(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { workingDirectory: repositoryRoot, acceptedExitCodes: [0, 1], signal },
  );
  const baseCandidates = [
    symbolicOriginHead.trim(),
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].filter(Boolean);
  for (const baseCandidate of baseCandidates) {
    const resolvedCommit = await runCommand("git", ["rev-parse", "--verify", "--quiet", `${baseCandidate}^{commit}`], {
      workingDirectory: repositoryRoot,
      acceptedExitCodes: [0, 1],
      signal,
    });
    if (resolvedCommit.trim()) {
      return baseCandidate;
    }
  }

  throw new Error("Could not detect the base branch; pass --base <ref>");
}

async function readGitHubPullRequestPatch(pullRequestUrl: string, signal: AbortSignal): Promise<string> {
  const patch = await runCommand("gh", ["pr", "diff", pullRequestUrl], { signal });
  if (!patch.trim()) {
    throw new Error("The GitHub PR has no changes");
  }

  return patch;
}

async function createReadingPatchWithMeat(
  sourcePatch: string,
  gatewayModel: string,
  gatewayBaseUrl: string,
  gatewayToken: string,
  signal: AbortSignal,
): Promise<string> {
  const output = await runCommand("meat", ["-json", "-model", gatewayModel], {
    input: sourcePatch,
    environment: {
      ...process.env,
      OPENAI_BASE_URL: gatewayBaseUrl,
      OPENAI_API_KEY: gatewayToken,
      MEAT_MODEL: gatewayModel,
    },
    signal,
  });
  return parseMeatResult(output);
}

async function startPrivateGateway(options: ReviewOptions, signal: AbortSignal): Promise<PrivateGatewayHandle> {
  if (signal.aborted) throw new Error("Review interrupted");
  const gatewayToken = `oca_${randomBytes(GATEWAY_TOKEN_RANDOM_BYTE_LENGTH).toString("hex")}`;
  const gatewayModel = `opencode-gateway/${options.openCodeModel}${options.openCodeVariant ? `:${options.openCodeVariant}` : ""}`;
  const gatewayArguments = ["--model", options.openCodeModel, "--port", "0"];
  if (options.openCodeVariant !== undefined) {
    gatewayArguments.push("--variant", options.openCodeVariant);
  }
  if (options.openCodeDirectory !== undefined) {
    gatewayArguments.push("--directory", options.openCodeDirectory);
  }
  const gatewayChildProcess = spawn("opencode-as-openai-api", gatewayArguments, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCODE_API_MODEL: gatewayModel,
      OPENCODE_API_TOKEN: gatewayToken,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  gatewayChildProcess.stdout.setEncoding("utf8");
  let baseUrl: string;
  try {
    baseUrl = await waitForGatewayBaseUrl(gatewayChildProcess, signal);
  } catch (error: unknown) {
    await stopChildProcess(gatewayChildProcess);
    throw error;
  }

  return {
    gatewayBaseUrl: baseUrl,
    gatewayModel,
    gatewayToken,
    stop: () => stopChildProcess(gatewayChildProcess),
  };
}

function waitForGatewayBaseUrl(child: GatewayChildProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolveBaseUrl, rejectBaseUrl) => {
    let output = "";
    let hasSettled = false;
    const timeout = setTimeout(
      () => fail(new Error("Gateway startup timed out")),
      GATEWAY_START_TIMEOUT_30_SECONDS_MS,
    );

    function removeStartupListeners(): void {
      clearTimeout(timeout);
      child.stdout.off("data", inspectOutput);
      child.off("error", handleError);
      child.off("exit", handleExit);
      signal.removeEventListener("abort", handleAbort);
    }

    function fail(error: Error): void {
      if (hasSettled) {
        return;
      }

      hasSettled = true;
      removeStartupListeners();
      rejectBaseUrl(error);
    }

    function inspectOutput(chunk: string): void {
      output += chunk;
      const match = output.match(GATEWAY_BASE_URL_PATTERN);
      const matchedBaseUrl = match?.[1];
      if (matchedBaseUrl === undefined) {
        return;
      }

      hasSettled = true;
      removeStartupListeners();
      child.stdout.resume();
      resolveBaseUrl(matchedBaseUrl);
    }

    function handleError(error: Error): void {
      fail(createCommandSpawnError("opencode-as-openai-api", error));
    }

    function handleExit(exitCode: number | null, exitSignal: NodeJS.Signals | null): void {
      if (exitSignal !== null) {
        fail(new Error(`Gateway terminated by ${exitSignal}`));
        return;
      }

      fail(new Error(`Gateway exited with code ${String(exitCode)}`));
    }

    function handleAbort(): void {
      fail(new Error("Review interrupted"));
    }

    child.once("error", handleError);
    child.once("exit", handleExit);
    child.stdout.on("data", inspectOutput);
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) handleAbort();
  });
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    await runCommand("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      acceptedExitCodes: [0, 128],
    });
    return;
  }

  await new Promise<void>((resolveStop) => {
    const finishStop = (): void => {
      clearTimeout(timeout);
      resolveStop();
    };
    const timeout = setTimeout(() => {
      if (!child.kill("SIGKILL")) {
        finishStop();
      }
    }, GATEWAY_STOP_TIMEOUT_15_SECONDS_MS);
    child.once("exit", finishStop);
    if (child.exitCode !== null || child.signalCode !== null || !child.kill("SIGTERM")) {
      finishStop();
    }
  });
}
