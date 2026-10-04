import { starterBlocks } from "@onioneko/boardkit-blocks";
import {
  createEngine,
  createMemStorage,
  type Engine,
  type Intent,
  type ProjectionMiddleware,
  type Source,
  type WriteMiddleware,
  type Writer,
} from "@onioneko/boardkit-core";
import { htmlProjector } from "@onioneko/boardkit-html";
import { afterEach, describe, expect, it } from "vitest";
import {
  CASH_MASK,
  HUMANS_ONLY_REASON,
  humansOnlyExecute,
  maskCashForGuests,
} from "./middleware.js";
import {
  DEMO_CASH,
  demoSource,
  FIN_DOC,
  loadFixtures,
  MACBOOK_BLOCK,
  Q3_DOC,
  seedWriter,
} from "./shared.js";
import { demoClock, rejectionDiagnostics, rejectionReason } from "./testing/helpers.js";

/** Every engine a test opened, closed after it. */
const opened: Engine[] = [];

afterEach(async () => {
  for (const engine of opened.splice(0)) await engine.close();
});

/** An in-memory engine over the canonical fixtures with the given middleware chains. */
async function seededEngine(middleware: {
  readonly write?: readonly WriteMiddleware[];
  readonly projection?: readonly ProjectionMiddleware[];
}): Promise<Engine> {
  const engine = createEngine({
    storage: createMemStorage(),
    clock: demoClock,
    blocks: starterBlocks,
    middleware,
  });
  // Same as the workbench: `html` is registered by the consumer, not the engine.
  engine.registerProjector(htmlProjector);
  const { fin, q3review } = loadFixtures();
  await engine.createDoc(FIN_DOC, { writer: seedWriter, content: fin });
  await engine.createDoc(Q3_DOC, { writer: seedWriter, content: q3review });
  opened.push(engine);
  return engine;
}

/** The `transition → <to>` intent for the decision block. */
function transitionTo(to: string): Intent {
  return { docId: FIN_DOC, blockId: MACBOOK_BLOCK, affordance: "transition", params: { to } };
}

const programWriter: Writer = { kind: "program", id: "x" };
const agentWriter: Writer = { kind: "agent", id: "my-agent" };
const humanWriter: Writer = { kind: "human", id: "alice" };

describe("humansOnlyExecute (write middleware)", () => {
  it.each([
    ["program", programWriter],
    ["agent", agentWriter],
  ])("rejects a %s transition → executed with humans-only", async (_kind, writer) => {
    const engine = await seededEngine({ write: [humansOnlyExecute] });
    const result = await engine.applyIntent(transitionTo("executed"), { writer });
    expect(result.ok).toBe(false);
    expect(rejectionReason(result)).toBe(HUMANS_ONLY_REASON);
    expect(rejectionDiagnostics(result).map((d) => d.code)).toEqual(["E_NOT_HUMAN"]);
  });

  it("passes the identical intent from a human", async () => {
    const engine = await seededEngine({ write: [humansOnlyExecute] });
    const result = await engine.applyIntent(transitionTo("executed"), { writer: humanWriter });
    expect(result.ok).toBe(true);
    expect((await engine.getBlock(FIN_DOC, MACBOOK_BLOCK))?.attrs.value).toBe("executed");
  });

  it("passes a program transition → approved (only `executed` is guarded)", async () => {
    const engine = await seededEngine({ write: [humansOnlyExecute] });
    const result = await engine.applyIntent(transitionTo("approved"), { writer: programWriter });
    expect(result.ok).toBe(true);
    expect((await engine.getBlock(FIN_DOC, MACBOOK_BLOCK))?.attrs.value).toBe("approved");
  });

  it("passes a program full-text write that types `value: executed` by hand (documented gap)", async () => {
    const engine = await seededEngine({ write: [humansOnlyExecute] });
    const doc = await engine.getDoc(FIN_DOC);
    const fullText = (doc?.src ?? "").replace("value: pending", "value: executed");
    const result = await engine.write(FIN_DOC, { writer: programWriter, fullText });
    expect(result.ok).toBe(true);
    expect((await engine.getBlock(FIN_DOC, MACBOOK_BLOCK))?.attrs.value).toBe("executed");
  });
});

describe("maskCashForGuests (projection middleware)", () => {
  /** Project `fin.md` with the mask installed, as the given reader. */
  async function project(
    projectorId: "text" | "html",
    reader: string | undefined,
    source: Source = demoSource(),
  ): Promise<string> {
    const engine = await seededEngine({ projection: [maskCashForGuests] });
    const result = await engine.projection<string>(FIN_DOC, projectorId, {
      source,
      ...(reader !== undefined ? { options: { reader } } : {}),
    });
    return result.output;
  }

  it.each(["text", "html"] as const)(
    "masks the cash value for a guest in the %s projection",
    async (projectorId) => {
      const output = await project(projectorId, "guest");
      expect(output).toContain(CASH_MASK);
      expect(output).not.toContain(DEMO_CASH);
    },
  );

  it.each([
    ["text", "owner"],
    ["html", "owner"],
    ["text", undefined],
    ["html", undefined],
  ] as const)(
    "leaves the cash value alone in the %s projection for reader %s",
    async (projectorId, reader) => {
      const output = await project(projectorId, reader);
      expect(output).toContain(DEMO_CASH);
      expect(output).not.toContain(CASH_MASK);
    },
  );

  it("leaves the Source's own value untouched (redaction is a reader concern)", async () => {
    const resolved: string[] = [];
    const inner = demoSource();
    const spy: Source = {
      resolve: async (ref) => {
        const value = await inner.resolve(ref);
        resolved.push(typeof value === "string" ? value : value.value);
        return value;
      },
    };
    const output = await project("text", "guest", spy);
    expect(output).toContain(CASH_MASK);
    expect(resolved).toContain(DEMO_CASH);
  });
});
