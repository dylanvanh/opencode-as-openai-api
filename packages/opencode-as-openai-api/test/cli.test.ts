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
const UPSTREAM_URL = "http://127.0.0.1:4096";
const UPSTREAM_DIRECTORY = "/srv/opencode-api";
const MAX_UPSTREAM_URL_LENGTH = 2_048;
const MAX_DIRECTORY_LENGTH = 4_096;

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

for (const directory of [UPSTREAM_DIRECTORY, "C:\\OpenCode\\API", "/remote-only/config with spaces/日本語"]) {
  test(`preserves the upstream directory ${directory} without local resolution`, () => {
    // given
    const argumentsList = ["--model", MODEL, "--upstream-url", `${UPSTREAM_URL}/proxy/`, "--directory", directory];

    // when
    const options = parseGatewayOptions(argumentsList);

    // then
    assert.equal(options.upstreamUrl, `${UPSTREAM_URL}/proxy`);
    assert.equal(options.directory, directory);
  });
}

test("requires an explicit upstream directory", () => {
  // given
  const argumentsList = ["--model", MODEL, "--upstream-url", UPSTREAM_URL];

  // when
  const parse = (): unknown => parseCliArguments(argumentsList);

  // then
  assert.throws(parse, /--directory is required with --upstream-url/);
});

for (const directory of ["relative", "~/api", "", " ", "/config\nother", "/".repeat(MAX_DIRECTORY_LENGTH + 1)]) {
  test(`rejects an invalid upstream directory of length ${directory.length}`, () => {
    // given
    const argumentsList = ["--model", MODEL, "--upstream-url", UPSTREAM_URL, "--directory", directory];

    // when
    const parse = (): unknown => parseCliArguments(argumentsList);

    // then
    assert.throws(parse, /--directory/);
  });
}

for (const url of [
  "", "localhost:4096", "file:///tmp/server", "http://user:secret@localhost:4096", `${UPSTREAM_URL}?token=secret`,
  `${UPSTREAM_URL}#fragment`, "http://localhost:0", "http://localhost:65536", `${UPSTREAM_URL}\n`,
  `${UPSTREAM_URL}/${"a".repeat(MAX_UPSTREAM_URL_LENGTH)}`,
]) {
  test(`rejects an invalid upstream URL of length ${url.length}`, () => {
    // given
    const argumentsList = ["--model", MODEL, "--upstream-url", url, "--directory", UPSTREAM_DIRECTORY];

    // when
    const parse = (): unknown => parseCliArguments(argumentsList);

    // then
    assert.throws(parse, /upstream-url|URL credentials/);
  });
}

test("accepts HTTPS, IPv6, and both upstream port bounds", () => {
  // given
  const urls = ["https://api.example.com/opencode", "http://[::1]:1", `http://localhost:${MAX_PORT}`];

  // when
  const options = urls.map((url) => parseGatewayOptions(["--model", MODEL, "--upstream-url", url, "--directory", UPSTREAM_DIRECTORY]));

  // then
  assert.deepEqual(options.map((option) => option.upstreamUrl), urls);
});

test("accepts an upstream URL and directory at their length limits", () => {
  // given
  const urlPrefix = `${UPSTREAM_URL}/`;
  const url = `${urlPrefix}${"a".repeat(MAX_UPSTREAM_URL_LENGTH - urlPrefix.length)}`;
  const directory = `/${"a".repeat(MAX_DIRECTORY_LENGTH - 1)}`;
  const argumentsList = ["--model", MODEL, "--upstream-url", url, "--directory", directory];

  // when
  const options = parseGatewayOptions(argumentsList);

  // then
  assert.equal(options.upstreamUrl, url);
  assert.equal(options.directory, directory);
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
