import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createGateway } from "../src/server.js";
import { normalizeResponses, openCodeRequest, resultSchema } from "../src/translate.js";

const servers = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))));

async function fixture(result, options = {}) {
  const backend = { toolIds: ["bash", "read", "write"], calls: [], async run(body) { this.calls.push(body); return result; } };
  const server = createGateway({ model: "test/model", token: "secret", backend, logger: { info() {} }, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { backend, url: `http://127.0.0.1:${server.address().port}` };
}

function request(url, path, body, headers = {}) {
  return fetch(`${url}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer secret", "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("lists only the locked model and requires authentication", async () => {
  const { url } = await fixture({ info: { tokens: {} }, parts: [] });
  const models = await request(url, "/v1/models");
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).data.map((model) => model.id), ["test/model"]);
  assert.equal((await fetch(`${url}/v1/models`)).status, 401);
});

test("returns a non-streaming Responses text object and disables OpenCode tools", async () => {
  const { url, backend } = await fixture({ info: { tokens: { input: 3, output: 2, reasoning: 1 } }, parts: [{ type: "text", text: "Hello" }] });
  const response = await request(url, "/v1/responses", { model: "test/model", input: "Hi" });
  const body = await response.json();
  assert.equal(body.output[0].content[0].text, "Hello");
  assert.equal(body.usage.output_tokens, 3);
  assert.deepEqual(backend.calls[0].tools, { bash: false, read: false, write: false });
});

test("uses a public model alias without changing the OpenCode model", async () => {
  // given
  const upstreamModel = "anthropic/claude-sonnet";
  const publicModel = "opencode-gateway/anthropic/claude-sonnet";
  const { backend, url } = await fixture(
    { info: { tokens: {} }, parts: [{ type: "text", text: "Hello" }] },
    { model: publicModel, upstreamModel },
  );

  // when
  const response = await request(url, "/v1/responses", { model: publicModel, input: "Hi" });

  // then
  assert.equal(response.status, 200);
  assert.deepEqual(backend.calls[0].model, { providerID: "anthropic", modelID: "claude-sonnet" });
});

test("streams Responses events in order", async () => {
  const { url } = await fixture({ info: { tokens: { input: 1, output: 1 } }, parts: [{ type: "text", text: "Hello" }] });
  const response = await request(url, "/v1/responses", { model: "test/model", input: "Hi", stream: true });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  assert.equal(events[0].type, "response.created");
  assert.ok(events.some((event) => event.type === "response.output_text.delta" && event.delta === "Hello"));
  assert.equal(events.at(-1).type, "response.completed");
});

test("translates a Meat-shaped function tool response", async () => {
  const { url } = await fixture({ info: { structured: { type: "function_call", name: "shell", arguments: { command: "pwd" } }, tokens: {} }, parts: [] });
  const response = await request(url, "/v1/responses", {
    model: "test/model", input: [{ role: "user", content: [{ type: "input_text", text: "Where am I?" }] }],
    stream: true, store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "medium" },
    tools: [{ type: "function", name: "shell", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } }],
  });
  const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const done = events.find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.type, "function_call");
  assert.equal(done.item.name, "shell");
  assert.deepEqual(JSON.parse(done.item.arguments), { command: "pwd" });
});

test("supports Chat Completions text and tool calls", async () => {
  const textFixture = await fixture({ info: { tokens: {} }, parts: [{ type: "text", text: "Hello" }] });
  const text = await (await request(textFixture.url, "/v1/chat/completions", { model: "test/model", messages: [{ role: "user", content: "Hi" }] })).json();
  assert.equal(text.choices[0].message.content, "Hello");
  const toolFixture = await fixture({ info: { structured: { type: "function_call", name: "weather", arguments: { city: "Cape Town" } }, tokens: {} }, parts: [] });
  const tool = await (await request(toolFixture.url, "/v1/chat/completions", {
    model: "test/model", messages: [{ role: "user", content: "Weather?" }],
    tools: [{ type: "function", function: { name: "weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
  })).json();
  assert.equal(tool.choices[0].finish_reason, "tool_calls");
  assert.equal(tool.choices[0].message.tool_calls[0].function.name, "weather");
});

test("rejects model mismatch, unsupported media, and public quick-tunnel streaming", async () => {
  const { url } = await fixture({ info: { tokens: {} }, parts: [] });
  assert.equal((await request(url, "/v1/responses", { model: "other/model", input: "Hi" })).status, 404);
  assert.equal((await request(url, "/v1/responses", { model: "test/model", input: [{ role: "user", content: [{ type: "input_image", image_url: "x" }] }] })).status, 400);
  const backend = { toolIds: [], async run() { throw new Error("must not run"); } };
  const server = createGateway({ model: "test/model", token: "secret", backend, quickTunnel: true, logger: { info() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const tunneled = await request(`http://127.0.0.1:${server.address().port}`, "/v1/responses", { model: "test/model", input: "Hi", stream: true }, { "cf-ray": "test" });
  assert.equal(tunneled.status, 400);
});

test("rejects required tool choice without tools", async () => {
  const { url } = await fixture({ info: { tokens: {} }, parts: [] });
  const response = await request(url, "/v1/responses", { model: "test/model", input: "Hi", tool_choice: "required" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.param, "tool_choice");
});

test("builds a strict per-function schema", () => {
  const schema = resultSchema([{ name: "weather", parameters: { type: "object", required: ["city"], properties: { city: { type: "string" } } } }], "required");
  assert.equal(schema.type, "object");
  assert.equal(schema.oneOf.length, 1);
  assert.equal(schema.oneOf[0].properties.name.const, "weather");
  const normalized = normalizeResponses({ model: "test/model", input: "Hi", tools: [], tool_choice: "none" }, "test/model");
  assert.equal(openCodeRequest(normalized, "test/model", null, ["bash"]).tools.bash, false);
});
