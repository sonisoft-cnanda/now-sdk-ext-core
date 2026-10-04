# ServiceNow SDK upgrade routine

Runbook for a scheduled agent routine that notices new `@servicenow/sdk` releases, has them
QA'd, and rolls them through our four packages when QA passes. The same overview opens this
document in every repo; the second half is specific to this repo.

## Why there is a chain at all

`@sonisoft/sn-credstore` patches the SDK's credential storage. It **fails closed** on any
`@servicenow/sdk-cli` release it has not reviewed, and it checks every copy it can find,
including the one behind a globally installed `now-sdk`. So when someone runs
`npm i -g @servicenow/sdk` and gets a new release, every `--cred-store` consumer on that
machine stops working (`… has not been verified against this shim`) until sn-credstore
allowlists that release and the consumers pick up the new sn-credstore. Nothing is broken
in our code; the shim is refusing an unreviewed release on purpose. The routine's job is to
make that window short.

```
@servicenow/sdk X.Y.Z on npm
  1. sn-credstore         detect -> review seams -> allowlist -> QA -> PR -> merge -> npm   (feat:)
  2. now-sdk-ext-core     raise sn-credstore floor (+ optionally SDK pins) -> QA -> PR -> npm (fix(deps):)
  3. now-sdk-ext-cli  }   bump core / sn-credstore (+ optionally SDK pins) -> QA -> PR -> npm (fix(deps):)
     now-sdk-ext-mcp  }   (separate repos: may run in parallel)
  4. hosts                reinstall global `nex`; MCP clients restart/reinstall
```

Each step starts only after the previous package is **visible on npm** (`watch-release.sh`).

## Roles

| Role | Does | Never |
|---|---|---|
| Engineer agent | runs the check/review/bump scripts, edits, opens PRs, answers review notes, merges after QA passes, watches the release | merges with failing QA or CI; allowlists past a `seams-changed` verdict |
| QA agent | `gh pr checkout <n>`, runs this repo's QA script, posts the JSON summary on the PR, approves or rejects | edits code; runs live checks against production |

## Rules for every repo

- **Production is off limits.** Live checks need `SN_INSTANCE_ALIAS` set to a PDI/dev alias.
  They only read and run `gs.info()` scripts, except core's `--integration`, which creates and
  deletes test records.
- **Never print or commit a secret.** Use `SN_CRED_STORE=file` for live checks. Every QA script
  uses throwaway stores for anything it writes.
- **One merge at a time per repo.** `release.yml` has no concurrency guard. Merge, run
  `watch-release.sh <merge-sha>`, and only then merge the next PR in that repo.
- **PR titles are conventional commits.** `main` only allows squash merges, and the squash
  commit takes the PR title, which semantic-release reads: `feat:` is a minor release,
  `fix:`/`fix(deps):` a patch, and `chore:`/`docs:`/`test:` no release.
- **Stop and escalate to a human** on any of these:
  - a sn-credstore review verdict of `seams-changed` or `error`
  - QA that fails twice for the same reason
  - a blocking review comment you cannot resolve
  - a `watch-release.sh` failure at the `publish` stage

## Script conventions

All scripts live in `scripts/sdk-watch/`.
- Progress goes to **stderr**, and the result is **one JSON document on stdout**.
- `check` scripts exit 0 and describe what is due in `action`/`actions` plus `next` (exact
  commands to run). QA scripts exit 0 only when every step passed. Exit 2 means bad usage.

Host prerequisites:
- Node >= 26, npm, `tar`, `diff`, `gh` (authenticated with push access to the four repos)
- `keyctl` (package `keyutils`) for sn-credstore's headless ladder
- network access to npm
- for live checks only: `SN_CRED_STORE=file` with the alias stored in the sn-credstore file
  store, and `SN_INSTANCE_ALIAS`
- optional: `QA_APP_SCOPE` (a `sys_app` scope on that instance) and `QA_STORE_APP_SCOPE` (a
  `sys_store_app` scope), so the live checks also cover both kinds of app

## Pitfalls we have already hit

- **Green is not published.** A publish job also succeeds when it *skips* an existing version.
  `watch-release.sh` checks the log for `+ <pkg>@<version>`.
- **npm lags.** A new version took 1.5–3.5 minutes to appear. Poll rather than fail.
- **The automated `claude-review` check can fail on its own.** If it fails with
  `Claude execution failed: result is_error:true`, the run crashed rather than reviewed:
  `gh run rerun <run-id> --failed`. Notes it leaves on a passing run are non-blocking unless
  it says otherwise.
- **The SDK logger writes to stdout.** Lines like `[now-sdk] Access Token has expired,
  refreshing token` go to stdout by default. Our scripts redirect them. This corrupts an MCP
  server's JSON-RPC stream, which `stdio-smoke.mjs` checks for.
- **A global `now-sdk` changes behaviour.** QA simulates a global SDK of a given version
  through `NODE_PATH` (sn-credstore searches it) instead of touching the real global install.
- **SDK packages move in lockstep.** `sdk`, `sdk-cli`, `sdk-core`, `sdk-build-core` and
  `sdk-api` share one version. `@servicenow/sdk-cli-core` has its own line, and its `latest`
  tag can lag.
- **Global is only identifiable by its sys_id.** In `sys_scope`, `scope=global` matches every
  global-scoped app. `source=global` also matches apps that now-sdk deployed into global (two on
  one PDI). Script output (`Script completed in scope global`, `rhino.global`) looks identical
  for Global and for those apps, so the live checks assert the sys_id actually sent (`global`).
- **Telemetry.** SDK 4.12+ ships `posthog-node` under `sdk-build-core`. Nothing in our runtime
  loads it, and `NO_TELEMETRY=1` disables it; the MCP stdio smoke asserts it stays unloaded.

---

## This repo: now-sdk-ext-core (step 2)

Core declares `@sonisoft/sn-credstore` as an optional dependency (`^x.y.z`) and pins the
ServiceNow SDK packages exactly. Two kinds of update reach it:

- **sn-credstore floor**: after sn-credstore releases, raise the floor so an existing
  install cannot keep an older sn-credstore that refuses the new SDK. This is required
  whenever sn-credstore released for a new SDK.
- **SDK pins**: move `@servicenow/sdk`, `sdk-cli`, `sdk-core` and `sdk-build-core` together
  to a release sn-credstore allowlists. Optional per release, but don't let core drift far:
  the CLI and MCP install core's SDK tree beside their own. Core reaches into unversioned
  `@servicenow/sdk-cli*/dist/**` paths, so an SDK bump can break at import time.
  `test:eval` (`sdkDeepImports.test.ts`) catches that.

| Script | Who | Purpose |
|---|---|---|
| `sdk-deps.mjs check` | engineer | SDK pin vs npm, which newer releases the latest sn-credstore allowlists (`candidate`) or not yet (`blockedByCredstore`), sn-credstore floor/lock vs latest. `actions` + `next`. |
| `sdk-deps.mjs bump [--sdk <v\|candidate>] [--credstore <v\|latest>] [--no-install] [--force]` | engineer | Edits `package.json` and runs `npm install`. Refuses an SDK the shipped sn-credstore does not allowlist. |
| `qa-sdk.sh [--live] [--integration] [--global-sdk <v> ...]` | QA | build, unit, `test:eval`, `test:consumer` (+ cleanup self-test), `global-sdk-check.mjs`; `--live` adds `test:eval:live` and `live-scope-smoke.mjs`; `--integration` runs `npm run test:integration` (writes; PDI only). |
| `global-sdk-check.mjs <v> [...]` | QA | `initCredentialStore()` next to a simulated global `now-sdk` of each version. |
| `live-scope-smoke.mjs` | QA | Read-only: `global` sends sys_id `global` and runs in `rhino.global`; an unknown scope is refused before sending; optional store app / `sys_app` checks. |
| `watch-release.sh <merge-sha>` | engineer | release run → version → real publish → visible on npm. |

`scripts/sdk-compat-consumer.mjs` reads the sn-credstore floor and the SDK pin from
`package.json`, so neither kind of bump needs an edit there.

### Engineer steps

1. Wait until the new sn-credstore is on npm, then:
   ```bash
   git switch main && git pull && npm ci
   node scripts/sdk-watch/sdk-deps.mjs check
   ```
2. On a branch (`fix/deps-sdk-<v>`), apply what `actions` lists:
   ```bash
   node scripts/sdk-watch/sdk-deps.mjs bump --credstore latest
   node scripts/sdk-watch/sdk-deps.mjs bump --sdk candidate
   ```
   Do one per PR, or both in one. Then `npm run build && npm run test:unit` locally. If the
   bump changes behaviour, update the README's sn-credstore/SDK note and
   `docs/APIReference.md`.
3. Open the PR as `fix(deps): …`. The body lists old → new versions and links the
   sn-credstore release. Ask QA for `qa-sdk.sh --live`.
4. After QA, CI and review pass: squash-merge, `scripts/sdk-watch/watch-release.sh <merge-sha>`,
   then start the CLI and MCP updates.

If `test:eval` fails on a deep import after an SDK bump, the SDK moved a file. That's a
code change in `src/` and a reason to stop and escalate, not something to work around.

### QA steps

```bash
gh pr checkout <n> && npm ci
SN_CRED_STORE=file SN_INSTANCE_ALIAS=<pdi-alias> \
  QA_APP_SCOPE=<sys_app scope> QA_STORE_APP_SCOPE=<store app scope> \
  scripts/sdk-watch/qa-sdk.sh --live --global-sdk <new-sdk-version>
```
Add `--integration` only against a PDI. Post the JSON summary on the PR. It runs in about
2 minutes without `--integration`.
