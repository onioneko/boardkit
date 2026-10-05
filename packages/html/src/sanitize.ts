import type { MergedInclude } from "@onioneko/boardkit-core";
import type { Element, ElementContent, Nodes, Root } from "hast";
import { defaultSchema, type Schema, sanitize } from "hast-util-sanitize";
import { visit } from "unist-util-visit";

/**
 * The html projector's sanitize policy, as one pass a structured projector can
 * run on its own hast: {@link sanitizePanelHast}. Every piece of the policy
 * lives here, and `projectHtml` runs exactly this pass, so a projector that
 * calls it cannot drift from the html projector's rules.
 */

/** The prefix the sanitizer puts in front of every `id` and `name`. */
const CLOBBER_PREFIX = defaultSchema.clobberPrefix ?? "user-content-";

/** Form-submission attributes defaultSchema's wildcard allows and the panel schema does not. */
const FORM_ATTRIBUTES: ReadonlySet<string> = new Set(["action", "method", "encType"]);

/**
 * Panel-embedding sanitize schema, applied to the whole projected document:
 * defaultSchema plus className/id/data-intent/data-source/data-state on every
 * element, minus the wildcard's form-submission attributes (`action`,
 * `method`, `encType`), `data-doc`/`data-section` on `section` (the include
 * provenance wrapper; {@link sanitizePanelHast} keeps them only on wrappers
 * built by {@link includeWrapper}), `button` and `label` added to `tagNames`
 * (hosts render transition buttons; a checklist item wraps its input and text in a `label`
 * so a click on the text toggles the box — neither tag is in the default
 * schema), and `required.input` narrowed to `{ type: "checkbox" }`.
 *
 * URL protocols follow defaultSchema, except that `href` is narrowed to
 * `http`, `https` and `mailto`: a URL with any other scheme (`javascript:`,
 * `vbscript:`, `data:`, …) is dropped, while relative and fragment URLs pass.
 * `src` keeps defaultSchema's `http`/`https`. `srcSet` (a list of URLs the
 * sanitizer cannot check one by one) is removed from `source`.
 *
 * BoardKit inputs that carry `data-intent` are interactive controls, not
 * GitHub's read-only tasklist markers, so `defaultSchema.required.input`'s
 * `disabled: true` (GFM tasklist rendering — every `<input>` forced
 * `disabled`) is deliberately not inherited here. `type` stays required to
 * `"checkbox"`, the only input type BoardKit projects.
 *
 * `label` is given no attribute list of its own here, because one would not
 * help: `hast-util-sanitize`'s `'*'` wildcard entry (extended above with
 * `className`/`id`/`data-intent`/`data-source`/`data-state` so arbitrary hook-authored
 * elements can carry them) is an *unconditional* per-attribute fallback — a
 * tag with its own specific attribute list still falls back to `'*'` for any
 * key that list doesn't itself allow (`properties()` in `hast-util-sanitize`'s
 * `lib/index.js` retries `defaults` whenever the tag-specific lookup misses,
 * regardless of why; confirmed empirically against the installed 5.0.2). A
 * schema can add permissions for one tag beyond the wildcard; it cannot
 * revoke a wildcard-granted one for a single tag. So `label` inherits `for`
 * (`htmlFor`) and `id` from the vanilla wildcard, and `data-intent`/`data-source`
 * from this function's own addition — enough for a broken or hostile hook to
 * redirect a click to a different control (`for`) or spoof the click's own
 * intent ahead of the input it wraps, since `closest('[data-intent]')` matches
 * the label before it ever reaches the input inside. `pruneLabelAttributes`
 * enforces the real restriction after `sanitize` runs, where denial is
 * unconditional.
 * @returns A fresh schema; callers may extend it without affecting this module.
 */
export function panelSchema(): Schema {
  const attributes: Schema["attributes"] = {};
  for (const [tag, value] of Object.entries(defaultSchema.attributes ?? {})) {
    attributes[tag] = [...value, "className", "id", "data-intent", "data-source", "data-state"];
  }
  // `form` is not an allowed tag, but defaultSchema's wildcard still lets any
  // element carry `action`, `method` and `encType` (with no protocol check on
  // `action`). A host that extends the schema with `form` must not inherit a
  // live submission target, so they are not allowed at all.
  attributes["*"] = (attributes["*"] ?? []).filter(
    (attr) => !FORM_ATTRIBUTES.has(typeof attr === "string" ? attr : attr[0]),
  );
  attributes.section = [...(attributes.section ?? []), "data-doc", "data-section"];
  // `srcset` holds several URLs, and the sanitizer checks only a value's first
  // scheme, so it is not allowed at all.
  attributes.source = (attributes.source ?? []).filter((attr) => attr !== "srcSet");
  return {
    ...defaultSchema,
    attributes,
    tagNames: [...(defaultSchema.tagNames ?? []), "button", "label"],
    required: { ...defaultSchema.required, input: { type: "checkbox" } },
    protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto"] },
  };
}

/**
 * Post-sanitize hardening for `<label>`: strips every property except
 * `className`. `label` exists in the panel schema only so a checklist item's
 * text can wrap its input for a native click-to-toggle; it has no
 * legitimate use for `for`/`id`/`data-intent` or anything else, and — unlike
 * every other restriction this module applies — the sanitizer's schema
 * cannot deny them, because they are allowed through its `'*'` wildcard (see
 * `panelSchema`'s doc comment). Mutates in place; returns `node` so callers
 * can chain it directly onto `sanitize`'s result.
 * @param node The sanitized subtree to harden.
 * @returns The same node, with every `<label>` stripped to `className`.
 */
export function pruneLabelAttributes(node: Nodes): Nodes {
  visit(node, "element", (el: Element) => {
    if (el.tagName !== "label") return;
    const { className } = el.properties;
    el.properties = className === undefined ? {} : { className };
  });
  return node;
}

/**
 * Lowercase the scheme of every `href` and `src`, so the sanitizer's
 * case-sensitive scheme check keeps `HTTPS:` and `MAILTO:` URLs (schemes are
 * case-insensitive) while still dropping every scheme it does not allow.
 */
function lowercaseSchemes(tree: Nodes): void {
  visit(tree, "element", (el: Element) => {
    for (const key of ["href", "src"]) {
      const value = el.properties[key];
      if (typeof value !== "string") continue;
      const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(value)?.[0];
      if (scheme !== undefined)
        el.properties[key] = scheme.toLowerCase() + value.slice(scheme.length);
    }
  });
}

/**
 * Point footnote links at their sanitized targets. The sanitizer prefixes the
 * footnote ids (`fn-1` → `user-content-fn-1`) but cannot know which `href`s
 * name them, so the GFM footnote reference and back-reference anchors get the
 * same prefix here.
 */
function prefixFootnoteLinks(tree: Nodes): void {
  visit(tree, "element", (el: Element) => {
    if (el.tagName !== "a") return;
    const { href, dataFootnoteRef, dataFootnoteBackref } = el.properties;
    if (dataFootnoteRef === undefined && dataFootnoteBackref === undefined) return;
    if (typeof href === "string" && href.startsWith("#")) {
      el.properties.href = `#${CLOBBER_PREFIX}${href.slice(1)}`;
    }
  });
}

/**
 * Include wrappers built by {@link includeWrapper}: the only elements whose
 * `data-doc`/`data-section` survive {@link sanitizePanelHast}. Membership is
 * object identity, which hook output (plain data a block hook returned) cannot
 * forge.
 */
const provenanceWrappers = new WeakSet<Element>();

/** `data-doc` and `data-section` in any spelling a hast property could use. */
function isProvenanceKey(key: string): boolean {
  const flat = key.toLowerCase().replaceAll("-", "");
  return flat === "datadoc" || flat === "datasection";
}

/**
 * The provenance wrapper around one expanded include: a `<section>` carrying
 * the include's `data-doc` and, for a section slice, `data-section`, with
 * `children` inside it. It is the only element whose provenance attributes
 * {@link sanitizePanelHast} keeps, so a block hook cannot make its output look
 * as though it came from another document. The trust is in this exact object:
 * a copy of it (`structuredClone`, a spread) is an ordinary `section` again.
 * @param include The expanded include (its child node carries the provenance).
 * @param children What the include projected to.
 * @returns The wrapper element.
 * @example
 * ```ts
 * // Inside a HastHoleHandlers.onHole, for an include hole:
 * const inner = await projectHast({ ...walk, node: hole.include.node }, handlers);
 * return [includeWrapper(hole.include, inner.children as ElementContent[])];
 * ```
 */
export function includeWrapper(include: MergedInclude, children: ElementContent[]): Element {
  const { docId, sectionId } = include.node.provenance;
  const wrapper: Element = {
    type: "element",
    tagName: "section",
    properties:
      sectionId === undefined
        ? { "data-doc": docId }
        : { "data-doc": docId, "data-section": sectionId },
    children,
  };
  provenanceWrappers.add(wrapper);
  return wrapper;
}

/** Remove `data-doc`/`data-section` from every element that is not an {@link includeWrapper}. */
function stripForgedProvenance(tree: Nodes): void {
  visit(tree, "element", (el: Element) => {
    if (provenanceWrappers.has(el)) return;
    for (const key of Object.keys(el.properties)) {
      if (isProvenanceKey(key)) delete el.properties[key];
    }
  });
}

/**
 * The html projector's whole sanitize pass, for a projector that builds hast
 * itself (with {@link projectHast} or otherwise) and wants exactly the html
 * projector's policy:
 *
 * 1. `data-doc`/`data-section` are removed from every element that is not an
 *    {@link includeWrapper}, so hook output cannot fake include provenance;
 * 2. `href`/`src` schemes are lowercased, so `HTTPS:` and `MAILTO:` URLs pass
 *    the case-sensitive scheme check;
 * 3. the tree is sanitized with {@link panelSchema};
 * 4. every `<label>` is pruned to its `className` ({@link pruneLabelAttributes});
 * 5. GFM footnote links get the `user-content-` prefix their targets' ids got.
 *
 * `projectHtml` runs this function and nothing else, so the two never differ.
 * @param tree The unsanitized tree. It may be mutated; use the return value.
 * @returns A new, sanitized tree.
 * @example
 * ```ts
 * const safe = sanitizePanelHast(await projectHast(walk, handlers));
 * ```
 */
export function sanitizePanelHast(tree: Root): Root {
  stripForgedProvenance(tree);
  lowercaseSchemes(tree);
  const safe = sanitize(tree, panelSchema()) as Root;
  pruneLabelAttributes(safe);
  prefixFootnoteLinks(safe);
  return safe;
}

/**
 * The attribute names {@link panelSchema} allows, per tag name plus `"*"` (the
 * wildcard every tag falls back to), as plain lists without the schema's value
 * constraints (`["type", "checkbox"]` tuples become `"type"`). Names are hast
 * property names (`className`, `htmlFor`), and `data-*` names as written. A
 * host that checks properties at a process boundary can test
 * `names[tag]?.includes(key) || names["*"].includes(key)`.
 *
 * Two rules sit outside the schema and are not reflected here: a `<label>`
 * keeps only `className`, and `data-doc`/`data-section` survive only on an
 * {@link includeWrapper}.
 * @returns A fresh record; callers may change it without affecting this module.
 */
export function panelAttributeNames(): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, string[]> = {};
  for (const [tag, defs] of Object.entries(panelSchema().attributes ?? {})) {
    out[tag] = [...new Set(defs.map((def) => (typeof def === "string" ? def : def[0])))];
  }
  return out;
}
