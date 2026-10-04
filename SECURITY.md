# Security policy

## Supported versions

BoardKit is pre-1.0. Security fixes are released for the latest `0.x` minor of each published package; older minors are not patched, so upgrade to the latest minor to receive a fix.

| Package | Supported |
|---|---|
| `@onioneko/boardkit-core` | latest `0.x` minor |
| `@onioneko/boardkit-html` | latest `0.x` minor |
| `@onioneko/boardkit-blocks` | latest `0.x` minor |

The workbench in `apps/demo` and the scripts in `examples/` are not published and are not covered.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue, discussion or pull request.

Report it privately through GitHub private vulnerability reporting:

1. Open the [onioneko/boardkit](https://github.com/onioneko/boardkit) repository.
2. Open the **Security** tab (shown as **Security and quality** in newer layouts).
3. Choose **Report a vulnerability**, fill in the form and submit it.

The [new advisory form](https://github.com/onioneko/boardkit/security/advisories/new) is the same page. The report is visible only to you and the repository maintainers.

## What to include

- The affected package or packages and their versions.
- The Node version and the storage adapter in use (`createFsStorage` or `createMemStorage`), if relevant.
- A minimal reproduction: the document source, the API calls or intent payloads, and the configuration (for example `maxDocumentBytes` or the include limits) that trigger the issue.
- What happens and what you expected, and the impact you see: for example script execution in projected HTML, reading or writing outside the workspace root, or a denial of service.
- Whether the issue is already public anywhere.

## Untrusted input

The documentation describes how BoardKit treats untrusted input and where the host stays responsible. Please read the relevant section before reporting, since behavior described there is by design:

- **HTML sanitization.** The html projector sanitizes the whole projected document, and output that a projection middleware writes is the host's responsibility. See the [html projector notes](packages/html/README.md#notes) and [Projector exceptions](docs/guides/projections.md#projector-exceptions).
- **Include, document size and complexity limits.** Include expansion is bounded per projection, documents above `maxDocumentBytes` are never parsed, and neither are documents over the markdown `complexityLimits` (deep nesting, long delimiter runs), which are on by default. A parse that throws is reported as a diagnostic and never escapes the engine. Some markdown still parses in superlinear time within these limits, so a host that accepts writes from untrusted parties should keep the size limit low or parse off the main thread. See [Expansion limit](docs/guides/projections.md#expansion-limit), [Document size limit](docs/guides/projections.md#document-size-limit) and [Complexity limits](docs/guides/projections.md#complexity-limits).
- **Workspace containment.** With `createFsStorage`, document ids and includes cannot reach outside the workspace `root`. See [Containment](docs/guides/storage-and-watch.md#containment).
- **The workbench is local-only.** `apps/demo` binds `127.0.0.1`, has no authentication, and must not be exposed on a non-loopback address. See the [workbench notes](README.md#notes).
