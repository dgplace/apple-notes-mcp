import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { runJxa } from "../src/jxa.js";
import { cleanupIntegrationNoteOnce } from "./integration-cleanup.js";

// Full lifecycle against the real Notes.app. This is deliberately opt-in and
// requires an explicitly selected dedicated test account. Each run creates a
// collision-resistant folder and note, and trashes only the exact note ID it
// created. Notes automation has no safe recoverable folder-removal primitive,
// so the empty test folder is reported for manual cleanup instead of calling
// Notes.delete.
//
//   APPLE_NOTES_IT_ACCOUNT_ID='x-coredata://.../ICAccount/...' \
//   APPLE_NOTES_TRASH_FOLDER_IDS='x-coredata://.../ICFolder/...' \
//   npm run test:integration
const enabled = process.env.APPLE_NOTES_IT === "1";

interface RpcResponse {
  id?: number;
  result?: {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  error?: { code: number; message: string };
}

interface ToolResponse {
  isError: boolean;
  text: string;
  payload?: Record<string, unknown>;
}

interface FixtureFolder {
  ok: boolean;
  error?: string;
  id?: string;
  name?: string;
  account?: { id: string; name: string };
}

const CREATE_FIXTURE_FOLDER_JXA = `
  function run(argv) {
    const Notes = Application("Notes");
    const accountId = argv[0];
    const folderName = argv[1];
    const accounts = Notes.accounts;
    const accountIds = accounts.id();
    const accountNames = accounts.name();
    const indexes = [];
    for (let i = 0; i < accountIds.length; i++) {
      if (accountIds[i] === accountId) indexes.push(i);
    }
    if (indexes.length !== 1) {
      return JSON.stringify({
        ok: false,
        error: "APPLE_NOTES_IT_ACCOUNT_ID must resolve to exactly one Notes account"
      });
    }
    const index = indexes[0];
    const folder = Notes.Folder({ name: folderName });
    accounts[index].folders.push(folder);
    return JSON.stringify({
      ok: true,
      id: folder.id(),
      name: folder.name(),
      account: { id: accountIds[index], name: accountNames[index] }
    });
  }
`;

const FIND_FIXTURE_FOLDER_JXA = `
  function run(argv) {
    const Notes = Application("Notes");
    const accountId = argv[0];
    const folderName = argv[1];
    const accounts = Notes.accounts;
    const accountIds = accounts.id();
    const accountNames = accounts.name();
    const found = [];
    for (let i = 0; i < accountIds.length; i++) {
      if (accountIds[i] !== accountId) continue;
      const folderIds = accounts[i].folders.id();
      const folderNames = accounts[i].folders.name();
      for (let j = 0; j < folderIds.length; j++) {
        if (folderNames[j] === folderName) {
          found.push({
            id: folderIds[j],
            name: folderNames[j],
            account: { id: accountIds[i], name: accountNames[i] }
          });
        }
      }
    }
    return JSON.stringify({ found: found });
  }
`;

function startServer() {
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<
    number,
    {
      resolve: (response: RpcResponse) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_192);
  });
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as RpcResponse;
    if (msg.id !== undefined) {
      const waiter = pending.get(msg.id);
      if (waiter) {
        clearTimeout(waiter.timeout);
        pending.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  });
  proc.once("exit", (code, signal) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(
        new Error(`Integration server exited before responding (code=${code}, signal=${signal}): ${stderr}`),
      );
    }
    pending.clear();
  });

  let nextId = 1;
  const request = (method: string, params: unknown): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for integration RPC method ${method}`));
      }, 35_000);
      pending.set(id, { resolve, reject, timeout });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method: string) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);

  return { proc, request, notify, stderr: () => stderr };
}

function parseToolResponse(response: RpcResponse): ToolResponse {
  if (response.error) {
    return {
      isError: true,
      text: `RPC error ${response.error.code}: ${response.error.message}`,
    };
  }
  const text = response.result?.content[0]?.text ?? "missing tool result";
  if (response.result?.isError) return { isError: true, text };
  try {
    return {
      isError: false,
      text,
      payload: JSON.parse(text) as Record<string, unknown>,
    };
  } catch {
    return { isError: true, text: "Tool returned invalid JSON" };
  }
}

function expandedSummaryId(payload: Record<string, unknown>, note: Record<string, unknown>): string {
  const id = String(note.id ?? "");
  const prefix = typeof payload.idPrefix === "string" ? payload.idPrefix : "";
  return id.startsWith("x-coredata://") ? id : prefix + id;
}

test("isolated lifecycle: create → search → update → get → trash", { skip: !enabled }, async () => {
  const accountId = process.env.APPLE_NOTES_IT_ACCOUNT_ID;
  assert.match(
    accountId ?? "",
    /^x-coredata:\/\/.+\/ICAccount\/.+$/,
    "Set APPLE_NOTES_IT_ACCOUNT_ID to the full stable ID of an explicitly dedicated test account",
  );
  assert.ok(
    process.env.APPLE_NOTES_TRASH_FOLDER_IDS,
    "Set APPLE_NOTES_TRASH_FOLDER_IDS to exactly one stable trash folder ID for every Notes account",
  );

  const nonce = randomUUID();
  const marker = `apple-notes-mcp-it-marker-${nonce}`;
  const title = `apple-notes-mcp-it-note-${nonce}`;
  const folderName = `apple-notes-mcp-it-folder-${nonce}`;
  let fixtureFolder: FixtureFolder;
  try {
    fixtureFolder = await runJxa<FixtureFolder>(CREATE_FIXTURE_FOLDER_JXA, [accountId!, folderName]);
  } catch (createError) {
    // The create response can be lost after Notes accepted the folder. Resolve
    // the collision-resistant name in the exact account before deciding; never
    // retry folder creation blindly.
    const discovery = await runJxa<{ found: FixtureFolder[] }>(FIND_FIXTURE_FOLDER_JXA, [accountId!, folderName]);
    if (discovery.found.length !== 1) throw createError;
    fixtureFolder = { ...discovery.found[0], ok: true };
  }
  assert.equal(fixtureFolder.ok, true, fixtureFolder.error);
  assert.match(fixtureFolder.id ?? "", /^x-coredata:\/\/.+\/ICFolder\/.+$/);
  assert.equal(fixtureFolder.name, folderName);
  assert.equal(fixtureFolder.account?.id, accountId);

  const folderId = fixtureFolder.id!;
  const { proc, request, notify, stderr } = startServer();
  let createdNoteId: string | undefined;
  let trashAttempted = false;
  let trashVerified = false;

  const rawCall = async (name: string, args: unknown): Promise<ToolResponse> =>
    parseToolResponse(await request("tools/call", { name, arguments: args }));
  const call = async (name: string, args: unknown) => {
    const result = await rawCall(name, args);
    assert.equal(result.isError, false, `${name} failed: ${result.text}`);
    return result.payload!;
  };

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "0" },
    });
    assert.equal(initialized.error, undefined);
    notify("notifications/initialized");

    const exactFolders: Record<string, unknown>[] = [];
    let folderOffset = 0;
    do {
      const folderPage = await call("list_folders", {
        limit: 100,
        offset: folderOffset,
      });
      exactFolders.push(
        ...(folderPage.folders as Record<string, unknown>[]).filter((folder) => folder.id === folderId),
      );
      const page = folderPage.page as {
        truncated?: boolean;
        next_offset?: number;
      };
      if (!page.truncated) break;
      assert.ok(
        typeof page.next_offset === "number" && page.next_offset > folderOffset,
        "Folder pagination did not advance",
      );
      folderOffset = page.next_offset;
    } while (exactFolders.length === 0);
    assert.equal(exactFolders.length, 1, "Created fixture folder was not discoverable by exact ID");
    assert.deepEqual(exactFolders[0].account, {
      id: accountId,
      name: fixtureFolder.account?.name,
    });

    const created = await call("create_note", {
      title,
      body: `${marker} original`,
      folder_id: folderId,
    });
    createdNoteId = String(created.id);
    assert.match(createdNoteId, /^x-coredata:\/\/.+\/ICNote\/.+$/);
    assert.equal((created.folder as { id: string }).id, folderId);

    const found = await call("search_notes", { query: marker, scope: "all" });
    const matches = (found.notes as Record<string, unknown>[]).filter(
      (note) => expandedSummaryId(found, note) === createdNoteId,
    );
    assert.equal(matches.length, 1);

    const updated = await call("update_note", {
      id: createdNoteId,
      expected_revision: created.revision,
      body: `${marker} updated`,
      mode: "replace",
    });
    const note = await call("get_note", { id: createdNoteId });
    assert.match(String(note.plaintext), /updated/);
    assert.doesNotMatch(String(note.plaintext), /original/);
    assert.equal((note.folder as { id: string }).id, folderId);

    trashAttempted = true;
    const trashed = await call("trash_note", {
      id: createdNoteId,
      expected_revision: updated.revision,
      confirm: true,
    });
    trashVerified = trashed.trashed === true;
    assert.equal(trashVerified, true);

    const gone = await call("search_notes", { query: marker, scope: "all" });
    assert.equal(
      (gone.notes as Record<string, unknown>[]).some(
        (candidate) => expandedSummaryId(gone, candidate) === createdNoteId,
      ),
      false,
    );
  } finally {
    // If the main path did not return an ID (for example, a create response
    // was lost after mutation), recover only the collision-resistant exact
    // title/folder candidate. Never select the first broad search result.
    if (!createdNoteId && proc.exitCode === null) {
      const search = await rawCall("search_notes", { query: title }).catch(() => undefined);
      const candidates = search?.payload?.notes;
      if (Array.isArray(candidates)) {
        const exact = candidates.filter((candidate: unknown) => {
          if (typeof candidate !== "object" || candidate === null) return false;
          const value = candidate as Record<string, unknown>;
          const folder = value.folder as { id?: string } | undefined;
          return value.name === title && folder?.id === folderId;
        });
        if (exact.length === 1) {
          createdNoteId = expandedSummaryId(search!.payload!, exact[0] as Record<string, unknown>);
        }
      }
    }

    if (createdNoteId && !trashAttempted && proc.exitCode === null) {
      const cleanupState = { trashAttempted, trashVerified };
      const outcome = await cleanupIntegrationNoteOnce(
        cleanupState,
        async () => {
          const observed = await rawCall("get_note", { id: createdNoteId }).catch(() => undefined);
          const revision = observed && !observed.isError ? observed.payload?.revision : undefined;
          return typeof revision === "string" ? { revision } : undefined;
        },
        async (revision) => {
          const cleanup = await rawCall("trash_note", {
            id: createdNoteId,
            expected_revision: revision,
            confirm: true,
          });
          return cleanup.payload?.trashed === true;
        },
      );
      trashAttempted = cleanupState.trashAttempted;
      trashVerified = cleanupState.trashVerified;
      if (outcome === "outcome-unknown") {
        console.error(
          `Integration cleanup outcome is unknown for exact note ${createdNoteId}; no retry was attempted.`,
        );
      } else if (outcome === "not-authoritatively-live") {
        console.error(`Integration note ${createdNoteId} was not authoritatively live; cleanup trash was not retried.`);
      }
    } else if (trashAttempted && !trashVerified) {
      console.error(
        `Integration trash outcome is unknown for exact note ${createdNoteId ?? "(unknown)"}; no retry was attempted.`,
      );
    }

    if (proc.exitCode === null) proc.kill("SIGTERM");
    console.error(
      trashVerified
        ? `Integration fixture folder ${folderId} (${folderName}) is expected to be empty and remains for manual removal: Notes automation exposes no approved recoverable folder cleanup operation.`
        : `Integration fixture folder ${folderId} (${folderName}) remains for manual inspection and may still contain the exact fixture note because cleanup was not verified.`,
    );
    if (stderr()) console.error(stderr());
  }
});
