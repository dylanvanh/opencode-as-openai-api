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
const CITY = "Cape Town";
const CITY_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
};
const CITY_FORMAT = { type: "json_schema", name: "city_response", strict: true, schema: CITY_SCHEMA };

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

for (const chat of [true, false]) {
  for (const schemaFormat of [true, false]) {
    for (const stream of [true, false]) {
      test(`returns validated ${schemaFormat ? "schema" : "JSON object"} output through ${chat ? "Chat Completions" : "Responses"} with stream=${stream}`, async () => {
        // given
        const output = { city: CITY };
        const { url, calls } = await fixture({ info: { structured: output }, parts: [] });
        const format = schemaFormat ? CITY_FORMAT : { type: "json_object" };
        const chatFormat = schemaFormat ? { type: "json_schema", json_schema: CITY_FORMAT } : format;
        const requestBody = chat
          ? { model: MODEL, messages: [{ role: "user", content: "Return a city as JSON" }], response_format: chatFormat, stream }
          : { model: MODEL, input: "Return a city as JSON", text: { format }, stream };
        const endpoint = chat ? "/v1/chat/completions" : "/v1/responses";

        // when
        const response = await postJson(url, endpoint, requestBody);
        const body = stream ? await response.text() : await responseJson(response);

        // then
        assert.equal(response.status, HTTP_OK_STATUS);
        assert.deepEqual(calls.at(0)?.format?.schema, schemaFormat ? CITY_SCHEMA : { type: "object" });
        if (typeof body === "string") {
          const events = body.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice("data: ".length)));
          const delta = chat
            ? events.find((event) => event.choices?.[0]?.delta?.content)?.choices[0].delta.content
            : events.find((event) => event.type === "response.output_text.delta")?.delta;
          assert.equal(delta, JSON.stringify(output));
          return;
        }
        assert.equal(structuredResponseText(body, chat), JSON.stringify(output));
        if (!chat) assert.deepEqual(body["text"], { format });
      });
    }
  }
}

for (const output of [undefined, null, [], "{}", {}, { city: null }, { city: CITY, extra: true }]) {
  test(`rejects invalid upstream schema output before streaming: ${JSON.stringify(output)}`, async () => {
    // given
    const { url } = await fixture({ info: { structured: output }, parts: [{ type: "text", text: JSON.stringify({ city: CITY }) }] });
    const requestBody = {
      model: MODEL,
      messages: [{ role: "user", content: "Return a city" }],
      response_format: { type: "json_schema", json_schema: CITY_FORMAT },
      stream: true,
    };

    // when
    const response = await postJson(url, "/v1/chat/completions", requestBody);
    const body = await responseJson(response);

    // then
    assert.equal(response.status, HTTP_BAD_GATEWAY_STATUS);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assertErrorCode(body, "upstream_error");
  });
}

test("rejects invalid schemas before calling OpenCode", async () => {
  // given
  const { url, calls } = await fixture(textResult("Unexpected"));
  const requestBody = {
    model: MODEL,
    messages: [{ role: "user", content: "Return a city" }],
    response_format: { type: "json_schema", json_schema: { ...CITY_FORMAT, schema: { type: "object", $ref: "#/$defs/missing" } } },
  };

  // when
  const response = await postJson(url, "/v1/chat/completions", requestBody);
  const body = await responseJson(response);

  // then
  assert.equal(response.status, HTTP_BAD_REQUEST_STATUS);
  assert.ok(isRecord(body["error"]));
  assert.equal(body["error"]["param"], "response_format.json_schema.schema");
  assert.deepEqual(calls, []);
});

for (const toolChoice of ["auto", "required", "none", { type: "function", function: { name: "weather" } }]) {
  const expectsToolCall = toolChoice === "required" || typeof toolChoice === "object";
  test(`supports JSON response formats with tool_choice=${JSON.stringify(toolChoice)}`, async () => {
    // given
    const output = expectsToolCall
      ? { type: "function_call", name: "weather", arguments: { city: CITY } }
      : toolChoice === "none" ? { city: CITY } : { type: "text", text: { city: CITY } };
    const { url } = await fixture({ info: { structured: output }, parts: [] });
    const requestBody = {
      model: MODEL,
      messages: [{ role: "user", content: "Return a city" }],
      response_format: { type: "json_schema", json_schema: CITY_FORMAT },
      tools: [{ type: "function", function: { name: "weather", parameters: CITY_SCHEMA } }],
      tool_choice: toolChoice,
    };

    // when
    const response = await postJson(url, "/v1/chat/completions", requestBody);
    const body = await responseJson(response);

    // then
    assert.equal(response.status, HTTP_OK_STATUS);
    if (!expectsToolCall) {
      assert.equal(structuredResponseText(body, true), JSON.stringify({ city: CITY }));
      return;
    }
    const choices = body["choices"];
    assert.ok(Array.isArray(choices));
    assert.equal(choices[0].finish_reason, "tool_calls");
    assert.equal(choices[0].message.tool_calls[0].function.name, "weather");
  });
}

test("rejects a JSON answer when a function call is required", async () => {
  // given
  const { url } = await fixture({ info: { structured: { type: "text", text: { city: CITY } } }, parts: [] });

  // when
  const response = await postJson(url, "/v1/responses", {
    model: MODEL,
    input: "Return a city",
    text: { format: CITY_FORMAT },
    tools: [{ type: "function", name: "weather", parameters: CITY_SCHEMA }],
    tool_choice: "required",
  });
  const body = await responseJson(response);

  // then
  assert.equal(response.status, HTTP_BAD_GATEWAY_STATUS);
  assertErrorCode(body, "upstream_error");
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

function structuredResponseText(body: UnknownRecord, chat: boolean): unknown {
  if (chat) {
    const choices = body["choices"];
    assert.ok(Array.isArray(choices));
    assert.ok(isRecord(choices[0]));
    const message = choices[0]["message"];
    assert.ok(isRecord(message));
    return message["content"];
  }
  const output = body["output"];
  assert.ok(Array.isArray(output));
  assert.ok(isRecord(output[0]));
  const content = output[0]["content"];
  assert.ok(Array.isArray(content));
  assert.ok(isRecord(content[0]));
  return content[0]["text"];
}
