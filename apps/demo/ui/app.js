const MAX_ENTRIES = 200;
// Every write declares its body as JSON. The server refuses anything else,
// which is what keeps another website from posting to this one: a browser
// cannot send this header cross-origin without a preflight.
const JSON_HEADERS = { "content-type": "application/json" };
const el = (id) => document.getElementById(id);
const state = {
  docs: [],
  doc: "overview",
  tab: "board",
  reader: "owner",
  live: true,
  lastSeq: 0,
  version: null,
  dirty: false,
  stale: false,
};
let stream = null;
// A stream opens by replaying everything the page has not seen. Those are
// *past* commits: one fetch per frame would be N round-trips at a moving
// target. The `ready` frame means "you are current" — that is when the
// page draws itself, once, however long the replay was.
let replaying = false;
// Every pane fetch carries the selection it was issued under. A response
// that comes back after the selection moved is dropped rather than painted
// over the document the user is looking at now.
let generation = 0;

// A document id is a path: each segment is encoded on its own, so
// `research/q3-review` stays a path while a space or `#` inside a segment
// does not break the url.
const docPath = (id) => id.split("/").map(encodeURIComponent).join("/");

// Every request goes through here: a dead server or an answer that is not
// JSON becomes a banner instead of an unhandled rejection and a page that
// has silently stopped working.
async function request(url, init) {
  try {
    const res = await fetch(url, init);
    return { ok: res.ok, body: await res.json() };
  } catch (err) {
    banner(`${url} failed: ${err?.message ?? err}`, "bad");
    return null;
  }
}

// GET /api/state — the workspace path, the document list, and the cursor.
async function loadState() {
  const res = await request("/api/state");
  if (!res) return;
  if (!res.ok) return banner("cannot read the workspace state", "bad");
  el("workspace").textContent = res.body.rootDir;
  state.docs = res.body.docs;
  if (state.lastSeq === 0) state.lastSeq = res.body.lastSeq;
  if (!state.docs.includes(state.doc)) state.doc = state.docs[0] ?? "";
  renderDocs();
}

// Draws the document list; selecting one reloads the current tab.
function renderDocs() {
  const nav = el("docs");
  nav.replaceChildren();
  for (const id of state.docs) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = id;
    button.className = id === state.doc ? "on" : "";
    button.addEventListener("click", () => {
      // Leaving the document is the one move that really does drop the buffer.
      if (state.dirty && !confirm("Discard unsaved edits?")) return;
      state.doc = id;
      state.dirty = false;
      state.stale = false;
      renderDocs();
      showTab(state.tab);
    });
    nav.append(button);
  }
}

// GET /api/projection/{docId}?format=&reader= — the board and text tabs.
async function loadProjection() {
  const issued = generation;
  const doc = state.doc;
  const format = state.tab === "text" ? "text" : "html";
  const url = `/api/projection/${docPath(doc)}?format=${format}&reader=${state.reader}`;
  const res = await request(url);
  if (!res || issued !== generation) return;
  if (!res.ok) return banner(`cannot project ${doc}`, "bad");
  if (format === "text") el("text").textContent = res.body.output;
  else el("board").innerHTML = res.body.output;
  renderDiagnostics(res.body.diagnostics);
}

// GET /api/doc/{docId} — the source textarea and the version Save writes against.
async function loadSource() {
  const issued = generation;
  const doc = state.doc;
  const res = await request(`/api/doc/${docPath(doc)}`);
  if (!res || issued !== generation) return;
  if (!res.ok) {
    // No version means no Save: a PUT carrying a foreign version is worse
    // than a Save button that refuses.
    state.version = null;
    return banner(`cannot read ${doc}`, "bad");
  }
  el("src").value = res.body.src;
  state.version = res.body.version;
  state.dirty = false;
  state.stale = false;
  renderStale();
}

// PUT /api/doc/{docId} — save the textarea against the version it was loaded at.
async function save() {
  if (state.version === null) return banner("nothing loaded to save against", "bad");
  const res = await request(`/api/doc/${docPath(state.doc)}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ fullText: el("src").value, expectedVersion: state.version }),
  });
  if (!res) return;
  report(res, "saved");
  if (res.ok) await loadSource();
}

// POST /api/intent — one [data-intent] click, sent exactly as it was rendered.
async function sendIntent(payload) {
  const res = await request("/api/intent", {
    method: "POST",
    headers: JSON_HEADERS,
    body: payload,
  });
  if (res) report(res, "applied");
}

// GET /api/events?afterSeq=N — the live stream; EventSource resumes with Last-Event-ID.
function openStream() {
  replaying = true;
  stream = new EventSource(`/api/events?afterSeq=${state.lastSeq}`);
  stream.addEventListener("commit", (e) => onCommit(JSON.parse(e.data), e.lastEventId));
  stream.addEventListener("rejection", (e) => onRejection(JSON.parse(e.data)));
  stream.addEventListener("ready", (e) => {
    state.lastSeq = JSON.parse(e.data).lastSeq;
    replaying = false;
    // One draw for the whole replay, from the state the server has just
    // said the page is level with.
    loadState().then(() => showTab(state.tab));
  });
  // A dropped connection reopens itself with Last-Event-ID, which means
  // another replay: the page is behind again until the next `ready`.
  stream.addEventListener("error", () => {
    replaying = true;
  });
}

// Pausing keeps the rendered [data-intent] payloads as they are — that is
// how you watch value-CAS refuse a stale click.
function closeStream() {
  if (stream) stream.close();
  stream = null;
}

// One commit: log it, follow doc.created/doc.removed, and refresh the view
// — unless the stream is still replaying, in which case `ready` will.
function onCommit(evt, id) {
  state.lastSeq = Math.max(state.lastSeq, Number(id) || evt.seq || 0);
  const where = evt.docId + (evt.blockId ? `/${evt.blockId}` : "");
  const moved = evt.from !== undefined && evt.to !== undefined;
  entry(
    "events",
    `#${evt.seq} ${evt.type}`,
    `${where} ${moved ? `${evt.from} → ${evt.to}` : ""}`,
    evt.by,
  );
  // The disk moved under an unsaved buffer — say so, whichever tab is
  // showing, replay or not: the buffer is as stale either way.
  if (evt.docId === state.doc && state.dirty) {
    state.stale = true;
    renderStale();
  }
  // Replay is history. Drawing it event by event is N fetches at a target
  // that is still moving; `ready` draws the end of it, once.
  if (replaying) return;
  if (evt.type === "doc.created" || evt.type === "doc.removed") loadState();
  if (state.tab !== "source") loadProjection();
  else if (evt.docId === state.doc && !state.dirty) loadSource();
}

// One refused write, from any surface (this pane is fed by the stream only).
function onRejection(notice) {
  const current =
    notice.current === undefined ? "" : ` (current: ${JSON.stringify(notice.current)})`;
  entry(
    "rejections",
    `✗ ${notice.surface} ${notice.reason}`,
    notice.docId + (notice.blockId ? `/${notice.blockId}` : "") + current,
    notice.by,
  );
}

// Appends one line to a pane, keeping only the newest MAX_ENTRIES.
function entry(pane, head, body, by) {
  const list = el(pane);
  const li = document.createElement("li");
  const who = by ? ` by ${by.kind}:${by.id}` : "";
  li.append(head, document.createElement("br"), body);
  const span = document.createElement("span");
  span.className = "by";
  span.textContent = who;
  li.append(span);
  list.append(li);
  while (list.children.length > MAX_ENTRIES) list.firstElementChild.remove();
  list.lastElementChild.scrollIntoView({ block: "nearest" });
}

// The inline banner for this client's own writes (the stream never feeds it).
function banner(text, kind) {
  const box = el("banner");
  box.textContent = text;
  box.className = kind;
  box.hidden = false;
}

// Turns one write response into a banner line.
function report(res, verb) {
  if (res.ok) return banner(verb, "good");
  const rejection = res.body?.rejection ?? {};
  const current =
    rejection.current === undefined ? "" : ` — current: ${JSON.stringify(rejection.current)}`;
  banner(`rejected: ${rejection.reason}${current}`, "bad");
}

// Shows the badge exactly when the disk moved under an unsaved edit.
function renderStale() {
  el("stale").hidden = !state.stale;
}

// A projection can render *and* complain: the diagnostics say what the
// projectors could not resolve in what you are nonetheless looking at.
function renderDiagnostics(diagnostics) {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  const box = el("diags");
  box.hidden = list.length === 0;
  box.textContent =
    list.length === 0
      ? ""
      : `${list.length} diagnostic${list.length === 1 ? "" : "s"} — first: ${list[0].code}`;
}

// Switches panes. An unsaved source buffer survives a trip to another tab:
// only a clean pane is reloaded from disk.
async function showTab(tab) {
  // A new selection: whatever is in flight for the old one is no longer
  // wanted, however late it arrives.
  generation += 1;
  state.tab = tab;
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.className = button.dataset.tab === tab ? "on" : "";
  }
  for (const pane of ["board", "text", "source"]) el(pane).hidden = pane !== tab;
  if (tab !== "source") return loadProjection();
  renderDiagnostics([]);
  renderStale();
  if (!state.dirty) await loadSource();
}

for (const button of document.querySelectorAll("[data-tab]")) {
  button.addEventListener("click", () => showTab(button.dataset.tab));
}
el("reader").addEventListener("change", (e) => {
  state.reader = e.target.value;
  generation += 1;
  if (state.tab !== "source") loadProjection();
});
el("live").addEventListener("click", () => {
  state.live = !state.live;
  el("live").className = state.live ? "on" : "";
  el("live").textContent = state.live ? "● live" : "❚❚ paused";
  if (state.live) openStream();
  else closeStream();
});
el("save").addEventListener("click", save);
// The badge is the reload: it discards the buffer the user chose to drop.
el("stale").addEventListener("click", () => {
  state.dirty = false;
  state.stale = false;
  loadSource();
});
el("src").addEventListener("input", () => {
  state.dirty = true;
});
el("board").addEventListener("click", (e) => {
  const target = e.target.closest("[data-intent]");
  if (!target) return;
  e.preventDefault();
  sendIntent(target.dataset.intent);
});

loadState().then(() => showTab("board"));
openStream();
