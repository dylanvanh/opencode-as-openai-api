import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  FAKE_OPENCODE_SOURCE,
  installNodeCommand,
  pathWithCommandDirectory,
} from "../../../test/e2e-helpers.mjs";

const BASE_BRANCH = "main";
const MODEL = "test/model";
const TRACKED_FILE_NAME = "tracked.txt";
const INITIAL_CONTENT = "before\n";
const UPDATED_CONTENT = "after\n";
const PROCESS_TIMEOUT_15_SECONDS_MS = 15_000;
const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const GATEWAY_CLI_PATH = fileURLToPath(new URL("../../opencode-as-openai-api/dist/cli.js", import.meta.url));

test("should review a local change through the packaged CLI", async () => {
  // given
  const testDirectory = await mkdtemp(join(tmpdir(), "meat-review-e2e-"));
  const commandDirectory = join(testDirectory, "bin");
  const repositoryDirectory = join(testDirectory, "repository");
  const capturedPatchPath = join(testDirectory, "plannotator.patch");
  await mkdir(commandDirectory);
  await mkdir(repositoryDirectory);
  await createRepository(repositoryDirectory);
  await installCommands(commandDirectory);

  try {
    // when
    const result = spawnSync(process.execPath, [CLI_PATH, "--model", MODEL, "--base", BASE_BRANCH], {
      cwd: repositoryDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: pathWithCommandDirectory(commandDirectory),
        PLANNOTATOR_CAPTURE_FILE: capturedPatchPath,
      },
      timeout: PROCESS_TIMEOUT_15_SECONDS_MS,
    });

    // then
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const capturedPatch = await readFile(capturedPatchPath, "utf8");
    assert.match(capturedPatch, new RegExp(`diff --git a/${TRACKED_FILE_NAME} b/${TRACKED_FILE_NAME}`));
    assert.ok(capturedPatch.includes(`+${UPDATED_CONTENT.trim()}`));
    assert.match(result.stderr, /Reducing the diff with Meat/);
    assert.match(result.stderr, /Opening Plannotator/);
  } finally {
    await rm(testDirectory, { recursive: true, force: true });
  }
});

async function installCommands(commandDirectory: string): Promise<void> {
  await Promise.all([
    installNodeCommand(commandDirectory, "opencode", FAKE_OPENCODE_SOURCE),
    installNodeCommand(commandDirectory, "opencode-as-openai-api", gatewayCommandSource()),
    installNodeCommand(commandDirectory, "meat", FAKE_MEAT_SOURCE),
    installNodeCommand(commandDirectory, "plannotator", FAKE_PLANNOTATOR_SOURCE),
  ]);
}

function gatewayCommandSource(): string {
  return `
import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(GATEWAY_CLI_PATH)}, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.once("SIGTERM", () => child.kill("SIGTERM"));
process.once("SIGINT", () => child.kill("SIGINT"));
child.once("exit", exitCode => process.exit(exitCode ?? 1));
`;
}

const FAKE_MEAT_SOURCE = `
let sourcePatch = "";
for await (const chunk of process.stdin) sourcePatch += chunk;
const response = await fetch(process.env.OPENAI_BASE_URL + "/responses", {
  method: "POST",
  headers: {
    authorization: "Bearer " + process.env.OPENAI_API_KEY,
    "content-type": "application/json",
  },
  body: JSON.stringify({ model: process.env.MEAT_MODEL, input: "Reduce this diff" }),
});
const body = await response.json();
if (!response.ok || body.output?.[0]?.content?.[0]?.text !== "Hello from fake OpenCode") {
  throw new Error("gateway request failed");
}
process.stdout.write(JSON.stringify({ smart_diff: sourcePatch }));
`;

const FAKE_PLANNOTATOR_SOURCE = `
import { writeFile } from "node:fs/promises";
let patch = "";
for await (const chunk of process.stdin) patch += chunk;
await writeFile(process.env.PLANNOTATOR_CAPTURE_FILE, patch);
`;

async function createRepository(repositoryDirectory: string): Promise<void> {
  runGit(repositoryDirectory, ["init", `--initial-branch=${BASE_BRANCH}`]);
  runGit(repositoryDirectory, ["config", "user.email", "test@example.com"]);
  runGit(repositoryDirectory, ["config", "user.name", "Test"]);
  await writeFile(join(repositoryDirectory, TRACKED_FILE_NAME), INITIAL_CONTENT);
  runGit(repositoryDirectory, ["add", TRACKED_FILE_NAME]);
  runGit(repositoryDirectory, ["commit", "-m", "initial"]);
  await writeFile(join(repositoryDirectory, TRACKED_FILE_NAME), UPDATED_CONTENT);
}

function runGit(workingDirectory: string, arguments_: string[]): void {
  execFileSync("git", arguments_, { cwd: workingDirectory, stdio: "ignore" });
}
