import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ComplexityLimits,
  DEFAULT_COMPLEXITY_LIMITS,
  documentComplexityDiagnostic,
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

function timed(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe("documentComplexityDiagnostic", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_COMPLEXITY_LIMITS).toEqual({
      maxContainerDepth: 32,
      maxIndentColumns: 160,
      maxBracketDepth: 32,
      maxDelimiterRun: 64,
      maxEmphasisDepth: 64,
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
      expect(check(`${"~".repeat(70)}python\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"*".repeat(40)}${"_".repeat(40)}\n`)).toBeUndefined();
    });
  });

  describe("maxEmphasisDepth", () => {
    it("accepts n unclosed openers in a paragraph and rejects n + 1", () => {
      expect(check(`${"*a ".repeat(64)}\n`)).toBeUndefined();
      const d = check(`${"*a ".repeat(65)}\n`);
      expect(d?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(d?.message).toContain("maxEmphasisDepth");
      // A run opens as many levels as it has characters.
      expect(check(`${"**a ".repeat(32)}\n`)).toBeUndefined();
      expect(check(`${"**a ".repeat(33)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"~a ".repeat(65)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
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
      expect(check(`${"_a ".repeat(40)}${"a** ".repeat(40)}${"_a ".repeat(30)}\n`)?.code).toBe(
        "E_DOCUMENT_TOO_COMPLEX",
      );
    });

    it("counts a run that can both open and close", () => {
      // Intraword stars can open (and close), so a long enough run of them in
      // one paragraph is refused: a known false positive.
      expect(check(`${"2*3 ".repeat(64)}\n`)).toBeUndefined();
      expect(check(`${"2*3 ".repeat(65)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("lets closers lower the depth", () => {
      expect(check(`${"*a* **b** _c_ ~d~ ".repeat(500)}\n`)).toBeUndefined();
      expect(
        check(`${"*a ".repeat(60)}x${" a*".repeat(60)} ${"*a ".repeat(60)}\n`),
      ).toBeUndefined();
      // A stray closer does not go below zero and so cannot bank depth.
      expect(check(`${"a* ".repeat(100)}${"*a ".repeat(64)}\n`)).toBeUndefined();
    });

    it("does not count intraword underscores, unflanked stars or escapes", () => {
      expect(check(`${"snake_case_name ".repeat(200)}\n`)).toBeUndefined();
      expect(check(`${"\\*a ".repeat(200)}\n`)).toBeUndefined();
      expect(check(`${"* a ".repeat(10)}${"a * b ".repeat(200)}\n`)).toBeUndefined();
    });

    it("counts openers after Unicode punctuation", () => {
      // CommonMark treats Unicode punctuation like ASCII punctuation here.
      expect(check(`${"「*a ".repeat(65)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"「_a ".repeat(65)}\n`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
    });

    it("tracks depth across the lines of a paragraph and resets at a blank line", () => {
      expect(check(`${"*a\n".repeat(65)}`)?.code).toBe("E_DOCUMENT_TOO_COMPLEX");
      expect(check(`${"*a ".repeat(40)}\n\n${"*a ".repeat(40)}\n`)).toBeUndefined();
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

  it("scans in linear time", () => {
    // Same byte count, very different shapes: a hostile document must not cost
    // more per byte to scan than plain prose (each is within the limits, so the
    // whole input is scanned). Each time is the fastest of several runs, so a
    // busy machine adds noise to neither side of a ratio.
    const size = 2 * 1024 * 1024;
    const fill = (unit: string): string => unit.repeat(Math.floor(size / unit.length));
    const prose = fill("lorem ipsum dolor sit amet\n");
    const nested = fill(`${"> ".repeat(32)}*a* _b_ ~c~ [a]\n`);
    const indented = fill(`${" ".repeat(150)}x\n`);
    const brackets = fill(`${"[".repeat(30)}${"]".repeat(30)}\n`);
    const delims = fill(`${"*".repeat(30)}a${"*".repeat(30)} ${"_".repeat(60)}\n`);
    const fastest = (src: string): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let k = 0; k < 5; k += 1)
        best = Math.min(
          best,
          timed(() => check(src)),
        );
      return Math.max(best, 0.5);
    };
    const baseline = fastest(prose);
    for (const s of [nested, indented, brackets, delims]) {
      expect(check(s)).toBeUndefined();
      expect(fastest(s) / baseline).toBeLessThan(20);
    }
    // Doubling the input roughly doubles the time.
    expect(fastest(nested + nested) / fastest(nested)).toBeLessThan(4);
  }, 60_000);
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
