import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseCliArguments, type GatewayOptions } from "../src/cli.js";

const MODEL = "provider/model";
const DEFAULT_PORT = 8_787;
const MIN_PORT = 0;
const MAX_PORT = 65_535;
const BELOW_MIN_PORT = MIN_PORT - 1;
const ABOVE_MAX_PORT = MAX_PORT + 1;
const NON_INTEGER_PORT = 1.5;

test("uses the public CLI defaults", () => {
  // given
  const argumentsList = ["--model", MODEL];

  // when
  const action = parseCliArguments(argumentsList);

  // then
  assert.deepEqual(action, {
    kind: "serve",
    options: {
      model: MODEL,
      port: DEFAULT_PORT,
    },
  });
});

test("parses all public CLI options", () => {
  // given
  const selectedPort = MIN_PORT;
  const argumentsList = [
    "--model",
    MODEL,
    "--variant",
    "fast",
    "--port",
    String(selectedPort),
  ];

  // when
  const action = parseCliArguments(argumentsList);

  // then
  assert.deepEqual(action, {
    kind: "serve",
    options: {
      model: MODEL,
      variant: "fast",
      port: selectedPort,
    },
  });
});

test("accepts both gateway port bounds", () => {
  // given
  const minimumPortArguments = ["--model", MODEL, "--port", String(MIN_PORT)];
  const maximumPortArguments = ["--model", MODEL, "--port", String(MAX_PORT)];

  // when
  const minimumPort = parseGatewayOptions(minimumPortArguments).port;
  const maximumPort = parseGatewayOptions(maximumPortArguments).port;

  // then
  assert.equal(minimumPort, MIN_PORT);
  assert.equal(maximumPort, MAX_PORT);
});

for (const port of [BELOW_MIN_PORT, ABOVE_MAX_PORT, NON_INTEGER_PORT]) {
  test(`rejects an invalid gateway port: ${port}`, () => {
    // given
    const portArguments = port < MIN_PORT ? [`--port=${port}`] : ["--port", String(port)];
    const argumentsList = ["--model", MODEL, ...portArguments];

    // when
    const parseInvalidPort = (): unknown => parseCliArguments(argumentsList);

    // then
    assert.throws(parseInvalidPort, new RegExp(`--port must be from ${MIN_PORT} to ${MAX_PORT}`));
  });
}

test("requires a model for gateway startup", () => {
  // given
  const argumentsList: string[] = [];

  // when
  const parseWithoutModel = (): unknown => parseCliArguments(argumentsList);

  // then
  assert.throws(parseWithoutModel, /--model is required/);
});

test("returns help without a model", () => {
  // given
  const argumentsList = ["--help"];

  // when
  const action = parseCliArguments(argumentsList);

  // then
  assert.deepEqual(action, { kind: "help" });
});

test("returns version without a model", () => {
  // given
  const argumentsList = ["--version"];

  // when
  const action = parseCliArguments(argumentsList);

  // then
  assert.deepEqual(action, { kind: "version" });
});

test("resolves a relative OpenCode directory", () => {
  // given
  const relativeDirectory = "config";
  const argumentsList = ["--model", MODEL, "--directory", relativeDirectory];

  // when
  const options = parseGatewayOptions(argumentsList);

  // then
  assert.equal(options.directory, resolve(relativeDirectory));
});

test("requires provider/model syntax", () => {
  // given
  const argumentsList = ["--model", "invalid"];

  // when
  const parseInvalidModel = (): unknown => parseCliArguments(argumentsList);

  // then
  assert.throws(parseInvalidModel, /provider\/model format/);
});

test("rejects positional CLI arguments", () => {
  // given
  const argumentsList = ["review", "--model", MODEL];

  // when
  const parsePositionalArgument = (): unknown => parseCliArguments(argumentsList);

  // then
  assert.throws(parsePositionalArgument, /Unexpected argument 'review'/);
});

test("rejects a value option followed by another option", () => {
  // given
  const argumentsList = ["--model", "--port", String(DEFAULT_PORT)];

  // when
  const parseMissingModel = (): unknown => parseCliArguments(argumentsList);

  // then
  assert.throws(parseMissingModel, /Option '--model' argument is ambiguous/);
});

function parseGatewayOptions(argumentsList: readonly string[]): GatewayOptions {
  const action = parseCliArguments(argumentsList);
  if (action.kind !== "serve") throw new Error("Expected gateway options");
  return action.options;
}
