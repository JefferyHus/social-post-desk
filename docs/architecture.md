# Social Post Desk architecture review

**Decision status** · Proposed after the paired prototypes. A product migration requires the release gates below.

**Baseline** · Social Post Desk v0.3.0 at `ed9b7d1`.

## Recommendation

Make the application a modular monolith with typed boundaries around projects, connector credentials, reports and publishing. Start with TypeScript in new modules and use runtime schemas at the API and provider boundaries. Fastify with React and Vite is the leading candidate for the private dashboard. Keep the browser app and API on one origin and deploy them together during the first migration. Compare a small Next.js implementation on the same workflow before adopting a framework across the product.

Keep SQLite for a single operator on one host with a persistent disk. Put project membership and authorization ahead of a shared hosted deployment. Adopt PostgreSQL and a durable worker when the product needs concurrent workers, separate operators or a defined recovery target. A Python reporting worker can be introduced later if an actual data-processing workload benefits from it.

## Evidence from the current application

- The baseline runs with Node.js 24, built-in SQLite, zero runtime dependencies and no build step. The full set of 47 synthetic tests passed. The existing LinkedIn and GA4 adapters already model provider scopes, date windows, unavailable data, and uncertain publishing outcomes.
- One process holds the sessions, pending OAuth operations and access-token caches. Every signed-in operator shares access to every project. SQLite uses synchronous disk operations in production and serializes writes. These constraints matter for team access, worker contention and restart recovery.
- In a synthetic microbenchmark on Node.js 24.7.0, authenticated reads of 50 drafts took 5.53 ms at p50 and 6.70 ms at p95. It used in-memory SQLite, 12 projects, 600 drafts, 16 concurrent requests, 16 warmup requests and 160 measured requests. Disk I/O, writes, provider latency and sustained load remain unmeasured. [Node.js SQLite](https://nodejs.org/api/sqlite.html)

## Candidate stacks

| Option | Fit for Social Post Desk | Cost and risk |
| --- | --- | --- |
| **TypeScript + Fastify + React/Vite** | The private dashboard is interactive. One TypeScript contract can serve the UI, API and future agent and worker adapters. Existing connectors can be migrated a module at a time. | Adds a build, dependency updates and runtime validation maintenance. A client-rendered interface still needs keyboard, focus, loading and error-state design. |
| **TypeScript + Next.js App Router** | Integrated React routing and server rendering would help if the product needs more server-rendered pages or a public interface alongside the dashboard. | Adds framework-specific server/client and caching boundaries. Private responses need explicit authorization and cache controls. A durable worker still needs its own lifecycle. |
| **FastAPI + React/Vite** | Pydantic and generated OpenAPI are attractive if the team already uses Python or needs substantial Python-native analysis. | Adds another runtime and contract generation. Rewriting the existing Google and LinkedIn adapters would need new parity tests for consent, timestamps and publication outcomes. |
| **Current Node.js + HTML + SQLite** | Small installation, one process, strong baseline tests and a practical self-hosted deployment. | As connectors and reporting modes expand, large UI and server modules and implicit object shapes raise the cost of changes. Session and worker design matters more than changing syntax alone. |

TypeScript checks code before execution. Browser, provider and MCP data still need runtime validation. Use typed interfaces with narrow inputs and outputs. Keep permissions in domain services and validate them on each adapter entry point. [TypeScript migration](https://www.typescriptlang.org/docs/handbook/migrating-from-javascript.html), [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [Vite](https://vite.dev/guide/), [React with TypeScript](https://react.dev/learn/typescript), [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [Next.js data security](https://nextjs.org/docs/app/guides/data-security), [FastAPI features](https://fastapi.tiangolo.com/features/)

## Paired prototypes

Both TypeScript prototypes used the same fictional report and one bearer-protected project endpoint. Both built, typechecked and ran locally under Node.js 24.7.0. The authorized request returned the expected values, a missing grant returned 401, and a valid grant for the wrong project returned 404.

| Prototype | Versions used | Runnable artifact | Browser asset files |
| --- | --- | ---: | ---: |
| Fastify with React and Vite | Fastify 5.12.8, React 19.3.1, Vite 8.4.0, TypeScript 5.9.3 | 8,848,433 bytes | 219,726 bytes |
| Next.js App Router | Next.js 16.4.5, React 19.2.3, TypeScript 5.9.3 | 47,971,907 bytes | 893,506 bytes |

These are uncompressed regular-file bytes from the local runnable package layouts. Fastify serves built assets and the API in one Node process. Next used standalone output with the required static assets copied in. Both render the shared typed fixture directly, so authenticated browser fetching, production sessions, worker behavior, and real application latency remain untested. The npm production audit returned zero advisories for the two prototype lockfiles at the time of testing.

The smaller Fastify deployment and explicit API boundary fit the current private reporting workflow. Next remains a viable option if server-rendered navigation or public pages become a product requirement. The next comparison should use one full existing workflow with real authentication semantics and fictional provider data.

## Storage, jobs and operating cost

**Single-host SQLite.** Keep the database on a private persistent disk with a rehearsed backup and restore. A quiesced SQLite backup and restore of 50 fictional drafts preserved project IDs, a pending reconciliation state and decryptable LinkedIn and GA4 credentials with the same key. Measure database lock waits and event-loop delay under realistic read and write workloads before extrapolating. WAL may improve reader and writer overlap. It still has a single writer and additional backup and checkpoint behavior. [When to use SQLite](https://www.sqlite.org/whentouse.html), [WAL](https://www.sqlite.org/wal.html), [SQLite backup](https://www.sqlite.org/backup.html)

**PostgreSQL when the deployment needs it.** Introduce an explicit user, workspace and project-membership model with roles and revocation. Use application authorization on every read and write, with row-level security as defense in depth where appropriate. Budget for DB hosting, credentials, backups, restore time and migration operations. Measure expected operating cost after choosing hosting and recovery targets. [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [PostgreSQL backups](https://www.postgresql.org/docs/current/backup.html)

**Start scheduled work with a durable database queue.** Save the approved draft revision, verified Page, time, timezone and queue record atomically. Claim jobs with atomic writes or PostgreSQL row locks, track leases and attempts, and persist a separate outcome for requests that may have reached LinkedIn. Those requests go to operator review and reconciliation. Test loss of a worker before and after send, simultaneous claims, expired permissions, missed execution windows, DST and revocation. PostgreSQL can support the queue without operating a second data service. Redis Streams become a candidate once a distinct workload or measured throughput justifies their added persistence and monitoring. [PostgreSQL row locking](https://www.postgresql.org/docs/current/sql-select.html), [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/), [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)

## MCP and trust boundaries

The initial MCP adapter uses local stdio and an opt-in loopback reporting listener. An operator issues an expiring, revocable grant for one project. The bridge can request approved aggregate figures. The application alone holds the database key and provider credentials. Treat returned data as untrusted content and apply authorization per tool call. Use bounded result sizes and sanitized errors. [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/mcp/), [Claude Code MCP](https://code.claude.com/docs/en/mcp)

A hosted connector is a separate deployment decision. It requires a reachable HTTPS endpoint, MCP authorization, token audience and expiry validation, project and tool scope enforcement, origin checks, revocation and independent tests. OpenAI’s hosted Responses connector and Anthropic’s Messages connector execute outside the local process. Local OpenAI Agents SDK and Claude tool hosts can spawn a stdio process. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [Anthropic Messages MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)

## Migration and release gates

1. **Start with contracts.** Preserve OAuth redirect URIs, existing publishing review and reconciliation, the demo fixtures, and API behavior. Introduce explicit validation, static checking, provider adapters and contract tests.
2. **Migrate one vertical slice.** Compare project switching, a GA4 report and a reviewable draft in both UI approaches. Measure build size, startup, synthetic API latency, accessibility and deployment and rollback complexity with equivalent scenarios. Use tests for cross-project denial, OAuth replay and missing provider data. [WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/)
3. **Rehearse any data migration.** Use a restorable SQLite snapshot and a separate protected key backup. Preserve IDs, relationships, draft revisions, pending publication outcomes and the authenticated encryption context. Verify import counts, foreign keys, credential decryption and access boundaries with disposable data. Use one authoritative writer during cutover and prove how writes after cutover would be recovered before relying on rollback.
4. **Gate multi-user and background operation.** Choose membership and approval rules, expected load, operating budget, and recovery and downtime targets. Exercise worker restart, ambiguous publication, backup restoration and grant revocation before hosting the shared product.

The prototypes inform framework ergonomics. Team size, production traffic, hosting cost and live-provider permissions still need to be measured or agreed before a platform migration.
