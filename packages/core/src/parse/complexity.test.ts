import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ComplexityLimits,
  DEFAULT_COMPLEXITY_LIMITS,
  delimiterRunCan,
  documentComplexityDiagnostic,
  fencedCodeLines,
  resolveComplexityLimits,
} from "./complexity.js";

const limits = DEFAULT_COMPLEXITY_LIMITS;

function check(src: string, l: Required<ComplexityLimits> = limits) {
  return documentComplexityDiagnostic("d", src, l, "read");
}

/** Directories that hold no repository markdown of our own. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...markdownFiles(full));
    } else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * The number of character reads `documentComplexityDiagnostic` makes on `src`:
 * every string method the scanner calls on its input is counted, and a
 * `slice` or `startsWith` counts the characters it covers.
 */
function stepsOf(src: string): number {
  let steps = 0;
  const counted = {
    get length(): number {
      return src.length;
    },
    charCodeAt(i: number): number {
      steps += 1;
      return src.charCodeAt(i);
    },
    charAt(i: number): string {
      steps += 1;
      return src.charAt(i);
    },
    codePointAt(i: number): number | undefined {
      steps += 1;
      return src.codePointAt(i);
    },
    slice(start?: number, end?: number): string {
      const out = src.slice(start, end);
      steps += Math.max(1, out.length);
      return out;
    },
    startsWith(search: string, at?: number): boolean {
      steps += Math.max(1, search.length);
      return src.startsWith(search, at);
    },
  };
  const result = documentComplexityDiagnostic("d", counted as unknown as string, limits, "read");
  // The stand-in must not change the outcome.
  expect(result).toEqual(check(src));
  return steps;
}

describe("documentComplexityDiagnostic", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_COMPLEXITY_LIMITS).toEqual({
      maxContainerDepth: 32,
      maxIndentColumns: 160,
      maxBracketDepth: 32,
      maxDelimiterRun: 64,
      maxEmphasisDepth: 256,
    });
    expect(Object.isFrozen(DEFAULT_COMPLEXITY_LIMITS)).toBe(true);
  });

  it("accepts ordinary markdown", () => {
    expect(check("")).toBeUndefined();
    expect(
      check("# t\n\n> quote\n> > nested\n\n- a\n  - b\n    1. c\n\n[^n]: note\n"),
    ).toBeUndefined();
  });

  describe("maxContainerDepth", () => {
    it("accepts n blockquote markers on one line and rejects n + 1", () => {
      expect(check(`${">".repeat(32)} x\n`)).toBeUndefined();
      const d = check(`# t\n\n${">".repeat(33)} x\n`);
      expect(d).toMatchObject({ code: "E_DOCUMENT_TOO_COMPLEX", line: 3, nodeId: "d" });
      expect(d?.message).toContain("maxContainerDepth");
    });

    it("counts list markers, ordered markers, footnote definitions and spaced quotes", () => {
      expect(check(`${"- ".repeat(32)}x\n`)).toBeUndefined();
      expect(check(`${"- ".repeat(33)}x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"1. ".repeat(33)}x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"2) ".repeat(33)}x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"- > ".repeat(17)}x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"> ".repeat(33)}x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"[^a]: ".repeat(33)}x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"* ".repeat(16)}${"+ ".repeat(17)}x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("does not count markers after the line's content starts", () => {
      expect(check(`x ${"- ".repeat(100)}\n`)).toBeUndefined();
      expect(check(`x ${">".repeat(100)}\n`)).toBeUndefined();
      // A dash or digit run not followed by whitespace is content, not a marker.
      expect(check(`${"-".repeat(60)}\n`)).toBeUndefined();
      expect(check(`${"1.".repeat(40)}\n`)).toBeUndefined();
    });

    it("counts per line, not per document", () => {
      expect(check(`${">".repeat(32)} x\n`.repeat(100))).toBeUndefined();
    });
  });

  describe("maxIndentColumns", () => {
    it("accepts n columns of prefix indentation and rejects n + 1", () => {
      expect(check(`${" ".repeat(160)}x\n`)).toBeUndefined();
      const d = check(`a\n${" ".repeat(161)}x\n`);
      expect(d).toMatchObject({ code: "E_DOCUMENT_TOO_COMPLEX", line: 2 });
      expect(d?.message).toContain("maxIndentColumns");
    });

    it("expands tabs to the next multiple of 4", () => {
      expect(check(`${"\t".repeat(40)}x\n`)).toBeUndefined();
      expect(check(`${"\t".repeat(41)}x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      // One space then a tab is 4 columns, not 5.
      expect(check(`${" \t".repeat(40)}x\n`)).toBeUndefined();
      expect(check(`${" \t".repeat(40)} x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("counts whitespace between container markers", () => {
      // 20 markers, each followed by 8 spaces: 160 columns of whitespace.
      expect(check(`${"-        ".repeat(20)}x\n`)).toBeUndefined();
      expect(check(`${"-        ".repeat(20)} x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("ignores a line that holds only whitespace", () => {
      expect(check(`a\n${" ".repeat(500)}\nb\n`)).toBeUndefined();
    });
  });

  describe("maxBracketDepth", () => {
    it("accepts n nested brackets in a paragraph and rejects n + 1", () => {
      expect(check(`${"[".repeat(32)}x\n`)).toBeUndefined();
      const d = check(`${"[".repeat(33)}x\n`);
      expect(d?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(d?.message).toContain("maxBracketDepth");
    });

    it("tracks nesting across lines of one paragraph", () => {
      const lines = `${"[\n".repeat(33)}x\n`;
      expect(check(lines)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("resets at a blank line", () => {
      const para = `${"[".repeat(20)}x\n`;
      expect(check(`${para}\n${para}\n${para}`)).toBeUndefined();
      expect(check(`${para}${para}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      // A line of only whitespace is blank too.
      expect(check(`${para}   \n${para}`)).toBeUndefined();
    });

    it("lets a closing bracket lower the depth", () => {
      expect(check(`${"[a] ".repeat(500)}\n`)).toBeUndefined();
      expect(check(`${"[".repeat(30)}${"]".repeat(30)}${"[".repeat(30)}\n`)).toBeUndefined();
      // A stray `]` does not go below zero and so cannot bank depth.
      expect(check(`${"]".repeat(100)}${"[".repeat(32)}\n`)).toBeUndefined();
    });

    it("skips escaped brackets", () => {
      expect(check(`${"\\[".repeat(100)}\n`)).toBeUndefined();
      // An escaped backslash does not escape the bracket after it.
      expect(check(`${"\\\\[".repeat(33)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });
  });

  describe("paragraph resets", () => {
    it("does not reset on a line holding only a list or footnote marker", () => {
      // An empty list item cannot interrupt a paragraph, so the brackets on both
      // sides of it nest in one paragraph.
      for (const marker of ["*", "+", "-", "1.", "2)", "[^a]:", "  *"]) {
        const src = `${"[".repeat(20)}\n${marker}\n${"[".repeat(20)}x\n`;
        expect({ marker, code: check(src)?.code }).toEqual({
          marker,
          code: "E_DOCUMENT_TOO_COMPLEX",
        });
      }
    });

    it("refuses the empty-list-item bracket bypass", () => {
      const src = `${`${"[".repeat(30)}\n*\n`.repeat(300)}x${"](u)".repeat(9000)}\n`;
      expect(check(src)?.message).toContain("maxBracketDepth");
    });

    it("still resets on a blank line or a line of only `>` markers", () => {
      const para = `${"[".repeat(20)}x\n`;
      expect(check(`${para}>\n${para}`)).toBeUndefined();
      expect(check(`${para}> >  \n${para}`)).toBeUndefined();
      expect(check(`${para} \t\n${para}`)).toBeUndefined();
    });
  });

  describe("thematic break and fence lines", () => {
    it("does not count a line of one delimiter character as a run", () => {
      for (const ch of ["*", "_", "~", "-", "`"]) {
        expect(check(`a\n\n${ch.repeat(80)}\n\nb\n`)).toBeUndefined();
        expect(check(`${`${ch} `.repeat(20)}${ch.repeat(70)}  \n`)).toBeUndefined();
      }
      // A fence of 70 tildes around code.
      expect(check(`${"~".repeat(70)}\ncode\n${"~".repeat(70)}\n`)).toBeUndefined();
    });

    it("still counts a run on a line with other content", () => {
      expect(check(`${"_".repeat(80)} x\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`x ${"~".repeat(70)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"*".repeat(40)}${"_".repeat(40)}\n`)).toBeUndefined();
    });
  });

  describe("maxEmphasisDepth", () => {
    it("accepts n unclosed openers in a paragraph and rejects n + 1", () => {
      expect(check(`${"*a ".repeat(256)}\n`)).toBeUndefined();
      const d = check(`${"*a ".repeat(257)}\n`);
      expect(d?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(d?.message).toContain("maxEmphasisDepth");
      // A run opens as many levels as it has characters.
      expect(check(`${"**a ".repeat(128)}\n`)).toBeUndefined();
      expect(check(`${"**a ".repeat(129)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"~a ".repeat(257)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("refuses deeply nested alternating emphasis", () => {
      const src = `${"*a _b ".repeat(3000)}x${" b_ a*".repeat(3000)}\n`;
      expect(check(src)?.message).toContain("maxEmphasisDepth");
    });

    it("refuses the mixed-marker shape that overflowed the parser within the old estimate", () => {
      // 39 KB: runs next to other markers open in micromark, closers only match
      // their own marker, and both-flanking runs can open.
      const src = `${" ~~a*_".repeat(3000)}x${"**(*_~~".repeat(3000)}\n`;
      expect(src.length).toBeGreaterThan(38_000);
      expect(check(src)?.message).toContain("maxEmphasisDepth");
    });

    it("keeps one count per marker: a closer only lowers its own", () => {
      expect(check(`${"_a ".repeat(160)}${"a** ".repeat(160)}${"_a ".repeat(120)}\n`)?.code).toBe(
        "E_DOCUMENT_TOO_COMPLEX",
      );
    });

    it("counts a run that can both open and close", () => {
      // Intraword stars can open (and close), so a long enough run of them in
      // one paragraph is refused: a known false positive.
      expect(check(`${"2*3 ".repeat(256)}\n`)).toBeUndefined();
      expect(check(`${"2*3 ".repeat(257)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("treats a run before another attention marker as an opener, as micromark does", () => {
      // `a*_`: plain flanking says the `*` can only close; micromark lets a run
      // followed by another marker open too.
      expect(delimiterRunCan(0x2a, 1, "a", "_")).toEqual({ open: true, close: true });
      expect(delimiterRunCan(0x2a, 1, "a", " ")).toEqual({ open: false, close: true });
      expect(delimiterRunCan(0x5f, 1, "a", "b")).toEqual({ open: false, close: false });
      expect(delimiterRunCan(0x7e, 3, " ", "a")).toEqual({ open: false, close: false });
    });

    it("lets closers lower the depth", () => {
      expect(check(`${"*a* **b** _c_ ~d~ ".repeat(500)}\n`)).toBeUndefined();
      expect(
        check(`${"*a ".repeat(60)}x${" a*".repeat(60)} ${"*a ".repeat(60)}\n`),
      ).toBeUndefined();
      // A stray closer does not go below zero and so cannot bank depth.
      expect(check(`${"a* ".repeat(100)}${"*a ".repeat(256)}\n`)).toBeUndefined();
    });

    it("does not count intraword underscores, unflanked stars or escapes", () => {
      expect(check(`${"snake_case_name ".repeat(200)}\n`)).toBeUndefined();
      expect(check(`${"\\*a ".repeat(200)}\n`)).toBeUndefined();
      expect(check(`${"* a ".repeat(10)}${"a * b ".repeat(200)}\n`)).toBeUndefined();
    });

    it("counts openers after Unicode punctuation", () => {
      // CommonMark treats Unicode punctuation like ASCII punctuation here.
      expect(check(`${"「*a ".repeat(257)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"「_a ".repeat(257)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("tracks depth across the lines of a paragraph and resets at a blank line", () => {
      expect(check(`${"*a\n".repeat(257)}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"*a ".repeat(200)}\n\n${"*a ".repeat(200)}\n`)).toBeUndefined();
    });

    it("accepts the technical markdown the review found refused at the old default", () => {
      const globTable = `| pattern | what |\n|---|---|\n${"| `src/**/*.ts` | sources |\n".repeat(40)}`;
      const mdTable = `| file | note |\n|---|---|\n${"| `*.md` | docs |\n".repeat(70)}`;
      const tightList = "- `*.ts` files\n".repeat(70);
      const regexFence = `\`\`\`python\n${"re.compile(r'.*foo.*')\n".repeat(80)}\`\`\`\n`;
      for (const [name, src] of Object.entries({ globTable, mdTable, tightList, regexFence })) {
        expect({ name, d: check(src) }).toEqual({ name, d: undefined });
      }
    });

    it("still refuses emphasis nested past the new limit in prose", () => {
      const src = `${"*a _b ".repeat(130)}x${" b_ a*".repeat(130)}\n`;
      expect(check(src)?.message).toContain("maxEmphasisDepth");
    });
  });

  describe("fenced code", () => {
    const regex = "re.compile(r'.*foo.*')\n".repeat(300);
    const deep = `${"*a ".repeat(300)}\n`;

    it("skips the content of a closed fence, and scans the prose after it", () => {
      expect(check(regex)?.message).toContain("maxEmphasisDepth");
      expect(check(`\`\`\`\n${regex}\`\`\`\n`)).toBeUndefined();
      expect(check(`~~~~ text\n${regex}~~~~~~\n`)).toBeUndefined();
      expect(check(`> \`\`\`\n${regex.replace(/^/gm, "> ")}> \`\`\`\n`)).toBeUndefined();
      expect(check(`\`\`\`\n${regex}\`\`\`\n\n${deep}`)?.line).toBe(304);
    });

    it("skips brackets and delimiter runs inside a fence", () => {
      expect(check(`\`\`\`\n${"x.append('[')\n".repeat(40)}\`\`\`\n`)).toBeUndefined();
      const stars = `x = '${"*".repeat(80)}'\n`;
      expect(check(stars)?.message).toContain("maxDelimiterRun");
      expect(check(`\`\`\`\n${stars}\`\`\`\n`)).toBeUndefined();
    });

    it("runs an unclosed fence to the end of the document", () => {
      expect(check(`\`\`\`\n${regex}`)).toBeUndefined();
    });

    it("does not close on a shorter or different fence", () => {
      expect(check(`\`\`\`\`\n\`\`\`\n${regex}\`\`\`\`\n`)).toBeUndefined();
      expect(check(`\`\`\`\n~~~\n${regex}\`\`\`\n`)).toBeUndefined();
      expect(check(`\`\`\`\n\`\`\` x\n${regex}\`\`\`\n`)).toBeUndefined();
      // Closing fences may be indented up to 3 spaces; 4 is code.
      expect(check(`\`\`\`\n    \`\`\`\n${regex}`)).toBeUndefined();
      expect(check(`\`\`\`\n   \`\`\`\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("ends a fence in a block quote at the first line outside the quote", () => {
      expect(check(`> \`\`\`\n> code\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`> \`\`\`\n> code\n\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`> > \`\`\`\n> > code\n> ${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("does not treat look-alikes as fences", () => {
      // A backtick fence's info string cannot hold a backtick.
      expect(check(`\`\`\`a\`b\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      // Indented 4 spaces: code or paragraph text, not a fence.
      expect(check(`    \`\`\`\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      // Two backticks are not a fence.
      expect(check(`\`\`\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("does not let a fence-like line inside HTML or front matter hide prose", () => {
      expect(check(`<!--\n\`\`\`\n-->\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`<div>\n\`\`\`\n</div>\n\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`---\na: \`\`\`\n\`\`\`\n---\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("does not let a fence it cannot follow hide prose", () => {
      // A fence in a list item ends where the item does, which the scan does
      // not track: it stops skipping fences altogether.
      expect(check(`- ~~~\n  \`\`\`\nx\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`  ~~~~\n\`\`\`\n  ~~~~\n${deep}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("marks the lines it skips", () => {
      const flags = fencedCodeLines("a\n```\nb\n```\nc\n> ~~~\n> d\ne\n");
      expect([...flags]).toEqual([0, 2, 1, 1, 0, 2, 1, 0]);
    });
  });

  describe("maxDelimiterRun", () => {
    it("accepts a run of n and rejects n + 1, for each delimiter", () => {
      for (const ch of ["*", "_", "~"]) {
        expect(check(`a${ch.repeat(64)}b\n`)).toBeUndefined();
        const d = check(`a${ch.repeat(65)}b\n`);
        expect(d?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
        expect(d?.message).toContain("maxDelimiterRun");
      }
    });

    it("counts runs of one character only", () => {
      const runsOnly = { ...limits, maxEmphasisDepth: Infinity };
      expect(check(`a${"*_".repeat(100)}b\n`, runsOnly)).toBeUndefined();
      expect(check(`a${"*".repeat(40)}${"_".repeat(40)}b\n`, runsOnly)).toBeUndefined();
    });

    it("skips escaped delimiters", () => {
      expect(check(`a${"\\*".repeat(100)}b\n`)).toBeUndefined();
      expect(check(`a${"*".repeat(40)}\\*${"*".repeat(40)}b\n`)).toBeUndefined();
    });
  });

  it("reports the write phase in its message", () => {
    const write = documentComplexityDiagnostic("d", `${">".repeat(40)}\n`, limits, "write");
    expect(write?.message).toContain("not stored");
    const read = documentComplexityDiagnostic("d", `${">".repeat(40)}\n`, limits, "read");
    expect(read?.message).toContain("not parsed");
  });

  it("treats Infinity as no bound", () => {
    const open = {
      maxContainerDepth: Infinity,
      maxIndentColumns: Infinity,
      maxBracketDepth: Infinity,
      maxDelimiterRun: Infinity,
      maxEmphasisDepth: Infinity,
    };
    expect(
      check(`${">".repeat(8000)} ${"[".repeat(100)}${"*".repeat(100)}\n`, open),
    ).toBeUndefined();
  });

  it("accepts fin.md and every markdown fixture", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = [
      ...markdownFiles(path.join(here, "../../test/fixtures")),
      ...markdownFiles(path.join(here, "../../../html/test/fixtures")),
    ];
    expect(files.some((f) => f.endsWith("fin.md"))).toBe(true);
    for (const file of files) {
      expect({ file, d: check(readFileSync(file, "utf8")) }).toEqual({ file, d: undefined });
    }
  });

  it("accepts every markdown file in the repository", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    const files = markdownFiles(root);
    expect(files.some((f) => f.endsWith("CONTRIBUTING.md"))).toBe(true);
    expect(files.length).toBeGreaterThan(30);
    const refused = files
      .map((file) => ({ file: path.relative(root, file), d: check(readFileSync(file, "utf8")) }))
      .filter((r) => r.d !== undefined)
      .map((r) => `${r.file}: ${r.d?.message}`);
    expect(refused).toEqual([]);
  });

  it("scans in linear time (counted string accesses, not wall-clock time)", () => {
    // Same byte count, very different shapes: a hostile document must not cost
    // more per byte to scan than a bounded constant (each is within the limits,
    // so the whole input is scanned). The cost is the number of character
    // reads the scanner makes, counted through a string stand-in, so the
    // assertion is deterministic and cannot flake on a busy machine.
    const size = 64 * 1024;
    const fill = (unit: string, bytes = size): string =>
      unit.repeat(Math.floor(bytes / unit.length));
    const shapes: Record<string, string> = {
      prose: "lorem ipsum dolor sit amet\n",
      nested: `${"> ".repeat(32)}*a* _b_ ~c~ [a]\n`,
      indented: `${" ".repeat(150)}x\n`,
      brackets: `${"[".repeat(30)}${"]".repeat(30)}\n`,
      delims: `${"*".repeat(30)}a${"*".repeat(30)} ${"_".repeat(60)}\n`,
      fenced: "```\ncode *a* [b\n```\n",
    };
    for (const [name, unit] of Object.entries(shapes)) {
      const src = fill(unit);
      expect({ name, d: check(src) }).toEqual({ name, d: undefined });
      const perChar = stepsOf(src) / src.length;
      expect({ name, perChar: perChar <= 12 }).toEqual({ name, perChar: true });
      // Doubling the input doubles the reads: a linear scan of a repeated unit
      // lands within a fraction of a percent of 2, and even a small quadratic
      // term (n²/10⁶ extra reads) pushes the ratio past 2.02.
      const twice = fill(unit, 2 * size);
      const ratio = stepsOf(twice) / stepsOf(src);
      expect({ name, ratio: Math.abs(ratio - 2) < 0.005 }).toEqual({ name, ratio: true });
    }
  });
});

describe("resolveComplexityLimits", () => {
  it("fills absent fields with the defaults and passes false through", () => {
    expect(resolveComplexityLimits(undefined)).toEqual(DEFAULT_COMPLEXITY_LIMITS);
    expect(resolveComplexityLimits(false)).toBe(false);
    expect(resolveComplexityLimits({ maxBracketDepth: 8 })).toEqual({
      ...DEFAULT_COMPLEXITY_LIMITS,
      maxBracketDepth: 8,
    });
    expect(resolveComplexityLimits({ maxContainerDepth: Infinity })).toMatchObject({
      maxContainerDepth: Infinity,
    });
  });

  it("throws a TypeError for an invalid value or an unknown field", () => {
    for (const bad of [
      true,
      null,
      [],
      5,
      { maxBracketDepth: -1 },
      { maxBracketDepth: 1.5 },
      { maxBracketDepth: "3" },
      { maxBracketDepth: Number.NaN },
      { maxDepth: 3 },
    ]) {
      expect(() => resolveComplexityLimits(bad as unknown as ComplexityLimits)).toThrow(TypeError);
    }
  });
});
