import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs } from "../src/cli.js";
import { parseMeatResult, readLocalBranchPatch } from "../src/review.js";

test("parses the public CLI options", () => {
  assert.deepEqual(parseArgs(["--model", "provider/model", "--port", "0", "--max-concurrency", "2", "--tunnel", "quick"]), {
    model: "provider/model", port: 0, maxConcurrency: 2, tunnel: "quick",
  });
  assert.throws(() => parseArgs([]), /--model is required/);
  assert.throws(() => parseArgs(["--model", "invalid"]), /provider\/model/);
});

test("parses local and GitHub PR review options", () => {
  // given
  const localArgs = ["--model", "provider/model", "--base", "origin/trunk"];
  const prArgs = ["https://github.com/acme/repo/pull/12", "--model", "provider/model"];

  // when
  const localOptions = parseArgs(localArgs, true);
  const prOptions = parseArgs(prArgs, true);

  // then
  assert.equal(localOptions.base, "origin/trunk");
  assert.equal(localOptions.port, 0);
  assert.equal(prOptions.prUrl, prArgs[0]);
  assert.throws(() => parseArgs(["https://example.com/not-a-pr", "--model", "provider/model"], true), /GitHub PR URL/);
  assert.throws(() => parseArgs([prArgs[0], "--model", "provider/model", "--base", "main"], true), /--base cannot/);
});

test("extracts the Meat reading diff", () => {
  // given
  const expectedPatch = "diff --git a/a.js b/a.js\n";
  const output = JSON.stringify({ smart_diff: expectedPatch });

  // when
  const patch = parseMeatResult(output);

  // then
  assert.equal(patch, expectedPatch);
  assert.throws(() => parseMeatResult("not json"), /invalid JSON/);
});

test("reads tracked and untracked changes since the base branch", async () => {
  // given
  const repository = await mkdtemp(join(tmpdir(), "opencode-review-test-"));
  const trackedPath = join(repository, "tracked.txt");
  const untrackedPath = join(repository, "untracked.txt");
  try {
    runGit(repository, ["init", "--initial-branch=main"]);
    runGit(repository, ["config", "user.email", "test@example.com"]);
    runGit(repository, ["config", "user.name", "Test"]);
    await writeFile(trackedPath, "before\n");
    runGit(repository, ["add", "tracked.txt"]);
    runGit(repository, ["commit", "-m", "initial"]);
    await writeFile(trackedPath, "after\n");
    await writeFile(untrackedPath, "new\n");

    // when
    const patch = await readLocalBranchPatch("main", repository);

    // then
    assert.match(patch, /diff --git a\/tracked\.txt b\/tracked\.txt/);
    assert.match(patch, /diff --git a\/untracked\.txt b\/untracked\.txt/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

function runGit(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
