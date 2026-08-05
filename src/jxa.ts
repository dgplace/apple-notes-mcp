import { execFile } from "node:child_process";
import { SafeToolError } from "./errors.js";

interface SafeAutomationFailure {
  __appleNotesSafeError: true;
  code: string;
  message: string;
}

/**
 * Run a JXA (JavaScript for Automation) script via osascript.
 * Arguments are passed through argv — never interpolated into the script —
 * so user input cannot inject script code.
 */
export function runJxa<T>(script: string, args: string[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", script, "--", ...args],
      // Bound even malformed/unexpected automation output. Normal read
      // results are far smaller (the public MCP result ceiling is 64 KiB).
      { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error) {
          // stderr and Error.message can include script source, argv, or Notes
          // content. They are deliberately not copied into the returned error.
          reject(new Error("Apple Notes automation process failed"));
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
      }
    );
  });
}
