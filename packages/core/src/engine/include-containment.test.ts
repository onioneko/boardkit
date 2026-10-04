import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFsStorage } from "../ports/fs.js";
import { createEngine } from "./engine.js";

const writer = { kind: "human", id: "me" } as const;

describe("include containment over filesystem storage", () => {
  it("diagnoses an include that resolves outside the root and keeps the engine working", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boardkit-"));
    try {
      const root = path.join(dir, "ws");
      await mkdir(root);
      await writeFile(path.join(dir, "secret.md"), "# Secret\n\nTOPSECRET\n");
      await symlink(path.join(dir, "secret.md"), path.join(root, "evil.md"));
      await writeFile(path.join(root, "board.md"), "# Board\n\n{{include:evil}}\n");
      await writeFile(path.join(root, "other.md"), "# Other\n");
      const engine = createEngine({ storage: createFsStorage({ root }), watch: false });

      const projected = await engine.projection("board", "text", {
        source: { resolve: async () => "V" },
      });
      expect(projected.output).not.toContain("TOPSECRET");
      expect(projected.diagnostics.map((d) => d.code)).toContain("E_INCLUDE_OUTSIDE_ROOT");

      const graph = await engine.refGraph("board");
      expect(graph.diagnostics.map((d) => d.code)).toContain("E_INCLUDE_OUTSIDE_ROOT");

      const unsubscribe = engine.subscribe("board", () => undefined);
      const doc = await engine.getDoc("other");
      const result = await engine.write("other", {
        writer,
        fullText: "# Other\n\nedited\n",
        ...(doc !== undefined ? { baseVersion: doc.version } : {}),
      });
      expect(result.ok).toBe(true);
      unsubscribe();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a write whose content has an escaping include target", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boardkit-"));
    try {
      const engine = createEngine({ storage: createFsStorage({ root: dir }), watch: false });
      const result = await engine.createDoc("evil", {
        writer,
        content: "# Hi\n\n{{include:../outside/secret}}\n",
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain("E_INCLUDE_INVALID_TARGET");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["loop", "dirdoc"])(
    "diagnoses an unreadable include target (%s) and keeps the engine working",
    async (name) => {
      const dir = await mkdtemp(path.join(tmpdir(), "boardkit-"));
      try {
        const root = path.join(dir, "ws");
        await mkdir(root);
        if (name === "loop") await symlink(path.join(root, "loop.md"), path.join(root, "loop.md"));
        else await mkdir(path.join(root, "dirdoc.md"));
        await writeFile(path.join(root, "board.md"), `# Board\n\n{{include:${name}}}\n`);
        await writeFile(path.join(root, "other.md"), "# Other\n");
        const storage = createFsStorage({ root });
        const engine = createEngine({ storage, watch: false });

        expect(await storage.list()).toEqual(["board", "other"]);
        const projected = await engine.projection("board", "text", {
          source: { resolve: async () => "V" },
        });
        expect(projected.diagnostics.map((d) => d.code)).toContain("E_INCLUDE_UNREADABLE");
        expect((await engine.refGraph("board")).diagnostics.map((d) => d.code)).toContain(
          "E_INCLUDE_UNREADABLE",
        );

        const unsubscribe = engine.subscribe("board", () => undefined);
        const doc = await engine.getDoc("other");
        const result = await engine.write("other", {
          writer,
          fullText: "# Other\n\nedited\n",
          ...(doc !== undefined ? { baseVersion: doc.version } : {}),
        });
        expect(result.ok).toBe(true);
        unsubscribe();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("externalWrite ignores a path whose id is not valid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boardkit-"));
    try {
      await writeFile(path.join(dir, "notes.md.md"), "# N\n");
      const engine = createEngine({ storage: createFsStorage({ root: dir }), watch: false });
      expect(await engine.externalWrite(path.join(dir, "notes.md.md"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
