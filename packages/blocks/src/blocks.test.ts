import {
  type AnyBlockType,
  applyIntent,
  asBlockId,
  asDocId,
  attributeChanges,
  createDoc,
  createEngine,
  createMemStorage,
  type HtmlProjectionHook,
  matchTransitions,
  type PipelineDeps,
  type ProjectionHook,
  type ProjectionMiddleware,
  type Source,
  validateBlock,
  WriteRejection,
} from "@onioneko/boardkit-core";
import { htmlProjector } from "@onioneko/boardkit-html";
import type { Element, Root } from "hast";
import { fromHtml } from "hast-util-from-html";
import { describe, expect, it } from "vitest";
import {
  chartBlock,
  checklistBlock,
  type FormAttrs,
  formBlock,
  type MetricAttrs,
  metricBlock,
  ruleBlock,
  starterBlocks,
  statusBlock,
} from "./index.js";

const textHook = (block: (typeof starterBlocks)[number]): ProjectionHook =>
  block.project?.text as ProjectionHook;
const htmlHook = (block: (typeof starterBlocks)[number]): HtmlProjectionHook =>
  block.project?.html as HtmlProjectionHook;

const writer = { kind: "human", id: "u1" } as const;

function pipelineDeps(): PipelineDeps {
  const storage = createMemStorage();
  return {
    storage,
    clock: () => "2026-08-21T00:00:00Z",
    blockTypes: new Map<string, AnyBlockType>([
      ["checklist", checklistBlock],
      ["status", statusBlock],
    ]),
    parseOptions: { blockTypes: new Set(["checklist", "status"]) },
  };
}

describe("starter blocks pack", () => {
  it("ships all six blocks", () => {
    expect(starterBlocks.map((b) => b.type)).toEqual([
      "checklist",
      "status",
      "metric",
      "chart",
      "form",
      "rule",
    ]);
  });
});

describe("checklistBlock", () => {
  const valid = { id: "c", items: [{ id: "a", label: "A", done: false }] };

  it("validates schema", () => {
    expect(validateBlock(checklistBlock, valid)).toEqual([]);
    expect(
      validateBlock(checklistBlock, { id: "c", items: [{ id: "a", label: "A" }] }).length,
    ).toBeGreaterThan(0);
  });

  it("toggles items via its affordance", () => {
    const delta = checklistBlock.affordances?.[0]?.patch(valid, { itemId: "a" });
    expect(delta).toEqual({ items: [{ id: "a", label: "A", done: true }] });
  });

  it("emits checklist.item.done transitions", () => {
    const changes = attributeChanges(valid, {
      id: "c",
      items: [{ id: "a", label: "A", done: true }],
    });
    expect(matchTransitions(checklistBlock.transitions, changes)).toEqual([
      { event: "checklist.item.done", from: false, to: true },
    ]);
  });

  it("toggles through the patch pipeline, emitting directional done/undone events", async () => {
    const d = pipelineDeps();
    const src = "```checklist\nid: c\nitems:\n  - id: a\n    label: A\n    done: false\n```\n";
    await createDoc(d, asDocId("fin"), writer, src);

    const done = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("c"),
        affordance: "toggle",
        params: { itemId: "a" },
      },
      writer,
    );
    if (!done.ok) throw new Error("expected done ok");
    expect(done.events?.map((e) => e.type)).toContain("checklist.item.done");
    expect(done.events?.find((e) => e.type === "checklist.item.done")).toMatchObject({
      from: false,
      to: true,
    });

    const undone = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("c"),
        affordance: "toggle",
        params: { itemId: "a" },
      },
      writer,
    );
    if (!undone.ok) throw new Error("expected undone ok");
    expect(undone.events?.map((e) => e.type)).toContain("checklist.item.undone");
    expect(undone.events?.find((e) => e.type === "checklist.item.undone")).toMatchObject({
      from: true,
      to: false,
    });
  });

  it("renders text and html", () => {
    expect(textHook(checklistBlock)(valid, {})).toBe("- [ ] A");
    expect(htmlHook(checklistBlock)(valid, {})).toMatchObject({ type: "element", tagName: "ul" });
  });

  describe("html — clickable, real checked state (user report: boxes don't respond to clicks and render unchecked)", () => {
    const twoItems = {
      id: "c",
      items: [
        { id: "a", label: "Video platform", done: false },
        { id: "b", label: "Cloud storage", done: true },
      ],
    };

    it("renders `checked` on a done item and not on an undone one", () => {
      const html = htmlHook(checklistBlock)(twoItems, {}) as import("hast").Element;
      const [liA, liB] = html.children as import("hast").Element[];
      const inputA = ((liA as import("hast").Element).children[0] as import("hast").Element)
        .children[0] as import("hast").Element;
      const inputB = ((liB as import("hast").Element).children[0] as import("hast").Element)
        .children[0] as import("hast").Element;
      expect(inputA.properties.checked).toBeUndefined();
      expect(inputB.properties.checked).toBe(true);
    });

    it("wraps each item as li > label > input[data-intent] + text", () => {
      const html = htmlHook(checklistBlock)(twoItems, {}) as import("hast").Element;
      for (const li of html.children as import("hast").Element[]) {
        expect(li.tagName).toBe("li");
        const label = li.children[0] as import("hast").Element;
        expect(label.tagName).toBe("label");
        const [input, text] = label.children as [import("hast").Element, import("hast").Text];
        expect(input.tagName).toBe("input");
        expect(typeof input.properties["data-intent"]).toBe("string");
        expect(text.type).toBe("text");
      }
    });

    it("serializes through the core html projector with no `disabled` on any checkbox", async () => {
      const engine = createEngine({
        storage: createMemStorage(),
        clock: () => "2026-08-21T00:00:00Z",
        blocks: [checklistBlock],
      });
      // `html` is not an engine default: the consumer registers it.
      engine.registerProjector(htmlProjector);
      await engine.createDoc("c", {
        writer,
        content:
          "```checklist\nid: c\nitems:\n  - id: a\n    label: Video platform\n    done: false\n  - id: b\n    label: Cloud storage\n    done: true\n```\n",
      });
      const html = await engine.projection<string>("c", "html", {});
      expect(String(html.output)).not.toContain("disabled");
      expect(String(html.output)).toContain("<label>");
      expect(String(html.output)).toMatch(/<input[^>]*\bchecked\b[^>]*>/);
    });
  });
});

describe("html projection of untrusted, malformed documents (fail-soft never emits live markup)", () => {
  const f = "```";
  // A malformed starter block (its hook throws on `items: 5`) next to raw HTML
  // that would run script if the source ever reached the page unescaped. The
  // document is written straight to storage, as an editor save would be.
  const malformed = `# Board\n\n${f}checklist\nid: c\nitems: 5\n${f}\n\n<img src=x onerror=alert(document.domain)>\n`;

  /** Parsed elements of `html`, flattened in document order. */
  function elementsIn(html: string): Element[] {
    const out: Element[] = [];
    const collect = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type === "element") {
          out.push(child);
          collect(child);
        }
      }
    };
    collect(fromHtml(html, { fragment: true }));
    return out;
  }

  function unsafe(html: string): string[] {
    return elementsIn(html).flatMap((el) =>
      Object.entries(el.properties)
        .filter(
          ([key, value]) =>
            // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers skip leading C0 controls before a URL scheme, so the check must too.
            /^on/i.test(key) || /^[\u0000- ]*(?:javascript|vbscript|data):/i.test(String(value)),
        )
        .map(([key]) => `${el.tagName}[${key}]`),
    );
  }

  async function project(
    content: string,
    opts: { blocks?: AnyBlockType[]; projection?: ProjectionMiddleware[] } = {},
  ) {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("d"), content);
    const engine = createEngine({
      storage,
      blocks: opts.blocks ?? starterBlocks,
      projectors: [htmlProjector],
      ...(opts.projection !== undefined ? { middleware: { projection: opts.projection } } : {}),
    });
    const out = await engine.projection<string>("d", "html", {});
    return { html: String(out.output), codes: out.diagnostics.map((d) => d.code) };
  }

  it("renders a block whose hook throws as its escaped source; the rest renders normally", async () => {
    const { html, codes } = await project(malformed);
    expect(unsafe(html)).toEqual([]);
    expect(elementsIn(html).some((el) => el.tagName === "img")).toBe(false);
    expect(elementsIn(html).find((el) => el.tagName === "h1")).toBeDefined();
    expect(html).toContain("<pre><code>```checklist\nid: c\nitems: 5\n```</code></pre>");
    expect(codes).toContain("E_BLOCK_HOOK_ERROR");
  });

  it("degrades to the escaped source when the html projector itself throws", async () => {
    // A host block whose hook returns a malformed hast node (no properties)
    // makes the projector throw outside the hook call.
    const broken: AnyBlockType = {
      type: "broken",
      schema: { type: "object" },
      project: {
        html: () => ({ type: "element", tagName: "div" }) as unknown as import("hast").Element,
      },
    };
    const { html, codes } = await project(`${malformed}\n${f}broken\nid: x\n${f}\n`, {
      blocks: [...starterBlocks, broken],
    });
    expect(codes).toContain("E_PROJECTOR_ERROR");
    expect(unsafe(html)).toEqual([]);
    const els = elementsIn(html);
    expect(els.map((el) => el.tagName)).toEqual(["pre", "code"]);
    expect(els[0]?.properties.className).toEqual(["projection-degraded"]);
    expect(html).toContain("&lt;img src=x onerror=alert(document.domain)&gt;");
  });

  it("degrades to the escaped source when projection middleware rejects", async () => {
    const reject: ProjectionMiddleware = async () => {
      throw new WriteRejection("blocked", [{ code: "E_BLOCKED", message: "no" }]);
    };
    const { html, codes } = await project(malformed, { projection: [reject] });
    expect(codes).toContain("E_BLOCKED");
    expect(unsafe(html)).toEqual([]);
    expect(elementsIn(html).map((el) => el.tagName)).toEqual(["pre", "code"]);
  });
});

describe("statusBlock", () => {
  const valid = { id: "d", states: ["pending", "approved"], value: "pending" };

  it("enforces value ∈ states through the cross-field hook", () => {
    expect(validateBlock(statusBlock, valid)).toEqual([]);
    expect(validateBlock(statusBlock, { ...valid, value: "bogus" }).map((d) => d.code)).toEqual([
      "E_STATUS_VALUE",
    ]);
  });

  it("never throws on null/undefined attrs (validate's documented fail-soft contract)", () => {
    expect(() => validateBlock(statusBlock, null)).not.toThrow();
    expect(() => validateBlock(statusBlock, undefined)).not.toThrow();
    expect(Array.isArray(validateBlock(statusBlock, null))).toBe(true);
    expect(Array.isArray(validateBlock(statusBlock, undefined))).toBe(true);
  });

  it("transitions via its affordance and emits status.changed", () => {
    const delta = statusBlock.affordances?.[0]?.patch(valid, { to: "approved" });
    expect(delta).toEqual({ value: "approved" });
    const changes = attributeChanges(valid, { ...valid, value: "approved" });
    expect(matchTransitions(statusBlock.transitions, changes)).toEqual([
      { event: "status.changed", from: "pending", to: "approved" },
    ]);
  });

  it("keeps single-name transitions through the patch pipeline (status.changed)", async () => {
    const d = pipelineDeps();
    const src = "```status\nid: d\nstates: [pending, approved]\nvalue: pending\n```\n";
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("d"),
        affordance: "transition",
        params: { to: "approved" },
      },
      writer,
    );
    if (!r.ok) throw new Error("expected r ok");
    expect(r.events?.map((e) => e.type)).toContain("status.changed");
    expect(r.events?.find((e) => e.type === "status.changed")).toMatchObject({
      from: "pending",
      to: "approved",
    });
  });

  it("renders text with the title (value — title)", () => {
    expect(textHook(statusBlock)({ ...valid, title: "Buy MacBook" }, {})).toBe(
      "**STATUS**: pending — Buy MacBook",
    );
  });

  it("renders text without a title (no dangling em-dash)", () => {
    expect(textHook(statusBlock)(valid, {})).toBe("**STATUS**: pending");
    expect(textHook(statusBlock)({ ...valid, title: "  " }, {})).toBe("**STATUS**: pending");
  });

  it("renders html as a badge + transition buttons", () => {
    const html = htmlHook(statusBlock)(valid, {});
    expect(html).toMatchObject({ type: "element", tagName: "div" });
  });

  it("carries the current state in data-state, keeping a fixed class list", () => {
    expect(htmlHook(statusBlock)(valid, {})).toMatchObject({
      properties: { className: ["status"], "data-state": "pending" },
    });
  });

  it("renders a value with spaces and name=value as one data-state attribute, never as attributes or classes", async () => {
    const hostile = "a onerror=alert(document.domain) b";
    const engine = createEngine({ storage: createMemStorage(), blocks: [statusBlock] });
    engine.registerProjector(htmlProjector);
    await engine.createDoc("s", {
      writer,
      content: `\`\`\`status\nid: s\nstates: ["${hostile}", ok]\nvalue: "${hostile}"\n\`\`\`\n`,
    });
    const html = String((await engine.projection<string>("s", "html", {})).output);
    const elements: Element[] = [];
    const collect = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type === "element") {
          elements.push(child);
          collect(child);
        }
      }
    };
    collect(fromHtml(html, { fragment: true }));
    for (const el of elements) {
      expect(Object.keys(el.properties).filter((key) => /^on/i.test(key))).toEqual([]);
    }
    const status = elements.find((el) => el.tagName === "div");
    expect(status?.properties).toMatchObject({ className: ["status"], dataState: hostile });
  });
});

describe("metricBlock", () => {
  const valid = { id: "m", label: "Cash", source: "cash" };

  it("renders the live value from hook values, falling back to the source id", () => {
    expect(textHook(metricBlock)(valid, { cash: "¥100" })).toBe("Cash: ¥100");
    expect(textHook(metricBlock)(valid, {})).toBe("Cash: cash");
  });

  it("renders html with a strong label", () => {
    expect(htmlHook(metricBlock)(valid, { cash: "¥100" })).toMatchObject({
      type: "element",
      tagName: "span",
    });
  });

  it("declares its `source` attr as a param-less live-value ref", () => {
    // Partial on purpose (exercises `sources` on its own, `id`/`label` unused): cast past the type.
    expect(metricBlock.sources?.({ source: "bank_balance" } as MetricAttrs)).toEqual([
      { kind: "source", source: "bank_balance", params: {} },
    ]);
  });

  it("declares nothing when `source` is absent or not a string", () => {
    // Malformed on purpose (the runtime guard, not the type, is under test): cast past the type.
    expect(metricBlock.sources?.({} as MetricAttrs)).toEqual([]);
    expect(metricBlock.sources?.({ source: 42 } as unknown as MetricAttrs)).toEqual([]);
  });

  it("projects a standalone metric document (no prose ref) in text and html", async () => {
    const source: Source = {
      resolve: async (r) =>
        r.source === "bank_balance"
          ? { value: "¥23,450", stale: false }
          : { value: "—", stale: false },
    };
    const engine = createEngine({
      storage: createMemStorage(),
      clock: () => "2026-08-21T00:00:00Z",
      blocks: [metricBlock],
    });
    engine.registerProjector(htmlProjector);
    await engine.createDoc("m", {
      writer,
      content: "```metric\nid: m1\nlabel: Cash\nsource: bank_balance\n```\n",
    });

    const text = await engine.projection<string>("m", "text", { source });
    expect(text.output).toContain("Cash: ¥23,450");
    const html = await engine.projection<string>("m", "html", { source });
    expect(html.output).toContain("¥23,450");
  });
});

describe("chartBlock", () => {
  const valid = { id: "ch", type: "line", source: "corr", spec: "mermaid-ish" };

  it("emits the spec verbatim in text (machine-readable)", () => {
    expect(textHook(chartBlock)(valid, {})).toBe("mermaid-ish");
  });

  it("renders html as a pre fallback (hosts register real renderers)", () => {
    expect(htmlHook(chartBlock)(valid, {})).toMatchObject({ type: "element", tagName: "pre" });
  });
});

describe("formBlock", () => {
  const valid: FormAttrs = {
    id: "f",
    fields: [{ id: "q1", label: "What?", type: "text" }],
    status: "open",
  };

  it("answers via its affordance and emits form.answered", () => {
    const delta = formBlock.affordances?.[0]?.patch(valid, { q1: "yes" });
    expect(delta).toMatchObject({ status: "answered" });
    const changes = attributeChanges(valid, { ...valid, status: "answered" });
    expect(matchTransitions(formBlock.transitions, changes)).toEqual([
      { event: "form.answered", from: "open", to: "answered" },
    ]);
  });

  it("renders questions in text", () => {
    expect(textHook(formBlock)(valid, {})).toBe("- What?");
  });
});

describe("ruleBlock", () => {
  const valid = { id: "r", when: "x", do: "y", enabled: true };

  it("toggles enabled via its affordance and emits rule.enabled", () => {
    const delta = ruleBlock.affordances?.[0]?.patch(valid, undefined);
    expect(delta).toEqual({ enabled: false });
    const changes = attributeChanges(valid, { ...valid, enabled: false });
    expect(matchTransitions(ruleBlock.transitions, changes)).toEqual([
      { event: "rule.enabled", from: true, to: false },
    ]);
  });

  it("renders the rule text with its state", () => {
    expect(textHook(ruleBlock)(valid, {})).toBe("- rule (enabled): when x do y");
    expect(textHook(ruleBlock)({ ...valid, enabled: false }, {})).toBe(
      "- rule (disabled): when x do y",
    );
  });
});
