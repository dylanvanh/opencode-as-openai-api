import { execFile, spawn, type ChildProcess } from "node:child_process";

const DEFAULT_ACCEPTED_EXIT_CODES = [0] as const;
const COMMAND_NOT_FOUND_ERROR_CODE = "ENOENT";
const COMMAND_ABORT_TIMEOUT_5_SECONDS_MS = 5_000;

export interface RunCommandOptions {
  readonly acceptedExitCodes?: readonly number[];
  readonly workingDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly signal?: AbortSignal | undefined;
  readonly stdio?: "pipe" | "inherit";
}

export function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: RunCommandOptions = {},
): Promise<string> {
  if (executable.length === 0) {
    throw new TypeError("executable must not be empty");
  }
  if (options.signal?.aborted) {
    return Promise.reject(new Error(`${executable} was aborted`));
  }
  if (options.stdio === "inherit") {
    return runInheritedCommand(executable, arguments_, options);
  }

  return new Promise((resolveCommand, rejectCommand) => {
    const childProcess = execFile(
      executable,
      [...arguments_],
      {
        cwd: options.workingDirectory,
        env: options.environment,
        encoding: "utf8",
        maxBuffer: Number.POSITIVE_INFINITY,
      },
      (error, stdout, stderr) => {
        removeAbortHandler();
        if (options.signal?.aborted) {
          rejectCommand(new Error(`${executable} was aborted`));
          return;
        }

        const acceptedExitCodes = options.acceptedExitCodes ?? DEFAULT_ACCEPTED_EXIT_CODES;
        if (error === null || (typeof error.code === "number" && acceptedExitCodes.includes(error.code))) {
          resolveCommand(stdout);
          return;
        }

        const stderrMessage = stderr.trim();
        if (stderrMessage.length > 0) {
          rejectCommand(new Error(stderrMessage));
          return;
        }
        if (error.signal !== undefined && error.signal !== null) {
          rejectCommand(new Error(`${executable} terminated by ${error.signal}`));
          return;
        }
        if (typeof error.code === "number") {
          rejectCommand(new Error(`${executable} exited with code ${String(error.code)}`));
          return;
        }

        rejectCommand(createCommandSpawnError(executable, error));
      },
    );
    const removeAbortHandler = stopCommandOnAbort(childProcess, options.signal);
    childProcess.stdin?.once("error", (error: Error) => {
      rejectCommand(createCommandSpawnError(executable, error));
    });
    childProcess.stdin?.end(options.input);
  });
}

export function createCommandSpawnError(executable: string, error: Error): Error {
  if (hasErrorCode(error, COMMAND_NOT_FOUND_ERROR_CODE)) {
    return new Error(`${executable} is not installed or is not in PATH`);
  }

  return new Error(`${executable} failed to start: ${error.message}`);
}

function runInheritedCommand(
  executable: string,
  arguments_: readonly string[],
  options: RunCommandOptions,
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const childProcess = spawn(executable, arguments_, {
      cwd: options.workingDirectory,
      env: options.environment,
      stdio: [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    const removeAbortHandler = stopCommandOnAbort(childProcess, options.signal);

    childProcess.once("error", (error: Error) => {
      removeAbortHandler();
      rejectCommand(createCommandSpawnError(executable, error));
    });
    childProcess.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      removeAbortHandler();
      if (options.signal?.aborted) {
        rejectCommand(new Error(`${executable} was aborted`));
        return;
      }

      const acceptedExitCodes = options.acceptedExitCodes ?? DEFAULT_ACCEPTED_EXIT_CODES;
      if (exitCode !== null && acceptedExitCodes.includes(exitCode)) {
        resolveCommand("");
        return;
      }
      if (signal !== null) {
        rejectCommand(new Error(`${executable} terminated by ${signal}`));
        return;
      }

      rejectCommand(new Error(`${executable} exited with code ${String(exitCode)}`));
    });
    childProcess.stdin?.once("error", (error: Error) => {
      rejectCommand(createCommandSpawnError(executable, error));
    });
    childProcess.stdin?.end(options.input);
  });
}

function stopCommandOnAbort(childProcess: ChildProcess, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => undefined;

  let forceStopTimeout: NodeJS.Timeout | undefined;
  const stopCommand = (): void => {
    if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;

    childProcess.kill("SIGTERM");
    forceStopTimeout = setTimeout(() => childProcess.kill("SIGKILL"), COMMAND_ABORT_TIMEOUT_5_SECONDS_MS);
  };
  signal.addEventListener("abort", stopCommand, { once: true });
  if (signal.aborted) stopCommand();

  return () => {
    signal.removeEventListener("abort", stopCommand);
    if (forceStopTimeout) clearTimeout(forceStopTimeout);
  };
}

function hasErrorCode(error: Error, expectedCode: string): boolean {
  return "code" in error && error.code === expectedCode;
}
