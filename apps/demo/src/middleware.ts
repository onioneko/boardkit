/**
 * The workbench's two example middlewares — one per pipeline.
 *
 * `humansOnlyExecute` (write) turns a host policy ("only a person may execute a
 * decision") into a rule the engine applies to every write surface: `write`,
 * `patch`, and `applyIntent` all run the same chain, so the policy is stated
 * once rather than at each call site. (A direct file edit is not one of those
 * paths: it is already on disk when the watcher sees it.)
 *
 * `maskCashForGuests` (projection) is the other half of the pitch: redaction is
 * a *reader* concern, not a document concern, so the same committed bytes render
 * one way for the owner and another for a guest — without the Source ever
 * returning anything but the real value.
 */
import type { ProjectionMiddleware, WriteMiddleware } from "@onioneko/boardkit-core";
import { WriteRejection } from "@onioneko/boardkit-core";

// ---------------------------------------------------------------------------
// Write: only a human may execute a decision
// ---------------------------------------------------------------------------

/** The rejection reason the guard states (surfaces as `WriteResult.rejection.reason`). */
export const HUMANS_ONLY_REASON = "humans-only";

/** The state only a human may move a decision into. */
const EXECUTED = "executed";

/**
 * The workbench's write middleware: a `transition` intent whose params ask for
 * `executed` is rejected unless the writer's kind is `human`.
 *
 * How much a given guard covers is its own predicate's business. This one
 * matches the proposal's *origin* (`affordance` + `params`) rather than the
 * opaque delta, which is what makes the rejection legible; a full-text write
 * that types `value: executed` by hand carries no affordance and walks past it.
 * A policy that must hold for those too reads `proposed.fullText` — and the
 * plain `delta` of an affordance-less patch — in the same middleware.
 *
 * The rejection is a value (a `WriteResult` rejection), never a throw out of the
 * engine: the same intent from a human commits.
 * @param ctx The write context (mode, writer, proposal).
 * @param next Runs the rest of the chain and the commit pipeline.
 * @returns A promise that settles when the chain settles.
 */
export const humansOnlyExecute: WriteMiddleware = async (ctx, next) => {
  const proposed = ctx.proposed as { affordance?: string; params?: { to?: unknown } };
  if (
    ctx.mode === "patch" &&
    proposed.affordance === "transition" &&
    proposed.params?.to === EXECUTED &&
    ctx.writer.kind !== "human"
  ) {
    throw new WriteRejection(HUMANS_ONLY_REASON, [
      { code: "E_NOT_HUMAN", message: `writer ${ctx.writer.id} may not transition to ${EXECUTED}` },
    ]);
  }
  await next();
};

// ---------------------------------------------------------------------------
// Projection: a guest does not see the cash
// ---------------------------------------------------------------------------

/** What a guest sees instead of the cash amount. */
export const CASH_MASK = "¥••••";

/**
 * The canonical values-map key of a param-less `bank_balance` ref (the engine
 * keys resolved values by `<source>?<sorted params>`).
 */
const BANK_BALANCE_KEY = "bank_balance?";

/**
 * The workbench's projection middleware: after the projector has run, a `text`
 * or `html` projection requested with `options.reader === "guest"` has the
 * resolved `bank_balance` value replaced by {@link CASH_MASK}. The board is
 * html and the text tab is text, so both surfaces mask.
 *
 * The middleware never hard-codes the secret — it reads the resolved value out
 * of `ctx.values` by its canonical key and replaces exactly that string in the
 * output.
 * @param ctx The projection context (options before, output after).
 * @param next Runs the rest of the chain and the projector.
 * @returns A promise that settles when the chain settles.
 */
export const maskCashForGuests: ProjectionMiddleware = async (ctx, next) => {
  await next();
  if (ctx.projectorId !== "text" && ctx.projectorId !== "html") return;
  if (ctx.options.reader !== "guest") return;
  const cash = ctx.values.get(BANK_BALANCE_KEY);
  if (cash === undefined || typeof ctx.output !== "string") return;
  ctx.output = ctx.output.replaceAll(cash.value, CASH_MASK);
};
