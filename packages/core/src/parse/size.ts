import { type Diagnostic, diagnostic } from "../model/diagnostic.js";
import type { DocId } from "../model/ids.js";
import type { Storage } from "../ports/ports.js";

/**
 * The default document size limit (`EngineOptions.maxDocumentBytes`):
 * 256 KiB of source, measured in UTF-8 bytes. Parsing cost grows with document
 * size, and faster than linearly for some markdown shapes, so a document over
 * the limit is never parsed.
 */
export const DEFAULT_MAX_DOCUMENT_BYTES = 256 * 1024;

/**
 * UTF-8 byte length of a string, without allocating.
 * @param src The text to measure.
 * @returns Its length in UTF-8 bytes (a lone surrogate counts as 3).
 */
export function utf8ByteLength(src: string): number {
  let bytes = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < src.length) {
      const next = src.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Whether a document's source is over the size limit.
 * @param src The document source.
 * @param maxBytes The limit in UTF-8 bytes.
 * @returns True when the source takes more than `maxBytes` UTF-8 bytes.
 */
export function exceedsDocumentLimit(src: string, maxBytes: number): boolean {
  // Every UTF-16 code unit takes 1 to 3 UTF-8 bytes (a surrogate pair takes 4
  // for its 2 units), so the exact count is only needed between the bounds.
  if (src.length > maxBytes) return true;
  if (src.length * 3 <= maxBytes) return false;
  return utf8ByteLength(src) > maxBytes;
}

/**
 * The `E_DOCUMENT_TOO_LARGE` diagnostic for a source over the size limit.
 * @param docId The document the source belongs to.
 * @param src The document source.
 * @param maxBytes The limit in UTF-8 bytes.
 * @param action `"write"` for a proposed write that is not stored, `"read"` for
 *   a stored document that is not parsed.
 * @returns The diagnostic, or `undefined` when the source fits.
 */
export function documentSizeDiagnostic(
  docId: string,
  src: string,
  maxBytes: number,
  action: "write" | "read",
): Diagnostic | undefined {
  if (!exceedsDocumentLimit(src, maxBytes)) return undefined;
  return documentBytesDiagnostic(docId, utf8ByteLength(src), maxBytes, action);
}

/**
 * The `E_DOCUMENT_TOO_LARGE` diagnostic for a document of a known size, such
 * as a stored document's size from `Storage.size`, checked before it is read.
 * @param docId The document.
 * @param bytes Its size in bytes.
 * @param maxBytes The limit in UTF-8 bytes.
 * @param action `"write"` for a proposed write that is not stored, `"read"` for
 *   a stored document that is not parsed.
 * @returns The diagnostic, or `undefined` when the size fits.
 */
export function documentBytesDiagnostic(
  docId: string,
  bytes: number,
  maxBytes: number,
  action: "write" | "read",
): Diagnostic | undefined {
  if (bytes <= maxBytes) return undefined;
  const size = `${bytes} bytes, over the limit of ${maxBytes} bytes`;
  return diagnostic(
    "E_DOCUMENT_TOO_LARGE",
    action === "write"
      ? `document ${JSON.stringify(docId)} would be ${size}; the write was not stored`
      : `document ${JSON.stringify(docId)} is ${size}; it was not parsed`,
    { nodeId: docId },
  );
}

/**
 * Validate a `maxDocumentBytes` option.
 * @param value The option as passed (`undefined` takes the default).
 * @returns The limit in UTF-8 bytes.
 * @throws TypeError when the value is not a non-negative integer or `Infinity`.
 */
export function resolveMaxDocumentBytes(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_DOCUMENT_BYTES;
  if (typeof value !== "number") {
    throw new TypeError(
      `maxDocumentBytes must be a non-negative integer or Infinity, got a ${value === null ? "null" : typeof value} (${JSON.stringify(value)})`,
    );
  }
  if (value !== Number.POSITIVE_INFINITY && !(Number.isInteger(value) && value >= 0)) {
    throw new TypeError(
      `maxDocumentBytes must be a non-negative integer or Infinity, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * The `E_DOCUMENT_TOO_LARGE` diagnostic for a stored document whose
 * `Storage.size` is over the limit, found without reading it. `undefined` when
 * the storage has no `size`, the size is unknown or within the limit, the
 * limit is infinite, or `size` throws: the caller then reads the document and
 * checks its source.
 * @param storage Where the document is stored.
 * @param docId The document.
 * @param maxDocumentBytes The limit in UTF-8 bytes.
 * @returns The diagnostic, or `undefined` when the document must be read to tell.
 */
export async function sizeOverLimit(
  storage: Pick<Storage, "size">,
  docId: DocId,
  maxDocumentBytes: number,
): Promise<Diagnostic | undefined> {
  if (storage.size === undefined || maxDocumentBytes === Number.POSITIVE_INFINITY) {
    return undefined;
  }
  let bytes: number | undefined;
  try {
    bytes = await storage.size(docId);
  } catch {
    return undefined; // fail-soft: the read decides
  }
  if (bytes === undefined) return undefined;
  return documentBytesDiagnostic(docId, bytes, maxDocumentBytes, "read");
}
