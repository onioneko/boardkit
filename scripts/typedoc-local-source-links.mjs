// A typedoc plugin: keep "Defined in" links for this repository's own sources only.
//
// typedoc.json sets `disableGit` with a `sourceLinkTemplate`, so source links do
// not depend on finding a `.git` directory (a git worktree has a `.git` file,
// and typedoc then silently drops every link). The template applies to every
// source, though, including members inherited from TypeScript's lib and
// @types/node, whose files live under node_modules and have no page in this
// repository. This plugin removes the link from those sources; their
// "Defined in" text stays.

import { Converter } from "typedoc";

/**
 * Register the plugin.
 * @param {import("typedoc").Application} app The typedoc application.
 */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_END, (context) => {
    for (const reflection of Object.values(context.project.reflections)) {
      for (const source of reflection.sources ?? []) {
        if (source.fullFileName.replaceAll("\\", "/").includes("/node_modules/")) {
          source.url = undefined;
        }
      }
    }
  });
}
