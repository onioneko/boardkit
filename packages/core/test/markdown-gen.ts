/**
 * Deterministic markdown for the parse tests: a seeded random source,
 * generated boards shaped like real ones, and random edits that favour the
 * constructs incremental parsing has to get right.
 */

/**
 * A seeded pseudo-random source (mulberry32).
 * @param seed The seed.
 * @returns A function returning numbers in `[0, 1)`.
 */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "alpha beta gamma delta review draft budget schedule owner status blocked done next " +
  "design release note risk plan milestone metric target latency cache index query " +
  "日程 进度 风险 Überblick café naïve"
).split(" ");
const SOURCES = ["build.status", "queue.depth", "metrics.p95", "deploy.version env=prod"];

/** Options for {@link generateBoard}. */
export interface BoardOptions {
  /** Line ending. Default `"\n"`. */
  readonly eol?: "\n" | "\r\n" | "\r";
  /** Chance per section of a reference link whose definition sits in a footer section. */
  readonly footerDefinitions?: number;
}

/**
 * A board of about `bytes` characters: frontmatter, a title, then dated entry
 * sections with paragraphs, lists, task lists, tables, typed blocks, code
 * fences holding `#` lines, quotes, subsections, HTML comments and includes.
 * @param bytes The target length.
 * @param seed The seed.
 * @param opts Options.
 * @returns The markdown.
 */
export function generateBoard(bytes: number, seed: number, opts: BoardOptions = {}): string {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const words = (n: number): string => Array.from({ length: n }, () => pick(WORDS)).join(" ");
  const sentence = (): string => {
    const parts = [words(4 + Math.floor(r() * 8))];
    const roll = r();
    if (roll < 0.2) parts.push(`**${words(2)}**`);
    else if (roll < 0.35) parts.push(`\`${pick(WORDS)}\``);
    else if (roll < 0.5) parts.push(`{{source:${pick(SOURCES)}}}`);
    else if (roll < 0.6) parts.push(`[${words(2)}](https://example.com/${pick(WORDS)})`);
    else if (roll < 0.65) parts.push(`_${words(1)}_`);
    parts.push(words(3 + Math.floor(r() * 6)));
    return `${parts.join(" ")}.`;
  };
  const paragraph = (): string =>
    Array.from({ length: 2 + Math.floor(r() * 4) }, sentence)
      .join(" ")
      .replace(/(.{70,90}) /g, "$1\n");
  const footer: string[] = [];
  let out = "---\ntitle: Project log\nrefs: [source, include]\n---\n\n# Project log\n\n";
  out += "Running notes. Build {{source:build.status}}.\n\n";
  for (let n = 1; out.length < bytes; n += 1) {
    const day = String(1 + (n % 28)).padStart(2, "0");
    out += `## 2026-10-${day} entry ${n} · ${pick(["ana", "bo", "cy", "di"])} {#e-${n}}\n\n`;
    const blocks = 2 + Math.floor(r() * 4);
    for (let b = 0; b < blocks; b += 1) {
      const kind = r();
      if (kind < 0.35) out += `${paragraph()}\n\n`;
      else if (kind < 0.5) {
        out += `${Array.from({ length: 2 + Math.floor(r() * 4) }, () => `- ${sentence()}`).join("\n")}\n\n`;
      } else if (kind < 0.58) {
        const items = Array.from(
          { length: 2 + Math.floor(r() * 3) },
          () => `- [${r() < 0.5 ? " " : "x"}] ${words(5)}`,
        );
        out += `${items.join("\n")}\n\n`;
      } else if (kind < 0.66) {
        out += "| Item | Count | Share | Note |\n| --- | ---: | ---: | --- |\n";
        for (let i = 0; i < 3 + Math.floor(r() * 5); i += 1) {
          out += `| ${pick(WORDS)} | ${Math.floor(r() * 900)} | ${(r() * 100).toFixed(1)} | ${words(3)} |\n`;
        }
        out += "\n";
      } else if (kind < 0.74) {
        out += `\`\`\`checklist\nid: c-${n}-${b}\ntitle: ${words(3)}\nitems:\n  - id: i1\n    label: ${words(4)}\n    done: ${r() < 0.5}\n\`\`\`\n\n`;
      } else if (kind < 0.79)
        out += `\`\`\`bash\n# rebuild\n./build --since ${n}\n# done\n\`\`\`\n\n`;
      else if (kind < 0.85) out += `> ${sentence()}\n> ${sentence()}\n\n`;
      else if (kind < 0.9) out += `### ${words(3)}\n\n${paragraph()}\n\n`;
      else if (kind < 0.93) out += `<!-- note: ${words(4)} -->\n\n`;
      else if (kind < 0.96) out += `1. ${sentence()}\n2. ${sentence()}\n   - ${words(4)}\n\n`;
      else out += `{{include:notes#${pick(WORDS)}}}\n\n`;
    }
    if (opts.footerDefinitions !== undefined && r() < opts.footerDefinitions) {
      out += `See [the spec][spec-${n}] and the note[^n${n}].\n\n`;
      footer.push(`[spec-${n}]: https://example.com/spec/${n}`, `[^n${n}]: Note ${n}.`);
    }
  }
  if (footer.length > 0) out += `## Links\n\n${footer.join("\n\n")}\n`;
  return opts.eol === undefined || opts.eol === "\n" ? out : out.replace(/\n/g, opts.eol);
}

/**
 * A one-paragraph edit: a sentence appended to the paragraph nearest `at`
 * (a fraction of the document).
 * @param src The document.
 * @param at Where, from `0` (top) to `1` (bottom).
 * @param salt Makes the edit unique.
 * @returns The edited document.
 */
export function editParagraph(src: string, at: number, salt: number): string {
  const starts: number[] = [];
  const re = /\n\n(?=[A-Za-z])/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) starts.push(m.index + 2);
  const start = starts[Math.min(starts.length - 1, Math.floor(at * starts.length))] as number;
  const end = src.indexOf("\n\n", start);
  return `${src.slice(0, end)} Edited ${salt}.${src.slice(end)}`;
}

/**
 * Insertions that change block structure across sections: fences, HTML
 * blocks, headings, definitions, footnotes, frontmatter fences, setext
 * underlines, containers, tables, line endings, tabs and byte order marks.
 */
export const DANGEROUS = [
  "```\n",
  "~~~\n",
  "````md\n",
  "```js\n",
  "<div>\n",
  "<!--",
  "-->",
  "<script>\n",
  "</script>",
  "<pre>",
  "<?php",
  "<!DOCTYPE",
  "<![CDATA[",
  "\n# H\n",
  "\n## sub\n",
  "# ",
  "#",
  "\n#\n",
  "###### six\n",
  "#######\n",
  "[x]: /y\n",
  "\n[spec-3]: /s\n",
  "[^1]: note\n",
  "[^1]",
  "- [R&amp;D]: /rd\n",
  "[R&amp;D]",
  "1. [a\\*b]: /ab\n",
  "[a\\*b]",
  "[x&#93;y]: /b\n",
  "[x&#93;y]",
  "[x]",
  "[X ]",
  "[spec-3]",
  "---\n",
  "---",
  "\n---\n",
  "\n===\n",
  "> ",
  "- ",
  "1. ",
  "    ",
  "|a|b|\n|-|-|\n",
  "| c |",
  "\r\n",
  "\r",
  "\t",
  "\n\n",
  "\n",
  "﻿",
  "{{source:a}}",
  "*",
  "_",
  "`",
  "\\",
  "&amp;",
  "<",
  " ",
] as const;

/**
 * One random edit of `src`: a dangerous insertion anywhere or at a line
 * start, or a short deletion.
 * @param src The document.
 * @param r The random source.
 * @returns The edited document.
 */
export function mutate(src: string, r: () => number): string {
  const at = Math.floor(r() * (src.length + 1));
  const roll = r();
  const insert = DANGEROUS[Math.floor(r() * DANGEROUS.length)] as string;
  if (roll < 0.45) return src.slice(0, at) + insert + src.slice(at);
  if (roll < 0.7)
    return src.slice(0, at) + src.slice(Math.min(src.length, at + 1 + Math.floor(r() * 12)));
  if (roll < 0.8) return insert + src;
  const lineStart = Math.max(src.lastIndexOf("\n", at - 1), src.lastIndexOf("\r", at - 1)) + 1;
  return src.slice(0, lineStart) + insert + src.slice(lineStart);
}
