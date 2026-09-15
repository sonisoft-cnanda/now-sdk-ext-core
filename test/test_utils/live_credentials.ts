import {getCredentials} from '@servicenow/sdk-cli/dist/auth/index.js';
import {sessionCredentials, type SessionCredentials} from '../../src/auth/CredentialProvider';
import {initCredentialStore} from '../../src/credentials/ensureShim';
import {SN_INSTANCE_ALIAS} from './test_config';

/**
 * Resolve stored credentials for a live test.
 *
 * Prefers the SDK `getCredentials` path. Jest's ESM loader can instantiate the
 * SDK keychain before the optional shim sees it, in which case the same alias
 * is read from `@sonisoft/sn-credstore` the way other live suites already do.
 */
export async function loadLiveAliasCredentials(
    alias: string = SN_INSTANCE_ALIAS,
): Promise<SessionCredentials> {
    await initCredentialStore();
    try {
        return sessionCredentials(await getCredentials(alias));
    } catch {
        const {loadConfig, parseKeyStore, vaultFor} = await import('@sonisoft/sn-credstore');
        const vault = vaultFor(loadConfig());
        try {
            const blob = await vault.getPassword();
            const store = blob ? parseKeyStore(blob) : null;
            return sessionCredentials(store?.[alias]?.creds);
        } finally {
            await vault.abandonLease();
        }
    }
}
