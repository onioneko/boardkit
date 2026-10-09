/**
 * Differential test: projecting from the parsed tree against the projection
 * that rewrote the source with hole tokens and parsed the result again (kept
 * frozen in `test/reparse/`), over every document the core test suite parses
 * (`test/corpus/`) and every Markdown file in the repository.
 *
 * The two agree byte for byte except where the token rewrite changed what
 * the markdown says, which the new projection reads as the source does:
 *
 * 1. a typed block directly followed (or preceded) by a text line: the token
 *    made the block part of that paragraph;
 * 2. inline syntax right next to a `{{source:…}}` ref: the token's letters
 *    made a `*` or `_` flanking (emphasis) where the source's `{{`/`}}` do not,
 *    and likewise made an email autolink of a ref followed by `@domain`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AnyBlockType, ParsedDoc, SourceValue } from "@onioneko/boardkit-core";
import { canonicalKey } from "@onioneko/boardkit-core";
import { parseDoc } from "@onioneko/boardkit-core/internal";
import { describe, expect, it } from "vitest";
import { projectHtml as reparseProjectHtml } from "../test/reparse/html.js";
import { projectHtml } from "./html.js";

const here = new URL(".", import.meta.url).pathname;
const repo = join(here, "../../..");

const corpus: string[] = gunzipSync(
  readFileSync(join(here, "../test/corpus/parse-inputs.jsonl.gz")),
)
  .toString("utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as string);

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(path, out);
    else if (entry.name.endsWith(".md")) out.push(readFileSync(path, "utf8"));
  }
  return out;
}

/** A block type whose html hook renders its type and attrs in a `<div>`. */
const hooked = (type: string): AnyBlockType =>
  ({
    type,
    schema: {},
    project: {
      html: (attrs: Record<string, unknown>) => ({
        type: "element",
        tagName: "div",
        properties: { className: [type] },
        children: [{ type: "text", value: JSON.stringify(attrs).slice(0, 40) }],
      }),
    },
  }) as unknown as AnyBlockType;

const TYPES = ["box", "late", "status", "checklist", "metric", "note", "counter", "bold"];
const blockTypes = new Map(TYPES.map((t) => [t, hooked(t)]));
const typeNames = new Set(TYPES);

/** Every source ref resolved to a value that shows which ref it is. */
function valuesOf(doc: ParsedDoc): Map<string, SourceValue> {
  const values = new Map<string, SourceValue>();
  for (const span of doc.refSpans) {
    if (span.ref.kind !== "source") continue;
    values.set(canonicalKey(span.ref), { value: `V<${span.ref.source}>`, stale: false });
  }
  return values;
}

async function both(
  src: string,
  resolve = true,
): Promise<{ readonly next: string; readonly before: string } | undefined> {
  let doc: ParsedDoc;
  try {
    doc = parseDoc(src, { blockTypes: typeNames });
  } catch {
    return undefined; // input too deep for the parser (the complexity tests)
  }
  const values = resolve ? valuesOf(doc) : new Map<string, SourceValue>();
  const opts = { blockTypes };
  return {
    next: await projectHtml(doc, src, values, opts),
    before: await reparseProjectHtml(doc, src, values, opts),
  };
}

const FENCE = /^(`{3,}|~{3,})[ \t]*([A-Za-z][\w-]*)/;

/** `src` with a blank line before and after every typed block's fence. */
function separateTypedBlocks(src: string): string | undefined {
  const out: string[] = [];
  let open: string | undefined;
  let changed = false;
  for (const line of src.split("\n")) {
    if (open === undefined) {
      const m = FENCE.exec(line);
      if (m !== null && typeNames.has(m[2] as string)) {
        open = m[1];
        out.push("", line);
        changed = true;
        continue;
      }
      out.push(line);
    } else {
      out.push(line);
      if (line.trim().startsWith(open as string)) {
        open = undefined;
        out.push("");
      }
    }
  }
  return changed ? out.join("\n") : undefined;
}

/** Whether a `{{source:…}}` ref has inline syntax right next to it (emphasis, an email's `@`). */
function refBesideDelimiter(src: string): boolean {
  return /[*_~]\{\{\s*source:|\}\}[*_~@]/.test(src);
}

type Outcome = "identical" | "typedBlockLine" | "refDelimiter" | "unexplained";

/** How the two projections of `src` compare, or `undefined` when it does not parse. */
async function compare(src: string): Promise<{ outcome: Outcome; detail: string } | undefined> {
  const r = await both(src);
  if (r === undefined) return undefined;
  if (r.next === r.before) return { outcome: "identical", detail: "" };
  // 1. Blank lines around every typed block take the block out of the
  //    paragraph in the token re-parse too; then both agree.
  const separated = separateTypedBlocks(src);
  const again = separated === undefined ? undefined : await both(separated);
  if (again !== undefined && again.next === again.before) {
    return { outcome: "typedBlockLine", detail: "" };
  }
  // 2. Without values there are no tokens, and both read the source.
  if (refBesideDelimiter(src)) {
    const raw = await both(src, false);
    if (raw !== undefined && raw.next === raw.before)
      return { outcome: "refDelimiter", detail: "" };
  }
  const detail = `${JSON.stringify(src.slice(0, 200))}\n  new: ${r.next.slice(0, 300)}\n  old: ${r.before.slice(0, 300)}`;
  return { outcome: "unexplained", detail };
}

async function tally(sources: readonly string[]): Promise<{
  counts: Record<Outcome, number>;
  unexplained: string[];
}> {
  const counts: Record<Outcome, number> = {
    identical: 0,
    typedBlockLine: 0,
    refDelimiter: 0,
    unexplained: 0,
  };
  const unexplained: string[] = [];
  for (const src of sources) {
    const r = await compare(src);
    if (r === undefined) continue;
    counts[r.outcome] += 1;
    if (r.outcome === "unexplained") unexplained.push(r.detail);
  }
  return { counts, unexplained };
}

describe("projection from the parsed tree, against the token re-parse", () => {
  it("matches on the recorded corpus except for the two documented artefacts", async () => {
    const { counts, unexplained } = await tally(corpus);
    expect(unexplained.slice(0, 5)).toEqual([]);
    // The corpus is a fixed file, so the split is exact: a change here means
    // the projection's output changed.
    expect(counts).toMatchInlineSnapshot(`
      {
        "identical": 7697,
        "refDelimiter": 0,
        "typedBlockLine": 2047,
        "unexplained": 0,
      }
    `);
  }, 300_000);

  it("matches on every Markdown file in the repository", async () => {
    const { counts, unexplained } = await tally(markdownFiles(repo));
    expect(unexplained).toEqual([]);
    expect(counts.identical).toBeGreaterThan(0);
  }, 300_000);
});

/** Both projections of `src`, its `box` block hooked and every ref resolved to `V<id>`. */
async function projectEdge(
  src: string,
): Promise<{ readonly next: string; readonly before: string }> {
  const r = await both(src);
  if (r === undefined) throw new Error("unparseable test input");
  return { next: r.next.trim(), before: r.before.trim() };
}

describe("projection from the parsed tree: behaviour changes", () => {
  it("1. keeps a typed block out of the text line right after it", async () => {
    const { next, before } = await projectEdge("```box\nid: b\n```\nprobe\n");
    expect(next).toBe('<p><div class="box">{"id":"b"}</div></p>\n<p>probe</p>');
    // The token re-parse glued the line into the block's paragraph.
    expect(before).toBe('<p><div class="box">{"id":"b"}</div>\nprobe</p>');
  });

  it("1. keeps a typed block out of the text line right before it", async () => {
    const { next, before } = await projectEdge("text\n```box\nid: b\n```\n");
    expect(next).toBe('<p>text</p>\n<p><div class="box">{"id":"b"}</div></p>');
    expect(before).toBe('<p>text\n<div class="box">{"id":"b"}</div></p>');
  });

  it("2. reads emphasis next to a ref by the source's flanking rules", async () => {
    // `*` before `{` and after `}` is not left- or right-flanking around
    // punctuation the way it is around the token's letters: no emphasis.
    const inner = await projectEdge("foo*{{source:a}}*bar\n");
    expect(inner.next).toBe("<p>foo*V&#x3C;a>*bar</p>");
    expect(inner.before).toBe("<p>foo<em>V&#x3C;a></em>bar</p>");
    const strong = await projectEdge("**{{source:a}}**bar\n");
    expect(strong.next).toBe("<p>**V&#x3C;a>**bar</p>");
    expect(strong.before).toBe("<p><strong>V&#x3C;a></strong>bar</p>");
  });

  it("2. finds a heading's anchor exactly where the parser does, next to a ref", async () => {
    // In the source `}}_a {#b_` is emphasis, so the heading has no anchor (its
    // section id is the slug); the token's letters made the `_` intraword.
    const src = "## {{source:p}}_a {#b_}\n";
    const { next, before } = await projectEdge(src);
    expect(parseDoc(src).nodes.map((n) => ("sectionId" in n ? n.sectionId : ""))).not.toContain(
      "b_",
    );
    expect(next).toBe("<h2>V&#x3C;p><em>a {#b</em>}</h2>");
    expect(before).toBe('<h2 id="user-content-b_">V&#x3C;p>_a</h2>');
  });

  it("2. makes no email autolink of a ref followed by `@domain`", async () => {
    const { next, before } = await projectEdge("{{source:p}}@example.com\n");
    expect(next).toBe("<p>V&#x3C;p>@example.com</p>");
    expect(before).toBe('<p><a href="mailto:V<p>@example.com">V&#x3C;p>@example.com</a></p>');
  });

  it.each([
    "*{{source:a}}*\n",
    "_{{source:a}}_x\n",
    "~~{{source:a}}~~\n",
    "www.example.com/{{source:p}}\n",
    "https://x.io/{{source:p}} y\n",
    "<https://x.io/{{source:p}}>\n",
    "\\{{source:a}} {{source:a}}\n",
    "&amp; {{source:a}} &lt; &#123;{{source:b}}\n",
    "a &copy; {{source:a}} \\* {{source:b}}\n",
    "- a\n  {{source:a}} \\* {{source:b}}\n",
    "| a | b |\n|---|---|\n| {{source:a}} | x \\| y |\n",
    "## Head {{source:a}} {#h}\n",
    "[link {{source:a}}](/u) ![{{source:a}}](/i)\n",
    "> {{source:a}}\n> more\n",
    "- [ ] {{source:a}}\n",
    "x\\\n{{source:a}}\n",
    "a {{source:a}}{{source:b}} b\n",
    "{{source:a}}\n===\n",
    "<span>{{source:a}}</span>\n",
    "`{{source:a}}`\n",
    "{{source:rsi symbol=AAPL period=14}} ok\n",
    "[x]: /u\n\n[x] {{source:a}}\n",
    "# A\n\n[^1] {{source:a}}\n\n# B\n\n[^1]: note\n",
    "- ```box\n  id: b\n  ```\n- after\n",
    "> ```box\n> id: b\n> ```\n",
  ])("is unchanged for %j", async (src) => {
    const { next, before } = await projectEdge(src);
    expect(next).toBe(before);
  });
});
