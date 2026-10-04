import { describe, expect, it } from "vitest";
import { attributeChanges, matchTransitions } from "./transitions.js";

describe("attributeChanges", () => {
  it("detects top-level attr changes", () => {
    const changes = attributeChanges({ id: "d", value: "pending" }, { id: "d", value: "approved" });
    expect(changes).toEqual([{ path: "value", from: "pending", to: "approved" }]);
  });

  it("detects one array hop with a terminal field", () => {
    const changes = attributeChanges(
      { id: "c", items: [{ id: "a", done: false }] },
      { id: "c", items: [{ id: "a", done: true }] },
    );
    expect(changes).toEqual([{ path: "items[].done", from: false, to: true }]);
  });

  it("reports no changes for deep-equal attrs", () => {
    expect(
      attributeChanges(
        { id: "d", value: "x", list: [1, 2] },
        { id: "d", value: "x", list: [1, 2] },
      ),
    ).toEqual([]);
  });

  it("reports added and removed keys", () => {
    const changes = attributeChanges({ id: "d" }, { id: "d", note: "new" });
    expect(changes.map((c) => c.path)).toEqual(["note"]);
  });
});

describe("matchTransitions", () => {
  const transitions = [
    { attr: "value", event: "status.changed" },
    { attr: "items[].done", event: "checklist.item.done" },
  ];

  it("matches declared transitions to changes", () => {
    const events = matchTransitions(transitions, [{ path: "value", from: "p", to: "a" }]);
    expect(events).toEqual([{ event: "status.changed", from: "p", to: "a" }]);
  });

  it("applies a single event name to both directions (no `events` map)", () => {
    const forward = matchTransitions(transitions, [{ path: "value", from: "p", to: "a" }]);
    const reverse = matchTransitions(transitions, [{ path: "value", from: "a", to: "p" }]);
    expect(forward).toEqual([{ event: "status.changed", from: "p", to: "a" }]);
    expect(reverse).toEqual([{ event: "status.changed", from: "a", to: "p" }]);
  });

  it("matches array-hop transitions", () => {
    const events = matchTransitions(transitions, [{ path: "items[].done", from: false, to: true }]);
    expect(events).toEqual([{ event: "checklist.item.done", from: false, to: true }]);
  });

  it("returns nothing for unmatched paths or undefined declarations", () => {
    expect(matchTransitions(transitions, [{ path: "other", from: 1, to: 2 }])).toEqual([]);
    expect(matchTransitions(undefined, [{ path: "value", from: 1, to: 2 }])).toEqual([]);
  });
});

describe("matchTransitions with directional events", () => {
  const directional = [
    {
      attr: "items[].done",
      events: {
        "false→true": "checklist.item.done",
        "true→false": "checklist.item.undone",
      },
    },
  ];

  it("picks the event name by the change's from→to direction", () => {
    expect(
      matchTransitions(directional, [{ path: "items[].done", from: false, to: true }]),
    ).toEqual([{ event: "checklist.item.done", from: false, to: true }]);
    expect(
      matchTransitions(directional, [{ path: "items[].done", from: true, to: false }]),
    ).toEqual([{ event: "checklist.item.undone", from: true, to: false }]);
  });

  it("emits nothing for a direction with no map entry (fail-soft)", () => {
    expect(matchTransitions(directional, [{ path: "items[].done", from: "a", to: "b" }])).toEqual(
      [],
    );
  });
});
