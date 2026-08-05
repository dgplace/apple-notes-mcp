import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

// Full lifecycle against the real Notes.app — creates, edits, and deletes one
// test note (ending up in Recently Deleted). Opt-in:
//
//   npm run test:integration
//
const enabled = process.env.APPLE_NOTES_IT === "1";

interface RpcResponse {
  id?: number;
  result?: {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
}

function startServer() {
  const proc: ChildProcessWithoutNullStreams = spawn("node", ["dist/index.js"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map<number, (r: RpcResponse) => void>();
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const msg: RpcResponse = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });

  let nextId = 1;
  const request = (method: string, params: unknown): Promise<RpcResponse> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method: string) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

  return { proc, request, notify };
}

test("lifecycle: create → search → update → get → delete", { skip: !enabled }, async () => {
  const { proc, request, notify } = startServer();
  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "0" },
    });
    notify("notifications/initialized");

    const call = async (name: string, args: unknown) => {
      const r = await request("tools/call", { name, arguments: args });
      assert.ok(!r.result?.isError, `${name} failed: ${r.result?.content[0]?.text}`);
      return JSON.parse(r.result!.content[0].text);
    };

    const marker = "integration-marker-zanzibar";
    const folderPage = await call("list_folders", {});
    const targetFolder = folderPage.folders.find(
      (folder: { name: string }) => folder.name === "Notes"
    ) ?? folderPage.folders[0];
    assert.ok(targetFolder?.id, "No writable Notes folder was discovered");
    const created = await call("create_note", {
      title: "apple-notes-mcp integration test",
      body: `${marker} original`,
      folder_id: targetFolder.id,
    });
    assert.ok(created.id);

    const found = await call("search_notes", { query: marker });
    assert.equal(found.notes.length, 1);

    await call("update_note", { id: created.id, body: `${marker} updated`, mode: "replace" });
    const note = await call("get_note", { id: created.id });
    assert.match(note.plaintext, /updated/);
    assert.doesNotMatch(note.plaintext, /original/);

    const deleted = await call("delete_note", { id: created.id });
    assert.equal(deleted.deleted, true);

    const gone = await call("search_notes", { query: marker });
    assert.equal(gone.notes.length, 0);
  } finally {
    proc.kill();
  }
});
