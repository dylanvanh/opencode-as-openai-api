import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
import {
  createUpstreamFixture,
  UPSTREAM_AUTHORIZATION,
  UPSTREAM_DIRECTORY,
  UPSTREAM_PASSWORD,
  UPSTREAM_USERNAME,
  UPSTREAM_V2_TOKEN,
  UPSTREAM_V2_SESSION_PATH,
} from "./upstream-fixture.js";

const MODEL = "test/model";
const API_TOKEN = "e2e-token";
const HTTP_OK_STATUS = 200;
const PROCESS_STOP_TIMEOUT_5_SECONDS_MS = 5_000;
const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const CITY = "Cape Town";
const NODE_EXECUTABLE = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
const CLI_START_TIMEOUT_10_SECONDS_MS = 10_000;

for (const { label, requestBody, expectedText } of [
  { label: "text", requestBody: { model: MODEL, input: "Say hello" }, expectedText: "Hello from fake OpenCode" },
  {
    label: "structured JSON",
    requestBody: {
      model: MODEL,
      input: "Return a city to visit",
      text: {
        format: {
          type: "json_schema",
          name: "city_response",
          strict: true,
          schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
        },
      },
    },
    expectedText: JSON.stringify({ city: CITY }),
  },
]) {
  test(`should serve an OpenAI ${label} response through the packaged CLI`, async () => {
    // given
    const commandDirectory = await mkdtemp(join(tmpdir(), "opencode-api-e2e-"));
    await installNodeCommand(commandDirectory, "opencode", FAKE_OPENCODE_SOURCE);
    const gatewayProcess = spawn(NODE_EXECUTABLE, [CLI_PATH, "--model", MODEL, "--port", "0"], {
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
        body: JSON.stringify(requestBody),
      });
      const responseBody: unknown = await response.json();

      // then
      assert.equal(response.status, HTTP_OK_STATUS);
      assert.equal(responseText(responseBody), expectedText);
    } finally {
      await stopProcess(gatewayProcess);
      await rm(commandDirectory, { recursive: true, force: true });
    }
  });
}

test("attaches without a local OpenCode executable and leaves the upstream running after shutdown", async () => {
  // given
  const upstream = await createUpstreamFixture();
  const emptyCommandDirectory = await mkdtemp(join(tmpdir(), "opencode-api-attach-e2e-"));
  const gatewayProcess = spawn(NODE_EXECUTABLE, [
    CLI_PATH, "--model", MODEL, "--port", "0", "--upstream-url", upstream.url, "--directory", UPSTREAM_DIRECTORY,
  ], {
    env: {
      ...process.env,
      PATH: emptyCommandDirectory,
      OPENCODE_API_TOKEN: API_TOKEN,
      OPENCODE_SERVER_USERNAME: UPSTREAM_USERNAME,
      OPENCODE_SERVER_PASSWORD: UPSTREAM_PASSWORD,
    },
    stdio: "pipe",
  });
  try {
    const baseUrl = await readGatewayBaseUrl(gatewayProcess);

    // when
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: "Say hello" }),
    });
    const body: unknown = await response.json();
    await stopProcess(gatewayProcess);
    const health = await fetch(`${upstream.url}/global/health`, { headers: { authorization: UPSTREAM_AUTHORIZATION } });

    // then
    assert.equal(response.status, HTTP_OK_STATUS);
    assert.equal(responseText(body), "Remote answer");
    assert.equal(health.status, HTTP_OK_STATUS);
    assert.ok(upstream.requests.slice(0, -1).every((request) => (request.path === "/api/health" || request.directory === UPSTREAM_DIRECTORY) && request.authorization === UPSTREAM_AUTHORIZATION));
    assert.deepEqual(upstream.requests.filter((request) => request.method === "DELETE").map((request) => request.path), ["/session/owned-session"]);
  } finally {
    await stopProcess(gatewayProcess);
    await upstream.close();
    await rm(emptyCommandDirectory, { recursive: true, force: true });
  }
});

test("fails startup for invalid upstream credentials without changing the server", async () => {
  // given
  const upstream = await createUpstreamFixture();
  const gatewayProcess = spawn(NODE_EXECUTABLE, [
    CLI_PATH, "--model", MODEL, "--port", "0", "--upstream-url", upstream.url, "--directory", UPSTREAM_DIRECTORY,
  ], {
    env: { ...process.env, OPENCODE_SERVER_USERNAME: UPSTREAM_USERNAME, OPENCODE_SERVER_PASSWORD: "incorrect" },
    stdio: "pipe",
  });
  try {
    // when
    const startup = readGatewayBaseUrl(gatewayProcess);

    // then
    await assert.rejects(startup, /authentication failed/);
    assert.ok(upstream.requests.every((request) => request.method === "GET"));
  } finally {
    await stopProcess(gatewayProcess);
    await upstream.close();
  }
});

for (const { label, path, requestBody, text, expectedStatus } of [
  { label: "text", path: "responses", requestBody: { input: "Say hello" }, text: "V2 answer", expectedStatus: HTTP_OK_STATUS },
  { label: "structured JSON", path: "responses", requestBody: { input: "Return a city", text: { format: { type: "json_object" } } }, text: JSON.stringify({ city: CITY }), expectedStatus: HTTP_OK_STATUS },
  { label: "required function calls", path: "chat/completions", requestBody: {
    messages: [{ role: "user", content: "Get weather" }], tool_choice: "required",
    tools: [{ type: "function", function: { name: "weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
    response_format: { type: "json_object" },
  }, text: JSON.stringify({ type: "function_call", name: "weather", arguments: { city: CITY } }), expectedStatus: HTTP_OK_STATUS },
  { label: "invalid structured output", path: "responses", requestBody: { input: "Return JSON", text: { format: { type: "json_object" } } }, text: "invalid", expectedStatus: 502 },
]) {
  test(`serves ${label} through the packaged CLI attached to V2`, async () => {
    // given
    const upstream = await createUpstreamFixture({ apiVersion: 2, authorization: `Bearer ${UPSTREAM_V2_TOKEN}`, texts: [text] });
    const gatewayProcess = spawn(NODE_EXECUTABLE, [
      CLI_PATH, "--model", MODEL, "--port", "0", "--upstream-url", upstream.url, "--directory", UPSTREAM_DIRECTORY,
    ], {
      env: { ...process.env, OPENCODE_API_TOKEN: API_TOKEN, OPENCODE_UPSTREAM_TOKEN: UPSTREAM_V2_TOKEN, OPENCODE_SERVER_PASSWORD: "" },
      stdio: "pipe",
    });
    try {
      const baseUrl = await readGatewayBaseUrl(gatewayProcess);

      // when
      const response = await fetch(`${baseUrl}/${path}`, {
        method: "POST", headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, ...requestBody }),
      });
      const result: unknown = await response.json();
      await stopProcess(gatewayProcess);
      const health = await fetch(`${upstream.url}/api/health`, { headers: { authorization: `Bearer ${UPSTREAM_V2_TOKEN}` } });

      // then
      assert.equal(response.status, expectedStatus);
      assert.equal(health.status, HTTP_OK_STATUS);
      if (expectedStatus === HTTP_OK_STATUS && path === "responses") assert.equal(responseText(result), text);
      if (path === "chat/completions") {
        assert.ok(typeof result === "object" && result !== null && "choices" in result && Array.isArray(result.choices));
        assert.deepEqual(result.choices[0].message.tool_calls[0].function, { name: "weather", arguments: JSON.stringify({ city: CITY }) });
      }
      assert.deepEqual(upstream.requests.filter((request) => request.method === "DELETE").map((request) => request.path), [UPSTREAM_V2_SESSION_PATH]);
    } finally {
      await stopProcess(gatewayProcess);
      await upstream.close();
    }
  });
}

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
      clearTimeout(timeout);
      childProcess.stdout.off("data", inspectOutput);
      childProcess.stderr.off("data", collectError);
      childProcess.off("exit", handleExit);
      childProcess.off("error", handleError);
    };

    const timeout = setTimeout(() => {
      removeListeners();
      rejectBaseUrl(new Error(`Gateway startup timed out: ${standardError}`));
    }, CLI_START_TIMEOUT_10_SECONDS_MS);
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
