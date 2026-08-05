const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_SAFE_MESSAGE_CHARS = 2_000;

/** An error whose message is explicitly safe to return to an MCP client. */
export class SafeToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SafeToolError";
    this.code = SAFE_CODE.test(code) ? code : "SAFE_ERROR";
  }
}

export function safeError(code: string, message: string): SafeToolError {
  return new SafeToolError(code, message);
}

export function safeErrorText(error: unknown): string {
  if (!(error instanceof SafeToolError)) {
    return "Error [AUTOMATION_FAILED]: Apple Notes automation failed without a safe diagnostic.";
  }

  // Messages are created only at explicit safe-error sites. Still remove
  // control characters and cap their size before crossing the MCP boundary.
  const message = error.message
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .slice(0, MAX_SAFE_MESSAGE_CHARS);
  return `Error [${error.code}]: ${message}`;
}

export interface WriteBoundaryContext {
  automationStarted: boolean;
  dryRun: boolean;
  operation: string;
  noteId?: string;
  folderId?: string;
  title?: string;
}

/**
 * Preserve explicit JXA domain failures, but never present a process-level
 * failure as proof that a mutation-capable call made no change. RESULT_TOO_LARGE
 * is generated locally after a successful automation response, so it has the
 * same unknown-outcome treatment as losing the child response itself.
 */
export function writeBoundaryError(
  error: unknown,
  context: WriteBoundaryContext
): unknown {
  if (error instanceof SafeToolError && error.code !== "RESULT_TOO_LARGE") {
    return error;
  }
  if (!context.automationStarted) return error;

  if (context.dryRun) {
    return safeError(
      "DRY_RUN_AUTOMATION_FAILED",
      `The ${context.operation} dry-run automation failed. This call requested no mutation and did not enter the mutation branch. No process output was exposed.`
    );
  }

  const target = context.noteId
    ? ` for note ${context.noteId.slice(0, 2048)}`
    : ` in target folder ${(context.folderId ?? "unknown").slice(0, 2048)} with title ${(context.title ?? "unknown").slice(0, 256)}`;
  return safeError(
    "MUTATION_OUTCOME_UNKNOWN",
    `The ${context.operation} mutation may already have occurred${target}, but automation ended without a complete verified response. Re-read or list the target before retrying; do not retry blindly.`
  );
}
