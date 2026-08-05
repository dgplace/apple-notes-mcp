import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JXA_MAX_BUFFER_BYTES,
  JXA_TIMEOUT_MS,
  minimalAutomationEnvironment,
  OSASCRIPT_PATH,
  runJxa,
  runJxaProcess,
  type JxaProcessExecutor,
} from "../src/jxa.js";
import { SafeToolError, safeErrorText } from "../src/errors.js";

function processError(message: string, properties: Partial<ExecFileException> = {}): ExecFileException {
  return Object.assign(new Error(message), properties) as ExecFileException;
}

test("process invocation fixes the executable, argv, bounds, and minimal environment", async () => {
  let captured:
    | {
        file: string;
        args: readonly string[];
        options: ExecFileOptionsWithStringEncoding;
      }
    | undefined;
  const executor: JxaProcessExecutor = (file, args, options, callback) => {
    captured = { file, args, options };
    callback(null, '{"ok":true}', "PRIVATE STDERR");
  };

  const result = await runJxaProcess<{ ok: boolean }>(executor, "SCRIPT_SECRET", ["ARGV_SECRET"], {
    HOME: "/Users/example",
    TMPDIR: "/private/tmp/example/",
    PATH: "/attacker",
    PRIVATE_TOKEN: "PRIVATE",
    DYLD_INSERT_LIBRARIES: "/attacker/library.dylib",
    NODE_OPTIONS: "--require=/attacker/module.js",
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(captured?.file, OSASCRIPT_PATH);
  assert.deepEqual(captured?.args, ["-l", "JavaScript", "-e", "SCRIPT_SECRET", "--", "ARGV_SECRET"]);
  assert.equal(captured?.options.timeout, JXA_TIMEOUT_MS);
  assert.equal(captured?.options.maxBuffer, JXA_MAX_BUFFER_BYTES);
  assert.equal(captured?.options.encoding, "utf8");
  assert.deepEqual(captured?.options.env, {
    HOME: "/Users/example",
    TMPDIR: "/private/tmp/example/",
    LANG: "en_US.UTF-8",
  });
});

test("minimal environment never inherits executable or secret-bearing variables", () => {
  assert.deepEqual(
    minimalAutomationEnvironment({
      HOME: "/Users/example",
      TMPDIR: "/tmp/example",
      PATH: "/fake",
      APPLE_NOTES_MODE: "read-write",
      PRIVATE_SECRET: "do not pass",
      DYLD_LIBRARY_PATH: "/fake",
      NODE_OPTIONS: "--inspect",
    }),
    { HOME: "/Users/example", TMPDIR: "/tmp/example", LANG: "en_US.UTF-8" },
  );
});

test("PATH manipulation cannot substitute another osascript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-notes-path-proof-"));
  const executable = join(directory, "osascript");
  const marker = join(directory, "fake-executed");
  const oldPath = process.env.PATH;
  try {
    await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\nprintf '%s' '{"source":"fake"}'\n`);
    await chmod(executable, 0o755);
    process.env.PATH = directory;

    const result = await runJxa<{ source: string; value: string }>(
      'function run(argv) { return JSON.stringify({source: "system", value: argv[0]}); }',
      ["argv-is-data"],
    );
    assert.deepEqual(result, { source: "system", value: "argv-is-data" });
    await assert.rejects(access(marker));
  } finally {
    process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("automation process errors never disclose stderr, script, argv, or bodies", async () => {
  const executor: JxaProcessExecutor = (_file, _args, _options, callback) => {
    callback(processError("COMPLETE PRIVATE NOTE BODY"), "", "SCRIPT_SECRET ARGV_SECRET");
  };
  await assert.rejects(runJxaProcess(executor, "SCRIPT_SECRET", ["ARGV_SECRET"]), (error: Error) => {
    assert.equal(error.message, "Apple Notes automation process failed");
    assert.doesNotMatch(error.message, /PRIVATE|SCRIPT_SECRET|ARGV_SECRET/);
    return true;
  });
});

test("timeout and output overflow are bounded and sanitized", async () => {
  const timeoutExecutor: JxaProcessExecutor = (_file, _args, options, callback) => {
    assert.equal(options.timeout, 30_000);
    callback(
      processError("PRIVATE TIMEOUT DETAIL", {
        code: "ETIMEDOUT",
        killed: true,
      }),
      "PRIVATE STDOUT",
      "PRIVATE STDERR",
    );
  };
  await assert.rejects(runJxaProcess(timeoutExecutor, "SCRIPT_SECRET", ["ARGV_SECRET"]), (error: Error) => {
    assert.equal(error.message, "Apple Notes automation exceeded its execution time limit");
    assert.doesNotMatch(error.message, /PRIVATE|SCRIPT|ARGV/);
    return true;
  });

  const overflowExecutor: JxaProcessExecutor = (_file, _args, options, callback) => {
    assert.equal(options.maxBuffer, 1024 * 1024);
    callback(
      processError("stdout maxBuffer length exceeded PRIVATE", {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
      "PRIVATE STDOUT",
      "PRIVATE STDERR",
    );
  };
  await assert.rejects(runJxaProcess(overflowExecutor, "SCRIPT_SECRET", ["ARGV_SECRET"]), (error: Error) => {
    assert.equal(error.message, "Apple Notes automation exceeded its output limit");
    assert.doesNotMatch(error.message, /PRIVATE|SCRIPT|ARGV/);
    return true;
  });
});

test("unexpected stdout is replaced while explicit safe domain errors survive", async () => {
  const invalidExecutor: JxaProcessExecutor = (_file, _args, _options, callback) => {
    callback(null, "PRIVATE BODY, NOT JSON", "");
  };
  await assert.rejects(runJxaProcess(invalidExecutor, "ignored"), /returned invalid output/);

  const safeExecutor: JxaProcessExecutor = (_file, _args, _options, callback) => {
    callback(null, '{"__appleNotesSafeError":true,"code":"NOTE_NOT_FOUND","message":"Note was not found."}', "");
  };
  await assert.rejects(runJxaProcess(safeExecutor, "ignored"), (error: Error) => {
    assert.ok(error instanceof SafeToolError);
    assert.equal(safeErrorText(error), "Error [NOTE_NOT_FOUND]: Note was not found.");
    return true;
  });
});
