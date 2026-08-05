import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAppleNotesMode,
  SERVER_INSTRUCTIONS,
} from "../src/server.js";
import {
  parseAllowRawHtml,
  parseAllowSharedWrites,
} from "../src/write-policy.js";
import { requireTrashConfirmation } from "../src/tools/write.js";

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    instructions?: string;
    serverInfo?: { name: string; version: string };
    tools?: {
      name: string;
      inputSchema?: {
        required?: string[];
        properties?: Record<string, { pattern?: string; default?: unknown; enum?: unknown[]; const?: unknown }>;
      };
    }[];
    isError?: boolean;
    content?: { type: string; text: string }[];
  };
  error?: { code: number; message: string };
}

interface ServerProcess {
  proc: ChildProcessWithoutNullStreams;
  request(method: string, params?: unknown): Promise<RpcResponse>;
  notify(method: string, params?: unknown): void;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

function startServer(
  mode: string | undefined,
  extraEnv: NodeJS.ProcessEnv = {}
): ServerProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (
    Object.prototype.hasOwnProperty.call(extraEnv, "APPLE_NOTES_TRASH_FOLDER_IDS") &&
    extraEnv.APPLE_NOTES_TRASH_FOLDER_IDS === undefined
  ) {
    delete env.APPLE_NOTES_TRASH_FOLDER_IDS;
  }
  if (mode === undefined) delete env.APPLE_NOTES_MODE;
  else env.APPLE_NOTES_MODE = mode;

  const proc = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts"],
    {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let stdout = "";
  const pending = new Map<
    number,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
  >();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    while (true) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line) as RpcResponse;
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    proc.once("exit", (code, signal) => {
      for (const waiter of pending.values()) {
        waiter.reject(
          new Error(`Server exited before responding (code ${code}, signal ${signal})`)
        );
      }
      pending.clear();
      resolve({ code, signal });
    });
  });

  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<RpcResponse> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 5_000);
      pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) +
          "\n"
      );
    });
  };

  const notify = (method: string, params?: unknown) => {
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) +
        "\n"
    );
  };

  return {
    proc,
    request,
    notify,
    stderr: () => stderr,
    exited,
    stop: async () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
      await exited;
    },
  };
}

async function initialize(server: ServerProcess): Promise<RpcResponse> {
  const response = await server.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "policy-test", version: "0" },
  });
  assert.equal(response.error, undefined);
  server.notify("notifications/initialized");
  return response;
}

async function advertisedTools(mode: string | undefined): Promise<string[]> {
  const server = startServer(mode);
  try {
    await initialize(server);
    const response = await server.request("tools/list", {});
    assert.equal(response.error, undefined);
    return response.result?.tools?.map((tool) => tool.name) ?? [];
  } finally {
    await server.stop();
  }
}

test("mode parser defaults only an absent setting to read-only", () => {
  assert.equal(parseAppleNotesMode(undefined), "read-only");
  assert.equal(parseAppleNotesMode("read-only"), "read-only");
  assert.equal(parseAppleNotesMode("read-write"), "read-write");
});

test("mode parser rejects empty, malformed, padded, and case-mismatched values", () => {
  for (const value of ["", "write", " read-only", "read-write ", "READ-WRITE"]) {
    assert.throws(
      () => parseAppleNotesMode(value),
      /Invalid APPLE_NOTES_MODE.*Expected exactly "read-only" or "read-write"/
    );
  }
});

test("default startup advertises only the four read tools", async () => {
  assert.deepEqual(await advertisedTools(undefined), [
    "list_folders",
    "list_notes",
    "search_notes",
    "get_note",
  ]);
});

test("explicit read-only startup advertises only the four read tools", async () => {
  assert.deepEqual(await advertisedTools("read-only"), [
    "list_folders",
    "list_notes",
    "search_notes",
    "get_note",
  ]);
});

test("read-write startup advertises the complete tool surface", async () => {
  assert.deepEqual(await advertisedTools("read-write"), [
    "list_folders",
    "list_notes",
    "search_notes",
    "get_note",
    "create_note",
    "update_note",
    "move_note",
    "trash_note",
  ]);
});

test("mutation schemas require stable full folder/note ids and expose no name selector", async () => {
  const server = startServer("read-write");
  try {
    await initialize(server);
    const response = await server.request("tools/list", {});
    const tools = response.result?.tools ?? [];
    const create = tools.find((tool) => tool.name === "create_note")?.inputSchema;
    const update = tools.find((tool) => tool.name === "update_note")?.inputSchema;
    const move = tools.find((tool) => tool.name === "move_note")?.inputSchema;
    const trash = tools.find((tool) => tool.name === "trash_note")?.inputSchema;
    assert.equal(tools.some((tool) => tool.name === "delete_note"), false);

    assert.ok(create?.required?.includes("folder_id"));
    assert.deepEqual(Object.keys(create?.properties ?? {}).sort(), [
      "allow_shared_note", "body", "content_format", "dry_run", "folder_id", "title"
    ]);
    assert.match(create?.properties?.folder_id?.pattern ?? "", /ICFolder/);
    assert.equal(create?.properties?.content_format?.default, "plain");
    assert.deepEqual(create?.properties?.content_format?.enum, ["plain", "html"]);

    for (const schema of [update, move, trash]) {
      assert.ok(schema?.required?.includes("id"));
      assert.ok(schema?.required?.includes("expected_revision"));
      assert.ok(!("title" in (schema?.properties ?? {})));
      assert.match(schema?.properties?.id?.pattern ?? "", /ICNote/);
    }
    assert.ok(move?.required?.includes("folder_id"));
    assert.ok(trash?.required?.includes("confirm"));
    assert.deepEqual(trash?.properties?.confirm?.const, true);
    assert.deepEqual(Object.keys(trash?.properties ?? {}).sort(), [
      "allow_shared_trash",
      "confirm",
      "confirm_shared_impact",
      "dry_run",
      "expected_revision",
      "id",
    ]);
    assert.equal(update?.properties?.content_format?.default, "plain");
    assert.deepEqual(update?.properties?.content_format?.enum, ["plain", "html"]);
  } finally {
    await server.stop();
  }
});

test("invalid mutation identifiers are rejected by schema before JXA can run", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "apple-notes-identity-no-jxa-"));
  const marker = join(fakeBin, "jxa-launched");
  const fakeOsascript = join(fakeBin, "osascript");
  await writeFile(
    fakeOsascript,
    '#!/bin/sh\n/usr/bin/touch "$APPLE_NOTES_JXA_MARKER"\nexit 99\n'
  );
  await chmod(fakeOsascript, 0o755);

  const server = startServer("read-write", {
    PATH: fakeBin,
    APPLE_NOTES_JXA_MARKER: marker,
  });
  try {
    await initialize(server);
    const calls = [
      { name: "create_note", arguments: { title: "x", body: "", folder: "Work" } },
      { name: "update_note", arguments: { id: "p1", body: "x" } },
      { name: "trash_note", arguments: { id: "p1", confirm: true } },
    ];
    for (const call of calls) {
      const response = await server.request("tools/call", call);
      assert.equal(response.error, undefined);
      assert.equal(response.result?.isError, true);
      assert.match(response.result?.content?.[0]?.text ?? "", /invalid|folder_id|full/i);
    }
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await server.stop();
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("update, move, and trash reject missing revisions before JXA can run", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "apple-notes-revision-no-jxa-"));
  const marker = join(fakeBin, "jxa-launched");
  const fakeOsascript = join(fakeBin, "osascript");
  await writeFile(
    fakeOsascript,
    '#!/bin/sh\n/usr/bin/touch "$APPLE_NOTES_JXA_MARKER"\nexit 99\n'
  );
  await chmod(fakeOsascript, 0o755);
  const server = startServer("read-write", {
    PATH: fakeBin,
    APPLE_NOTES_JXA_MARKER: marker,
    APPLE_NOTES_TRASH_FOLDER_IDS: "x-coredata://A/ICFolder/trash",
  });
  try {
    await initialize(server);
    for (const call of [
      { name: "update_note", arguments: { id: "x-coredata://A/ICNote/p1", body: "x" } },
      { name: "move_note", arguments: { id: "x-coredata://A/ICNote/p1", folder_id: "x-coredata://A/ICFolder/work" } },
      { name: "trash_note", arguments: { id: "x-coredata://A/ICNote/p1", confirm: true } },
    ]) {
      const response = await server.request("tools/call", call);
      assert.equal(response.result?.isError, true);
      assert.match(response.result?.content?.[0]?.text ?? "", /expected_revision/i);
    }
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await server.stop();
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("trash confirmation is literal true at schema and runtime boundaries with no JXA", async () => {
  for (const value of [undefined, false, "true", 1]) {
    assert.throws(
      () => requireTrashConfirmation(value),
      (error: any) => error.code === "TRASH_CONFIRMATION_REQUIRED"
    );
  }
  assert.doesNotThrow(() => requireTrashConfirmation(true));

  const fakeBin = await mkdtemp(join(tmpdir(), "apple-notes-trash-confirm-no-jxa-"));
  const marker = join(fakeBin, "jxa-launched");
  const fakeOsascript = join(fakeBin, "osascript");
  await writeFile(
    fakeOsascript,
    '#!/bin/sh\n/usr/bin/touch "$APPLE_NOTES_JXA_MARKER"\nexit 99\n'
  );
  await chmod(fakeOsascript, 0o755);
  const server = startServer("read-write", {
    PATH: fakeBin,
    APPLE_NOTES_JXA_MARKER: marker,
    APPLE_NOTES_TRASH_FOLDER_IDS: "x-coredata://A/ICFolder/trash",
  });
  try {
    await initialize(server);
    for (const args of [
      { id: "x-coredata://A/ICNote/p1", expected_revision: "r2|stale" },
      { id: "x-coredata://A/ICNote/p1", expected_revision: "r2|stale", confirm: false },
      { id: "x-coredata://A/ICNote/p1", expected_revision: "r2|stale", confirm: "true" },
    ]) {
      const response = await server.request("tools/call", {
        name: "trash_note",
        arguments: args,
      });
      assert.equal(response.result?.isError, true);
      assert.match(response.result?.content?.[0]?.text ?? "", /confirm|true/i);
    }
    const legacy = await server.request("tools/call", {
      name: "delete_note",
      arguments: {
        id: "x-coredata://A/ICNote/p1",
        expected_revision: "r2|stale",
        confirm: true,
      },
    });
    assert.equal(legacy.result?.isError, true);
    assert.match(legacy.result?.content?.[0]?.text ?? "", /Tool delete_note not found/);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await server.stop();
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("initialize returns version 2.0.0 and the security boundary instructions", async () => {
  const server = startServer(undefined);
  try {
    const response = await initialize(server);
    assert.equal(response.result?.serverInfo?.version, "2.0.0");
    assert.equal(response.result?.instructions, SERVER_INSTRUCTIONS);
    assert.match(response.result?.instructions ?? "", /model provider/i);
    assert.match(response.result?.instructions ?? "", /explicit user approval/i);
    assert.match(response.result?.instructions ?? "", /never invokes Notes' delete command.*permanent-delete operation/i);
    assert.match(response.result?.instructions ?? "", /account type.*ownership.*unavailable or unknown/i);
    assert.match(response.result?.instructions ?? "", /confirm=true/i);
    assert.match(response.result?.instructions ?? "", /locked notes/i);
    assert.match(response.result?.instructions ?? "", /shared-note writes/i);
    assert.match(response.result?.instructions ?? "", /confirm_shared_impact=true/i);
    assert.match(response.result?.instructions ?? "", /rich-content replacement/i);
    assert.match(response.result?.instructions ?? "", /raw html/i);
  } finally {
    await server.stop();
  }
});

test("shared-write capability parser is exact and fails closed", () => {
  assert.equal(parseAllowSharedWrites(undefined), false);
  assert.equal(parseAllowSharedWrites("false"), false);
  assert.equal(parseAllowSharedWrites("true"), true);
  for (const value of ["", "TRUE", " true", "1"]) {
    assert.throws(() => parseAllowSharedWrites(value), /Invalid APPLE_NOTES_ALLOW_SHARED_WRITES/);
  }
});

test("raw-HTML capability parser is exact and fails closed", () => {
  assert.equal(parseAllowRawHtml(undefined), false);
  assert.equal(parseAllowRawHtml("false"), false);
  assert.equal(parseAllowRawHtml("true"), true);
  for (const value of ["", "TRUE", " true", "true ", "1"]) {
    assert.throws(() => parseAllowRawHtml(value), /Invalid APPLE_NOTES_ALLOW_RAW_HTML/);
  }
});

test("invalid raw-HTML configuration exits before startup", async () => {
  const server = startServer("read-write", { APPLE_NOTES_ALLOW_RAW_HTML: "TRUE" });
  const { code } = await server.exited;
  assert.notEqual(code, 0);
  assert.match(server.stderr(), /Invalid APPLE_NOTES_ALLOW_RAW_HTML "TRUE"/);
  assert.doesNotMatch(server.stderr(), /server running on stdio/);
});

test("raw HTML calls fail before JXA unless the startup capability is enabled", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "apple-notes-html-no-jxa-"));
  const marker = join(fakeBin, "jxa-launched");
  const fakeOsascript = join(fakeBin, "osascript");
  await writeFile(
    fakeOsascript,
    '#!/bin/sh\n/usr/bin/touch "$APPLE_NOTES_JXA_MARKER"\nprintf \'{}\'\n'
  );
  await chmod(fakeOsascript, 0o755);
  const server = startServer("read-write", {
    PATH: fakeBin,
    APPLE_NOTES_JXA_MARKER: marker,
    APPLE_NOTES_TRASH_FOLDER_IDS: "x-coredata://A/ICFolder/trash",
    APPLE_NOTES_ALLOW_RAW_HTML: "false",
  });
  try {
    await initialize(server);
    for (const call of [
      {
        name: "create_note",
        arguments: {
          title: "x",
          body: "<p>raw</p>",
          content_format: "html",
          folder_id: "x-coredata://A/ICFolder/work",
        },
      },
      {
        name: "update_note",
        arguments: {
          id: "x-coredata://A/ICNote/p1",
          expected_revision: "r2|stale",
          body: "<p>raw</p>",
          content_format: "html",
        },
      },
    ]) {
      const response = await server.request("tools/call", call);
      assert.equal(response.result?.isError, true);
      assert.match(response.result?.content?.[0]?.text ?? "", /RAW_HTML_DISABLED/);
    }
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await server.stop();
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("create passes only escaped or sanitized projections to JXA", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "apple-notes-html-projection-"));
  const marker = join(fakeBin, "projected-html");
  const fakeOsascript = join(fakeBin, "osascript");
  await writeFile(
    fakeOsascript,
    '#!/bin/sh\nprintf \'%s\' "$7" > "$APPLE_NOTES_JXA_MARKER"\nprintf \'{}\'\n'
  );
  await chmod(fakeOsascript, 0o755);
  const server = startServer("read-write", {
    PATH: fakeBin,
    APPLE_NOTES_JXA_MARKER: marker,
    APPLE_NOTES_TRASH_FOLDER_IDS: "x-coredata://A/ICFolder/trash",
    APPLE_NOTES_ALLOW_RAW_HTML: "true",
  });
  try {
    await initialize(server);
    const common = {
      title: "x",
      folder_id: "x-coredata://A/ICFolder/work",
      dry_run: true,
    };
    const plain = await server.request("tools/call", {
      name: "create_note",
      arguments: { ...common, body: "<p>& literal</p>" },
    });
    assert.equal(plain.result?.isError, undefined);
    assert.equal(
      await readFile(marker, "utf8"),
      "<div>&lt;p&gt;&amp; literal&lt;/p&gt;</div>"
    );

    const html = await server.request("tools/call", {
      name: "create_note",
      arguments: {
        ...common,
        body: "<DIV>safe &amp; <STRONG>x</STRONG><BR /></DIV>",
        content_format: "html",
      },
    });
    assert.equal(html.result?.isError, undefined);
    assert.equal(
      await readFile(marker, "utf8"),
      "<div>safe &amp; <strong>x</strong><br></div>"
    );
  } finally {
    await server.stop();
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("invalid shared-write configuration exits before startup", async () => {
  const server = startServer("read-write", { APPLE_NOTES_ALLOW_SHARED_WRITES: "TRUE" });
  const { code } = await server.exited;
  assert.notEqual(code, 0);
  assert.match(server.stderr(), /Invalid APPLE_NOTES_ALLOW_SHARED_WRITES "TRUE"/);
  assert.doesNotMatch(server.stderr(), /server running on stdio/);
});

test("invalid case-mismatched mode exits before startup with a clear error", async () => {
  const server = startServer("READ-WRITE");
  const { code } = await server.exited;
  assert.notEqual(code, 0);
  assert.match(
    server.stderr(),
    /Invalid APPLE_NOTES_MODE "READ-WRITE".*Expected exactly "read-only" or "read-write"/
  );
  assert.doesNotMatch(server.stderr(), /server running on stdio/);
});

test("direct stale write calls in read-only mode are rejected without launching JXA", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "apple-notes-no-jxa-"));
  const marker = join(fakeBin, "jxa-launched");
  const fakeOsascript = join(fakeBin, "osascript");
  await writeFile(
    fakeOsascript,
    '#!/bin/sh\n/usr/bin/touch "$APPLE_NOTES_JXA_MARKER"\nexit 99\n'
  );
  await chmod(fakeOsascript, 0o755);

  const server = startServer("read-only", {
    PATH: fakeBin,
    APPLE_NOTES_JXA_MARKER: marker,
  });
  try {
    await initialize(server);
    for (const name of ["create_note", "update_note", "move_note", "trash_note", "delete_note"]) {
      const response = await server.request("tools/call", {
        name,
        arguments: {},
      });
      assert.equal(response.error, undefined);
      assert.equal(response.result?.isError, true);
      assert.match(response.result?.content?.[0]?.text ?? "", new RegExp(`Tool ${name} not found`));
    }

    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await server.stop();
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("trash bootstrap permits folder discovery but blocks every note-bearing read", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "apple-notes-trash-bootstrap-"));
  const marker = join(fakeBin, "jxa-launched");
  const fakeOsascript = join(fakeBin, "osascript");
  await writeFile(
    fakeOsascript,
    '#!/bin/sh\n/usr/bin/touch "$APPLE_NOTES_JXA_MARKER"\nprintf \'{"accountIds":[],"folders":[]}\'\n'
  );
  await chmod(fakeOsascript, 0o755);

  const server = startServer("read-only", {
    PATH: fakeBin,
    APPLE_NOTES_JXA_MARKER: marker,
    APPLE_NOTES_TRASH_FOLDER_IDS: undefined,
  });
  try {
    await initialize(server);
    const discovery = await server.request("tools/call", {
      name: "list_folders",
      arguments: {},
    });
    assert.equal(discovery.result?.isError, undefined);
    const payload = JSON.parse(discovery.result?.content?.[0]?.text ?? "null");
    assert.equal(payload.trash_configuration.ready, false);
    await rm(marker, { force: true });

    for (const call of [
      { name: "list_notes", arguments: {} },
      { name: "search_notes", arguments: { query: "private" } },
      { name: "get_note", arguments: { id: "x-coredata://A/ICNote/p1" } },
    ]) {
      const response = await server.request("tools/call", call);
      assert.equal(response.result?.isError, true);
      assert.match(response.result?.content?.[0]?.text ?? "", /TRASH_CONFIG_REQUIRED/);
    }
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await server.stop();
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("partial multi-account trash configuration is not ready and blocks reads", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "apple-notes-trash-partial-"));
  const fakeOsascript = join(fakeBin, "osascript");
  const accountA = "x-coredata://A/ICAccount/p1";
  const accountB = "x-coredata://B/ICAccount/p1";
  const trashA = "x-coredata://A/ICFolder/trash";
  const trashB = "x-coredata://B/ICFolder/trash";
  const folderPayload = JSON.stringify({
    accountIds: [accountA, accountB],
    folders: [
      { id: trashA, name: "Bin A", account: { id: accountA, name: "A" }, count: 0 },
      { id: trashB, name: "Bin B", account: { id: accountB, name: "B" }, count: 0 },
    ],
  });
  await writeFile(fakeOsascript, `#!/bin/sh\nprintf '%s' '${folderPayload}'\n`);
  await chmod(fakeOsascript, 0o755);

  const discoveryServer = startServer("read-only", {
    PATH: fakeBin,
    APPLE_NOTES_TRASH_FOLDER_IDS: trashA,
  });
  try {
    await initialize(discoveryServer);
    const response = await discoveryServer.request("tools/call", {
      name: "list_folders",
      arguments: {},
    });
    const payload = JSON.parse(response.result?.content?.[0]?.text ?? "null");
    assert.equal(payload.trash_configuration.ready, false);
    assert.deepEqual(payload.trash_configuration.missing_account_ids, [accountB]);
  } finally {
    await discoveryServer.stop();
  }

  const metadataPayload = JSON.stringify({
    ids: [],
    names: [],
    modified: [],
    revisionModified: [],
    locked: [],
    shared: [],
    folderIds: [trashA, trashB],
    folderAccounts: [
      { id: trashA, accountId: accountA },
      { id: trashB, accountId: accountB },
    ],
    accountIds: [accountA, accountB],
    location: null,
    locations: {},
    rich: { available: true, byNote: {} },
  });
  await writeFile(fakeOsascript, `#!/bin/sh\nprintf '%s' '${metadataPayload}'\n`);
  await chmod(fakeOsascript, 0o755);
  const readServer = startServer("read-only", {
    PATH: fakeBin,
    APPLE_NOTES_TRASH_FOLDER_IDS: trashA,
  });
  try {
    await initialize(readServer);
    const response = await readServer.request("tools/call", {
      name: "list_notes",
      arguments: {},
    });
    assert.equal(response.result?.isError, true);
    assert.match(response.result?.content?.[0]?.text ?? "", /TRASH_CONFIG_INCOMPLETE/);
    assert.match(response.result?.content?.[0]?.text ?? "", new RegExp(accountB));
  } finally {
    await readServer.stop();
    await rm(fakeBin, { recursive: true, force: true });
  }
});
