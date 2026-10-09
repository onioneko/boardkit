---
"@onioneko/boardkit-core": patch
---

A block patch can no longer close its block early and add blocks after it. String values with fence lines, or that line folding would put a fence at the start of a line, are now written on one line. A patch whose new body could still close the block is refused with `E_PATCH_FENCE`, and the document is unchanged. Patches also find tilde fences and fences longer than three backticks correctly. A block inside a list item or block quote is refused with `E_PATCH_SPAN` instead of being corrupted.
