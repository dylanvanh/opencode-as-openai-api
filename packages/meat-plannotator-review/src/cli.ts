#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runReview, type ReviewOptions } from "./review.js";

const VERSION = "0.1.0";
const MODEL_NAME_PATTERN = /^[^/\s]+\/\S+$/;
const GITHUB_PULL_REQUEST_PATH_PATTERN = /^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9]\d*\/?$/;
const GITHUB_HOSTNAME = "github.com";

export type CliAction =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "review"; readonly options: ReviewOptions };

export function parseCliArguments(arguments_: readonly string[]): CliAction {
  const parsedArguments = parseArgs({
    args: [...arguments_],
    options: {
      help: { type: "boolean" },
      version: { type: "boolean" },
      model: { type: "string" },
      variant: { type: "string" },
      directory: { type: "string" },
      base: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const { values, positionals } = parsedArguments;
  for (const [optionName, optionValue] of [
    ["--model", values.model],
    ["--variant", values.variant],
    ["--directory", values.directory],
    ["--base", values.base],
  ] as const) {
    if (optionValue !== undefined && (optionValue.length === 0 || optionValue.startsWith("-"))) {
      throw new Error(`${optionName} requires a value`);
    }
  }
  if (positionals.length > 1) {
    throw new Error(`unknown option: ${String(positionals[1])}`);
  }
  const pullRequestUrl = positionals[0] === undefined
    ? undefined
    : validateGitHubPullRequestUrl(positionals[0]);

  if (values.help === true) {
    return { kind: "help" };
  }
  if (values.version === true) {
    return { kind: "version" };
  }

  const model = values.model;
  if (model === undefined) {
    throw new Error("--model is required");
  }
  if (!MODEL_NAME_PATTERN.test(model)) {
    throw new Error("--model must use provider/model format");
  }
  if (pullRequestUrl !== undefined && values.base !== undefined) {
    throw new Error("--base cannot be combined with a GitHub PR URL");
  }

  return {
    kind: "review",
    options: {
      openCodeModel: model,
      ...(values.variant === undefined ? {} : { openCodeVariant: values.variant }),
      ...(values.directory === undefined ? {} : { openCodeDirectory: values.directory }),
      ...(values.base === undefined ? {} : { baseRef: values.base }),
      ...(pullRequestUrl === undefined ? {} : { pullRequestUrl }),
    },
  };
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const action = parseCliArguments(arguments_);

  if (action.kind === "help") {
    console.log(usage());
    return;
  }
  if (action.kind === "version") {
    console.log(VERSION);
    return;
  }

  await runReview(action.options);
}

function usage(): string {
  return `meat-plannotator-review ${VERSION}\n\nUsage:\n  meat-plannotator-review [GitHub PR URL] --model <provider/model> [options]\n\nOptions:\n  --model <provider/model>  OpenCode model used by Meat\n  --variant <id>            Fixed OpenCode model variant\n  --directory <path>        OpenCode configuration directory\n  --base <ref>              Local base branch (auto-detected by default)\n  --help                    Show help\n  --version                 Show version`;
}

function validateGitHubPullRequestUrl(value: string): string {
  let pullRequestUrl: URL;
  try {
    pullRequestUrl = new URL(value);
  } catch {
    throw new Error("review target must be a GitHub PR URL");
  }

  const isValidUrl = pullRequestUrl.protocol === "https:"
    && pullRequestUrl.hostname === GITHUB_HOSTNAME
    && pullRequestUrl.port.length === 0
    && pullRequestUrl.username.length === 0
    && pullRequestUrl.password.length === 0
    && pullRequestUrl.search.length === 0
    && pullRequestUrl.hash.length === 0
    && GITHUB_PULL_REQUEST_PATH_PATTERN.test(pullRequestUrl.pathname);
  if (!isValidUrl) {
    throw new Error("review target must be a GitHub PR URL");
  }

  return value;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`meat-plannotator-review: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
