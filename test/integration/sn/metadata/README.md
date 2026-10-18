# Metadata writer live checks

Build the library first. Run the offline checks:

```bash
node --test test/integration/sn/metadata/controls.test.mjs test/integration/sn/metadata/runner.test.mjs
```

Run the live command only on the authorized non-production alias, dev206299:

```bash
node test/integration/sn/metadata/run-live.mjs \
  --access-helper "$SN_ACCESS" --private-dir "$PRIVATE_DIR"
```

Use the installed absolute nex-cli access-helper path. Use a new restricted, persistent private directory outside the repository and run scratch. Never reuse an attempt marker.

The launcher runs `live-child.mjs` in native Node. Credential initialization and SDK calls share the native module registry. The launcher holds the helper lock during the lifecycle. It releases that lock before the separate read-only audit. Lifecycle failures, signal exits, missing evidence and audit failures return a nonzero status. No failed write is replayed.

Jest can discover the test without live opt-in. For an intentional Jest invocation, set `METADATA_LIVE_ALIAS=dev206299`, `METADATA_ACCESS_HELPER` and `METADATA_PRIVATE_DIR`. The Jest test starts the same native launcher. Do not wrap either launcher in another helper lock.

Keep preference snapshots and raw HTML private. Inspect the safe lifecycle report and independent audit before handoff. Preserve protected records, excluded scopes, capture rows and retained update sets. No app installation or ATF execution applies to this library test.
