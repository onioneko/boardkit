---
"@onioneko/boardkit-core": patch
---

A block patch now changes only its target block; it can no longer close the block early and add or hide blocks after it.

- String values that hold a fence run (three or more backticks or tildes) are written on one line, and line folding cannot put a fence at the start of a line. A patch whose new body could still close the block is refused with `E_PATCH_FENCE`.
- A block inside a list item or block quote is refused with `E_PATCH_SPAN` instead of being corrupted. `Block` gains an optional `contained: true` flag that marks such blocks. A full-text write that must truncate the bounded history of such a block is now rejected with reason `validation`.
- A fence indented 1–3 spaces keeps its body's indentation, so nested values stay nested.
- A block body that is not valid YAML is refused with `E_PATCH_YAML` instead of throwing.
- Tilde fences and fences longer than three backticks are located correctly.

In every refusal the document is left unchanged. The codes are listed in the blocks guide under "Patch semantics".
