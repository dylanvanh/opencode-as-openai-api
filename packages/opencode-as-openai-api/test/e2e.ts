import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  FAKE_OPENCODE_SOURCE,
  installNodeCommand,
  pathWithCommandDirectory,
} from "../../../test/e2e-helpers.mjs";

const MODEL = "test/model";
const API_TOKEN = "e2e-token";
const HTTP_OK_STATUS = 200;
const PROCESS_STOP_TIMEOUT_5_SECONDS_MS = 5_000;
const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("should serve an OpenAI response through the packaged CLI", async () => {
  // given
  const commandDirectory = await mkdtemp(join(tmpdir(), "opencode-api-e2e-"));
  await installNodeCommand(commandDirectory, "opencode", FAKE_OPENCODE_SOURCE);
  const gatewayProcess = spawn(process.execPath, [CLI_PATH, "--model", MODEL, "--port", "0"], {
    env: {
      ...process.env,
      OPENCODE_API_TOKEN: API_TOKEN,
      PATH: pathWithCommandDirectory(commandDirectory),
    },
    stdio: "pipe",
  });

  try {
    const baseUrl = await readGatewayBaseUrl(gatewayProcess);

    // when
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: "Say hello" }),
    });
    const responseBody: unknown = await response.json();

    // then
    assert.equal(response.status, HTTP_OK_STATUS);
    assert.equal(responseText(responseBody), "Hello from fake OpenCode");
  } finally {
    await stopProcess(gatewayProcess);
    await rm(commandDirectory, { recursive: true, force: true });
  }
});

function readGatewayBaseUrl(childProcess: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolveBaseUrl, rejectBaseUrl) => {
    let standardOutput = "";
    let standardError = "";
    const inspectOutput = (chunk: Buffer): void => {
      standardOutput += chunk.toString();
      const match = standardOutput.match(/Base URL: (http:\/\/127\.0\.0\.1:\d+\/v1)/);
      if (match?.[1]) {
        removeListeners();
        resolveBaseUrl(match[1]);
      }
    };
    const collectError = (chunk: Buffer): void => {
      standardError += chunk.toString();
    };
    const handleExit = (exitCode: number | null): void => {
      removeListeners();
      rejectBaseUrl(new Error(`Gateway exited with code ${String(exitCode)}: ${standardError}`));
    };
    const handleError = (error: Error): void => {
      removeListeners();
      rejectBaseUrl(error);
    };
    const removeListeners = (): void => {
      childProcess.stdout.off("data", inspectOutput);
      childProcess.stderr.off("data", collectError);
      childProcess.off("exit", handleExit);
      childProcess.off("error", handleError);
    };

    childProcess.stdout.on("data", inspectOutput);
    childProcess.stderr.on("data", collectError);
    childProcess.once("exit", handleExit);
    childProcess.once("error", handleError);
  });
}

async function stopProcess(childProcess: ChildProcessWithoutNullStreams): Promise<void> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  childProcess.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => childProcess.once("exit", () => resolveExit())),
    new Promise<never>((_, rejectTimeout) => setTimeout(
      () => rejectTimeout(new Error("Gateway did not stop")),
      PROCESS_STOP_TIMEOUT_5_SECONDS_MS,
    )),
  ]);
}

function responseText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("output" in value) || !Array.isArray(value.output)) {
    return undefined;
  }
  const firstOutput: unknown = value.output[0];
  if (typeof firstOutput !== "object" || firstOutput === null || !("content" in firstOutput)) return undefined;
  const content = firstOutput.content;
  if (!Array.isArray(content)) return undefined;
  const firstContent: unknown = content[0];
  if (typeof firstContent !== "object" || firstContent === null || !("text" in firstContent)) return undefined;
  return typeof firstContent.text === "string" ? firstContent.text : undefined;
}
