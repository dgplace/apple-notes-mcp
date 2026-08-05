import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { SafeToolError } from "./errors.js";

export const OSASCRIPT_PATH = "/usr/bin/osascript" as const;
export const JXA_TIMEOUT_MS = 30_000;
export const JXA_MAX_BUFFER_BYTES = 1024 * 1024;

export interface JxaRunner {
  <T>(script: string, args?: string[]): Promise<T>;
}

export type JxaProcessExecutor = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

interface SafeAutomationFailure {
  __appleNotesSafeError: true;
  code: string;
  message: string;
}

/**
 * Construct the complete osascript environment instead of inheriting the
 * server environment. HOME is needed by macOS frameworks for the current
 * user's preferences/Automation identity, and TMPDIR is the user's protected
 * temporary directory. Locale is fixed for deterministic UTF-8 JSON. No PATH,
 * dynamic-loader setting, Node option, MCP configuration, or secret is passed.
 */
export function minimalAutomationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: "en_US.UTF-8" };
  if (source.HOME) env.HOME = source.HOME;
  if (source.TMPDIR) env.TMPDIR = source.TMPDIR;
  return env;
}

function automationFailureMessage(error: ExecFileException): string {
  if (error.code === "ETIMEDOUT" || error.killed) {
    return "Apple Notes automation exceeded its execution time limit";
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "Apple Notes automation exceeded its output limit";
  }
  return "Apple Notes automation process failed";
}

const systemExecFile: JxaProcessExecutor = (file, args, options, callback) => {
  execFile(file, [...args], options, callback);
};

/**
 * Process seam used by unit tests. The executable is deliberately not an
 * argument: every executor receives the same absolute system path.
 */
export function runJxaProcess<T>(
  executor: JxaProcessExecutor,
  script: string,
  args: string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  return new Promise((resolve, reject) => {
    executor(
      OSASCRIPT_PATH,
      ["-l", "JavaScript", "-e", script, "--", ...args],
      {
        encoding: "utf8",
        env: minimalAutomationEnvironment(environment),
        maxBuffer: JXA_MAX_BUFFER_BYTES,
        timeout: JXA_TIMEOUT_MS,
      },
      (error, stdout, _stderr) => {
        if (error) {
          // Error.message, stderr, script, and argv may contain note content.
          reject(new Error(automationFailureMessage(error)));
          return;
        }
        const out = stdout.trim();
        try {
          const parsed = JSON.parse(out) as T | SafeAutomationFailure;
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "__appleNotesSafeError" in parsed &&
            parsed.__appleNotesSafeError === true
          ) {
            reject(new SafeToolError(parsed.code, parsed.message));
            return;
          }
          resolve(parsed as T);
        } catch {
          // Never echo unexpected stdout: it can contain a complete note body.
          reject(new Error("Apple Notes automation returned invalid output"));
        }
      },
    );
  });
}

/**
 * Run JXA through Apple's fixed system executable. User values flow only
 * through argv and can never alter the executable or script text.
 */
export function runJxa<T>(script: string, args: string[] = []): Promise<T> {
  return runJxaProcess<T>(systemExecFile, script, args);
}
