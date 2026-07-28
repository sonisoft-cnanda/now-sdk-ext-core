import { describe, it, expect } from '@jest/globals';

/**
 * Guard for the unversioned deep imports this library depends on.
 *
 * Several modules reach into `@servicenow/sdk-cli-core/dist/**` rather than the
 * package root, because the root exports nothing — importing it throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. Those `dist/` paths carry no semver contract.
 *
 * That means a ServiceNow SDK upgrade can move or rename a file and break us at
 * *import* time, which neither `tsc --noEmit` nor the rest of the unit suite can
 * observe — it only surfaces when something actually executes the import. On the
 * 4.3.0 -> 4.9.2 bump this was caught only by checking each path by hand.
 *
 * The paths below are the complete set actually imported by `src/`, derived from
 * the source rather than from memory:
 *
 *   grep -rhoE "from ['\"]@servicenow/[^'\"]+['\"]" src/ | sort -u
 *
 * If you add a new deep import, add it here too. If one of these ever stops
 * resolving, the SDK has moved it and the corresponding source import must be
 * updated — that is precisely the failure this test exists to surface in CI.
 */
describe('ServiceNow SDK deep imports', () => {
    it('dist/http/index.js exposes makeRequest and parseResponseBody', async () => {
        const mod = await import('@servicenow/sdk-cli-core/dist/http/index.js');
        expect(typeof mod.makeRequest).toBe('function');
        expect(typeof mod.parseResponseBody).toBe('function');
    });

    it('dist/util/sessionToken.js exposes getSafeUserSession', async () => {
        const mod = await import('@servicenow/sdk-cli-core/dist/util/sessionToken.js');
        expect(typeof mod.getSafeUserSession).toBe('function');
    });

    // src/sn/Application.ts imports parseXml from dist/util/index.js — NOT from
    // dist/util/Util.js. They are different modules; asserting the wrong one
    // would leave the real dependency unguarded.
    it('dist/util/index.js exposes the helpers Application.ts uses', async () => {
        const mod = await import('@servicenow/sdk-cli-core/dist/util/index.js');
        for (const name of [
            'parseXml',
            'getScopeMetadataFromInstance',
            'getNowTableRequest',
            'monitorUninstallWorkerCompletion',
            'getAppAndSummary',
        ]) {
            expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
        }
    });


});

// Deliberately not asserted here:
//
// 1. That `@servicenow/sdk-cli-core` has no public root entry point. Under Node
//    it throws ERR_PACKAGE_PATH_NOT_EXPORTED — the reason these deep imports
//    exist — but jest's resolver reports a different error, so pinning the code
//    would test the runner rather than the SDK. Check it with plain Node:
//      node -e "import('@servicenow/sdk-cli-core').catch(e => console.log(e.code))"
//    If that ever stops throwing, replace these deep imports with root imports.
//
// 2. `@servicenow/sdk-cli/dist/auth/index.js` (getCredentials). That import
//    belongs to now-sdk-ext-cli and now-sdk-ext-mcp, not to this package —
//    src/ does not reference @servicenow/sdk-cli at all.
//
// 3. `dist/command/login` and `dist/util/UISession`. Both appear in
//    src/auth/NowSDKAuthenticationHandler.ts but are commented out, and
//    neither path exists in sdk-cli-core 4.9.2. Asserting them would fail on a
//    dependency the library does not actually have. Note the extraction
//    command above must exclude comment lines, or it picks these up:
//      grep -rhE "^[^/]*\bfrom ['\"]@servicenow/" src/ | grep -vE "^\s*//"
