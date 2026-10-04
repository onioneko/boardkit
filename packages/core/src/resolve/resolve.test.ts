import { describe, expect, it } from "vitest";
import { asDocId } from "../model/ids.js";
import type { InlineRef, SourceRef } from "../model/refs.js";
import type { Source, SourceValue } from "../ports/ports.js";
import { canonicalKey, DEFAULT_CONCURRENCY, resolveRefs } from "./resolve.js";

const value = (v = "1"): SourceValue => ({ value: v, stale: false });
const ref = (source: string, params: Record<string, string> = {}): SourceRef => ({
  kind: "source",
  source,
  params,
});

describe("canonicalKey", () => {
  it("is order-independent on params", () => {
    const a = canonicalKey({ kind: "source", source: "x", params: { a: "1", b: "2" } });
    const b = canonicalKey({ kind: "source", source: "x", params: { b: "2", a: "1" } });
    expect(a).toBe(b);
  });
});

describe("DEFAULT_CONCURRENCY", () => {
  it("exposes the default concurrency bound", () => {
    expect(DEFAULT_CONCURRENCY).toBe(8);
  });
});

describe("resolveRefs", () => {
  it("deduplicates identical refs (source called once per canonical key)", async () => {
    const calls: string[] = [];
    const source: Source = {
      resolve: async (r) => {
        calls.push(r.source);
        return value();
      },
    };
    const result = await resolveRefs(
      [ref("x"), ref("x"), ref("x", { a: "1" }), ref("x", { a: "1" })],
      source,
    );
    expect(calls).toHaveLength(2);
    expect(result.size).toBe(2);
  });

  it("ignores include refs (LINK's concern, not RESOLVE's)", async () => {
    let called = false;
    const source: Source = {
      resolve: async () => {
        called = true;
        return value();
      },
    };
    const refs: InlineRef[] = [{ kind: "include", docId: asDocId("a") }];
    const result = await resolveRefs(refs, source);
    expect(called).toBe(false);
    expect(result.size).toBe(0);
  });

  it("bounds concurrency (≤ configured limit, default 8)", async () => {
    let inFlight = 0;
    let max = 0;
    const source: Source = {
      resolve: async () => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return value();
      },
    };
    const refs = Array.from({ length: 20 }, (_, i) => ref(`s${i}`));
    const result = await resolveRefs(refs, source);
    expect(max).toBeLessThanOrEqual(8);
    expect(result.size).toBe(20);
  });

  it("respects an explicit concurrency override", async () => {
    let inFlight = 0;
    let max = 0;
    const source: Source = {
      resolve: async () => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return value();
      },
    };
    const refs = Array.from({ length: 12 }, (_, i) => ref(`t${i}`));
    await resolveRefs(refs, source, { concurrency: 3 });
    expect(max).toBeLessThanOrEqual(3);
  });

  it("marks failures stale instead of throwing", async () => {
    const source: Source = {
      resolve: async () => {
        throw new Error("down");
      },
    };
    const result = await resolveRefs([ref("x")], source);
    const key = canonicalKey({ kind: "source", source: "x", params: {} });
    expect(result.get(key)?.stale).toBe(true);
  });
});
