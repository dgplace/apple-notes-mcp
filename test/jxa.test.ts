import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJxa } from "../src/jxa.js";
import { SafeToolError, safeErrorText } from "../src/errors.js";

async function withFakeOsascript(
  program: string,
  operation: () => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "apple-notes-jxa-error-"));
  const executable = join(directory, "osascript");
  const oldPath = process.env.PATH;
  try {
    await writeFile(executable, `#!/bin/sh\n${program}\n`);
    await chmod(executable, 0o755);
    process.env.PATH = directory;
    await operation();
  } finally {
    process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
}

test("automation process errors never disclose stderr, script, argv, or bodies", async () => {
  const secret = "COMPLETE PRIVATE NOTE BODY";
  await withFakeOsascript(`echo '${secret}' >&2; exit 1`, async () => {
    await assert.rejects(
      runJxa("SCRIPT_SECRET", ["ARGV_SECRET"]),
      (error: Error) => {
        assert.equal(error.message, "Apple Notes automation process failed");
        assert.doesNotMatch(error.message, /PRIVATE|SCRIPT_SECRET|ARGV_SECRET/);
        return true;
      }
    );
  });
});

test("unexpected stdout is replaced while explicit safe domain errors survive", async () => {
  await withFakeOsascript("printf 'PRIVATE BODY, NOT JSON'", async () => {
    await assert.rejects(runJxa("ignored"), /returned invalid output/);
  });

  await withFakeOsascript(
    `printf '%s' '{"__appleNotesSafeError":true,"code":"NOTE_NOT_FOUND","message":"Note was not found."}'`,
    async () => {
      await assert.rejects(runJxa("ignored"), (error: Error) => {
        assert.ok(error instanceof SafeToolError);
        assert.equal(safeErrorText(error), "Error [NOTE_NOT_FOUND]: Note was not found.");
        return true;
      });
    }
  );
});
