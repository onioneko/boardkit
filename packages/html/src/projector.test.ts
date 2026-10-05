import {
  asDocId,
  type BlockType,
  createEngine,
  createMemStorage,
  type Source,
  textProjector,
} from "@onioneko/boardkit-core";
import { describe, expect, it } from "vitest";
import { htmlProjector } from "./html.js";

const statusType: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "states", "value"],
    properties: {
      id: { type: "string" },
      states: { type: "array", items: { type: "string" } },
      value: { type: "string" },
    },
    additionalProperties: true,
  },
  project: {
    text: (attrs) => `**STATUS**: ${String(attrs.value ?? "")}`,
    html: (attrs) => ({
      type: "element",
      tagName: "span",
      properties: { className: ["status"] },
      children: [{ type: "text", value: String(attrs.value ?? "") }],
    }),
  },
};

const source: Source = {
  resolve: async (r) =>
    r.source === "cash" ? { value: "¥100", stale: false } : { value: "—", stale: false },
};

const writer = { kind: "human", id: "u1" } as const;

const src =
  "## Now\n\ncash: {{source:cash}}\n\n```status\nid: d\nstates: [pending, approved]\nvalue: pending\n```\n";

/** An engine with the status block type and no projector registered yet. */
async function makeEngine() {
  const engine = createEngine({
    storage: createMemStorage(),
    clock: () => "2026-08-21T00:00:00Z",
    blocks: [statusType],
  });
  await engine.createDoc("fin", { writer, content: src });
  return engine;
}

describe("htmlProjector", () => {
  it("degrades to the escaped source in a fixed <pre>, never to live markup", () => {
    const out = htmlProjector.degrade?.('<img src=x onerror="alert(1)">\n& done', []);
    expect(out).toBe(
      '<pre class="projection-degraded"><code>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;\n&amp; done</code></pre>',
    );
  });

  it("is a ready-to-register Projector<string> with id `html`", () => {
    expect(htmlProjector.id).toBe("html");
    expect(typeof htmlProjector.project).toBe("function");
  });

  it("renders values and block hooks once registered on an engine", async () => {
    const engine = await makeEngine();
    engine.registerProjector(htmlProjector);

    const html = await engine.projection<string>("fin", "html", { source });
    expect(html.ok).toBe(true);
    expect(html.output).toContain('<span class="status">pending</span>');
    expect(html.output).toContain("¥100");
    expect(html.diagnostics).toEqual([]);
  });

  it("registers at construction alongside the built-in text projector", async () => {
    const engine = createEngine({
      storage: createMemStorage(),
      clock: () => "2026-08-21T00:00:00Z",
      blocks: [statusType],
      projectors: [textProjector, htmlProjector],
    });
    await engine.createDoc("fin", { writer, content: src });

    expect((await engine.projection<string>("fin", "text", { source })).output).toContain(
      "**STATUS**: pending",
    );
    expect((await engine.projection<string>("fin", "html", { source })).output).toContain(
      '<span class="status">pending</span>',
    );
  });

  it("renders a heading without its {#anchor}, linking the anchor as the heading's id (#25)", async () => {
    const engine = createEngine({ storage: createMemStorage() });
    engine.registerProjector(htmlProjector);
    await engine.createDoc("rules", {
      writer,
      content: "# Rules\n\n## Risk limits {#risk-limits}\n\nBody.\n",
    });
    expect((await engine.projection("rules", "html", {})).output).toBe(
      '<h1>Rules</h1>\n<h2 id="user-content-risk-limits">Risk limits</h2>\n<p>Body.</p>',
    );
  });

  it("is not registered by default: an engine without it reports an unknown projector", async () => {
    const engine = await makeEngine();
    const html = await engine.projection("fin", "html", { source });
    expect(html.ok).toBe(false);
    expect(html.diagnostics.map((d) => d.code)).toEqual(["E_UNKNOWN_PROJECTOR"]);
  });
});

describe("htmlProjector — bounded include expansion", () => {
  it("projects a 2,000-document include chain without overflowing the stack", async () => {
    const storage = createMemStorage();
    const n = 2000;
    for (let k = n; k >= 0; k -= 1) {
      await storage.writeAtomic(
        asDocId(`c${k}`),
        k === n ? "leaf\n" : `c${k} {{include:c${k + 1}}}\n`,
      );
    }
    const engine = createEngine({ storage, projectors: [htmlProjector] });
    const result = await engine.projection<string>("c0", "html", {});

    expect(result.ok).toBe(true);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).not.toContain("E_PROJECTOR_ERROR");
    expect(codes).toContain("E_INCLUDE_LIMIT");
    expect(result.output).toContain('data-doc="c64"');
    expect(result.output).not.toContain('data-doc="c65"');
  });

  it("costs each included slice of a large document its slice, not the whole document", async () => {
    // 64 copies of a leaf that includes ten tiny sections (one holding a block)
    // of a large document with many refs and blocks outside those sections.
    const storage = createMemStorage();
    let big = "# s0\n\n```status\nid: d0\nstates: [a, b]\nvalue: a\n```\n\n";
    for (let i = 1; i < 10; i += 1) big += `# s${i}\n\nx\n\n`;
    big += "# tail\n\n";
    for (let i = 1; i < 200; i += 1)
      big += `\`\`\`status\nid: d${i}\nstates: [a, b]\nvalue: a\n\`\`\`\n\n`;
    big += `${Array.from({ length: 10_000 }, (_, i) => `{{source:s${i}}}`).join(" ")}\n\n`;
    big += `${"lorem ipsum dolor sit amet ".repeat(20_000)}\n`;
    await storage.writeAtomic(asDocId("big"), big);
    const leaf = `# a\n\n${Array.from({ length: 10 }, (_, i) => `{{include:big#s${i}}}`).join("\n\n")}\n`;
    for (let k = 6; k >= 0; k -= 1) {
      await storage.writeAtomic(
        asDocId(`d${k}`),
        k === 6 ? leaf : `# a\n\n{{include:d${k + 1}}}\n\n{{include:d${k + 1}#a}}\n`,
      );
    }
    // About 800 KB: lift the document size limit so the document is parsed at all.
    const engine = createEngine({
      storage,
      blocks: [statusType],
      projectors: [htmlProjector],
      maxDocumentBytes: 4 * 1024 * 1024,
    });
    await engine.projection<string>("d0", "html", {}); // warm caches

    const started = performance.now();
    const result = await engine.projection<string>("d0", "html", {});
    const elapsed = performance.now() - started;
    expect(result.diagnostics.map((d) => d.code)).not.toContain("E_INCLUDE_LIMIT");
    expect(result.output.split('<span class="status">a</span>')).toHaveLength(65);
    expect(elapsed).toBeLessThan(3000);
  });
});
