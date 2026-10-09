import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** The core test suite, with every parsed source recorded (see `record.mjs`). */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../../../core", import.meta.url)),
    include: ["src/**/*.test.ts"],
    setupFiles: [fileURLToPath(new URL("./record-setup.ts", import.meta.url))],
  },
});
