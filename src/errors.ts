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
