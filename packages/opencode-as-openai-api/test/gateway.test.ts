import { type Server } from "node:http";
import { afterEach, expect, test } from "vitest";
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
  quickTunnel?: boolean;
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
  expect(response.status).toBe(HTTP_UNAUTHORIZED_STATUS);
});

test("lists only the locked model", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await get(url, "/v1/models");
  const body = await responseJson(response);

  // then
  expect(response.status).toBe(HTTP_OK_STATUS);
  expect(body).toEqual({
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
  expect(response.status).toBe(HTTP_OK_STATUS);
  expect(calls.at(0)?.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" });
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
  expect(body).toMatchObject({
    output: [{ content: [{ text: "Hello" }] }],
    usage: { input_tokens: INPUT_TOKENS, output_tokens: TOTAL_OUTPUT_TOKENS },
  });
});

test("disables all OpenCode tools for each request", async () => {
  // given
  const { calls, url } = await fixture(textResult("Hello"));

  // when
  await postJson(url, "/v1/responses", { model: MODEL, input: "Hi" });

  // then
  expect(calls.at(0)?.tools).toEqual({ bash: false, read: false, write: false });
});

test("streams Responses events in order", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await postJson(url, "/v1/responses", { model: MODEL, input: "Hi", stream: true });
  const events = parseSseEvents(await response.text());

  // then
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(events.at(0)?.type).toBe("response.created");
  expect(events.some((event) => event.type === "response.output_text.delta" && event["delta"] === "Hello")).toBe(true);
  expect(events.at(-1)?.type).toBe("response.completed");
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
  expect(body).toMatchObject({
    output: [{ type: "function_call", name: "shell", arguments: "{\"command\":\"pwd\"}" }],
  });
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
  expect(body).toMatchObject({ choices: [{ message: { role: "assistant", content: "Hello" } }] });
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
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(body).not.toContain("event: undefined");
  expect(body).toContain('data: {"id":"chatcmpl-');
  expect(body).toContain("data: [DONE]\n\n");
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
  expect(body).toMatchObject({
    choices: [{
      finish_reason: "tool_calls",
      message: { tool_calls: [{ function: { name: "weather" } }] },
    }],
  });
});

test("rejects a model mismatch", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await postJson(url, "/v1/responses", { model: OTHER_MODEL, input: "Hi" });

  // then
  expect(response.status).toBe(HTTP_NOT_FOUND_STATUS);
});

test("rejects malformed model path encoding as a client error", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await get(url, "/v1/models/%");
  const body = await responseJson(response);

  // then
  expect(response.status).toBe(HTTP_BAD_REQUEST_STATUS);
  expect(body).toMatchObject({ error: { code: "invalid_model" } });
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
  expect(response.headers.get("x-request-id")).toMatch(/^req_[a-f0-9]+$/);
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
  expect(response.status).toBe(HTTP_BAD_REQUEST_STATUS);
});

test.each([null, [], "text", 1])("rejects a non-object JSON body: %j", async (requestBody) => {
  // given
  const { url } = await fixture(textResult("Hello"));

  // when
  const response = await postJson(url, "/v1/responses", requestBody);
  const body = await responseJson(response);

  // then
  expect(response.status).toBe(HTTP_BAD_REQUEST_STATUS);
  expect(body).toMatchObject({ error: { code: "invalid_json" } });
});

test("rejects malformed JSON", async () => {
  // given
  const { url } = await fixture(textResult("Hello"));
  const malformedJson = "{";

  // when
  const response = await postRaw(url, "/v1/responses", malformedJson);
  const body = await responseJson(response);

  // then
  expect(response.status).toBe(HTTP_BAD_REQUEST_STATUS);
  expect(body).toMatchObject({ error: { code: "invalid_json" } });
});

test("rejects streaming through a public quick tunnel", async () => {
  // given
  const { url } = await fixture(textResult("Hello"), { quickTunnel: true });

  // when
  const response = await postJson(
    url,
    "/v1/responses",
    { model: MODEL, input: "Hi", stream: true },
    { "cf-ray": "test" },
  );

  // then
  expect(response.status).toBe(HTTP_BAD_REQUEST_STATUS);
});

test("rejects a non-positive gateway concurrency limit", () => {
  // given
  const configuration = baseConfiguration();
  configuration.maxConcurrency = 0;

  // when
  const createInvalidGateway = (): Server => createGateway(configuration);

  // then
  expect(createInvalidGateway).toThrow("maxConcurrency must be a positive safe integer");
});

test("rejects an empty gateway token", () => {
  // given
  const configuration = baseConfiguration();
  configuration.token = "";

  // when
  const createInvalidGateway = (): Server => createGateway(configuration);

  // then
  expect(createInvalidGateway).toThrow("token must be a non-empty string");
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
  expect(response.status).toBe(HTTP_BAD_GATEWAY_STATUS);
});

async function fixture(result: unknown, options: FixtureOptions = {}): Promise<GatewayFixture> {
  const calls: OpenCodeRequestBody[] = [];
  const backend: GatewayBackend = {
    toolIds: TOOL_IDS,
    async run(body): Promise<unknown> {
      calls.push(body);
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
  if (options.quickTunnel !== undefined) configuration.quickTunnel = options.quickTunnel;
  const server = createGateway(configuration);
  const port = await listen(server);
  servers.push(server);
  return { calls, url: `http://${LOCALHOST}:${port}` };
}

function baseConfiguration(): GatewayConfiguration {
  return {
    model: MODEL,
    token: API_TOKEN,
    backend: { async run(): Promise<unknown> { return textResult("Hello"); } },
    logger: { info: () => undefined },
  };
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

async function responseJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return body;
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
