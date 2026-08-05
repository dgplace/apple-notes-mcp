# Dependency audit record

This file records release-dependency advisory triage. An audit count is a
point-in-time input, not a release rule: every high or critical finding must be
examined for its installed dependency path and this stdio server's actual import
and data-flow surface. A zero count is not assumed or required.

## 2026-08-06 review

Environment: Node `v25.9.0`, npm `11.12.1`, macOS. Commands were run against the
committed lockfile shape with lifecycle scripts disabled:

```bash
npm audit --omit=dev --json
npm ls @modelcontextprotocol/sdk @hono/node-server hono body-parser fast-uri ip-address --all
```

The first review found 3 high, 1 moderate, 1 low, and 0 critical vulnerable
packages after pinning `@modelcontextprotocol/sdk` 1.30.0. Compatible updates
removed every high and low finding. A corrected clean install retains
`@hono/node-server@1.19.17`, the newest 1.x release and one that declares Node
`>=18.14.1`; the advisory-fixed 2.x line requires Node 20 and is incompatible
with this package's Node 18 support.

The final `npm audit --omit=dev --json` reports 0 high, 2 moderate, 0 low, and 0
critical vulnerable package entries across 94 production packages. Both entries
represent the same residual `@hono/node-server` advisory: one for the installed
transitive and one propagated to the direct MCP SDK. This nonzero result is the
intentional outcome of reachability and engine triage, not an unreviewed failure.

### High/critical advisory triage

No critical advisory was reported. Every reported high advisory is listed below,
including the pre-remediation reachability analysis.

| Advisory | Installed dependency path before remediation | Affected surface and reachability | Decision / compensating boundary |
|---|---|---|---|
| `GHSA-v2hh-gcrm-f6hx`, `GHSA-7p8r-x3mc-p8w7`, `GHSA-4c8g-83qw-93j6` (`fast-uri` host/authority confusion) | app → `@modelcontextprotocol/sdk@1.30.0` → `ajv@8.20.0` → `fast-uri@3.1.2` | AJV is imported and constructed by the SDK server, so the library was reachable. The vulnerable operation concerns URI authority parsing. This server validates locally generated, fixed tool schemas; it accepts no remote schema URL or untrusted `$ref`, opens no network listener, and performs no outbound fetch from schema validation. Residual uncertainty was that a future SDK validation path could broaden URI use. | Updated lockfile to `fast-uri@3.1.5`. The stdio-only transport, fixed local schemas, and no outbound HTTP remained compensating boundaries before remediation. |
| `GHSA-88fw-hqm2-52qc` (`hono` wildcard-origin CORS with credentials) | app → `@modelcontextprotocol/sdk@1.30.0` → `hono@4.12.23`; also via `@hono/node-server@1.19.14` | The affected CORS middleware belongs to HTTP serving. Source import inspection confirmed the application's narrow `server/mcp.js` and `server/stdio.js` entry points do not import the SDK's Hono/streamable-HTTP module. The server has no HTTP listener, origin handling, cookies, or credentials. | Updated `hono` to 4.13.0. `@hono/node-server` is separately treated below because its fixed major drops Node 18. Narrow subpath imports and stdio-only operation are compensating boundaries. |
| `GHSA-mwp4-54f8-5fhr` (`ip-address` leading-zero IPv4 SSRF/trust bypass) | app → `@modelcontextprotocol/sdk@1.30.0` → `express-rate-limit@8.5.2` → `ip-address@10.2.0` | The package is used by the SDK's optional Express authentication/rate-limit handlers. Those handlers are not imported by the MCP/stdio entry points. This server does not parse client IPs, trust proxy addresses, accept URLs for network access, or make HTTP requests. | Updated lockfile to `ip-address@10.4.0`. Absence of an HTTP/auth surface and outbound network behavior were compensating boundaries. |

The initial audit also reported moderate/low findings in `hono`, `ip-address`,
and `body-parser`. They were confined to the same unused
HTTP/Lambda/auth surfaces described above and were removed by the compatible
updates (`hono@4.13.0`, `ip-address@10.4.0`, `body-parser@2.3.0`).

### Accepted residual moderate advisory

`GHSA-frvp-7c67-39w9` affects `@hono/node-server` static-file serving on Windows
when a URL contains an encoded backslash. The installed path is app →
`@modelcontextprotocol/sdk@1.30.0` → `@hono/node-server@1.19.17`. The package is
installed for the SDK's optional streamable-HTTP transport, but neither
`src/index.ts` nor the imported SDK `server/mcp.js` / `server/stdio.js` graph
imports that transport. This macOS-only package opens no HTTP listener, serves
no files, accepts no URL paths, and never runs on Windows. The vulnerable code
surface is therefore unreachable in the current product.

The registry marks a fix available only on `@hono/node-server>=2.0.5`; all 2.x
releases declare Node `>=20`. Selecting 2.x would silently violate supported
Node 18 installs. The exact 1.19.17 override is therefore retained, the package
minimum is stated accurately as Node `>=18.14.1`, and
`npm run check:dependency-engines` verifies both the installed version and its
engine declaration in every CI Node matrix job. Revisit this exception when
Node 18 support ends or a patched 1.x release appears.

### Residual uncertainty

The MCP SDK intentionally ships dependencies for transports and OAuth/auth
surfaces this package does not use. They remain installed even when not imported
by the stdio entry points. A future SDK release could change its import graph, so
each release must repeat both the advisory query and source/import-path review.
Registry advisory data can also change after this dated result.
