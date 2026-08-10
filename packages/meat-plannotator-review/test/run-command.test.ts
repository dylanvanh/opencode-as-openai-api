import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/_internal/run-command.js";

const FAILURE_EXIT_CODE = 7;

test("should return command output", async () => {
  // given
  const EXPECTED_OUTPUT = "command output";
  const script = `process.stdout.write(${JSON.stringify(EXPECTED_OUTPUT)})`;

  // when
  const output = await runCommand(process.execPath, ["-e", script]);

  // then
  assert.equal(output, EXPECTED_OUTPUT);
});

test("should use the selected working directory and environment", async () => {
  // given
  const ENVIRONMENT_VARIABLE_NAME = "MEAT_PLANNOTATOR_REVIEW_TEST_VALUE";
  const EXPECTED_ENVIRONMENT_VALUE = "configured";
  const EXPECTED_OUTPUT = `${process.cwd()}\n${EXPECTED_ENVIRONMENT_VALUE}`;
  const script = `process.stdout.write(process.cwd() + "\\n" + process.env.${ENVIRONMENT_VARIABLE_NAME})`;

  // when
  const output = await runCommand(process.execPath, ["-e", script], {
    workingDirectory: process.cwd(),
    environment: { ...process.env, [ENVIRONMENT_VARIABLE_NAME]: EXPECTED_ENVIRONMENT_VALUE },
  });

  // then
  assert.equal(output, EXPECTED_OUTPUT);
});

test("should write input to the command", async () => {
  // given
  const EXPECTED_OUTPUT = "command input";
  const script = "process.stdin.pipe(process.stdout)";

  // when
  const output = await runCommand(process.execPath, ["-e", script], { input: EXPECTED_OUTPUT });

  // then
  assert.equal(output, EXPECTED_OUTPUT);
});

test("should write input to a command with inherited output", async () => {
  // given
  const EXPECTED_INPUT = "inherited command input";
  const script = `let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.exit(input === ${JSON.stringify(EXPECTED_INPUT)} ? 0 : 1))`;

  // when
  const output = await runCommand(process.execPath, ["-e", script], {
    input: EXPECTED_INPUT,
    stdio: "inherit",
  });

  // then
  assert.equal(output, "");
});

test("should return output for an accepted nonzero exit code", async () => {
  // given
  const EXPECTED_OUTPUT = "accepted output";
  const script = `process.stdout.write(${JSON.stringify(EXPECTED_OUTPUT)}); process.exitCode = ${FAILURE_EXIT_CODE}`;

  // when
  const output = await runCommand(process.execPath, ["-e", script], {
    acceptedExitCodes: [FAILURE_EXIT_CODE],
  });

  // then
  assert.equal(output, EXPECTED_OUTPUT);
});

test("should return stderr for a failed command", async () => {
  // given
  const EXPECTED_ERROR = "command failed";
  const script = `process.stderr.write(${JSON.stringify(EXPECTED_ERROR)}); process.exitCode = ${FAILURE_EXIT_CODE}`;

  // when
  const commandPromise = runCommand(process.execPath, ["-e", script]);

  // then
  await assert.rejects(commandPromise, new Error(EXPECTED_ERROR));
});

test("should return an error when the executable is missing", async () => {
  // given
  const missingExecutable = "meat-plannotator-review-command-that-does-not-exist";

  // when
  const commandPromise = runCommand(missingExecutable, []);

  // then
  await assert.rejects(
    commandPromise,
    new Error(`${missingExecutable} is not installed or is not in PATH`),
  );
});

test("should terminate a command when its signal is aborted", async () => {
  // given
  const abortController = new AbortController();
  const script = "process.on('SIGTERM', () => process.exit(0)); setInterval(() => undefined, 1_000)";

  // when
  const commandPromise = runCommand(process.execPath, ["-e", script], { signal: abortController.signal });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  abortController.abort();

  // then
  await assert.rejects(commandPromise, new Error(`${process.execPath} was aborted`));
});
