#!/usr/bin/env bash
# QA gate for a ServiceNow SDK or dependency bump in now-sdk-ext-core.
#
# Usage: scripts/sdk-watch/qa-sdk.sh [--live] [--integration] [--global-sdk <version> ...]
#
# Always (no instance needed):
#   build, unit tests, test:eval (SDK deep imports and the auth/session suites),
#   test:consumer (+ cleanup self-test): pack this package and install it the way
#     consumers do: bare, with sn-credstore opted in, and under the nex CLI
#   global-sdk-check.mjs: initCredentialStore() next to a "global" now-sdk of each
#     --global-sdk version (default: the latest @servicenow/sdk on npm)
# --live         read-only checks against $SN_INSTANCE_ALIAS: test:eval:live and
#                scripts/sdk-watch/live-scope-smoke.mjs (QA_APP_SCOPE / QA_STORE_APP_SCOPE optional)
# --integration  npm run test:integration against $SN_INSTANCE_ALIAS. WRITES to the instance
#                (creates and deletes test records): a PDI/dev instance only.
#
# Prints one JSON summary on stdout; per-step logs in $QA_ARTIFACTS (default: temp dir).
# Exit 0 only when every step passed.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
live=false integration=false
global_sdk=()
while (($#)); do
    case "$1" in
        --live) live=true ;;
        --integration) integration=true ;;
        --global-sdk) global_sdk+=("$2"); shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
if { $live || $integration; } && [[ -z "${SN_INSTANCE_ALIAS:-}" ]]; then
    echo 'set SN_INSTANCE_ALIAS (a non-production alias) for --live / --integration' >&2
    exit 2
fi
((${#global_sdk[@]})) || global_sdk=("$(npm view @servicenow/sdk dist-tags.latest)")

artifacts="${QA_ARTIFACTS:-$(mktemp -d -t core-qa-XXXXXX)}"
mkdir -p "$artifacts"
results="$artifacts/results.tsv"
: >"$results"
step() { # step <name> <command...>
    local name="$1"
    shift
    local log="$artifacts/$name.log" start=$SECONDS status=pass
    echo "== $name" >&2
    "$@" >"$log" 2>&1 || status=fail
    printf '%s\t%s\t%s\t%s\n' "$name" "$status" "$((SECONDS - start))" "$log" >>"$results"
    echo "   $status ($((SECONDS - start))s)" >&2
}

[[ -d node_modules ]] || step npm-ci npm ci
step build npm run build
step unit npm run test:unit
step eval npm run test:eval
step consumer npm run test:consumer
step consumer-cleanup npm run test:consumer:cleanup
step global-sdk node scripts/sdk-watch/global-sdk-check.mjs "${global_sdk[@]}"
if $live; then
    step live-eval npm run test:eval:live
    step live-scope node scripts/sdk-watch/live-scope-smoke.mjs
fi
if $integration; then
    step integration npm run test:integration
fi

node - "$results" "$artifacts" <<'EOF'
const [results, artifacts] = process.argv.slice(2);
const steps = require('node:fs').readFileSync(results, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { const [name, status, seconds, log] = l.split('\t'); return { name, status, seconds: Number(seconds), log }; });
const pass = steps.length > 0 && steps.every((s) => s.status === 'pass');
process.stdout.write(JSON.stringify({ pass, steps, artifacts }, null, 2) + '\n');
process.exit(pass ? 0 : 1);
EOF
