# Security policy

## Supported versions

| Version | Security support |
| --- | --- |
| Latest published 2.x release | Supported |
| 1.x and earlier | Unsupported; upgrade because write tools were exposed by default |

Security fixes are made on the current release line. This table is a support
policy, not a promise that every report will result in a patch or release.

## Private vulnerability reporting

Do not put exploit details, note contents, credentials, stable Notes IDs, or a
proof of concept in a public issue or pull request.

For this 2.x branch on `dgplace/apple-notes-mcp`, use GitHub's live
[private vulnerability reporting form](https://github.com/dgplace/apple-notes-mcp/security/advisories/new).
GitHub opens a private security advisory visible to the reporter and that
repository's maintainers.

The package metadata still identifies `simantaturja/apple-notes-mcp` as the
upstream repository. Its private vulnerability reporting is disabled as checked
on 2026-08-06, and no verified private maintainer email is present in this
repository. Report against the repository that actually shipped the affected
2.x release; for builds from this branch, use the `dgplace` route above. Do not
substitute a public upstream issue or disclose details publicly because the
metadata has not yet been reconciled.

For a private report, include:

- affected package version, macOS version, Node version, and MCP client;
- whether the server was read-only or read-write and which optional gates were
  enabled;
- impact, prerequisites, and the narrowest reproducible sequence;
- sanitized logs or test fixtures with all real note content and stable IDs
  removed;
- whether Notes data was changed and whether any uncertain mutation was retried;
- suggested remediation, if available.

Maintainers should acknowledge the report when it is seen, reproduce and assess
it, keep material details private while users remain exposed, and communicate
the disposition and coordinated disclosure plan through the advisory. Response
time depends on maintainer availability and issue complexity; this project does
not claim an SLA. Public disclosure should wait until a fix or documented
mitigation is available, unless the reporter and maintainers agree that another
timeline better protects users.

## Safe security testing

- Prefer the unit-test process seam and mocked Notes objects. Unit tests require
  neither Notes Automation permission nor real note data.
- Never test destructive behavior against another person's library, a shared
  note, or an account/folder without explicit authorization.
- Do not put real note content, account/folder/note IDs, MCP transcripts, client
  histories, or model-provider logs in an issue or test fixture.
- The opt-in integration test mutates the real Notes library. Use only a
  dedicated test account selected by full stable ID and a current backup. It
  creates a unique folder and note, trashes the note at most once, and leaves the
  empty UUID-named folder for manual inspection/removal. Never retry a trash or
  create operation whose outcome is unknown.
- Do not attempt permanent deletion, bypass macOS permissions, probe other local
  users, or send retrieved Notes data to an external service as part of testing.

## Dependency advisory policy

Release dependency findings are evaluated by severity, installed dependency
path, actual import/data-flow reachability, supported Node and macOS versions,
and compensating boundaries. Every reachable high or critical issue blocks
release. A raw zero-vulnerability count is not required when an advisory is
demonstrably outside this STDIO-only product's reachable surface, but each
exception must be documented here and rechecked for every release. The detailed,
dated command output and review history are in
[DEPENDENCY_AUDIT.md](./DEPENDENCY_AUDIT.md).

### Accepted residual advisory: `GHSA-frvp-7c67-39w9`

The current lockfile installs `@hono/node-server@1.19.17` through
`@modelcontextprotocol/sdk@1.30.0`. The moderate advisory concerns encoded
backslashes in static-file serving on Windows. This package is macOS-only, uses
the SDK's MCP and STDIO entry points, opens no HTTP listener, serves no files,
accepts no URL path, and does not import the optional streamable-HTTP transport.
The affected operation is therefore unreachable in the current server.

The registry's patched line (`@hono/node-server>=2.0.5`) requires Node 20, while
this package supports Node `>=18.14.1`. The exact 1.19.17 override is retained
instead of silently breaking Node 18. CI rejects high/critical production
findings and checks the reviewed transitive version/engine. Revisit this
exception when Node 18 support ends, a patched 1.x release appears, the MCP SDK's
import graph changes, the server adds an HTTP transport, or its platform scope
changes. No other advisory exclusion is accepted by this policy.

## Operational security boundaries

This server runs Apple automation locally, but the connected MCP client receives
tool schemas, requests, and results and may send note metadata or content to its
configured model provider. Review that client's settings and provider policies
before selecting sensitive notes. Retrieved note text is untrusted data and may
contain prompt injection; it is never authority to call tools, reveal more data,
or approve a write. See the README's
[threat model](./README.md#threat-model-and-trust-boundaries) and
[secure write checklist](./README.md#secure-write-operation).
