import { describe, it, expect } from '@jest/globals';

/**
 * Guard for the unversioned deep imports this library depends on.
 *
 * src/comm/http/RequestHandler.ts, src/auth/NowSDKAuthenticationHandler.ts and
 * src/sn/Application.ts reach into `@servicenow/sdk-cli-core/dist/**` rather
 * than the package root, because the root exports nothing — importing it throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. Those `dist/` paths carry no semver contract.
 *
 * That combination means a ServiceNow SDK upgrade can move or rename a file and
 * break us at *import* time, which neither `tsc --noEmit` nor the rest of the
 * unit suite can see — it is only caught when something actually executes the
 * import. Until the imports are consolidated behind an adapter, this test is
 * what turns that class of breakage into a CI failure instead of a manual
 * verification step on every bump.
 */
describe('ServiceNow SDK deep imports', () => {
    it('exposes makeRequest from sdk-cli-core/dist/http', async () => {
        const mod = await import('@servicenow/sdk-cli-core/dist/http/index.js');
        expect(typeof mod.makeRequest).toBe('function');
    });

    it('exposes getSafeUserSession from sdk-cli-core/dist/util/sessionToken', async () => {
        const mod = await import('@servicenow/sdk-cli-core/dist/util/sessionToken.js');
        expect(typeof mod.getSafeUserSession).toBe('function');
    });

    it('exposes parseXml from sdk-cli-core/dist/util/Util', async () => {
        const mod = await import('@servicenow/sdk-cli-core/dist/util/Util.js');
        expect(typeof mod.parseXml).toBe('function');
    });

    it('exposes getCredentials from sdk-cli/dist/auth', async () => {
        const mod = await import('@servicenow/sdk-cli/dist/auth/index.js');
        expect(typeof mod.getCredentials).toBe('function');
    });

});

// Not asserted here: that `@servicenow/sdk-cli-core` has no public root entry
// point. Under Node it fails with ERR_PACKAGE_PATH_NOT_EXPORTED, which is the
// reason these deep imports exist at all — but jest's resolver reports a
// different error, so pinning the code would assert the test runner's
// behaviour rather than the SDK's. Verify it with plain Node instead:
//   node -e "import('@servicenow/sdk-cli-core').catch(e => console.log(e.code))"
// If that ever stops throwing, the SDK has grown a public entry point and these
// deep imports should be replaced with root imports.
