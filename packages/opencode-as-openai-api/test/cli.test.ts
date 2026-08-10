import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parseCliArguments, type GatewayOptions } from "../src/cli.js";

const MODEL = "provider/model";
const DEFAULT_PORT = 8_787;
const MIN_PORT = 0;
const MAX_PORT = 65_535;
const DEFAULT_MAX_CONCURRENCY = 1;
const MIN_CONCURRENCY = 1;
const MAX_SAFE_CONCURRENCY = Number.MAX_SAFE_INTEGER;
const BELOW_MIN_PORT = MIN_PORT - 1;
const ABOVE_MAX_PORT = MAX_PORT + 1;
const NON_INTEGER_PORT = 1.5;
const BELOW_MIN_CONCURRENCY = MIN_CONCURRENCY - 1;
const ABOVE_MAX_CONCURRENCY = MAX_SAFE_CONCURRENCY + 1;

test("uses the public CLI defaults", () => {
  // given
  const argumentsList = ["--model", MODEL];

  // when
  const action = parseCliArguments(argumentsList);

  // then
  expect(action).toEqual({
    kind: "serve",
    options: {
      model: MODEL,
      port: DEFAULT_PORT,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      tunnel: null,
    },
  });
});

test("parses all public CLI options", () => {
  // given
  const selectedPort = MIN_PORT;
  const selectedMaxConcurrency = 2;
  const argumentsList = [
    "--model",
    MODEL,
    "--variant",
    "fast",
    "--port",
    String(selectedPort),
    "--max-concurrency",
    String(selectedMaxConcurrency),
    "--tunnel",
    "quick",
  ];

  // when
  const action = parseCliArguments(argumentsList);

  // then
  expect(action).toEqual({
    kind: "serve",
    options: {
      model: MODEL,
      variant: "fast",
      port: selectedPort,
      maxConcurrency: selectedMaxConcurrency,
      tunnel: "quick",
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
  expect(minimumPort).toBe(MIN_PORT);
  expect(maximumPort).toBe(MAX_PORT);
});

test.each([BELOW_MIN_PORT, ABOVE_MAX_PORT, NON_INTEGER_PORT])("rejects an invalid gateway port: %s", (port) => {
  // given
  const argumentsList = ["--model", MODEL, "--port", String(port)];

  // when
  const parseInvalidPort = (): unknown => parseCliArguments(argumentsList);

  // then
  expect(parseInvalidPort).toThrow(`--port must be from ${MIN_PORT} to ${MAX_PORT}`);
});

test("accepts both max-concurrency bounds", () => {
  // given
  const minimumArguments = ["--model", MODEL, "--max-concurrency", String(MIN_CONCURRENCY)];
  const maximumArguments = ["--model", MODEL, "--max-concurrency", String(MAX_SAFE_CONCURRENCY)];

  // when
  const minimum = parseGatewayOptions(minimumArguments).maxConcurrency;
  const maximum = parseGatewayOptions(maximumArguments).maxConcurrency;

  // then
  expect(minimum).toBe(MIN_CONCURRENCY);
  expect(maximum).toBe(MAX_SAFE_CONCURRENCY);
});

test.each([BELOW_MIN_CONCURRENCY, ABOVE_MAX_CONCURRENCY])("rejects invalid max concurrency: %s", (maxConcurrency) => {
  // given
  const argumentsList = ["--model", MODEL, "--max-concurrency", String(maxConcurrency)];

  // when
  const parseInvalidConcurrency = (): unknown => parseCliArguments(argumentsList);

  // then
  expect(parseInvalidConcurrency).toThrow("--max-concurrency must be a positive integer");
});

test("requires a model for gateway startup", () => {
  // given
  const argumentsList: string[] = [];

  // when
  const parseWithoutModel = (): unknown => parseCliArguments(argumentsList);

  // then
  expect(parseWithoutModel).toThrow("--model is required");
});

test("returns help without a model", () => {
  // given
  const argumentsList = ["--help"];

  // when
  const action = parseCliArguments(argumentsList);

  // then
  expect(action).toEqual({ kind: "help" });
});

test("returns version without a model", () => {
  // given
  const argumentsList = ["--version"];

  // when
  const action = parseCliArguments(argumentsList);

  // then
  expect(action).toEqual({ kind: "version" });
});

test("resolves a relative OpenCode directory", () => {
  // given
  const relativeDirectory = "config";
  const argumentsList = ["--model", MODEL, "--directory", relativeDirectory];

  // when
  const options = parseGatewayOptions(argumentsList);

  // then
  expect(options.directory).toBe(resolve(relativeDirectory));
});

test("requires provider/model syntax", () => {
  // given
  const argumentsList = ["--model", "invalid"];

  // when
  const parseInvalidModel = (): unknown => parseCliArguments(argumentsList);

  // then
  expect(parseInvalidModel).toThrow("provider/model format");
});

test("rejects positional CLI arguments", () => {
  // given
  const argumentsList = ["review", "--model", MODEL];

  // when
  const parsePositionalArgument = (): unknown => parseCliArguments(argumentsList);

  // then
  expect(parsePositionalArgument).toThrow("unknown option: review");
});

test("rejects a value option followed by another option", () => {
  // given
  const argumentsList = ["--model", "--port", String(DEFAULT_PORT)];

  // when
  const parseMissingModel = (): unknown => parseCliArguments(argumentsList);

  // then
  expect(parseMissingModel).toThrow("--model requires a value");
});

function parseGatewayOptions(argumentsList: readonly string[]): GatewayOptions {
  const action = parseCliArguments(argumentsList);
  if (action.kind !== "serve") throw new Error("Expected gateway options");
  return action.options;
}
