/**
 * Writer-header parsing: the workbench's API lets a caller say who it is with
 * `X-Writer: <kind>:<id>`, and this turns that one header into the engine's
 * {@link Writer} provenance label.
 *
 * The workbench never invents a kind: a caller that says it is an `agent` is
 * recorded as one, and a request with no header is the browser (the page does
 * not send it). Because the header is untrusted input, a malformed value is a
 * *value* — `{ ok: false, message }` — not a throw: the http layer answers it
 * with a 400 carrying the message.
 */
import type { Writer } from "@onioneko/boardkit-core";
import { browserWriter } from "./shared.js";

/** The three provenance kinds a caller may claim (the engine's own writer kinds). */
const WRITER_KINDS: readonly Writer["kind"][] = ["human", "agent", "program"];

/** The header's grammar, named in every rejection message so the fix is obvious. */
const EXPECTED_FORM =
  'expected "<kind>:<id>" with kind human|agent|program and a non-empty id without whitespace';

/** The outcome of parsing an `X-Writer` header: a writer, or the reason it was refused. */
export type WriterParse =
  | {
      /** True when the header (or its absence) named a writer. */
      readonly ok: true;
      /** The writer the header named, or the browser writer when it was absent. */
      readonly writer: Writer;
    }
  | {
      /** False when the header was present but malformed. */
      readonly ok: false;
      /** Why it was refused, naming the expected form and echoing the value. */
      readonly message: string;
    };

/** Whether a string is one of the engine's three writer kinds. */
function isWriterKind(value: string): value is Writer["kind"] {
  return (WRITER_KINDS as readonly string[]).includes(value);
}

/**
 * Parse an `X-Writer` header value into a {@link Writer}.
 * @param value The raw header value, or `undefined` when the request sent none.
 * @returns The parsed writer (`browserWriter` when the header is absent), or a
 *   refusal carrying a message that names the expected form.
 */
export function parseWriterHeader(value: string | undefined): WriterParse {
  if (value === undefined) return { ok: true, writer: browserWriter };
  const separator = value.indexOf(":");
  const kind = separator === -1 ? "" : value.slice(0, separator);
  const id = separator === -1 ? "" : value.slice(separator + 1);
  if (!isWriterKind(kind) || id === "" || /\s/.test(id)) {
    return { ok: false, message: `bad X-Writer "${value}": ${EXPECTED_FORM}` };
  }
  return { ok: true, writer: { kind, id } };
}
