import { execFile } from "node:child_process";

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
      { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        const out = stdout.trim();
        try {
          resolve(JSON.parse(out) as T);
        } catch {
          reject(new Error(`Unexpected osascript output: ${out.slice(0, 500)}`));
        }
      }
    );
  });
}
