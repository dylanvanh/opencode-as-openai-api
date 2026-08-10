#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runReview, type ReviewOptions } from "./review.js";

const VERSION = "0.1.0";
const MODEL_NAME_PATTERN = /^[^/\s]+\/\S+$/;
const GITHUB_PULL_REQUEST_PATH_PATTERN = /^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9]\d*\/?$/;
const GITHUB_HOSTNAME = "github.com";

export type CliAction =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "review"; readonly options: ReviewOptions };

export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliInputError";
  }
}

export function parseCliArguments(arguments_: readonly string[]): CliAction {
  const parsedArguments: MutableCliOptions = {};
  let argumentIndex = 0;

  while (argumentIndex < arguments_.length) {
    const argument = arguments_[argumentIndex];
    if (argument === undefined) {
      throw new CliInputError("Could not read a CLI argument");
    }

    if (argument === "--help") {
      parsedArguments.help = true;
      argumentIndex += 1;
      continue;
    }
    if (argument === "--version") {
      parsedArguments.version = true;
      argumentIndex += 1;
      continue;
    }
    if (argument === "--model") {
      parsedArguments.model = readOptionValue(arguments_, argumentIndex, argument);
      argumentIndex += 2;
      continue;
    }
    if (argument === "--variant") {
      parsedArguments.variant = readOptionValue(arguments_, argumentIndex, argument);
      argumentIndex += 2;
      continue;
    }
    if (argument === "--directory") {
      parsedArguments.directory = readOptionValue(arguments_, argumentIndex, argument);
      argumentIndex += 2;
      continue;
    }
    if (argument === "--base") {
      parsedArguments.base = readOptionValue(arguments_, argumentIndex, argument);
      argumentIndex += 2;
      continue;
    }
    if (!argument.startsWith("-") && parsedArguments.prUrl === undefined) {
      parsedArguments.prUrl = validateGitHubPullRequestUrl(argument);
      argumentIndex += 1;
      continue;
    }

    throw new CliInputError(`unknown option: ${argument}`);
  }

  if (parsedArguments.help === true) {
    return { kind: "help" };
  }
  if (parsedArguments.version === true) {
    return { kind: "version" };
  }

  return createReviewAction(parsedArguments);
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

interface MutableCliOptions {
  help?: boolean;
  version?: boolean;
  model?: string;
  variant?: string;
  directory?: string;
  base?: string;
  prUrl?: string;
}

function usage(): string {
  return `meat-plannotator-review ${VERSION}\n\nUsage:\n  meat-plannotator-review [GitHub PR URL] --model <provider/model> [options]\n\nOptions:\n  --model <provider/model>  OpenCode model used by Meat\n  --variant <id>            Fixed OpenCode model variant\n  --directory <path>        OpenCode configuration directory\n  --base <ref>              Local base branch (auto-detected by default)\n  --help                    Show help\n  --version                 Show version`;
}

function readOptionValue(
  arguments_: readonly string[],
  optionIndex: number,
  optionName: string,
): string {
  const optionValue = arguments_[optionIndex + 1];
  if (optionValue === undefined || optionValue.length === 0 || optionValue.startsWith("-")) {
    throw new CliInputError(`${optionName} requires a value`);
  }

  return optionValue;
}

function createReviewAction(parsedArguments: MutableCliOptions): CliAction {
  const model = parsedArguments.model;
  if (model === undefined) {
    throw new CliInputError("--model is required");
  }
  if (!MODEL_NAME_PATTERN.test(model)) {
    throw new CliInputError("--model must use provider/model format");
  }
  if (parsedArguments.prUrl !== undefined && parsedArguments.base !== undefined) {
    throw new CliInputError("--base cannot be combined with a GitHub PR URL");
  }

  return {
    kind: "review",
    options: {
      openCodeModel: model,
      ...(parsedArguments.variant === undefined ? {} : { openCodeVariant: parsedArguments.variant }),
      ...(parsedArguments.directory === undefined
        ? {}
        : { openCodeDirectory: resolve(parsedArguments.directory) }),
      ...(parsedArguments.base === undefined ? {} : { baseRef: parsedArguments.base }),
      ...(parsedArguments.prUrl === undefined ? {} : { pullRequestUrl: parsedArguments.prUrl }),
    },
  };
}

function validateGitHubPullRequestUrl(value: string): string {
  let pullRequestUrl: URL;
  try {
    pullRequestUrl = new URL(value);
  } catch {
    throw new CliInputError("review target must be a GitHub PR URL");
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
    throw new CliInputError("review target must be a GitHub PR URL");
  }

  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`meat-plannotator-review: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
