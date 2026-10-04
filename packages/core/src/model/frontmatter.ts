import { type Diagnostic, diagnostic } from "./diagnostic.js";

/**
 * Frontmatter shape validation. The library defines the shape of exactly three
 * keys — `stability`, `stable_sections`, and `refs` — and assigns them no
 * behavior; all other keys pass through untouched.
 */

/** Document stability declaration values; the library assigns them no behavior. */
export type Stability = "stable" | "volatile";

/** The validated, narrowed frontmatter view. */
export interface ValidatedFrontmatter {
  /** The declared `stability` value, when present and one of `"stable"`/`"volatile"`. */
  readonly stability?: Stability;
  /** The declared `stable_sections` list, when present and an array of strings. */
  readonly stableSections?: string[];
  /**
   * The declared `refs` opt-out, when present: `false` disables all `{{…}}`
   * recognition in this document; an array of `"source"`/`"include"` selects
   * which ref kinds to recognize.
   */
  readonly refs?: false | ("source" | "include")[];
  /** Shape violations (invalid `stability`/`stable_sections`/`refs`), reported rather than thrown. */
  readonly diagnostics: readonly Diagnostic[];
}

const STABILITY_VALUES: ReadonlySet<string> = new Set(["stable", "volatile"]);
const REF_KINDS: ReadonlySet<string> = new Set(["source", "include"]);

/**
 * Validate frontmatter shape; violations become diagnostics, never thrown.
 * @param raw The frontmatter mapping parsed from the document's YAML block.
 * @returns The narrowed `stability`/`stable_sections`/`refs` view plus any shape diagnostics.
 */
export function validateFrontmatter(raw: Record<string, unknown>): ValidatedFrontmatter {
  const diagnostics: Diagnostic[] = [];
  let stability: Stability | undefined;
  let stableSections: string[] | undefined;
  let refs: false | ("source" | "include")[] | undefined;

  const rawStability = raw.stability;
  if (rawStability !== undefined) {
    if (typeof rawStability === "string" && STABILITY_VALUES.has(rawStability)) {
      stability = rawStability as Stability;
    } else {
      diagnostics.push(
        diagnostic(
          "E_FRONTMATTER_STABILITY",
          'frontmatter.stability must be "stable" or "volatile"',
        ),
      );
    }
  }

  const rawSections = raw.stable_sections;
  if (rawSections !== undefined) {
    if (Array.isArray(rawSections)) {
      const arr = Array.from(rawSections);
      if (arr.every((v): v is string => typeof v === "string")) {
        stableSections = arr;
      } else {
        diagnostics.push(
          diagnostic(
            "E_FRONTMATTER_STABLE_SECTIONS",
            "frontmatter.stable_sections must be an array of strings",
          ),
        );
      }
    } else {
      diagnostics.push(
        diagnostic(
          "E_FRONTMATTER_STABLE_SECTIONS",
          "frontmatter.stable_sections must be an array of strings",
        ),
      );
    }
  }

  const rawRefs = raw.refs;
  if (rawRefs !== undefined) {
    if (rawRefs === false) {
      refs = false;
    } else if (
      Array.isArray(rawRefs) &&
      rawRefs.every((v): v is "source" | "include" => typeof v === "string" && REF_KINDS.has(v))
    ) {
      refs = Array.from(rawRefs);
    } else {
      diagnostics.push(
        diagnostic(
          "E_FRONTMATTER_REFS",
          'frontmatter.refs must be false or an array of "source"/"include"',
        ),
      );
    }
  }

  return {
    ...(stability !== undefined ? { stability } : {}),
    ...(stableSections !== undefined ? { stableSections } : {}),
    ...(refs !== undefined ? { refs } : {}),
    diagnostics,
  };
}
