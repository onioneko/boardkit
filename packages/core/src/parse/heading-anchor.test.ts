import { describe, expect, it } from "vitest";
import { splitHeadingAnchor } from "../index.js";

describe("splitHeadingAnchor (public)", () => {
  it("splits a trailing {#anchor} off heading text", () => {
    expect(splitHeadingAnchor("Risk limits {#risk-limits}")).toEqual({
      anchor: "risk-limits",
      heading: "Risk limits",
    });
  });

  it("ignores trailing whitespace after the anchor and trims the heading", () => {
    expect(splitHeadingAnchor("Now   {#now}  \t")).toEqual({ anchor: "now", heading: "Now" });
  });

  it("returns the text unchanged when there is no anchor", () => {
    expect(splitHeadingAnchor("Plain heading ")).toEqual({ heading: "Plain heading " });
    expect(splitHeadingAnchor("Not {#an anchor}")).toEqual({ heading: "Not {#an anchor}" });
    expect(splitHeadingAnchor('Bad {#a"b}')).toEqual({ heading: 'Bad {#a"b}' });
    expect(splitHeadingAnchor("Mid {#x} text")).toEqual({ heading: "Mid {#x} text" });
  });

  it("takes only the last of two anchors", () => {
    expect(splitHeadingAnchor("A {#x}{#y}")).toEqual({ anchor: "y", heading: "A {#x}" });
  });

  it("accepts an anchor that is the whole text", () => {
    expect(splitHeadingAnchor("{#only}")).toEqual({ anchor: "only", heading: "" });
  });
});
