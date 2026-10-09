import { describe, expect, it } from "vitest";
import type { MergedTree } from "../link/merge.js";
import type { ParsedDoc } from "../model/doc.js";
import { asBlockId, asDocId } from "../model/ids.js";
import type { ProjectionCtx, ProjectionMiddleware, WriteCtx, WriteMiddleware } from "./compose.js";
import { compose, patchProposal, WriteRejection } from "./compose.js";

describe("compose", () => {
  it("runs middleware onion-style: in order, then out in reverse", async () => {
    const order: string[] = [];
    const m1 = async (_ctx: unknown, next: () => Promise<void>): Promise<void> => {
      order.push("m1-in");
      await next();
      order.push("m1-out");
    };
    const m2 = async (_ctx: unknown, next: () => Promise<void>): Promise<void> => {
      order.push("m2-in");
      await next();
      order.push("m2-out");
    };
    await compose([m1, m2])({}, async () => {
      order.push("body");
    });
    expect(order).toEqual(["m1-in", "m2-in", "body", "m2-out", "m1-out"]);
  });

  it("rejects a double next() call", async () => {
    const bad = async (_ctx: unknown, next: () => Promise<void>): Promise<void> => {
      await next();
      await next();
    };
    await expect(compose([bad])({})).rejects.toThrow("more than once");
  });

  it("propagates WriteRejection with diagnostics", async () => {
    const guard = async (ctx: WriteCtx, _next: () => Promise<void>): Promise<void> => {
      if (ctx.writer.id === "blocked") {
        throw new WriteRejection("rate-limited", [{ code: "E_RATE_LIMIT", message: "slow down" }]);
      }
      await _next();
    };
    const error = await compose([guard])({
      writer: { kind: "human", id: "blocked" },
    } as WriteCtx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteRejection);
    expect((error as WriteRejection).diagnostics.map((d) => d.code)).toEqual(["E_RATE_LIMIT"]);
  });

  it("patchProposal builds the WriteCtx proposed shape", () => {
    expect(patchProposal(asBlockId("d"), { value: "x" })).toEqual({
      blockId: "d",
      delta: { value: "x" },
    });
  });

  it("a patch proposal carries the intent origin (affordance/params), amendable before next()", async () => {
    // Type-level: `WriteCtx.proposed` accepts a patch carrying mutable
    // `affordance`/`params`. The runtime expectation below only observes this
    // test's own plain-object mutation; the pipeline's re-validation and
    // re-decoding of amended params live in write/pipeline.test.ts and
    // middleware/intent-proposal.test.ts.
    const ctx: WriteCtx = {
      docId: asDocId("fin"),
      writer: { kind: "human", id: "u1" },
      mode: "patch",
      proposed: {
        blockId: asBlockId("d"),
        delta: (_attrs, params) => ({ value: (params as { to: string }).to }),
        affordance: "transition",
        params: { to: "approved" },
      },
      parse: () => {
        throw new Error("not parsed in this test");
      },
    };
    const middleware: WriteMiddleware = async (c, next) => {
      const proposed = c.proposed as { affordance?: string; params?: unknown };
      expect(proposed.affordance).toBe("transition");
      proposed.params = { to: "rejected" };
      await next();
    };
    await middleware(ctx, async () => {});
    expect((ctx.proposed as { params?: unknown }).params).toEqual({ to: "rejected" });
  });

  it("ProjectionCtx and ProjectionMiddleware are usable (amend via options)", async () => {
    const emptyDoc = {
      frontmatter: {},
      nodes: [],
      refs: [],
      refSpans: [],
      diagnostics: [],
    } as ParsedDoc;
    const ctx: ProjectionCtx = {
      docId: asDocId("fin"),
      projectorId: "text",
      merged: {
        root: {
          provenance: { docId: asDocId("fin") },
          doc: emptyDoc,
          src: "",
          values: new Map(),
          ranges: [],
          includes: [],
        },
      } as MergedTree,
      values: new Map(),
      options: {},
    };
    const middleware: ProjectionMiddleware = async (c, next) => {
      c.options.flag = true;
      await next();
    };
    await middleware(ctx, async () => {});
    expect(ctx.options.flag).toBe(true);
  });
});
