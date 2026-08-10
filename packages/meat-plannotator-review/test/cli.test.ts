import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { CliInputError, parseCliArguments } from "../src/cli.js";

const MODEL = "provider/model";
const PULL_REQUEST_URL = "https://github.com/acme/repository/pull/12";

describe("parseCliArguments", () => {
  test("should return a local review action with resolved options", () => {
    // given
    const directory = "config";
    const arguments_ = [
      "--model",
      MODEL,
      "--variant",
      "high",
      "--directory",
      directory,
      "--base",
      "origin/trunk",
    ];

    // when
    const action = parseCliArguments(arguments_);

    // then
    expect(action).toEqual({
      kind: "review",
      options: {
        openCodeModel: MODEL,
        openCodeVariant: "high",
        openCodeDirectory: resolve(directory),
        baseRef: "origin/trunk",
      },
    });
  });

  test("should return a GitHub pull request review action", () => {
    // given
    const arguments_ = [PULL_REQUEST_URL, "--model", MODEL];

    // when
    const action = parseCliArguments(arguments_);

    // then
    expect(action).toEqual({
      kind: "review",
      options: { openCodeModel: MODEL, pullRequestUrl: PULL_REQUEST_URL },
    });
  });

  test("should return the help action without a model", () => {
    // given
    const arguments_ = ["--help"];

    // when
    const action = parseCliArguments(arguments_);

    // then
    expect(action).toEqual({ kind: "help" });
  });

  test("should return the version action without a model", () => {
    // given
    const arguments_ = ["--version"];

    // when
    const action = parseCliArguments(arguments_);

    // then
    expect(action).toEqual({ kind: "version" });
  });

  test("should reject a value option followed by another option", () => {
    // given
    const arguments_ = ["--model", "--base", "main"];

    // when
    const parseArguments = (): ReturnType<typeof parseCliArguments> => parseCliArguments(arguments_);

    // then
    expect(parseArguments).toThrowError(new CliInputError("--model requires a value"));
  });

  test("should reject a value option without a value", () => {
    // given
    const arguments_ = ["--model"];

    // when
    const parseArguments = (): ReturnType<typeof parseCliArguments> => parseCliArguments(arguments_);

    // then
    expect(parseArguments).toThrowError(new CliInputError("--model requires a value"));
  });

  test("should reject a review without a model", () => {
    // given
    const arguments_: readonly string[] = [];

    // when
    const parseArguments = (): ReturnType<typeof parseCliArguments> => parseCliArguments(arguments_);

    // then
    expect(parseArguments).toThrowError(new CliInputError("--model is required"));
  });

  test("should reject an unknown option", () => {
    // given
    const arguments_ = ["--unknown", "--model", MODEL];

    // when
    const parseArguments = (): ReturnType<typeof parseCliArguments> => parseCliArguments(arguments_);

    // then
    expect(parseArguments).toThrowError(new CliInputError("unknown option: --unknown"));
  });

  test("should reject a model without provider and model parts", () => {
    // given
    const arguments_ = ["--model", "model-only"];

    // when
    const parseArguments = (): ReturnType<typeof parseCliArguments> => parseCliArguments(arguments_);

    // then
    expect(parseArguments).toThrowError(/provider\/model format/);
  });

  test("should reject a non-GitHub review target", () => {
    // given
    const arguments_ = ["https://example.com/acme/repository/pull/12", "--model", MODEL];

    // when
    const parseArguments = (): ReturnType<typeof parseCliArguments> => parseCliArguments(arguments_);

    // then
    expect(parseArguments).toThrowError(/GitHub PR URL/);
  });

  test("should reject a GitHub pull request URL with query parameters", () => {
    // given
    const arguments_ = [`${PULL_REQUEST_URL}?diff=split`, "--model", MODEL];

    // when
    const parseArguments = (): ReturnType<typeof parseCliArguments> => parseCliArguments(arguments_);

    // then
    expect(parseArguments).toThrowError(/GitHub PR URL/);
  });

  test("should reject a base for a GitHub pull request review", () => {
    // given
    const arguments_ = [PULL_REQUEST_URL, "--model", MODEL, "--base", "main"];

    // when
    const parseArguments = (): ReturnType<typeof parseCliArguments> => parseCliArguments(arguments_);

    // then
    expect(parseArguments).toThrowError(/--base cannot/);
  });
});
