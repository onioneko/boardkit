/**
 * Validation and parse diagnostics. Content errors are reported through
 * diagnostics (fail-soft); exceptions are reserved for programming errors.
 */

/** A validation or parse diagnostic: stable code, message, and optional source position. */
export interface Diagnostic {
  /** Stable, greppable error code, e.g. `"E_FRONTMATTER_STABILITY"`. */
  readonly code: string;
  /** Human-readable description of the problem. */
  readonly message: string;
  /** 1-based line of the offending source, when a position is known. */
  readonly line?: number;
  /** 1-based column of the offending source, when a position is known. */
  readonly col?: number;
  /** Identifier of the node the diagnostic refers to (doc/section/block), when known. */
  readonly nodeId?: string;
  /** Severity; defaults to `"error"` when omitted by callers. Hosts use it to tell info notes from hard errors. */
  readonly severity?: "error" | "info";
}

/**
 * Create a diagnostic; unspecified fields other than `severity` are omitted from
 * the result. `severity` defaults to `"error"`.
 * @param code Stable error code, e.g. `"E_FRONTMATTER_STABILITY"`.
 * @param message Human-readable description of the problem.
 * @param opts Optional source position (`line`/`col`), the node id the
 * diagnostic refers to, and/or an explicit `severity`.
 * @returns A diagnostic carrying the provided fields plus a `severity`.
 */
export function diagnostic(
  code: string,
  message: string,
  opts?: { line?: number; col?: number; nodeId?: string; severity?: "error" | "info" },
): Diagnostic {
  return { code, message, ...opts, severity: opts?.severity ?? "error" };
}
