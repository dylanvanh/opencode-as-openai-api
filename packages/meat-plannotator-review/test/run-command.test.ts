import { expect, test } from "vitest";
import { RunCommandError, runCommand } from "../src/_internal/run-command.js";

const FAILURE_EXIT_CODE = 7;

test("should return command output", async () => {
  // given
  const EXPECTED_OUTPUT = "command output";
  const script = `process.stdout.write(${JSON.stringify(EXPECTED_OUTPUT)})`;

  // when
  const output = await runCommand(process.execPath, ["-e", script]);

  // then
  expect(output).toBe(EXPECTED_OUTPUT);
});

test("should write input to the command", async () => {
  // given
  const EXPECTED_OUTPUT = "command input";
  const script = "process.stdin.pipe(process.stdout)";

  // when
  const output = await runCommand(process.execPath, ["-e", script], { input: EXPECTED_OUTPUT });

  // then
  expect(output).toBe(EXPECTED_OUTPUT);
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
  expect(output).toBe(EXPECTED_OUTPUT);
});

test("should return a typed error for a failed command", async () => {
  // given
  const EXPECTED_ERROR = "command failed";
  const script = `process.stderr.write(${JSON.stringify(EXPECTED_ERROR)}); process.exitCode = ${FAILURE_EXIT_CODE}`;

  // when
  const commandPromise = runCommand(process.execPath, ["-e", script]);

  // then
  await expect(commandPromise).rejects.toMatchObject({
    name: "RunCommandError",
    message: EXPECTED_ERROR,
    executable: process.execPath,
    exitCode: FAILURE_EXIT_CODE,
    signal: null,
  } satisfies Partial<RunCommandError>);
});

test("should return a typed error when the executable is missing", async () => {
  // given
  const missingExecutable = "meat-plannotator-review-command-that-does-not-exist";

  // when
  const commandPromise = runCommand(missingExecutable, []);

  // then
  await expect(commandPromise).rejects.toMatchObject({
    name: "RunCommandError",
    message: `${missingExecutable} is not installed or is not in PATH`,
    executable: missingExecutable,
    exitCode: null,
    signal: null,
  } satisfies Partial<RunCommandError>);
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
  await expect(commandPromise).rejects.toMatchObject({
    name: "RunCommandError",
    message: `${process.execPath} was aborted`,
  } satisfies Partial<RunCommandError>);
});
