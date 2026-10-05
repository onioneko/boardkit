import type { MergedInclude } from "@onioneko/boardkit-core";
import { asDocId, asSectionId } from "@onioneko/boardkit-core";
import type { Element, ElementContent, Properties, Root } from "hast";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { includeWrapper, panelAttributeNames, panelSchema, sanitizePanelHast } from "./index.js";

const el = (
  tagName: string,
  properties: Properties = {},
  children: ElementContent[] = [],
): Element => ({ type: "element", tagName, properties, children });

const text = (value: string): ElementContent => ({ type: "text", value });

const root = (...children: ElementContent[]): Root => ({ type: "root", children });

/** Every element of `tree`, in document order. */
function elements(tree: Root): Element[] {
  const out: Element[] = [];
  visit(tree, "element", (node: Element) => {
    out.push(node);
  });
  return out;
}

/** Every attribute that could run script: an `on*` handler, or a `javascript:`/`vbscript:`/`data:` URL. */
function unsafeProperties(tree: Root): string[] {
  const found: string[] = [];
  for (const node of elements(tree)) {
    for (const [key, value] of Object.entries(node.properties)) {
      const flat = Array.isArray(value) ? value.join(" ") : String(value);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers skip leading C0 controls before a URL scheme, so the check must too.
      if (/^on/i.test(key) || /^[\u0000- ]*(?:javascript|vbscript|data):/i.test(flat)) {
        found.push(`<${node.tagName} ${key}="${flat}">`);
      }
    }
  }
  return found;
}

/** A merged include as the html projector hands it to `includeWrapper` (only provenance is read). */
function includeOf(docId: string, sectionId?: string): MergedInclude {
  return {
    node: {
      provenance: {
        docId: asDocId(docId),
        ...(sectionId !== undefined ? { sectionId: asSectionId(sectionId) } : {}),
      },
    },
  } as unknown as MergedInclude;
}

describe("sanitizePanelHast — URLs", () => {
  it("keeps HTTPS: and MAILTO: hrefs, lowercasing the scheme", () => {
    const out = sanitizePanelHast(
      root(
        el("a", { href: "HTTPS://example.com/X" }, [text("a")]),
        el("a", { href: "MAILTO:me@example.com" }, [text("b")]),
        el("img", { src: "Http://example.com/i.png" }),
      ),
    );
    expect(elements(out).map((n) => n.properties.href ?? n.properties.src)).toEqual([
      "https://example.com/X",
      "mailto:me@example.com",
      "http://example.com/i.png",
    ]);
  });

  it("drops javascript:, vbscript: and data: URLs in any case, with leading control characters", () => {
    const out = sanitizePanelHast(
      root(
        el("a", { href: "javascript:alert(1)" }, [text("a")]),
        el("a", { href: "JaVaScRiPt:alert(1)" }, [text("b")]),
        el("a", { href: "\u0001javascript:alert(1)" }, [text("c")]),
        el("a", { href: "vbscript:msgbox(1)" }, [text("d")]),
        el("a", { href: "data:text/html,<script>alert(1)</script>" }, [text("e")]),
        el("img", { src: "data:image/svg+xml,<svg onload=alert(1)>" }),
        el("img", { src: "javascript:alert(1)" }),
      ),
    );
    expect(unsafeProperties(out)).toEqual([]);
    expect(elements(out).filter((n) => n.tagName === "a")).toHaveLength(5);
    for (const node of elements(out)) {
      expect(node.properties.href ?? node.properties.src).toBeUndefined();
    }
  });

  it("prefixes footnote links to match their sanitized targets", () => {
    const out = sanitizePanelHast(
      root(
        el("a", { href: "#fn-1", id: "fnref-1", dataFootnoteRef: true }, [text("1")]),
        el("li", { id: "fn-1" }, [
          el("a", { href: "#fnref-1", dataFootnoteBackref: "" }, [text("↩")]),
        ]),
        el("a", { href: "#plain" }, [text("not a footnote")]),
      ),
    );
    const [ref, li, back, plain] = elements(out);
    expect(ref?.properties.href).toBe("#user-content-fn-1");
    expect(ref?.properties.id).toBe("user-content-fnref-1");
    expect(li?.properties.id).toBe("user-content-fn-1");
    expect(back?.properties.href).toBe("#user-content-fnref-1");
    expect(plain?.properties.href).toBe("#plain");
  });
});

describe("sanitizePanelHast — elements and attributes", () => {
  it("drops on* handlers, style, script, SVG script, iframe, form, action, method and encType", () => {
    const out = sanitizePanelHast(
      root(
        el("div", { onClick: "alert(1)", onMouseOver: "alert(1)", style: "color:red" }, [
          el("script", {}, [text("alert(1)")]),
          el("style", {}, [text("body{background:url(javascript:alert(1))}")]),
          el("svg", {}, [el("script", {}, [text("alert(2)")])]),
          el("iframe", { src: "https://evil.example" }),
          el("form", { action: "https://evil.example", method: "post" }, [el("button")]),
          el("div", { action: "https://evil.example", method: "post", encType: "text/plain" }),
          el("button", { formAction: "https://evil.example" }, [text("go")]),
        ]),
      ),
    );
    expect(unsafeProperties(out)).toEqual([]);
    const tags = new Set(elements(out).map((n) => n.tagName));
    for (const tag of ["script", "style", "svg", "iframe", "form"]) {
      expect(tags.has(tag), tag).toBe(false);
    }
    const keys = new Set(elements(out).flatMap((n) => Object.keys(n.properties)));
    for (const key of ["style", "action", "method", "encType", "formAction"]) {
      expect(keys.has(key), key).toBe(false);
    }
    // Script bodies are stripped, not kept as text.
    expect(JSON.stringify(out)).not.toContain("alert(2)");
  });

  it("prunes a <label> to its className", () => {
    const out = sanitizePanelHast(
      root(
        el(
          "label",
          {
            className: ["item"],
            htmlFor: ["user-content-x"],
            id: "l",
            "data-intent": "{}",
          },
          [text("click")],
        ),
      ),
    );
    expect(elements(out)[0]?.properties).toEqual({ className: ["item"] });
  });

  it("prefixes every id, including a heading anchor's", () => {
    const out = sanitizePanelHast(root(el("h2", { id: "risk-limits" }, [text("Risk")])));
    expect(elements(out)[0]?.properties.id).toBe("user-content-risk-limits");
  });
});

describe("sanitizePanelHast — include provenance (#8)", () => {
  it("drops data-doc and data-section from a section it did not build, in any spelling", () => {
    const out = sanitizePanelHast(
      root(
        el("section", { "data-doc": "other", "data-section": "s" }, [text("a")]),
        el("section", { dataDoc: "other", dataSection: "s" }, [text("b")]),
        el("section", { "DATA-DOC": "other", "data-Section": "s" }, [text("c")]),
        el("div", { "data-doc": "other" }, [text("d")]),
      ),
    );
    for (const node of elements(out)) {
      expect(Object.keys(node.properties), node.tagName).toEqual([]);
    }
  });

  it("keeps provenance on an includeWrapper section, but not on a forged one inside it", () => {
    const forged = el("section", { "data-doc": "forged" }, [text("inner")]);
    const wrapper = includeWrapper(includeOf("r", "s"), [forged]);
    const out = sanitizePanelHast(root(wrapper));
    const [outer, inner] = elements(out);
    expect(outer?.properties).toEqual({ "data-doc": "r", "data-section": "s" });
    expect(inner?.properties).toEqual({});
  });

  it("omits data-section for a whole-document include", () => {
    const out = sanitizePanelHast(root(includeWrapper(includeOf("r"), [text("x")])));
    expect(elements(out)[0]?.properties).toEqual({ "data-doc": "r" });
  });

  it("trusts the wrapper object itself, not a copy of it", () => {
    const copy = structuredClone(includeWrapper(includeOf("r"), [text("x")]));
    const out = sanitizePanelHast(root(copy));
    expect(elements(out)[0]?.properties).toEqual({});
  });
});

describe("panelAttributeNames", () => {
  it("lists exactly the attribute names panelSchema allows, per tag, without value constraints", () => {
    const names = panelAttributeNames();
    const schema = panelSchema().attributes ?? {};
    expect(Object.keys(names).sort()).toEqual(Object.keys(schema).sort());
    for (const [tag, defs] of Object.entries(schema)) {
      const expected = [...new Set(defs.map((d) => (typeof d === "string" ? d : d[0])))];
      expect(names[tag], tag).toEqual(expected);
      for (const name of names[tag] ?? []) expect(typeof name, `${tag}.${name}`).toBe("string");
    }
  });

  it("allows provenance only on section, and no form submission attributes anywhere", () => {
    const names = panelAttributeNames();
    expect(names.section).toEqual(expect.arrayContaining(["data-doc", "data-section"]));
    expect(names["*"]).not.toContain("data-doc");
    for (const [tag, list] of Object.entries(names)) {
      for (const attr of ["action", "method", "encType", "formAction"]) {
        expect(list, `${tag}.${attr}`).not.toContain(attr);
      }
    }
    expect(names.input).toEqual(expect.arrayContaining(["type"]));
  });

  it("returns a fresh object each call", () => {
    expect(panelAttributeNames()).not.toBe(panelAttributeNames());
  });
});
