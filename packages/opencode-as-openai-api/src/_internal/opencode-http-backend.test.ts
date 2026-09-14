import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createUpstreamFixture,
  UPSTREAM_AUTHORIZATION,
  UPSTREAM_DIRECTORY,
  UPSTREAM_MODEL,
  UPSTREAM_PASSWORD,
  UPSTREAM_USERNAME,
  UPSTREAM_VERSION,
} from "../../test/upstream-fixture.js";
import { createOpenCodeRequest, normalizeResponsesRequest } from "../translate.js";
import { OpenCodeHttpBackend } from "./opencode-http-backend.js";

const REQUEST_TIMEOUT_5_SECONDS_MS = 5_000;
const HTTP_SERVICE_UNAVAILABLE_STATUS = 503;

test("requires successful strategy initialization before creating a request session", async () => {
  // given
  const fixture = await createUpstreamFixture();
  const backend = createBackend(fixture.url);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
  const request = createOpenCodeRequest(normalizeResponsesRequest({ model: UPSTREAM_MODEL, input: "Hi" }, UPSTREAM_MODEL), UPSTREAM_MODEL, null, []);
  try {
    // when
    const run = backend.run(request, signal);

    // then
    await assert.rejects(run, /must be ready/);
    assert.deepEqual(fixture.requests, []);
  } finally {
    await fixture.close();
  }
});

for (const apiVersion of [undefined, 2] as const) {
  test(`keeps the selected V${apiVersion ?? 1} strategy for the connection lifetime`, async () => {
    // given
    const fixture = await createUpstreamFixture(apiVersion ? { apiVersion } : {});
    const backend = createBackend(fixture.url);
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
    try {
      const firstVersion = await backend.ready(UPSTREAM_MODEL, signal);
      const requestCountAfterStartup = fixture.requests.length;

      // when
      const secondVersion = await backend.ready(UPSTREAM_MODEL, signal);

      // then
      assert.equal(secondVersion, firstVersion);
      assert.equal(fixture.requests.length, requestCountAfterStartup);
      await assert.rejects(backend.ready("other/model", signal), /already connected to another model/);
    } finally {
      await fixture.close();
    }
  });
}

test("uses upstream authentication and directory for preflight, messages, and cleanup", async () => {
  // given
  const fixture = await createUpstreamFixture();
  const backend = createBackend(fixture.url);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
  try {
    // when
    const version = await backend.ready(UPSTREAM_MODEL, signal);
    const request = createOpenCodeRequest(normalizeResponsesRequest({ model: UPSTREAM_MODEL, input: "Hi" }, UPSTREAM_MODEL), UPSTREAM_MODEL, null, backend.toolIds);
    const result = await backend.run(request, signal);

    // then
    assert.equal(version, UPSTREAM_VERSION);
    assert.deepEqual(result, { info: {}, parts: [{ type: "text", text: "Remote answer" }] });
    assert.deepEqual(request.tools, { "*": false, bash: false, read: false, mcp_custom_tool: false });
    assert.ok(fixture.requests.every((request) => request.authorization === UPSTREAM_AUTHORIZATION && (request.path === "/api/health" || request.directory === UPSTREAM_DIRECTORY)));
    assert.deepEqual(fixture.requests.filter((request) => request.method !== "GET").map(({ method, path }) => ({ method, path })), [
      { method: "POST", path: "/session" },
      { method: "POST", path: "/session/owned-session/message" },
      { method: "DELETE", path: "/session/owned-session" },
    ]);
    const sessionBody = fixture.requests.find((request) => request.path === "/session")?.body;
    assert.ok(typeof sessionBody === "object" && sessionBody !== null && "permission" in sessionBody);
    assert.ok(Array.isArray(sessionBody.permission));
    assert.ok(sessionBody.permission.some((rule) => rule.permission === "*" && rule.pattern === "*" && rule.action === "deny"));
  } finally {
    await fixture.close();
  }
});

test("reports authentication failure without exposing the password", async () => {
  // given
  const fixture = await createUpstreamFixture();
  const invalidPassword = "invalid-secret";
  const backend = new OpenCodeHttpBackend({ url: fixture.url, directory: UPSTREAM_DIRECTORY, password: invalidPassword });
  try {
    // when
    const connect = backend.ready(UPSTREAM_MODEL, AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS));

    // then
    await assert.rejects(connect, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /authentication failed/);
      assert.equal(error.message.includes(invalidPassword), false);
      return true;
    });
    assert.deepEqual(fixture.requests.map((request) => request.path), ["/api/health"]);
  } finally {
    await fixture.close();
  }
});

for (const password of [undefined, UPSTREAM_PASSWORD]) {
  test(`connects with ${password ? "the default Basic username" : "no upstream authentication"}`, async () => {
    // given
    const authorization = password ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : null;
    const fixture = await createUpstreamFixture({ authorization });
    const backend = new OpenCodeHttpBackend({ url: fixture.url, ...(password === undefined ? {} : { password }) });
    try {
      // when
      const version = await backend.ready(UPSTREAM_MODEL, AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS));

      // then
      assert.equal(version, UPSTREAM_VERSION);
      assert.ok(fixture.requests.every((request) => request.authorization === (authorization ?? undefined)));
    } finally {
      await fixture.close();
    }
  });
}

test("does not follow upstream redirects or forward credentials to their destination", async () => {
  // given
  const destination = await createUpstreamFixture();
  const fixture = await createUpstreamFixture({ healthRedirect: `${destination.url}/global/health` });
  const backend = createBackend(fixture.url);
  try {
    // when
    const connect = backend.ready(UPSTREAM_MODEL, AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS));

    // then
    await assert.rejects(connect);
    assert.deepEqual(destination.requests, []);
  } finally {
    await fixture.close();
    await destination.close();
  }
});

for (const { label, options, errorPattern } of [
  { label: "an unhealthy server", options: { health: { healthy: false, version: UPSTREAM_VERSION } }, errorPattern: /not healthy/ },
  { label: "OpenCode 2.x", options: { health: { healthy: true, version: "2.0.0" } }, errorPattern: /1.x series/ },
  { label: "a missing version", options: { health: { healthy: true } }, errorPattern: /1.x series/ },
  { label: "a missing gateway agent", options: { agents: [] }, errorPattern: /Configure the opencode-as-openai-api primary agent/ },
  { label: "a subagent", options: { agents: [{ name: "opencode-as-openai-api", mode: "subagent" }] }, errorPattern: /primary agent/ },
  { label: "a missing model", options: { providers: { providers: [] } }, errorPattern: /model is not connected/ },
]) {
  test(`rejects ${label} before creating sessions`, async () => {
    // given
    const fixture = await createUpstreamFixture(options);
    const backend = createBackend(fixture.url);
    try {
      // when
      const connect = backend.ready(UPSTREAM_MODEL, AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS));

      // then
      await assert.rejects(connect, errorPattern);
      assert.ok(fixture.requests.every((request) => request.method === "GET"));
    } finally {
      await fixture.close();
    }
  });
}

test("deletes its session when the upstream message fails", async () => {
  // given
  const fixture = await createUpstreamFixture({ messageStatus: HTTP_SERVICE_UNAVAILABLE_STATUS });
  const backend = createBackend(fixture.url);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_5_SECONDS_MS);
  const request = createOpenCodeRequest(normalizeResponsesRequest({ model: UPSTREAM_MODEL, input: "Hi" }, UPSTREAM_MODEL), UPSTREAM_MODEL, null, []);
  try {
    await backend.ready(UPSTREAM_MODEL, signal);

    // when
    const run = backend.run(request, signal);

    // then
    await assert.rejects(run, new RegExp(`OpenCode ${HTTP_SERVICE_UNAVAILABLE_STATUS}`));
    assert.equal(fixture.requests.at(-1)?.path, "/session/owned-session");
    assert.equal(fixture.requests.at(-1)?.method, "DELETE");
  } finally {
    await fixture.close();
  }
});

test("uses a fresh authenticated signal to abort and delete its cancelled session", async () => {
  // given
  const controller = new AbortController();
  const fixture = await createUpstreamFixture({ onMessage: () => controller.abort() });
  const backend = createBackend(fixture.url);
  const request = createOpenCodeRequest(normalizeResponsesRequest({ model: UPSTREAM_MODEL, input: "Hi" }, UPSTREAM_MODEL), UPSTREAM_MODEL, null, []);
  try {
    await backend.ready(UPSTREAM_MODEL, controller.signal);

    // when
    const run = backend.run(request, controller.signal);

    // then
    await assert.rejects(run, /abort/i);
    assert.deepEqual(fixture.requests.slice(-2).map(({ path, method }) => ({ path, method })), [
      { path: "/session/owned-session/abort", method: "POST" },
      { path: "/session/owned-session", method: "DELETE" },
    ]);
    assert.ok(fixture.requests.every((request) => request.authorization === UPSTREAM_AUTHORIZATION && (request.path === "/api/health" || request.directory === UPSTREAM_DIRECTORY)));
  } finally {
    await fixture.close();
  }
});

function createBackend(url: string): OpenCodeHttpBackend {
  return new OpenCodeHttpBackend({ url, directory: UPSTREAM_DIRECTORY, username: UPSTREAM_USERNAME, password: UPSTREAM_PASSWORD });
}
