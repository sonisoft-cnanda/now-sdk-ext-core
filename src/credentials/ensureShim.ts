/**
 * Opt-in headless credential storage for library consumers.
 *
 * Deliberately NOT a module side effect and NOT in the ctix-generated barrel:
 * `import { anything } from '@sonisoft/now-sdk-ext-core'` must never monkeypatch
 * the ServiceNow SDK's credential storage as a consequence. A consumer that
 * wants the shim asks for it by calling this.
 *
 * Applications that own their entry point (nex, the MCP server) import
 * '@sonisoft/sn-credstore/register' there instead — earlier, and unconditional.
 * This exists for embedders that do not control process startup.
 */

/**
 * Absence is legitimate. A shim that loads and then fails is not.
 *
 * sn-credstore is an OPTIONAL dependency of this package, because core is a
 * library: making it required would force a credential shim onto every consumer,
 * including ones that never call initCredentialStore(). So it can genuinely be
 * missing — `npm install --no-optional`, a pruned install, a bundler that dropped
 * it — and that must degrade rather than throw.
 */
function isNotInstalled(error: unknown): boolean {
    const err = error as NodeJS.ErrnoException | undefined;
    return (
        err?.code === 'ERR_MODULE_NOT_FOUND' &&
        // Only OUR specifier missing means "not installed". The same code from a
        // broken import *inside* sn-credstore means it is installed and broken,
        // which must not be mistaken for absence.
        /@sonisoft[/\\]sn-credstore/.test(String(err.message))
    );
}

export interface InitCredentialStoreResult {
    /** True once the SDK's KeyChain is reading the headless-safe store. */
    active: boolean;
    /** Why it is not active, when it is not. */
    reason?: 'not-installed' | 'disabled';
}

let cached: InitCredentialStoreResult | undefined;

/**
 * Point the ServiceNow SDK's credential storage at a headless-safe store.
 *
 * Non-interactive sessions cannot unlock the OS keyring even as the same user,
 * and `KeyChain.getPassword()` swallows that failure and returns null — so the
 * SDK reports "Default Credential has not been set" rather than a keyring error.
 *
 * Idempotent, and safe to call when @sonisoft/sn-credstore is not installed: it
 * reports `active: false` and leaves the SDK on its default keyring path. Callers
 * that require the store should check the result rather than assume success.
 *
 * Throws only when the shim IS installed and fails to apply — continuing then
 * would silently fall back to the keyring, and the SDK's next credential write
 * reseeds from a failed read, wiping every other alias.
 */
export async function initCredentialStore(): Promise<InitCredentialStoreResult> {
    if (cached) return cached;

    if (process.env.SN_CRED_STORE_DISABLE) {
        cached = { active: false, reason: 'disabled' };
        return cached;
    }

    try {
        // Held in a variable so TypeScript does not try to resolve it. This
        // package still compiles with moduleResolution "node", which predates and
        // ignores `exports` maps, so a literal specifier for the ./register
        // subpath fails to type-check even though Node resolves it correctly at
        // runtime. Switching core to Node16 resolution would fix it properly, but
        // that is a change with a much wider blast radius than this file.
        const specifier = '@sonisoft/sn-credstore/register';
        await import(specifier);
        cached = { active: true };
    } catch (error) {
        if (!isNotInstalled(error)) throw error;
        cached = { active: false, reason: 'not-installed' };
    }

    return cached;
}
