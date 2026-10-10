import type { Diagnostic } from "./diagnostic.js";
import { diagnostic } from "./diagnostic.js";

/** Document identifier: workspace-relative path without extension (e.g. `research/q3-review`). */
export type DocId = string & { readonly __brand: "DocId" };

/** Section identifier: explicit `{#anchor}` or heading slug, unique within its document. */
export type SectionId = string & { readonly __brand: "SectionId" };

/** Block identifier: the `id` field of a typed block, unique within its document. */
export type BlockId = string & { readonly __brand: "BlockId" };

/**
 * Brand a plain string as a DocId. The engine treats identifiers as opaque;
 * branding here is a compile-time guard against mixing document ids with
 * other string identifiers.
 * @param value The workspace-relative document path without its extension.
 * @returns The same string, typed as a DocId.
 */
export function asDocId(value: string): DocId {
  return value as DocId;
}

/**
 * Brand a plain string as a SectionId (an explicit `{#anchor}` or a heading
 * slug, unique within its document).
 * @param value The anchor or slug string to brand.
 * @returns The same string, typed as a SectionId.
 */
export function asSectionId(value: string): SectionId {
  return value as SectionId;
}

/**
 * Brand a plain string as a BlockId (the `id` field of a typed block, unique
 * within its document).
 * @param value The block id string to brand.
 * @returns The same string, typed as a BlockId.
 */
export function asBlockId(value: string): BlockId {
  return value as BlockId;
}

/** The result of validating an id string at the engine boundary: the branded id or a diagnostic. */
export type ValidatedId<T> =
  | { readonly ok: true; readonly id: T }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

/** The document extension a docId is the path *without*. */
const DOC_EXT = ".md";

/**
 * Explain why a string is not a valid docId, or `undefined` when it is one.
 * DocIds are workspace-relative `a/b/c` paths naming a markdown document
 * without its extension, so absolute paths, backslashes, empty/`.`/`..` path
 * segments, and a trailing `.md` are all rejected at the boundary.
 */
function docIdProblem(value: string): string | undefined {
  if (value.length === 0) return "an id must not be empty";
  if (value.startsWith("/")) return "a docId is workspace-relative, not an absolute path";
  if (value.includes("\\")) return 'a docId separates path segments with "/", not "\\"';
  if (value.endsWith(DOC_EXT)) {
    return `a docId is the workspace-relative path without the "${DOC_EXT}" extension`;
  }
  for (const segment of value.split("/")) {
    if (segment.length === 0) return "a docId has no empty path segment";
    if (segment === "." || segment === "..") return `a docId has no "${segment}" path segment`;
  }
  return undefined;
}

/**
 * Validate a `docId` string at the engine boundary and brand it. A docId is the
 * workspace-relative path of a document without its `.md` extension, so this
 * rejects the empty string, absolute paths (a leading `/`), backslashes, empty
 * `.` or `..` path segments (`a//b`, `trailing/`, `./x`, `../x`), and a
 * trailing `.md`. Fail-soft: the caller reports the returned diagnostic rather
 * than throwing.
 * @param value The docId string a consumer supplied.
 * @returns The branded DocId, or a diagnostic describing why the id is invalid.
 */
export function tryDocId(value: string): ValidatedId<DocId> {
  const problem = docIdProblem(value);
  return problem === undefined
    ? { ok: true, id: asDocId(value) }
    : {
        ok: false,
        diagnostic: diagnostic(
          "E_INVALID_ID",
          `invalid document id ${JSON.stringify(value)}: ${problem}`,
        ),
      };
}

/**
 * Validate a `blockId` string at the engine boundary and brand it. Rejects an
 * empty string (fail-soft: the caller reports the returned diagnostic rather
 * than throwing). Block ids are YAML `id` fields, not paths.
 * @param value The blockId string a consumer supplied.
 * @returns The branded BlockId, or a diagnostic describing why the id is invalid.
 */
export function tryBlockId(value: string): ValidatedId<BlockId> {
  return value.length === 0
    ? { ok: false, diagnostic: diagnostic("E_INVALID_ID", "invalid block id: empty string") }
    : { ok: true, id: asBlockId(value) };
}
