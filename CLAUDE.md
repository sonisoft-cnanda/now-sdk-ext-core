# now-sdk-ext-core

TypeScript library that extends the ServiceNow SDK (`@servicenow/sdk`) to provide high-level managers for interacting with ServiceNow instances — applications, ATF tests, batch operations, workflows, update sets, and more.

## Project Overview

This is the core library used by both the `nex` CLI (`now-sdk-ext-cli`) and the MCP server (`now-sdk-ext-mcp`). It provides 25+ specialized manager classes that wrap ServiceNow REST APIs, WebSocket channels, and platform endpoints into a clean, typed interface.

## Architecture

- **Managers** — each takes a `ServiceNowInstance` and constructs its OWN `ServiceNowRequest` in its constructor. `SNRequestBase` exists and offers that shape, but only `UserRequest` extends it; do not assume a shared base.
- **`SessionManager`** — caches a `ServiceNowRequest` per instance alias. Only four consumers use it (`TableAPIRequest`, `BackgroundScriptExecutor`, `AMBClient`, `ScriptTracer`); the other ~21 managers bypass it entirely. Internal — deliberately excluded from the public barrel.
- **ServiceNowInstance** — central connection object holding host, username, alias, and credential. Passed to all manager constructors.
- **ServiceNowRequest** — HTTP abstraction layer that handles authentication, CSRF tokens, cookies, and session management automatically via `@servicenow/sdk-cli-core`'s `makeRequest`.
- **Communication Layer**: `RequestHandler` (HTTP with cookie/auth handling), `ATFMessageHandler` (WebSocket), `AuthenticatedWebSocket` (AMB event subscriptions via CometD).
- **Authentication**: Factory pattern (`AuthenticationHandlerFactory`) using `getCredentials()` from `@servicenow/sdk-cli` — the same credential store used by the ServiceNow CLI.

## Directory Structure

```
src/
├── index.ts                    # Barrel export (auto-generated via ctix)
├── auth/                       # Authentication handlers and factory
├── comm/
│   ├── http/                   # HTTP request handling (RequestHandler, TableAPIRequest, etc.)
│   └── ws/                     # WebSocket handling (ATFMessageHandler)
├── sn/                         # ServiceNow manager classes (25+ modules)
│   ├── ServiceNowInstance.ts   # Central connection object
│   ├── SNRequestBase.ts        # Abstract base for all managers
│   ├── aggregate/              # COUNT, AVG, MIN, MAX, SUM queries
│   ├── amb/                    # Asynchronous Message Bus (WebSocket)
│   ├── application/            # App install, upgrade, search, repo operations
│   ├── atf/                    # Automated Test Framework execution
│   ├── attachment/             # File attachment management
│   ├── batch/                  # Bulk create/update with variable substitution
│   ├── catalog/                # Service catalog management
│   ├── cmdb/                   # CMDB relationships and graph traversal
│   ├── codesearch/             # Platform code search
│   ├── discovery/              # Instance table and plugin discovery
│   ├── flow/                   # Flow Designer execution and management
│   ├── health/                 # Instance health monitoring
│   ├── knowledge/              # Knowledge base management
│   ├── schema/                 # Table schema discovery
│   ├── scope/                  # App scope management
│   ├── scriptsync/             # Bidirectional script sync
│   ├── syslog/                 # System log reading
│   ├── task/                   # Task operations (comments, assignments)
│   ├── updateset/              # Update set management
│   ├── user/                   # User management with factory pattern
│   ├── workflow/               # Workflow management
│   └── xml/                    # XML record import/export
├── util/                       # Logger (Winston), redact.ts, CSRF helper, string utilities
├── exception/                  # Custom exception classes — ANY file here is auto-exported
├── credentials/                # initCredentialStore() opt-in shim (see Key Patterns)
├── constants/                  # Extension, file, and ServiceNow constants
└── model/                      # Shared types (ServiceNowResponse<T>, ReferenceLink, etc.)
test/
├── unit/                       # Fast unit tests (~1,400, mock-based)
├── integration/                # Integration tests (require ServiceNow credentials)
└── test_utils/                 # Test configuration and utilities
dist/                           # Compiled JS output (gitignored)
```

## Sibling Projects

- **CLI**: `../nowsdk-ext-cli` (`@sonisoft/now-sdk-ext-cli`) — the `nex` CLI, reference implementation for using this library
- **MCP server**: `../nowsdk-ext-mcp` (`@sonisoft/now-sdk-ext-mcp`) — MCP server exposing these managers as AI-callable tools

## Build & Run

```bash
npm run build              # Full build: clean + generate barrel exports + compile TypeScript
npm run buildts            # Compile TypeScript only (with tsc-alias path resolution)
npm run build-index-export # Regenerate src/index.ts barrel exports via ctix
npm run lint               # Type check (tsc --noEmit) + ESLint
npm run clean              # Remove dist/ and build artifacts
```

## Testing

```bash
npm test                   # Unit tests only (fast, no credentials needed)
npm run test:unit          # Same as above (explicit)
npm run test:integration   # Integration tests (requires ServiceNow instance credentials)
npm run test:all           # Run all tests (unit + integration)
npm run watch-test         # Watch mode for unit tests
```

- **Unit tests**: Mock-based, run in ~2-3 seconds, no ServiceNow instance required
- **Integration tests**: Hit a real ServiceNow instance, require stored credentials
- **Path aliases**: `@src/*` and `@test/*` are configured in tsconfig and jest, but **no test actually uses them** — every test imports by relative path. Match the surrounding style rather than the config.

## Key Patterns

- All HTTP communication goes through `ServiceNowRequest`, which handles auth, CSRF tokens, cookies, and session management automatically.
- Manager classes follow a consistent pattern: constructor takes `ServiceNowInstance`, methods return typed `ServiceNowResponse<T>` wrappers.
- `BackgroundScriptExecutor` posts to `/sys.scripts.do` with a CSRF token and parses the XML response.
- Barrel exports in `src/index.ts` are auto-generated by `ctix` (configured in `.ctirc`) — run `npm run build-index-export` after adding new public exports.
- `initCredentialStore()` (from `src/credentials/ensureShim.ts`, exported via `PublicApi.ts`) opts into headless-safe credential storage. `@sonisoft/sn-credstore` is an **optional** dependency — required would force a credential shim onto every consumer of this library — so `initCredentialStore()` reports `{active: false, reason: 'not-installed'}` rather than throwing when it is absent. It is deliberately **not** in the generated barrel and has no import side effect: importing this library must never monkeypatch the SDK's credential storage. Applications that own their entry point should `import '@sonisoft/sn-credstore/register'` there instead — earlier and unconditional.
- Winston-based `Logger` class for structured logging.

## Releasing & Publishing

**Publishing to npm uses a Trusted Publisher (OIDC), not an auth token.** npmjs is
phasing token-based publishing out, so nothing here should reintroduce it.

Practically, that means:

- The workflow needs `permissions: id-token: write`. Without it npm cannot mint
  the OIDC credential and the publish fails with an auth error that reads like a
  missing token — which is the wrong thing to go looking for.
- The package must be registered as a trusted publisher on npmjs, bound to this
  repository and workflow file. Renaming `publish.yml`, or publishing from a
  different workflow, breaks that binding.
- `--provenance` works because of the same OIDC identity, which is why published
  versions carry SLSA attestations.
- Do NOT add an `NPM_TOKEN` back. If publishing fails, the fix is in the trusted
  publisher configuration on npmjs, not a new secret.

The release chain:

1. Merge to `main` → `release.yml` runs `semantic-release` (conventional commits,
   angular preset). It bumps the version, tags, and cuts a GitHub release.
   `npmPublish` is `false` — semantic-release never publishes.
2. That GitHub release fires `publish.yml`, which builds and publishes.

Step 2 fires **only** because `release.yml` runs semantic-release with
`RELEASE_TOKEN` rather than the default `GITHUB_TOKEN`. GitHub suppresses events
raised by `GITHUB_TOKEN` so a workflow cannot trigger further workflows. Since
`release.yml` falls back (`secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN`),
removing that secret leaves releases working while publishing silently stops.

`publish.yml` also accepts `workflow_dispatch` for backfilling a version, dry
runs, or republishing a specific ref. It skips when the version already exists on
npm, so re-running it is a no-op rather than an error.

## Conventions

- ES Modules (`"type": "module"` in package.json)
- TypeScript target ES2022. NOTE: `strict` and `noImplicitAny` are **false** — do not write code that assumes strict null checks, and do not add non-null assertions to satisfy a checker that is not running
- Semantic versioning via `semantic-release`
- Pre-commit hooks configured in `.githooks/`
