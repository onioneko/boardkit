/**
 * The workbench, run as a process: one long-running server over a real
 * filesystem workspace, editable from your editor, from the browser page it
 * serves, and from any script that speaks its JSON API — every surface watching
 * the same event stream. Its reactor is a *script* standing in for any
 * automated writer; a real agent plugs into the same API as `X-Writer: agent:<id>`.
 *
 * This is the only module in `apps/demo/src` with side effects: it reads the
 * command line, starts the workbench, prints what {@link banner} and
 * {@link feedLine} render, and closes everything on the first signal.
 */
import { banner, feedLine, parseFlags } from "./cli.js";
import { startWorkbench, type Workbench } from "./workbench.js";

const parsed = parseFlags(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.message);
  process.exit(2);
}

const { port, rootDir, reset, reactor, guard } = parsed.flags;
// `watch` is left at its default: this is the real run, so the engine's shipped
// chokidar source watches the root and stamps editor saves `human:editor`.
//
// Starting is the one step that can fail on the environment rather than on the
// input — an unwritable `--root`, a port already in use. That is worth one
// clean line on stderr, not a stack trace at a person who mistyped a path.
let workbench: Workbench;
try {
  workbench = await startWorkbench({ rootDir, port, reset, reactor, guard });
} catch (err) {
  console.error(
    `could not start the workbench: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

console.log(
  banner({
    url: workbench.url,
    rootDir: workbench.rootDir,
    flags: workbench.flags,
    lastSeq: workbench.feed.lastSeq(),
    seeded: workbench.seeded,
  }),
);

workbench.feed.subscribe((msg) => {
  console.log(feedLine(msg));
});

let stopping = false;

/**
 * Close the workbench once and exit 0. A second signal while the first close is
 * still running means the operator is done waiting: exit 1 immediately rather
 * than queueing a second shutdown.
 */
function stop(signal: NodeJS.Signals): void {
  if (stopping) process.exit(1);
  stopping = true;
  console.log(`\n${signal} — closing the workbench.`);
  void workbench
    .close()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(`failed to close cleanly: ${String(err)}`);
      process.exit(1);
    });
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
