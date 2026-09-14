import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenCodeRequest, normalizeResponsesRequest, parseOpenCodeResult } from "../translate.js";
import {
  createUpstreamFixture, UPSTREAM_DIRECTORY, UPSTREAM_MODEL, UPSTREAM_V2_TOKEN, UPSTREAM_V2_VERSION, UPSTREAM_V2_SESSION_PATH,
  UPSTREAM_USERNAME, UPSTREAM_PASSWORD,
} from "../../test/upstream-fixture.js";
import { OpenCodeHttpBackend } from "./opencode-http-backend.js";

const REQUEST_TIMEOUT_5_SECONDS_MS = 5_000;
const AUTHORIZATION = `Bearer ${UPSTREAM_V2_TOKEN}`;
const VARIANT = "high";
const CITY = "Cape Town";
const CITY_SCHEMA = { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false };
const CITY_FORMAT = { type: "json_schema", name: "city", schema: CITY_SCHEMA };
const EXPECTED_INPUT_TOKENS = 10;
const EXPECTED_GENERATED_TOKENS = 4;
const EXPECTED_REASONING_TOKENS = 2;

test("detects V2 and uses its location, model, prompt, wait, message, and deletion contracts", async () => {
  // given
  const fixture = await createUpstreamFixture({ apiVersion: 2, authorization: AUTHORIZATION });
  const backend = createBackend(fixture.url);
  const request = createRequest();
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
  try {
    // when
    const version = await backend.ready(UPSTREAM_MODEL, signal);
    const result = parseOpenCodeResult(await backend.run(request, signal), null);

    // then
    assert.equal(version, UPSTREAM_V2_VERSION);
    assert.deepEqual(result, {
      type: "text", text: "Remote answer",
      usage: { input: EXPECTED_INPUT_TOKENS, output: EXPECTED_GENERATED_TOKENS + EXPECTED_REASONING_TOKENS,
        reasoning: EXPECTED_REASONING_TOKENS, total: EXPECTED_INPUT_TOKENS + EXPECTED_GENERATED_TOKENS + EXPECTED_REASONING_TOKENS },
    });
    assert.ok(fixture.requests.every((request) => request.path.startsWith("/api/") && request.authorization === AUTHORIZATION));
    assert.ok(fixture.requests.filter((request) => request.path.startsWith("/api/agent") || request.path === "/api/model")
      .every((request) => request.directory === UPSTREAM_DIRECTORY && !request.query.has("directory")));
    assert.deepEqual(fixture.requests.find((request) => request.path === "/api/session")?.body, {
      title: "opencode-as-openai-api request", agent: "opencode-as-openai-api",
      model: { providerID: "test", id: "model", variant: VARIANT }, location: { directory: UPSTREAM_DIRECTORY },
    });
    assert.deepEqual(fixture.requests.filter((request) => request.method !== "GET").map(({ method, path }) => ({ method, path })), [
      { method: "POST", path: "/api/session" },
      { method: "POST", path: `${UPSTREAM_V2_SESSION_PATH}/prompt` },
      { method: "POST", path: `${UPSTREAM_V2_SESSION_PATH}/wait` },
      { method: "DELETE", path: UPSTREAM_V2_SESSION_PATH },
    ]);
    const messageQuery = fixture.requests.find((request) => request.path.endsWith("/message"))?.query;
    assert.equal(messageQuery?.get("type"), "assistant");
    assert.equal(messageQuery?.get("order"), "desc");
    assert.equal(messageQuery?.get("limit"), "1");
  } finally {
    await fixture.close();
  }
});

test("retries schema-invalid JSON and returns only the validated object", async () => {
  // given
  const fixture = await createUpstreamFixture({ apiVersion: 2, authorization: AUTHORIZATION, texts: ['{"city":1}', JSON.stringify({ city: CITY })] });
  const backend = createBackend(fixture.url);
  const request = createRequest({ text: { format: CITY_FORMAT } });
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
  try {
    await backend.ready(UPSTREAM_MODEL, signal);

    // when
    const result = await backend.run(request, signal);

    // then
    assert.deepEqual(result, { info: { structured: { city: CITY }, tokens: { input: EXPECTED_INPUT_TOKENS, output: EXPECTED_GENERATED_TOKENS, reasoning: EXPECTED_REASONING_TOKENS, cache: { read: 0, write: 0 } } }, parts: [] });
    const prompts = fixture.requests.filter((request) => request.path.endsWith("/prompt"));
    const EXPECTED_ATTEMPTS = 2;
    assert.equal(prompts.length, EXPECTED_ATTEMPTS);
    const promptBody = prompts[0]?.body;
    assert.ok(typeof promptBody === "object" && promptBody !== null && "text" in promptBody && typeof promptBody.text === "string");
    assert.deepEqual(Object.keys(promptBody), ["text"]);
    assert.ok(promptBody.text.includes(JSON.stringify(CITY_SCHEMA)));
  } finally {
    await fixture.close();
  }
});

test("preserves required function calls and validates their arguments against the full schema", async () => {
  // given
  const functionName = "get_weather";
  const functionCall = { type: "function_call", name: functionName, arguments: { city: CITY } };
  const fixture = await createUpstreamFixture({ apiVersion: 2, authorization: AUTHORIZATION, texts: [
    JSON.stringify({ type: "text", text: "I will answer directly" }),
    JSON.stringify({ ...functionCall, arguments: { city: 1 } }),
    JSON.stringify(functionCall),
  ] });
  const backend = createBackend(fixture.url);
  const request = createRequest({
    tools: [{ type: "function", name: functionName, parameters: {
      type: "object", $defs: { city: { type: "string" } }, properties: { city: { $ref: "#/$defs/city" } }, required: ["city"], additionalProperties: false,
    } }], tool_choice: "required",
    text: { format: CITY_FORMAT },
  });
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
  try {
    await backend.ready(UPSTREAM_MODEL, signal);

    // when
    const result = parseOpenCodeResult(await backend.run(request, signal), { allowText: false, allowedFunctionNames: [functionName] });

    // then
    assert.equal(result.type, "function_call");
    if (result.type !== "function_call") throw new Error("Expected function call");
    assert.equal(result.name, functionName);
    assert.equal(result.arguments, JSON.stringify(functionCall.arguments));
    const EXPECTED_ATTEMPTS = 3;
    assert.equal(fixture.requests.filter((request) => request.path.endsWith("/prompt")).length, EXPECTED_ATTEMPTS);
  } finally {
    await fixture.close();
  }
});

test("rejects non-JSON output after bounded retries and deletes the session", async () => {
  // given
  const fixture = await createUpstreamFixture({ apiVersion: 2, authorization: AUTHORIZATION });
  const backend = createBackend(fixture.url);
  const request = createRequest({ text: { format: CITY_FORMAT } });
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
  try {
    await backend.ready(UPSTREAM_MODEL, signal);

    // when
    const result = backend.run(request, signal);

    // then
    await assert.rejects(result, /invalid structured output after retries/);
    assert.equal(fixture.requests.filter((request) => request.path.endsWith("/prompt")).length, (request.format?.retryCount ?? 0) + 1);
    assert.equal(fixture.requests.at(-1)?.method, "DELETE");
  } finally {
    await fixture.close();
  }
});

for (const permissions of [[], [{ action: "shell", resource: "*", effect: "deny" }], [
  { action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" },
]]) {
  test(`rejects an agent without an effective deny-all rule: ${JSON.stringify(permissions)}`, async () => {
    // given
    const fixture = await createUpstreamFixture({ apiVersion: 2, authorization: AUTHORIZATION, permissions });
    const backend = createBackend(fixture.url);
    try {
      // when
      const ready = backend.ready(UPSTREAM_MODEL, AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS));

      // then
      await assert.rejects(ready, /wildcard deny rule/);
      assert.ok(fixture.requests.every((request) => request.method === "GET"));
    } finally {
      await fixture.close();
    }
  });
}

for (const outcome of ["failed", "interrupted"]) {
  test(`rejects a ${outcome} session even when it contains text`, async () => {
    // given
    const fixture = await createUpstreamFixture({ apiVersion: 2, authorization: AUTHORIZATION, outcome });
    const backend = createBackend(fixture.url);
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
    try {
      await backend.ready(UPSTREAM_MODEL, signal);

      // when
      const result = backend.run(createRequest(), signal);

      // then
      await assert.rejects(result, /did not complete successfully/);
      assert.equal(fixture.requests.at(-1)?.method, "DELETE");
    } finally {
      await fixture.close();
    }
  });
}

for (const messages of [[], [{ type: "assistant", finish: "length", time: { completed: 1 }, content: [{ type: "text", text: "partial" }] }]]) {
  test("rejects missing or truncated assistant output", async () => {
    // given
    const fixture = await createUpstreamFixture({ apiVersion: 2, authorization: AUTHORIZATION, messages });
    const backend = createBackend(fixture.url);
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
    try {
      await backend.ready(UPSTREAM_MODEL, signal);

      // when
      const result = backend.run(createRequest(), signal);

      // then
      await assert.rejects(result, /incomplete or failed assistant message/);
    } finally {
      await fixture.close();
    }
  });
}

test("interrupts and deletes only its own session after cancellation while waiting", async () => {
  // given
  const controller = new AbortController();
  const fixture = await createUpstreamFixture({ apiVersion: 2, authorization: AUTHORIZATION, onWait: () => controller.abort() });
  const backend = createBackend(fixture.url);
  try {
    await backend.ready(UPSTREAM_MODEL, controller.signal);

    // when
    const result = backend.run(createRequest(), controller.signal);

    // then
    await assert.rejects(result, /abort/i);
    assert.deepEqual(fixture.requests.slice(-2).map(({ method, path }) => ({ method, path })), [
      { method: "POST", path: `${UPSTREAM_V2_SESSION_PATH}/interrupt` }, { method: "DELETE", path: UPSTREAM_V2_SESSION_PATH },
    ]);
    assert.ok(fixture.requests.every((request) => request.authorization === AUTHORIZATION));
  } finally {
    await fixture.close();
  }
});

test("waits for V2 agent loading and supports foreground-server Basic authentication", async () => {
  // given
  const pendingReads = 1;
  const fixture = await createUpstreamFixture({ apiVersion: 2, agentPendingReads: pendingReads });
  const backend = new OpenCodeHttpBackend({ url: fixture.url, directory: UPSTREAM_DIRECTORY, username: UPSTREAM_USERNAME, password: UPSTREAM_PASSWORD });
  try {
    // when
    const version = await backend.ready(UPSTREAM_MODEL, AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS));

    // then
    assert.equal(version, UPSTREAM_V2_VERSION);
    assert.equal(fixture.requests.filter((request) => request.path.startsWith("/api/agent/")).length, pendingReads + 1);
  } finally {
    await fixture.close();
  }
});

test("rejects an agent whose permissions changed after startup before creating a session", async () => {
  // given
  const options = { apiVersion: 2 as const, authorization: AUTHORIZATION, permissions: [{ action: "*", resource: "*", effect: "deny" }] };
  const fixture = await createUpstreamFixture(options);
  const backend = createBackend(fixture.url);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
  try {
    await backend.ready(UPSTREAM_MODEL, signal);
    options.permissions.push({ action: "shell", resource: "*", effect: "allow" });

    // when
    const result = backend.run(createRequest(), signal);

    // then
    await assert.rejects(result, /wildcard deny rule/);
    assert.ok(fixture.requests.every((request) => request.method === "GET"));
  } finally {
    await fixture.close();
  }
});

test("rejects conflicting authentication settings without making a request", () => {
  // given
  const options = { url: "http://127.0.0.1", token: UPSTREAM_V2_TOKEN, password: UPSTREAM_PASSWORD };

  // when
  const create = (): OpenCodeHttpBackend => new OpenCodeHttpBackend(options);

  // then
  assert.throws(create, /Set only one/);
});

for (const healthStatus of [401, 503]) {
  test(`does not fall back to V1 after a V2 HTTP ${healthStatus} failure`, async () => {
    // given
    const fixture = await createUpstreamFixture({ apiVersion: 2, authorization: AUTHORIZATION, healthStatus });
    const backend = createBackend(fixture.url);
    try {
      // when
      const ready = backend.ready(UPSTREAM_MODEL, AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS));

      // then
      await assert.rejects(ready);
      assert.deepEqual(fixture.requests.map((request) => request.path), ["/api/health"]);
    } finally {
      await fixture.close();
    }
  });
}

function createBackend(url: string): OpenCodeHttpBackend {
  return new OpenCodeHttpBackend({ url, directory: UPSTREAM_DIRECTORY, token: UPSTREAM_V2_TOKEN });
}

function createRequest(extra: Record<string, unknown> = {}) {
  return createOpenCodeRequest(normalizeResponsesRequest({ model: UPSTREAM_MODEL, input: "Answer the question", ...extra }, UPSTREAM_MODEL), UPSTREAM_MODEL, VARIANT, []);
}
