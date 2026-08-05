import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createAppleNotesServer,
  parseAppleNotesMode,
  SERVER_INSTRUCTIONS,
  SERVER_VERSION,
} from "../src/server.js";
import {
  runJxaProcess,
  type JxaProcessExecutor,
  type JxaRunner,
} from "../src/jxa.js";
import { SafeToolError } from "../src/errors.js";
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

async function withInjectedServer<T>(
  mode: "read-only" | "read-write",
  runner: JxaRunner,
  operation: (client: Client) => Promise<T>,
  options: {
    allowRawHtml?: boolean;
    allowSharedWrites?: boolean;
    trashFolderIds?: string;
  } = {}
): Promise<T> {
  const previousTrashIds = process.env.APPLE_NOTES_TRASH_FOLDER_IDS;
  if (options.trashFolderIds === undefined) {
    delete process.env.APPLE_NOTES_TRASH_FOLDER_IDS;
  } else {
    process.env.APPLE_NOTES_TRASH_FOLDER_IDS = options.trashFolderIds;
  }

  const server = createAppleNotesServer(
    mode,
    {
      allowRawHtml: options.allowRawHtml ?? false,
      allowSharedWrites: options.allowSharedWrites ?? false,
    },
    runner
  );
  const client = new Client({ name: "in-memory-policy-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await operation(client);
  } finally {
    await client.close();
    await server.close();
    if (previousTrashIds === undefined) delete process.env.APPLE_NOTES_TRASH_FOLDER_IDS;
    else process.env.APPLE_NOTES_TRASH_FOLDER_IDS = previousTrashIds;
  }
}

function toolText(result: { content?: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { type?: string; text?: string } | undefined;
  return first?.type === "text" ? first.text ?? "" : "";
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

test("initialize reports the package.json version without a hardcoded duplicate", async () => {
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8")
  ) as { version: string };
  assert.equal(SERVER_VERSION, packageJson.version);

  const server = startServer("read-only");
  try {
    const response = await initialize(server);
    assert.equal(response.result?.serverInfo?.version, packageJson.version);
  } finally {
    await server.stop();
  }
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
  let launches = 0;
  await withInjectedServer("read-write", async <T>() => {
    launches++;
    throw new Error("JXA must not run");
  }, async (client) => {
    const calls = [
      { name: "create_note", arguments: { title: "x", body: "", folder: "Work" } },
      { name: "update_note", arguments: { id: "p1", body: "x" } },
      { name: "trash_note", arguments: { id: "p1", confirm: true } },
    ];
    for (const call of calls) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      assert.match(toolText(result), /invalid|folder_id|full/i);
    }
  });
  assert.equal(launches, 0);
});

test("update, move, and trash reject missing revisions before JXA can run", async () => {
  let launches = 0;
  await withInjectedServer("read-write", async <T>() => {
    launches++;
    throw new Error("JXA must not run");
  }, async (client) => {
    for (const call of [
      { name: "update_note", arguments: { id: "x-coredata://A/ICNote/p1", body: "x" } },
      { name: "move_note", arguments: { id: "x-coredata://A/ICNote/p1", folder_id: "x-coredata://A/ICFolder/work" } },
      { name: "trash_note", arguments: { id: "x-coredata://A/ICNote/p1", confirm: true } },
    ]) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      assert.match(toolText(result), /expected_revision/i);
    }
  }, { trashFolderIds: "x-coredata://A/ICFolder/trash" });
  assert.equal(launches, 0);
});

test("trash confirmation is literal true at schema and runtime boundaries with no JXA", async () => {
  for (const value of [undefined, false, "true", 1]) {
    assert.throws(
      () => requireTrashConfirmation(value),
      (error: any) => error.code === "TRASH_CONFIRMATION_REQUIRED"
    );
  }
  assert.doesNotThrow(() => requireTrashConfirmation(true));

  let launches = 0;
  await withInjectedServer("read-write", async <T>() => {
    launches++;
    throw new Error("JXA must not run");
  }, async (client) => {
    for (const args of [
      { id: "x-coredata://A/ICNote/p1", expected_revision: "r2|stale" },
      { id: "x-coredata://A/ICNote/p1", expected_revision: "r2|stale", confirm: false },
      { id: "x-coredata://A/ICNote/p1", expected_revision: "r2|stale", confirm: "true" },
    ]) {
      const result = await client.callTool({
        name: "trash_note",
        arguments: args,
      });
      assert.equal(result.isError, true);
      assert.match(toolText(result), /confirm|true/i);
    }
    const legacy = await client.callTool({
      name: "delete_note",
      arguments: {
        id: "x-coredata://A/ICNote/p1",
        expected_revision: "r2|stale",
        confirm: true,
      },
    });
    assert.equal(legacy.isError, true);
    assert.match(toolText(legacy), /Tool delete_note not found/);
  }, { trashFolderIds: "x-coredata://A/ICFolder/trash" });
  assert.equal(launches, 0);
});

test("initialize returns the derived version and security boundary instructions", async () => {
  const server = startServer(undefined);
  try {
    const response = await initialize(server);
    assert.equal(response.result?.serverInfo?.version, SERVER_VERSION);
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
  let launches = 0;
  await withInjectedServer("read-write", async <T>() => {
    launches++;
    throw new Error("JXA must not run");
  }, async (client) => {
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
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      assert.match(toolText(result), /RAW_HTML_DISABLED/);
    }
  }, { trashFolderIds: "x-coredata://A/ICFolder/trash" });
  assert.equal(launches, 0);
});

test("create passes only escaped or sanitized projections to JXA", async () => {
  let projectedHtml = "";
  const runner: JxaRunner = async <T>(_script: string, args: string[] = []) => {
    projectedHtml = args[1] ?? "";
    return {} as T;
  };
  await withInjectedServer("read-write", runner, async (client) => {
    const common = {
      title: "x",
      folder_id: "x-coredata://A/ICFolder/work",
      dry_run: true,
    };
    const plain = await client.callTool({
      name: "create_note",
      arguments: { ...common, body: "<p>& literal</p>" },
    });
    assert.equal(plain.isError, undefined);
    assert.equal(projectedHtml, "<div>&lt;p&gt;&amp; literal&lt;/p&gt;</div>");

    const html = await client.callTool({
      name: "create_note",
      arguments: {
        ...common,
        body: "<DIV>safe &amp; <STRONG>x</STRONG><BR /></DIV>",
        content_format: "html",
      },
    });
    assert.equal(html.isError, undefined);
    assert.equal(projectedHtml, "<div>safe &amp; <strong>x</strong><br></div>");
  }, {
    allowRawHtml: true,
    trashFolderIds: "x-coredata://A/ICFolder/trash",
  });
});

test("process-boundary write failures preserve unknown outcomes and dry-run certainty", async () => {
  const secret = "PRIVATE PROCESS DETAIL";
  const noteId = "x-coredata://A/ICNote/p1";
  const folderId = "x-coredata://A/ICFolder/work";
  const trashId = "x-coredata://A/ICFolder/trash";
  const cases: {
    label: string;
    executor: JxaProcessExecutor;
    call: { name: string; arguments: Record<string, unknown> };
    target: RegExp;
  }[] = [
    {
      label: "timeout",
      executor: (_file, _args, _options, callback) => callback(
        Object.assign(new Error(secret), { code: "ETIMEDOUT", killed: true }),
        secret,
        secret
      ),
      call: {
        name: "create_note",
        arguments: { title: "Boundary title", body: "body", folder_id: folderId },
      },
      target: /target folder .*ICFolder\/work.*Boundary title/,
    },
    {
      label: "output overflow",
      executor: (_file, _args, _options, callback) => callback(
        Object.assign(new Error(secret), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        }),
        secret,
        secret
      ),
      call: {
        name: "update_note",
        arguments: { id: noteId, expected_revision: "r2|current", body: "body" },
      },
      target: /ICNote\/p1/,
    },
    {
      label: "invalid stdout",
      executor: (_file, _args, _options, callback) => callback(null, secret, secret),
      call: {
        name: "move_note",
        arguments: {
          id: noteId,
          folder_id: folderId,
          expected_revision: "r2|current",
        },
      },
      target: /ICNote\/p1/,
    },
    {
      label: "generic executor failure",
      executor: (_file, _args, _options, callback) => callback(
        new Error(secret),
        secret,
        secret
      ),
      call: {
        name: "trash_note",
        arguments: {
          id: noteId,
          expected_revision: "r2|current",
          confirm: true,
        },
      },
      target: /ICNote\/p1/,
    },
  ];

  for (const fixture of cases) {
    const runner: JxaRunner = <T>(script: string, args: string[] = []) =>
      runJxaProcess<T>(fixture.executor, script, args);
    await withInjectedServer("read-write", runner, async (client) => {
      const mutation = await client.callTool(fixture.call);
      const mutationText = toolText(mutation);
      assert.equal(mutation.isError, true, fixture.label);
      assert.match(mutationText, /MUTATION_OUTCOME_UNKNOWN/);
      assert.match(mutationText, /mutation may already have occurred/i);
      assert.match(mutationText, fixture.target);
      assert.match(mutationText, /re-read or list.*do not retry blindly/i);
      assert.doesNotMatch(mutationText, /PRIVATE PROCESS DETAIL/);

      const dryRun = await client.callTool({
        ...fixture.call,
        arguments: { ...fixture.call.arguments, dry_run: true },
      });
      const dryRunText = toolText(dryRun);
      assert.equal(dryRun.isError, true, `${fixture.label} dry-run`);
      assert.match(dryRunText, /DRY_RUN_AUTOMATION_FAILED/);
      assert.match(dryRunText, /requested no mutation.*did not enter the mutation branch/i);
      assert.doesNotMatch(dryRunText, /may already have occurred/i);
      assert.doesNotMatch(dryRunText, /PRIVATE PROCESS DETAIL/);
    }, { trashFolderIds: trashId });
  }
});

test("safe JXA domain errors survive write handling unchanged", async () => {
  const runner: JxaRunner = async <T>() => {
    throw new SafeToolError(
      "CONFLICT",
      "The note changed after it was read. Re-read it before retrying."
    );
  };
  await withInjectedServer("read-write", runner, async (client) => {
    const result = await client.callTool({
      name: "update_note",
      arguments: {
        id: "x-coredata://A/ICNote/p1",
        expected_revision: "r2|stale",
        body: "replacement",
      },
    });
    assert.equal(result.isError, true);
    assert.equal(
      toolText(result),
      "Error [CONFLICT]: The note changed after it was read. Re-read it before retrying."
    );
  }, { trashFolderIds: "x-coredata://A/ICFolder/trash" });
});

test("oversized successful write results become conservative boundary failures", async () => {
  const runner: JxaRunner = async <T>() => ({ private: "x".repeat(70_000) }) as T;
  await withInjectedServer("read-write", runner, async (client) => {
    const common = {
      name: "update_note",
      arguments: {
        id: "x-coredata://A/ICNote/p1",
        expected_revision: "r2|current",
        body: "replacement",
      },
    };
    const mutation = await client.callTool(common);
    assert.equal(mutation.isError, true);
    assert.match(toolText(mutation), /MUTATION_OUTCOME_UNKNOWN/);
    assert.match(toolText(mutation), /do not retry blindly/i);
    assert.doesNotMatch(toolText(mutation), /xxxxx/);

    const dryRun = await client.callTool({
      ...common,
      arguments: { ...common.arguments, dry_run: true },
    });
    assert.equal(dryRun.isError, true);
    assert.match(toolText(dryRun), /DRY_RUN_AUTOMATION_FAILED/);
    assert.doesNotMatch(toolText(dryRun), /may already have occurred/i);
  }, { trashFolderIds: "x-coredata://A/ICFolder/trash" });
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
  let launches = 0;
  await withInjectedServer("read-only", async <T>() => {
    launches++;
    throw new Error("JXA must not run");
  }, async (client) => {
    for (const name of ["create_note", "update_note", "move_note", "trash_note", "delete_note"]) {
      const result = await client.callTool({
        name,
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.match(toolText(result), new RegExp(`Tool ${name} not found`));
    }
  });
  assert.equal(launches, 0);
});

test("trash bootstrap permits folder discovery but blocks every note-bearing read", async () => {
  let launches = 0;
  const runner: JxaRunner = async <T>() => {
    launches++;
    return { accountIds: [], folders: [] } as T;
  };
  await withInjectedServer("read-only", runner, async (client) => {
    const discovery = await client.callTool({
      name: "list_folders",
      arguments: {},
    });
    assert.equal(discovery.isError, undefined);
    const payload = JSON.parse(toolText(discovery));
    assert.equal(payload.trash_configuration.ready, false);
    assert.equal(launches, 1);

    for (const call of [
      { name: "list_notes", arguments: {} },
      { name: "search_notes", arguments: { query: "private" } },
      { name: "get_note", arguments: { id: "x-coredata://A/ICNote/p1" } },
    ]) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      assert.match(toolText(result), /TRASH_CONFIG_REQUIRED/);
    }
    assert.equal(launches, 1);
  });
});

test("partial multi-account trash configuration is not ready and blocks reads", async () => {
  const accountA = "x-coredata://A/ICAccount/p1";
  const accountB = "x-coredata://B/ICAccount/p1";
  const trashA = "x-coredata://A/ICFolder/trash";
  const trashB = "x-coredata://B/ICFolder/trash";
  const folderPayload = {
    accountIds: [accountA, accountB],
    folders: [
      { id: trashA, name: "Bin A", account: { id: accountA, name: "A" }, count: 0 },
      { id: trashB, name: "Bin B", account: { id: accountB, name: "B" }, count: 0 },
    ],
  };
  await withInjectedServer("read-only", async <T>() => folderPayload as T, async (client) => {
    const response = await client.callTool({
      name: "list_folders",
      arguments: {},
    });
    const payload = JSON.parse(toolText(response));
    assert.equal(payload.trash_configuration.ready, false);
    assert.deepEqual(payload.trash_configuration.missing_account_ids, [accountB]);
  }, { trashFolderIds: trashA });

  const metadataPayload = {
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
  };
  await withInjectedServer("read-only", async <T>() => metadataPayload as T, async (client) => {
    const response = await client.callTool({
      name: "list_notes",
      arguments: {},
    });
    assert.equal(response.isError, true);
    assert.match(toolText(response), /TRASH_CONFIG_INCOMPLETE/);
    assert.match(toolText(response), new RegExp(accountB));
  }, { trashFolderIds: trashA });
});
