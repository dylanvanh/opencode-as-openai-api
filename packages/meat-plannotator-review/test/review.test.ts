import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseMeatResult, readLocalBranchPatch } from "../src/review.js";

const BASE_BRANCH = "main";
const TRACKED_FILE_NAME = "tracked.txt";
const UNTRACKED_FILE_NAME = "untracked.txt";
const INITIAL_CONTENT = "before\n";
const UPDATED_CONTENT = "after\n";
const UNTRACKED_CONTENT = "new\n";
const MALFORMED_MEAT_RESULTS = [
  { shape: "null", output: "null" },
  { shape: "array", output: "[]" },
  { shape: "missing smart_diff", output: "{}" },
  { shape: "non-string smart_diff", output: JSON.stringify({ smart_diff: 1 }) },
] as const;

test("should extract the Meat reading diff", () => {
  // given
  const EXPECTED_PATCH = "diff --git a/a.js b/a.js\n";
  const output = JSON.stringify({ smart_diff: EXPECTED_PATCH });

  // when
  const patch = parseMeatResult(output);

  // then
  assert.equal(patch, EXPECTED_PATCH);
});

test("should reject invalid Meat JSON", () => {
  // given
  const output = "not json";

  // when
  const parseResult = (): string => parseMeatResult(output);

  // then
  assert.throws(parseResult, new Error("Meat returned invalid JSON"));
});

for (const malformedResult of MALFORMED_MEAT_RESULTS) {
  test(`should reject a malformed Meat result with ${malformedResult.shape}`, () => {
    // given
    const meatOutput = malformedResult.output;

    // when
    const parseResult = (): string => parseMeatResult(meatOutput);

    // then
    assert.throws(parseResult, new Error("Meat did not return smart_diff"));
  });
}

test("should include changes committed after the base branch", async () => {
  // given
  const repository = await createRepository();
  try {
    runGit(repository, ["checkout", "-b", "feature"]);
    await writeFile(join(repository, TRACKED_FILE_NAME), UPDATED_CONTENT);
    runGit(repository, ["add", TRACKED_FILE_NAME]);
    runGit(repository, ["commit", "-m", "update tracked file"]);

    // when
    const patch = await readLocalBranchPatch(BASE_BRANCH, repository);

    // then
    assert.match(patch, new RegExp(`diff --git a/${TRACKED_FILE_NAME} b/${TRACKED_FILE_NAME}`));
    assert.ok(patch.includes(`+${UPDATED_CONTENT.trim()}`));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("should include staged changes", async () => {
  // given
  const repository = await createRepository();
  try {
    await writeFile(join(repository, TRACKED_FILE_NAME), UPDATED_CONTENT);
    runGit(repository, ["add", TRACKED_FILE_NAME]);

    // when
    const patch = await readLocalBranchPatch(BASE_BRANCH, repository);

    // then
    assert.match(patch, new RegExp(`diff --git a/${TRACKED_FILE_NAME} b/${TRACKED_FILE_NAME}`));
    assert.ok(patch.includes(`+${UPDATED_CONTENT.trim()}`));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("should include unstaged changes", async () => {
  // given
  const repository = await createRepository();
  try {
    await writeFile(join(repository, TRACKED_FILE_NAME), UPDATED_CONTENT);

    // when
    const patch = await readLocalBranchPatch(BASE_BRANCH, repository);

    // then
    assert.match(patch, new RegExp(`diff --git a/${TRACKED_FILE_NAME} b/${TRACKED_FILE_NAME}`));
    assert.ok(patch.includes(`+${UPDATED_CONTENT.trim()}`));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("should include untracked files", async () => {
  // given
  const repository = await createRepository();
  try {
    await writeFile(join(repository, UNTRACKED_FILE_NAME), UNTRACKED_CONTENT);

    // when
    const patch = await readLocalBranchPatch(BASE_BRANCH, repository);

    // then
    assert.match(patch, new RegExp(`diff --git a/${UNTRACKED_FILE_NAME} b/${UNTRACKED_FILE_NAME}`));
    assert.ok(patch.includes(`+${UNTRACKED_CONTENT.trim()}`));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "meat-plannotator-review-test-"));
  runGit(repository, ["init", `--initial-branch=${BASE_BRANCH}`]);
  runGit(repository, ["config", "user.email", "test@example.com"]);
  runGit(repository, ["config", "user.name", "Test"]);
  await writeFile(join(repository, TRACKED_FILE_NAME), INITIAL_CONTENT);
  runGit(repository, ["add", TRACKED_FILE_NAME]);
  runGit(repository, ["commit", "-m", "initial"]);
  return repository;
}

function runGit(currentDirectory: string, arguments_: string[]): void {
  execFileSync("git", arguments_, { cwd: currentDirectory, stdio: "ignore" });
}
