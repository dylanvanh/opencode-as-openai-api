import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOpenCodeRequest,
  createResultSchema,
  normalizeChatCompletionsRequest,
  normalizeResponsesRequest,
  parseOpenCodeResult,
  type NormalizedTool,
  type StructuredOutputPolicy,
} from "../src/translate.js";

const MODEL = "test/model";
const TOOL_NAME = "weather";
const INPUT_TOKENS = 3;
const GENERATED_TOKENS = 2;
const REASONING_TOKENS = 1;
const EXPECTED_OUTPUT_TOKENS = GENERATED_TOKENS + REASONING_TOKENS;
const EXPECTED_TOTAL_TOKENS = INPUT_TOKENS + EXPECTED_OUTPUT_TOKENS;
const INVALID_TOKEN_COUNTS: unknown[] = [
  -1,
  1.5,
  "2",
  Number.MAX_SAFE_INTEGER + 1,
];
const WEATHER_TOOL: NormalizedTool = {
  name: TOOL_NAME,
  description: "Read the weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};
const REQUIRED_TOOL_POLICY: StructuredOutputPolicy = {
  allowText: false,
  allowedFunctionNames: [TOOL_NAME],
};

test("rejects a non-object request body at the translation boundary", () => {
  // given
  const requestBody = null;

  // when
  const normalizeInvalidBody = (): unknown => normalizeResponsesRequest(requestBody, MODEL);

  // then
  assert.throws(normalizeInvalidBody, /request body must be a JSON object/);
});

test("rejects required tool choice without tools", () => {
  // given
  const requestBody = { model: MODEL, input: "Hi", tool_choice: "required" };

  // when
  const normalizeRequiredTool = (): unknown => normalizeResponsesRequest(requestBody, MODEL);

  // then
  assert.throws(normalizeRequiredTool, /tool_choice requires at least one function tool/);
});

test("rejects a non-boolean stream option", () => {
  // given
  const requestBody = { model: MODEL, input: "Hi", stream: "true" };

  // when
  const normalizeInvalidStream = (): unknown => normalizeResponsesRequest(requestBody, MODEL);

  // then
  assert.throws(normalizeInvalidStream, /stream must be a boolean/);
});

test("rejects duplicate function names", () => {
  // given
  const requestBody = {
    model: MODEL,
    input: "Hi",
    tools: [
      { type: "function", name: TOOL_NAME },
      { type: "function", name: TOOL_NAME },
    ],
  };

  // when
  const normalizeDuplicateTools = (): unknown => normalizeResponsesRequest(requestBody, MODEL);

  // then
  assert.throws(normalizeDuplicateTools, new RegExp(`duplicate function name: ${TOOL_NAME}`));
});

test("rejects an invalid function name", () => {
  // given
  const requestBody = {
    model: MODEL,
    input: "Hi",
    tools: [{ type: "function", name: "invalid function" }],
  };

  // when
  const normalizeInvalidTool = (): unknown => normalizeResponsesRequest(requestBody, MODEL);

  // then
  assert.throws(normalizeInvalidTool, /function name must use 1-64 letters/);
});

test("rejects structured Responses output formats", () => {
  // given
  const requestBody = {
    model: MODEL,
    input: "Hi",
    text: { format: { type: "json_schema" } },
  };

  // when
  const normalizeStructuredResponse = (): unknown => normalizeResponsesRequest(requestBody, MODEL);

  // then
  assert.throws(normalizeStructuredResponse, /text is not supported/);
});

test("rejects structured Chat Completions output formats", () => {
  // given
  const requestBody = {
    model: MODEL,
    messages: [{ role: "user", content: "Hi" }],
    response_format: { type: "json_schema" },
  };

  // when
  const normalizeStructuredChat = (): unknown => normalizeChatCompletionsRequest(requestBody, MODEL);

  // then
  assert.throws(normalizeStructuredChat, /response_format is not supported/);
});

for (const parameters of [[], { type: "array" }]) {
  test("rejects non-object function parameters", () => {
    // given
    const requestBody = {
      model: MODEL,
      input: "Hi",
      tools: [{ type: "function", name: TOOL_NAME, parameters }],
    };

    // when
    const normalizeInvalidParameters = (): unknown => normalizeResponsesRequest(requestBody, MODEL);

    // then
    assert.throws(normalizeInvalidParameters, /function parameters must be an object/);
  });
}

test("builds a strict per-function result schema", () => {
  // given
  const tools = [WEATHER_TOOL];

  // when
  const schema = createResultSchema(tools, "required");

  // then
  assert.deepEqual(schema, {
    type: "object",
    oneOf: [{
      type: "object",
      additionalProperties: false,
      required: ["type", "name", "arguments"],
      properties: {
        type: { const: "function_call" },
        name: { const: TOOL_NAME },
        arguments: WEATHER_TOOL.parameters,
      },
    }],
  });
});

test("uses the upstream model and disables OpenCode tools", () => {
  // given
  const normalized = normalizeResponsesRequest({ model: MODEL, input: "Hi", tool_choice: "none" }, MODEL);
  const disabledToolIds = ["bash"];

  // when
  const request = createOpenCodeRequest(normalized, MODEL, null, disabledToolIds);

  // then
  assert.deepEqual(request.model, { providerID: "test", modelID: "model" });
  assert.deepEqual(request.tools, { bash: false });
});

test("disables an OpenCode tool named __proto__", () => {
  // given
  const normalized = normalizeResponsesRequest({ model: MODEL, input: "Hi", tool_choice: "none" }, MODEL);
  const disabledToolIds = ["__proto__"];

  // when
  const request = createOpenCodeRequest(normalized, MODEL, null, disabledToolIds);

  // then
  assert.equal(Object.hasOwn(request.tools, "__proto__"), true);
  assert.equal(JSON.stringify(request.tools), '{"__proto__":false}');
});

test("accepts an allowed structured function call", () => {
  // given
  const upstreamResponse = {
    info: {
      structured: { type: "function_call", name: TOOL_NAME, arguments: { city: "Cape Town" } },
      tokens: {},
    },
    parts: [],
  };

  // when
  const result = parseOpenCodeResult(upstreamResponse, REQUIRED_TOOL_POLICY);

  // then
  assert.equal(result.type, "function_call");
  assert.equal(result.name, TOOL_NAME);
  assert.equal(result.arguments, "{\"city\":\"Cape Town\"}");
});

test("rejects a structured function name outside the request policy", () => {
  // given
  const upstreamResponse = {
    info: {
      structured: { type: "function_call", name: "unknown", arguments: {} },
      tokens: {},
    },
    parts: [],
  };

  // when
  const translateUnknownFunction = (): unknown => parseOpenCodeResult(upstreamResponse, REQUIRED_TOOL_POLICY);

  // then
  assert.throws(translateUnknownFunction, /invalid structured output/);
});

test("rejects text when tool choice is required", () => {
  // given
  const upstreamResponse = {
    info: { structured: { type: "text", text: "No tool" }, tokens: {} },
    parts: [],
  };

  // when
  const translateText = (): unknown => parseOpenCodeResult(upstreamResponse, REQUIRED_TOOL_POLICY);

  // then
  assert.throws(translateText, /invalid structured output/);
});

for (const { label, output } of [
  { label: "array arguments", output: { type: "function_call", name: TOOL_NAME, arguments: [] } },
  { label: "extra fields", output: { type: "function_call", name: TOOL_NAME, arguments: {}, extra: true } },
]) {
  test(`rejects structured function output with ${label}`, () => {
    // given
    const upstreamResponse = { info: { structured: output, tokens: {} }, parts: [] };

    // when
    const translateInvalidOutput = (): unknown => parseOpenCodeResult(upstreamResponse, REQUIRED_TOOL_POLICY);

    // then
    assert.throws(translateInvalidOutput, /invalid structured output/);
  });
}

test("adds reasoning tokens to output and total usage", () => {
  // given
  const upstreamResponse = {
    info: { tokens: { input: INPUT_TOKENS, output: GENERATED_TOKENS, reasoning: REASONING_TOKENS } },
    parts: [{ type: "text", text: "Hello" }],
  };

  // when
  const result = parseOpenCodeResult(upstreamResponse, null);

  // then
  assert.deepEqual(result.usage, {
    input: INPUT_TOKENS,
    output: EXPECTED_OUTPUT_TOKENS,
    reasoning: REASONING_TOKENS,
    total: EXPECTED_TOTAL_TOKENS,
  });
});

for (const invalidTokenCount of INVALID_TOKEN_COUNTS) {
  test(`rejects an invalid token count: ${JSON.stringify(invalidTokenCount)}`, () => {
    // given
    const upstreamResponse = {
      info: { tokens: { input: invalidTokenCount } },
      parts: [{ type: "text", text: "Hello" }],
    };

    // when
    const translateInvalidUsage = (): unknown => parseOpenCodeResult(upstreamResponse, null);

    // then
    assert.throws(translateInvalidUsage, /invalid token usage/);
  });
}
