#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runReview } from "./review.js";

const VERSION = "0.1.0";

function usage() {
  return `meat-plannotator-review ${VERSION}\n\nUsage:\n  meat-plannotator-review [GitHub PR URL] --model <provider/model> [options]\n\nOptions:\n  --model <provider/model>  OpenCode model used by Meat\n  --variant <id>            Fixed OpenCode model variant\n  --directory <path>        OpenCode configuration directory\n  --base <ref>              Local base branch (auto-detected by default)\n  --help                    Show help\n  --version                 Show version`;
}

export function parseArgs(argv) {
  const options = {};
  const valueOptions = ["--model", "--variant", "--directory", "--base"];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") options.help = true;
    else if (arg === "--version") options.version = true;
    else if (valueOptions.includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else if (!arg.startsWith("-") && !options.prUrl) options.prUrl = validatePrUrl(arg);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.help && !options.version) {
    if (!options.model) throw new Error("--model is required");
    if (!/^[^/]+\/.+/.test(options.model)) throw new Error("--model must use provider/model format");
    if (options.prUrl && options.base) throw new Error("--base cannot be combined with a GitHub PR URL");
    if (options.directory) options.directory = resolve(options.directory);
  }
  return options;
}

function validatePrUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("review target must be a GitHub PR URL"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)) {
    throw new Error("review target must be a GitHub PR URL");
  }
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return console.log(usage());
  if (options.version) return console.log(VERSION);
  return runReview(options);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`meat-plannotator-review: ${error.message}`); process.exitCode = 1; });
}
