import { createHash } from "node:crypto";

/**
 * Compute a document's version: the SHA-256 of its committed source.
 * @param src The document's source text.
 * @returns The lowercase hex digest, used as the optimistic-concurrency version.
 */
export function docVersion(src: string): string {
  return createHash("sha256").update(src).digest("hex");
}
