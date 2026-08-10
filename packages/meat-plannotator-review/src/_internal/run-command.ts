import { spawn } from "node:child_process";

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

export class RunCommandError extends Error {
  readonly executable: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    executable: string,
    exitCode: number | null = null,
    signal: NodeJS.Signals | null = null,
  ) {
    super(message);
    this.name = "RunCommandError";
    this.executable = executable;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: RunCommandOptions = {},
): Promise<string> {
  if (executable.length === 0) {
    throw new TypeError("executable must not be empty");
  }
  if (options.stdio === "inherit" && options.input !== undefined) {
    throw new TypeError("input cannot be used with inherited stdio");
  }
  if (options.signal?.aborted) {
    return Promise.reject(new RunCommandError(`${executable} was aborted`, executable));
  }

  if (options.stdio === "inherit") {
    return runInheritedCommand(executable, arguments_, options);
  }

  return runPipedCommand(executable, arguments_, options);
}

export function createCommandSpawnError(executable: string, error: Error): RunCommandError {
  const message = hasErrorCode(error, COMMAND_NOT_FOUND_ERROR_CODE)
    ? `${executable} is not installed or is not in PATH`
    : `${executable} failed to start: ${error.message}`;
  return new RunCommandError(message, executable);
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
      stdio: "inherit",
    });
    const removeAbortHandler = stopCommandOnAbort(childProcess, options.signal);

    childProcess.once("error", (error: Error) => {
      removeAbortHandler();
      rejectCommand(createCommandSpawnError(executable, error));
    });
    childProcess.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      removeAbortHandler();
      if (options.signal?.aborted) {
        rejectCommand(new RunCommandError(`${executable} was aborted`, executable, exitCode, signal));
        return;
      }
      const acceptedExitCodes = options.acceptedExitCodes ?? DEFAULT_ACCEPTED_EXIT_CODES;
      if (exitCode !== null && acceptedExitCodes.includes(exitCode)) {
        resolveCommand("");
        return;
      }

      rejectCommand(createCommandExitError(executable, exitCode, signal));
    });
  });
}

function runPipedCommand(
  executable: string,
  arguments_: readonly string[],
  options: RunCommandOptions,
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const childProcess = spawn(executable, arguments_, {
      cwd: options.workingDirectory,
      env: options.environment,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const removeAbortHandler = stopCommandOnAbort(childProcess, options.signal);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const { stdin, stdout, stderr } = childProcess;
    if (stdout === null || stderr === null) {
      rejectCommand(new RunCommandError(`${executable} did not provide output streams`, executable));
      return;
    }

    stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    childProcess.once("error", (error: Error) => {
      removeAbortHandler();
      rejectCommand(createCommandSpawnError(executable, error));
    });
    childProcess.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      removeAbortHandler();
      if (options.signal?.aborted) {
        rejectCommand(new RunCommandError(`${executable} was aborted`, executable, exitCode, signal));
        return;
      }
      const acceptedExitCodes = options.acceptedExitCodes ?? DEFAULT_ACCEPTED_EXIT_CODES;
      if (exitCode !== null && acceptedExitCodes.includes(exitCode)) {
        resolveCommand(Buffer.concat(stdoutChunks).toString("utf8"));
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      rejectCommand(createCommandExitError(executable, exitCode, signal, stderr));
    });

    if (options.input !== undefined) {
      if (stdin === null) {
        rejectCommand(new RunCommandError(`${executable} did not provide an input stream`, executable));
        return;
      }
      stdin.on("error", (error: Error) => {
        rejectCommand(createCommandSpawnError(executable, error));
      });
      stdin.end(options.input);
    }
  });
}

function stopCommandOnAbort(childProcess: ReturnType<typeof spawn>, signal: AbortSignal | undefined): () => void {
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

function createCommandExitError(
  executable: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr = "",
): RunCommandError {
  if (stderr.length > 0) {
    return new RunCommandError(stderr, executable, exitCode, signal);
  }
  if (signal !== null) {
    return new RunCommandError(`${executable} terminated by ${signal}`, executable, exitCode, signal);
  }

  return new RunCommandError(`${executable} exited with code ${String(exitCode)}`, executable, exitCode);
}

function hasErrorCode(error: Error, expectedCode: string): boolean {
  return "code" in error && error.code === expectedCode;
}
