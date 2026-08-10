import assert from "node:assert/strict";
import { type Server } from "node:http";
import { afterEach, test } from "node:test";
import {
  createGateway,
  type GatewayBackend,
  type GatewayConfiguration,
} from "../src/server.js";
import { type OpenCodeRequestBody } from "../src/translate.js";

const MODEL = "test/model";
const OTHER_MODEL = "other/model";
const API_TOKEN = "secret";
const AUTHORIZATION_HEADER = `Bearer ${API_TOKEN}`;
const LOCALHOST = "127.0.0.1";
const DYNAMIC_PORT = 0;
const HTTP_OK_STATUS = 200;
const HTTP_BAD_REQUEST_STATUS = 400;
const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_NOT_FOUND_STATUS = 404;
const HTTP_TOO_MANY_REQUESTS_STATUS = 429;
const HTTP_BAD_GATEWAY_STATUS = 502;
const INPUT_TOKENS = 3;
const GENERATED_TOKENS = 2;
const REASONING_TOKENS = 1;
const TOTAL_OUTPUT_TOKENS = GENERATED_TOKENS + REASONING_TOKENS;
const TOOL_IDS = ["bash", "read", "write"];

type UnknownRecord = Record<string, unknown>;

interface FixtureOptions {
  model?: string;
  upstreamModel?: string;
  run?: GatewayBackend["run"];
}

interface GatewayFixture {
  calls: OpenCodeRequestBody[];
  url: string;
}

interface SseEvent extends UnknownRecord {
  type: string;
}

const servers: Server[] = [];

afterEach(async () => {
  const openServers = servers.splice(0);
  await Promise.all(openServers.map((server) => new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  })));
});

test("requires gateway authentication", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await fetch(`${url}/v1/models`);

  // then
  assert.equal(response.status, HTTP_UNAUTHORIZED_STATUS);
});

test("lists only the locked model", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await get(url, "/v1/models");
  const body = await responseJson(response);

  // then
  assert.equal(response.status, HTTP_OK_STATUS);
  assert.deepEqual(body, {
    object: "list",
    data: [{ id: MODEL, object: "model", created: 0, owned_by: "opencode" }],
  });
});

test("uses a public model alias without changing the OpenCode model", async () => {
  // given
  const upstreamModel = "anthropic/claude-sonnet";
  const publicModel = "opencode-gateway/anthropic/claude-sonnet";
  const { calls, url } = await fixture(textResult("Hello"), { model: publicModel, upstreamModel });

  // when
  const response = await postJson(url, "/v1/responses", { model: publicModel, input: "Hi" });

  // then
  assert.equal(response.status, HTTP_OK_STATUS);
  assert.deepEqual(calls.at(0)?.model, { providerID: "anthropic", modelID: "claude-sonnet" });
});

test("returns a non-streaming Responses text object with token usage", async () => {
  // given
  const result = {
    info: { tokens: { input: INPUT_TOKENS, output: GENERATED_TOKENS, reasoning: REASONING_TOKENS } },
    parts: [{ type: "text", text: "Hello" }],
  };
  const { url } = await fixture(result);

  // when
  const response = await postJson(url, "/v1/responses", { model: MODEL, input: "Hi" });
  const body = await responseJson(response);

  // then
  const output = body["output"];
  assert.ok(Array.isArray(output));
  assert.ok(isRecord(output[0]));
  const content = output[0]["content"];
  assert.ok(Array.isArray(content));
  assert.ok(isRecord(content[0]));
  assert.equal(content[0]["text"], "Hello");
  assert.ok(isRecord(body["usage"]));
  assert.equal(body["usage"]["input_tokens"], INPUT_TOKENS);
  assert.equal(body["usage"]["output_tokens"], TOTAL_OUTPUT_TOKENS);
});

test("disables all OpenCode tools for each request", async () => {
  // given
  const { calls, url } = await fixture(textResult("Hello"));

  // when
  await postJson(url, "/v1/responses", { model: MODEL, input: "Hi" });

  // then
  assert.deepEqual(calls.at(0)?.tools, { bash: false, read: false, write: false });
});

test("streams Responses events in order", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await postJson(url, "/v1/responses", { model: MODEL, input: "Hi", stream: true });
  const events = parseSseEvents(await response.text());

  // then
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(events.at(0)?.type, "response.created");
  assert.equal(events.some((event) => event.type === "response.output_text.delta" && event["delta"] === "Hello"), true);
  assert.equal(events.at(-1)?.type, "response.completed");
});

test("returns a caller-owned function call through Responses", async () => {
  // given
  const result = {
    info: {
      structured: { type: "function_call", name: "shell", arguments: { command: "pwd" } },
      tokens: {},
    },
    parts: [],
  };
  const { url } = await fixture(result);
  const requestBody = {
    model: MODEL,
    input: [{ role: "user", content: [{ type: "input_text", text: "Where am I?" }] }],
    tools: [{
      type: "function",
      name: "shell",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    }],
  };

  // when
  const response = await postJson(url, "/v1/responses", requestBody);
  const body = await responseJson(response);

  // then
  const output = body["output"];
  assert.ok(Array.isArray(output));
  assert.ok(isRecord(output[0]));
  assert.equal(output[0]["type"], "function_call");
  assert.equal(output[0]["name"], "shell");
  assert.equal(output[0]["arguments"], "{\"command\":\"pwd\"}");
});

test("returns Chat Completions text", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await postJson(url, "/v1/chat/completions", {
    model: MODEL,
    messages: [{ role: "user", content: "Hi" }],
  });
  const body = await responseJson(response);

  // then
  const choices = body["choices"];
  assert.ok(Array.isArray(choices));
  assert.ok(isRecord(choices[0]));
  assert.ok(isRecord(choices[0]["message"]));
  assert.equal(choices[0]["message"]["role"], "assistant");
  assert.equal(choices[0]["message"]["content"], "Hello");
});

test("streams Chat Completions as data-only server-sent events", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await postJson(url, "/v1/chat/completions", {
    model: MODEL,
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
  });
  const body = await response.text();

  // then
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.doesNotMatch(body, /event: undefined/);
  assert.match(body, /data: \{"id":"chatcmpl-/);
  assert.match(body, /data: \[DONE\]\n\n/);
});

test("returns caller-owned function calls through Chat Completions", async () => {
  // given
  const result = {
    info: {
      structured: { type: "function_call", name: "weather", arguments: { city: "Cape Town" } },
      tokens: {},
    },
    parts: [],
  };
  const { url } = await fixture(result);

  // when
  const response = await postJson(url, "/v1/chat/completions", {
    model: MODEL,
    messages: [{ role: "user", content: "Weather?" }],
    tools: [{
      type: "function",
      function: {
        name: "weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    }],
  });
  const body = await responseJson(response);

  // then
  const choices = body["choices"];
  assert.ok(Array.isArray(choices));
  assert.ok(isRecord(choices[0]));
  assert.equal(choices[0]["finish_reason"], "tool_calls");
  assert.ok(isRecord(choices[0]["message"]));
  const toolCalls = choices[0]["message"]["tool_calls"];
  assert.ok(Array.isArray(toolCalls));
  assert.ok(isRecord(toolCalls[0]));
  assert.ok(isRecord(toolCalls[0]["function"]));
  assert.equal(toolCalls[0]["function"]["name"], "weather");
});

test("rejects a model mismatch", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await postJson(url, "/v1/responses", { model: OTHER_MODEL, input: "Hi" });

  // then
  assert.equal(response.status, HTTP_NOT_FOUND_STATUS);
});

test("rejects malformed model path encoding as a client error", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await get(url, "/v1/models/%");
  const body = await responseJson(response);

  // then
  assert.equal(response.status, HTTP_BAD_REQUEST_STATUS);
  assertErrorCode(body, "invalid_model");
});

test("replaces an unsafe client request ID", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));
  const unsafeRequestId = "request id with spaces";

  // when
  const response = await fetch(`${url}/v1/models`, {
    headers: { authorization: AUTHORIZATION_HEADER, "x-request-id": unsafeRequestId },
  });

  // then
  assert.match(response.headers.get("x-request-id") ?? "", /^req_[a-f0-9]+$/);
});

test("rejects unsupported media", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await postJson(url, "/v1/responses", {
    model: MODEL,
    input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/image.png" }] }],
  });

  // then
  assert.equal(response.status, HTTP_BAD_REQUEST_STATUS);
});

for (const requestBody of [null, [], "text", 1]) {
  test(`rejects a non-object JSON body: ${JSON.stringify(requestBody)}`, async () => {
    // given
    const { url } = await fixture(textResult("Hello"));

    // when
    const response = await postJson(url, "/v1/responses", requestBody);
    const body = await responseJson(response);

    // then
    assert.equal(response.status, HTTP_BAD_REQUEST_STATUS);
    assertErrorCode(body, "invalid_json");
  });
}

test("rejects malformed JSON", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));
  const malformedJson = "{";

  // when
  const response = await postRaw(url, "/v1/responses", malformedJson);
  const body = await responseJson(response);

  // then
  assert.equal(response.status, HTTP_BAD_REQUEST_STATUS);
  assertErrorCode(body, "invalid_json");
});

test("limits gateway concurrency to one request", async () => {
  // given
  let backendStarted: () => void = () => undefined;
  let releaseBackend: () => void = () => undefined;
  const didBackendStart = new Promise<void>((resolveStarted) => {
    backendStarted = resolveStarted;
  });
  const run = async (): Promise<unknown> => {
    backendStarted();
    await new Promise<void>((resolveRun) => {
      releaseBackend = resolveRun;
    });
    return textResult("Hello");
  };
  const { url } = await fixture(textResult("unused"), { run });

  // when
  const firstResponsePromise = postJson(url, "/v1/responses", { model: MODEL, input: "First" });
  await didBackendStart;
  const secondResponse = await postJson(url, "/v1/responses", { model: MODEL, input: "Second" });
  releaseBackend();
  const firstResponse = await firstResponsePromise;

  // then
  assert.equal(firstResponse.status, HTTP_OK_STATUS);
  assert.equal(secondResponse.status, HTTP_TOO_MANY_REQUESTS_STATUS);
});

test("fails closed when OpenCode returns a different function", async () => {
  // given
  const result = {
    info: {
      structured: { type: "function_call", name: "unavailable", arguments: {} },
      tokens: {},
    },
    parts: [],
  };
  const { url } = await fixture(result);

  // when
  const response = await postJson(url, "/v1/responses", {
    model: MODEL,
    input: "Use the tool",
    tools: [{ type: "function", name: "allowed", parameters: { type: "object" } }],
  });

  // then
  assert.equal(response.status, HTTP_BAD_GATEWAY_STATUS);
});

async function fixture(result: unknown, options: FixtureOptions = {}): Promise<GatewayFixture> {
  const calls: OpenCodeRequestBody[] = [];
  const backend: GatewayBackend = {
    toolIds: TOOL_IDS,
    async run(body, signal): Promise<unknown> {
      calls.push(body);
      if (options.run) return options.run(body, signal);
      return result;
    },
  };
  const configuration: GatewayConfiguration = {
    model: options.model ?? MODEL,
    token: API_TOKEN,
    backend,
    logger: { info: () => undefined },
  };
  if (options.upstreamModel) configuration.upstreamModel = options.upstreamModel;
  const server = createGateway(configuration);
  const port = await listen(server);
  servers.push(server);
  return { calls, url: `http://${LOCALHOST}:${port}` };
}

function textResult(text: string): unknown {
  return { info: { tokens: {} }, parts: [{ type: "text", text }] };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(DYNAMIC_PORT, LOCALHOST, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test gateway did not bind to a TCP port");
  return address.port;
}

function get(url: string, path: string): Promise<Response> {
  return fetch(`${url}${path}`, { headers: { authorization: AUTHORIZATION_HEADER } });
}

function postJson(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const serializedBody = JSON.stringify(body);
  if (serializedBody === undefined) throw new Error("Test body is not JSON serializable");
  return postRaw(url, path, serializedBody, headers);
}

function postRaw(
  url: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      authorization: AUTHORIZATION_HEADER,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

async function responseJson(response: Response): Promise<UnknownRecord> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Test received a non-object JSON response");
  return body;
}

function assertErrorCode(body: UnknownRecord, expectedCode: string): void {
  const error = body["error"];
  assert.ok(isRecord(error));
  assert.equal(error["code"], expectedCode);
}

function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const parsed: unknown = JSON.parse(line.slice("data: ".length));
    if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
      throw new Error("Test received an invalid SSE event");
    }
    events.push({ ...parsed, type: parsed["type"] });
  }
  return events;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
