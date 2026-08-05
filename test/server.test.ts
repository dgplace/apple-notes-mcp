import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAppleNotesMode,
  SERVER_INSTRUCTIONS,
} from "../src/server.js";

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
        properties?: Record<string, { pattern?: string }>;
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
    "delete_note",
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
    const remove = tools.find((tool) => tool.name === "delete_note")?.inputSchema;

    assert.ok(create?.required?.includes("folder_id"));
    assert.deepEqual(Object.keys(create?.properties ?? {}).sort(), ["body", "folder_id", "title"]);
    assert.match(create?.properties?.folder_id?.pattern ?? "", /ICFolder/);

    for (const schema of [update, remove]) {
      assert.ok(schema?.required?.includes("id"));
      assert.ok(!("title" in (schema?.properties ?? {})));
      assert.match(schema?.properties?.id?.pattern ?? "", /ICNote/);
    }
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
      { name: "delete_note", arguments: { id: "p1" } },
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

test("initialize returns version 2.0.0 and the security boundary instructions", async () => {
  const server = startServer(undefined);
  try {
    const response = await initialize(server);
    assert.equal(response.result?.serverInfo?.version, "2.0.0");
    assert.equal(response.result?.instructions, SERVER_INSTRUCTIONS);
    assert.match(response.result?.instructions ?? "", /model provider/i);
    assert.match(response.result?.instructions ?? "", /explicit user approval/i);
    assert.match(response.result?.instructions ?? "", /recovery is not guaranteed/i);
    assert.match(response.result?.instructions ?? "", /locked notes/i);
    assert.match(response.result?.instructions ?? "", /shared-note writes/i);
    assert.match(response.result?.instructions ?? "", /rich-content replacement/i);
  } finally {
    await server.stop();
  }
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
    for (const name of ["create_note", "update_note", "delete_note"]) {
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
