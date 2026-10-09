import { LRUCache } from "lru-cache";
import type { ParsedDoc } from "../model/doc.js";
import { releaseMdast } from "../parse/pipeline.js";
import { docVersion } from "./version.js";

/** Most parses the engine keeps at once. */
export const PARSE_CACHE_MAX_ENTRIES = 256;

/**
 * Most source the engine's parse cache keeps parses of at once: 16 MiB, counted
 * in UTF-16 code units of the sources. A parse retains up to tens of times its
 * source in memory for heading- or block-dense markdown, so the cache is
 * bounded by the size of what it holds as well as by its entry count. A
 * source larger than the whole budget is parsed but never cached.
 */
export const PARSE_CACHE_MAX_SOURCE_BYTES = 16 * 1024 * 1024;

/**
 * Most source whose mdast trees the engine's parse cache keeps at once: 4 MiB,
 * counted in UTF-16 code units of the sources. A parse's mdast tree takes about
 * 10 to 14 times its source in memory (about 2.6 MiB for a 256 KiB document),
 * so this budget holds about 40 to 56 MiB of trees. The html projection reads a
 * kept tree instead of parsing the markdown again (`mdastOf`); the trees
 * of the least recently used parses past the budget are released, and those
 * parses stay cached without them. A source larger than the whole budget keeps
 * no tree.
 */
export const PARSE_CACHE_MAX_TREE_SOURCE_BYTES = 4 * 1024 * 1024;

/**
 * Most failed parses the engine remembers at once. A parse that throws (deep
 * nesting that overflows the stack) can take seconds before it does, so the
 * failure is remembered by content hash like a parse, and the same content is
 * not parsed again until it changes or is evicted.
 */
export const PARSE_CACHE_MAX_FAILURES = 256;

/** A bounded, content-keyed cache of parses. */
export interface ParseCache {
  /**
   * Parse `src`, or return the cached parse of identical content.
   * @param src The document source.
   * @returns The parse and the content hash it is cached under.
   * @throws Whatever the parse threw, for this content now or on an earlier
   *   call: a failed parse is remembered and rethrown without parsing again.
   */
  parse(src: string): { readonly doc: ParsedDoc; readonly hash: string };
  /**
   * The cached parse of `src`, without parsing on a miss.
   * @param src The document source.
   * @returns The cached parse and its hash, or `undefined` when none is cached
   *   (including when a failure is remembered for this content).
   */
  peek(src: string): { readonly doc: ParsedDoc; readonly hash: string } | undefined;
  /**
   * Cache a parse made elsewhere (a write's own parse of the content it
   * stored), as if `parse(src)` had produced it. Its block attrs are frozen.
   * @param src The source `doc` was parsed from.
   * @param doc The parse of `src`.
   * @param hash The content hash of `src`, when the caller already has it.
   * @returns The content hash the parse is cached under.
   */
  seed(src: string, doc: ParsedDoc, hash?: string): string;
  /**
   * Drop the parse (or remembered failure) cached under a content hash.
   * @param hash The content hash.
   */
  delete(hash: string): void;
  /** Drop every cached parse and remembered failure. */
  clear(): void;
  /** Number of cached parses. */
  readonly size: number;
  /** Total size of the sources whose parses are cached. */
  readonly sourceBytes: number;
  /** Total size of the sources whose cached parses still keep their mdast tree. */
  readonly treeSourceBytes: number;
}

/** Freeze a value and everything reachable from it (plain YAML data: objects and arrays). */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

/**
 * Create a parse cache keyed by content hash (`docVersion`), so a changed
 * document can never be served a stale parse. It is an LRU bounded both by
 * entry count and by the total size of the cached sources.
 *
 * Cached parses are shared by every reader, so block attrs are deep-frozen on
 * insert: a block hook or projector that tries to modify them throws (and fails
 * soft) instead of changing what later reads see.
 *
 * Each parse keeps its mdast tree (`mdastOf`) while it is among the most
 * recently used parses whose sources fit the tree budget. Past it, the least
 * recently used parse's tree is released (`releaseMdast`); the parse
 * stays cached. A parse that leaves the cache releases its tree too.
 * @param parse Parses one source (the engine passes `parseDoc` with its options).
 * @param opts Bounds; default to {@link PARSE_CACHE_MAX_ENTRIES},
 *   {@link PARSE_CACHE_MAX_SOURCE_BYTES} and {@link PARSE_CACHE_MAX_TREE_SOURCE_BYTES}.
 * @returns The cache.
 */
export function createParseCache(
  parse: (src: string) => ParsedDoc,
  opts: {
    readonly maxEntries?: number;
    readonly maxSourceBytes?: number;
    readonly maxTreeSourceBytes?: number;
  } = {},
): ParseCache {
  // The parses that still keep their tree, by content hash. Evicting one
  // releases its tree; the parse itself stays in `cache`.
  const trees = new LRUCache<string, ParsedDoc>({
    max: opts.maxEntries ?? PARSE_CACHE_MAX_ENTRIES,
    maxSize: opts.maxTreeSourceBytes ?? PARSE_CACHE_MAX_TREE_SOURCE_BYTES,
    dispose: (doc) => releaseMdast(doc),
  });
  const cache = new LRUCache<string, ParsedDoc>({
    max: opts.maxEntries ?? PARSE_CACHE_MAX_ENTRIES,
    maxSize: opts.maxSourceBytes ?? PARSE_CACHE_MAX_SOURCE_BYTES,
    // A parse that leaves the cache (evicted, deleted, cleared) gives up its tree.
    dispose: (_doc, hash) => {
      trees.delete(hash);
    },
  });
  /** A cache hit: the parse, its tree kept as recently used. */
  const hit = (hash: string): ParsedDoc | undefined => {
    const doc = cache.get(hash);
    if (doc !== undefined) trees.get(hash);
    return doc;
  };
  // The thrown value, boxed so that any value (even `undefined`) can be stored.
  const failures = new LRUCache<string, { readonly thrown: unknown }>({
    max: PARSE_CACHE_MAX_FAILURES,
  });
  const insert = (hash: string, src: string, doc: ParsedDoc): void => {
    for (const node of doc.nodes) if ("blockId" in node) deepFreeze(node.attrs);
    const size = Math.max(1, src.length);
    cache.set(hash, doc, { size });
    // A source over the whole tree budget is not admitted, so release its tree here.
    if (cache.has(hash)) trees.set(hash, doc, { size });
    if (!trees.has(hash)) releaseMdast(doc);
  };
  return {
    parse(src) {
      const hash = docVersion(src);
      let doc = hit(hash);
      if (doc === undefined) {
        const failed = failures.get(hash);
        if (failed !== undefined) throw failed.thrown;
        try {
          doc = parse(src);
        } catch (thrown) {
          failures.set(hash, { thrown });
          throw thrown;
        }
        insert(hash, src, doc);
      }
      return { doc, hash };
    },
    peek(src) {
      const hash = docVersion(src);
      const doc = hit(hash);
      return doc === undefined ? undefined : { doc, hash };
    },
    seed(src, doc, hash = docVersion(src)) {
      failures.delete(hash);
      if (hit(hash) === undefined) insert(hash, src, doc);
      return hash;
    },
    delete(hash) {
      cache.delete(hash);
      failures.delete(hash);
    },
    clear() {
      cache.clear();
      failures.clear();
    },
    get size() {
      return cache.size;
    },
    get sourceBytes() {
      return cache.calculatedSize;
    },
    get treeSourceBytes() {
      return trees.calculatedSize;
    },
  };
}
