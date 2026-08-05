import { test } from "node:test";
import assert from "node:assert/strict";
import {
  READ_LIMITS,
  normalizeBodyPageRequest,
  normalizePageRequest,
  normalizeSearchQuery,
  paginateBySerializedSize,
  parseTrashFolderIds,
  serializedToolResultBytes,
  assertCompleteTrashConfiguration,
  trashConfigurationStatus,
} from "../src/read-policy.js";
import { fitNoteDetailToResult, summaryRichContent } from "../src/tools/read.js";
import type { NoteDetail } from "../src/types.js";

test("runtime normalizers enforce limits even when schemas are bypassed", () => {
  assert.equal(normalizePageRequest(1_000_000, 0, 20).limit, READ_LIMITS.maxResults);
  assert.equal(
    normalizeBodyPageRequest(1_000_000, 0).maxChars,
    READ_LIMITS.maxBodyPageChars
  );
  assert.equal(normalizeBodyPageRequest(1, 0).maxChars, 1);
  assert.throws(() => normalizeSearchQuery("q".repeat(READ_LIMITS.maxQueryChars + 1)), /hard limit/i);
  assert.throws(() => normalizePageRequest(10, READ_LIMITS.maxOffset + 1, 20), /offset/i);
});

test("trash configuration accepts only bounded full stable folder IDs", () => {
  const id = "x-coredata://A/ICFolder/trash";
  assert.deepEqual(parseTrashFolderIds(id), [id]);
  assert.throws(() => parseTrashFolderIds("Recently Deleted"), /full.*ICFolder/i);
  assert.throws(() => parseTrashFolderIds(`${id},${id}`), /duplicate/i);
});

test("trash readiness requires exactly one configured folder per discovered account", () => {
  const aTrash = "x-coredata://A/ICFolder/trash";
  const aOther = "x-coredata://A/ICFolder/other";
  const bTrash = "x-coredata://B/ICFolder/trash";
  const folders = [
    { id: aTrash, accountId: "x-coredata://A/ICAccount/p1" },
    { id: aOther, accountId: "x-coredata://A/ICAccount/p1" },
    { id: bTrash, accountId: "x-coredata://B/ICAccount/p1" },
  ];
  const accounts = ["x-coredata://A/ICAccount/p1", "x-coredata://B/ICAccount/p1"];

  const partial = trashConfigurationStatus([aTrash], folders, accounts);
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.missingAccountIds, ["x-coredata://B/ICAccount/p1"]);
  assert.throws(
    () => assertCompleteTrashConfiguration([aTrash], folders, accounts),
    /TRASH_CONFIG_INCOMPLETE|No configured trash folder covers.*B\/ICAccount/s
  );

  const duplicate = trashConfigurationStatus([aTrash, aOther, bTrash], folders, accounts);
  assert.equal(duplicate.ready, false);
  assert.deepEqual(duplicate.duplicateAccountIds, ["x-coredata://A/ICAccount/p1"]);
  assert.throws(
    () => assertCompleteTrashConfiguration([aTrash, aOther, bTrash], folders, accounts),
    /More than one configured trash folder.*A\/ICAccount/s
  );

  assert.equal(trashConfigurationStatus([aTrash, bTrash], folders, accounts).ready, true);
});

test("metadata pagination is deterministic and the complete result stays within 64 KiB", () => {
  const items = Array.from({ length: 200 }, (_, index) => ({
    id: index,
    name: `${String(index).padStart(3, "0")}-${"x".repeat(900)}`,
  }));
  const first = paginateBySerializedSize(items, { limit: 100, offset: 0 }, (page, metadata) => ({
    items: page,
    page: metadata,
  })) as { items: typeof items; page: { next_offset?: number; truncated: boolean } };
  assert.ok(first.items.length < 100);
  assert.equal(first.page.truncated, true);
  assert.equal(first.page.next_offset, first.items.length);
  assert.ok(serializedToolResultBytes({ items: first.items, page: first.page }) <= 64 * 1024);

  const repeated = paginateBySerializedSize(items, { limit: 100, offset: 0 }, (page, metadata) => ({
    items: page,
    page: metadata,
  })) as { items: typeof items };
  assert.deepEqual(repeated.items, first.items);
});

test("body pages shrink for escaped-byte expansion and expose an exact continuation", () => {
  const plaintext = "\u0000".repeat(READ_LIMITS.maxBodyPageChars);
  const note: NoteDetail = {
    id: "x-coredata://A/ICNote/p1",
    name: "bounded",
    account: { id: "x-coredata://A/ICAccount/p1", name: "iCloud" },
    folder: { id: "x-coredata://A/ICFolder/p1", name: "Notes" },
    created: "2026-01-01T00:00:00Z",
    modified: "2026-01-01T00:00:00Z",
    locked: false,
    shared: false,
    rich_content: { status: "none" },
    content_available: true,
    plaintext,
    page: {
      offset: 400,
      returned_chars: plaintext.length,
      total_chars: 50_000,
      truncated: true,
      next_offset: 400 + plaintext.length,
    },
  };
  const fitted = fitNoteDetailToResult(note);
  assert.ok((fitted.plaintext?.length ?? 0) < plaintext.length);
  assert.equal(fitted.page.next_offset, fitted.page.offset + fitted.page.returned_chars);
  assert.ok(serializedToolResultBytes(fitted) <= READ_LIMITS.maxResponseBytes);
});

test("summary rich-content metadata is honest when bulk classification is unavailable", () => {
  assert.deepEqual(summaryRichContent("note", { available: false, byNote: {} }), {
    status: "unknown",
    unknown_kinds: ["attachment", "drawing", "table", "checklist"],
  });
  assert.equal(
    summaryRichContent("note", {
      available: true,
      byNote: { note: { attachment: true, possibleDrawing: false } },
    }).status,
    "present"
  );
});
