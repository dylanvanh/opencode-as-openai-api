import assert from "node:assert/strict";
import { test } from "node:test";
import { createResultSchema } from "../translate.js";
import { ApiError } from "./api-error.js";
import { normalizeResponseFormat } from "./response-format.js";

const FORMAT_NAME = "city_response";
const CITY = "Cape Town";
const CITY_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
};
const HTTP_BAD_REQUEST_STATUS = 400;
const MAX_FORMAT_NAME_LENGTH = 64;
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 10_000;
const EXAMPLES_SCHEMA_BASE_NODES = 3;

for (const chat of [true, false]) {
  test(`normalizes and validates a ${chat ? "Chat Completions" : "Responses"} JSON schema`, () => {
    // given
    const definition = { name: FORMAT_NAME, description: "City to visit", strict: true, schema: CITY_SCHEMA };
    const format = chat ? { type: "json_schema", json_schema: definition } : { type: "json_schema", ...definition };

    // when
    const normalized = normalizeResponseFormat(format, chat);

    // then
    assert.ok(normalized);
    assert.deepEqual(normalized.format, { type: "json_schema", ...definition });
    assert.equal(normalized.validate({ city: CITY }), true);
    assert.equal(normalized.validate({}), false);
    assert.equal(normalized.validate({ city: CITY, extra: true }), false);
  });
}

for (const value of [undefined, null, { type: "text" }]) {
  test(`uses plain text for ${JSON.stringify(value)}`, () => {
    // given
    const format = value;

    // when
    const normalized = normalizeResponseFormat(format, true);

    // then
    assert.equal(normalized, null);
  });
}

test("JSON object mode accepts objects without a caller schema", () => {
  // given
  const format = { type: "json_object" };

  // when
  const normalized = normalizeResponseFormat(format, true);

  // then
  assert.ok(normalized);
  assert.equal(normalized.validate({}), true);
  assert.equal(normalized.validate({ city: CITY }), true);
  assert.equal(normalized.validate([]), false);
  assert.equal(normalized.validate(null), false);
  assert.equal(normalized.validate("{}"), false);
});

for (const { label, definition, parameter } of [
  { label: "empty names", definition: { name: "" }, parameter: "name" },
  { label: "long names", definition: { name: "a".repeat(MAX_FORMAT_NAME_LENGTH + 1) }, parameter: "name" },
  { label: "invalid names", definition: { name: "invalid name" }, parameter: "name" },
  { label: "non-text descriptions", definition: { description: false }, parameter: "description" },
  { label: "non-boolean strict", definition: { strict: "true" }, parameter: "strict" },
  { label: "missing schemas", definition: { schema: undefined }, parameter: "schema" },
  { label: "boolean schemas", definition: { schema: true }, parameter: "schema" },
  { label: "array roots", definition: { schema: { type: "array" } }, parameter: "schema" },
  { label: "invalid property schemas", definition: { schema: { type: "object", properties: { city: { type: "invalid" } } } }, parameter: "schema" },
  { label: "unknown keywords", definition: { schema: { ...CITY_SCHEMA, unknownKeyword: true } }, parameter: "schema" },
  { label: "unresolved references", definition: { schema: { type: "object", $ref: "#/$defs/missing" } }, parameter: "schema" },
  { label: "remote references", definition: { schema: { type: "object", $ref: "https://example.com/schema.json" } }, parameter: "schema" },
  { label: "asynchronous schemas", definition: { schema: { ...CITY_SCHEMA, $async: true } }, parameter: "schema" },
]) {
  test(`rejects ${label} at the request boundary`, () => {
    // given
    const format = Object.assign({ type: "json_schema", name: FORMAT_NAME, schema: CITY_SCHEMA }, definition);

    // when
    const normalize = (): unknown => normalizeResponseFormat(format, false);

    // then
    assert.throws(normalize, (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, HTTP_BAD_REQUEST_STATUS);
      assert.equal(error.param, `text.format.${parameter}`);
      return true;
    });
  });
}

for (const format of [false, "json", [], {}, { type: "xml" }]) {
  test(`rejects invalid response formats: ${JSON.stringify(format)}`, () => {
    // given
    const invalidFormat = format;

    // when
    const normalize = (): unknown => normalizeResponseFormat(invalidFormat, true);

    // then
    assert.throws(normalize, ApiError);
  });
}

for (const strict of [undefined, null, false, true]) {
  test(`validates schema output with strict set to ${String(strict)}`, () => {
    // given
    const format = { type: "json_schema", name: "a".repeat(MAX_FORMAT_NAME_LENGTH), schema: CITY_SCHEMA, strict };

    // when
    const normalized = normalizeResponseFormat(format, false);

    // then
    assert.ok(normalized);
    assert.equal(normalized.validate({ city: CITY }), true);
    assert.equal(normalized.validate({ city: null }), false);
  });
}

for (const dialect of [
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2019-09/schema#",
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema#",
]) {
  test(`preserves local and recursive references with tools for ${dialect}`, () => {
    // given
    const schema = {
      $schema: dialect,
      type: "object",
      $defs: { city: { type: "string" } },
      properties: { city: { $ref: "#/$defs/city" }, next: { $ref: "#" } },
      required: ["city"],
      additionalProperties: false,
    };
    const tools = [{ name: "lookup", description: "Look up a city", parameters: CITY_SCHEMA }];
    const combinedSchema = createResultSchema(tools, "auto", schema);

    // when
    const normalized = normalizeResponseFormat({ type: "json_schema", name: FORMAT_NAME, schema: combinedSchema }, false);

    // then
    assert.ok(normalized);
    assert.equal(normalized.validate({ type: "text", text: { city: CITY, next: { city: CITY } } }), true);
    assert.equal(normalized.validate({ type: "text", text: { city: CITY, next: {} } }), false);
    assert.equal(normalized.validate({ type: "function_call", name: "lookup", arguments: { city: CITY } }), true);
    assert.equal(Object.hasOwn(schema, "$id"), false);
  });
}

test("validates standard string formats without coercing data", () => {
  // given
  const email = "person@example.com";
  const schema = { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] };

  // when
  const normalized = normalizeResponseFormat({ type: "json_schema", name: FORMAT_NAME, schema }, false);

  // then
  assert.ok(normalized);
  assert.equal(normalized.validate({ email }), true);
  assert.equal(normalized.validate({ email: "invalid" }), false);
  assert.equal(normalized.validate({ email: null }), false);
});

for (const schemaId of ["", "city-response", "https://example.com/city-response"]) {
  test(`preserves schema references inside a tool envelope with ID ${JSON.stringify(schemaId)}`, () => {
    // given
    const schema = {
      $id: schemaId,
      type: "object",
      $defs: { city: { type: "string" } },
      properties: { city: { $ref: "#/$defs/city" } },
      required: ["city"],
    };
    const tools = [{ name: "lookup", description: "Look up a city", parameters: CITY_SCHEMA }];
    const combinedSchema = createResultSchema(tools, "auto", schema);

    // when
    const normalized = normalizeResponseFormat({ type: "json_schema", name: FORMAT_NAME, schema: combinedSchema }, false);

    // then
    assert.ok(normalized);
    assert.equal(normalized.validate({ type: "text", text: { city: CITY } }), true);
    assert.equal(normalized.validate({ type: "text", text: {} }), false);
  });
}

test("accepts schemas at the depth limit and rejects deeper schemas", () => {
  // given
  let example: unknown = null;
  const examplesContainerDepth = 2;
  for (let depth = examplesContainerDepth; depth < MAX_SCHEMA_DEPTH; depth += 1) example = [example];
  const format = { type: "json_schema", name: FORMAT_NAME, schema: { type: "object", examples: [example] } };
  const deeperFormat = { ...format, schema: { ...format.schema, examples: [[example]] } };

  // when
  const normalized = normalizeResponseFormat(format, false);
  const normalizeDeeperSchema = (): unknown => normalizeResponseFormat(deeperFormat, false);

  // then
  assert.ok(normalized);
  assert.throws(normalizeDeeperSchema, /exceeds/);
});

test("accepts schemas at the node limit and rejects larger schemas", () => {
  // given
  const examples = Array.from({ length: MAX_SCHEMA_NODES - EXAMPLES_SCHEMA_BASE_NODES }, () => null);
  const format = { type: "json_schema", name: FORMAT_NAME, schema: { type: "object", examples } };
  const largerFormat = { ...format, schema: { ...format.schema, examples: [...examples, null] } };

  // when
  const normalized = normalizeResponseFormat(format, false);
  const normalizeLargerSchema = (): unknown => normalizeResponseFormat(largerFormat, false);

  // then
  assert.ok(normalized);
  assert.throws(normalizeLargerSchema, /exceeds/);
});
