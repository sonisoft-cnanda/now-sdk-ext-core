import {afterEach, describe, expect, it, jest} from '@jest/globals';

const lookup = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule('@servicenow/sdk-cli/dist/auth/index.js', () => ({getCredentials: lookup}));
const {resolveSessionCredentials} = await import('../../../src/auth/CredentialProvider');
const fresh = {
    type: 'oauth', instanceUrl: 'https://example.service-now.com',
    access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
};
afterEach(() => { lookup.mockReset(); delete process.env.SN_SDK_SESSION_BEARER_TOKEN; });

describe('SDK credential provider', () => {
    it('coalesces concurrent lookup and returns fresh SDK credentials', async () => {
        let finish: (value: unknown) => void;
        lookup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const pending = Array.from({length: 20}, () => resolveSessionCredentials('fixture'));
        expect(lookup).toHaveBeenCalledTimes(1);
        finish(fresh);
        await expect(Promise.all(pending)).resolves.toHaveLength(20);
    });
    it('distinguishes rejected renewal from temporary failure without leaking causes', async () => {
        lookup.mockRejectedValue(new Error('synthetic-access', {cause: {error: 'invalid_grant'}}));
        await expect(resolveSessionCredentials('fixture')).rejects.toMatchObject({code: 'NEX_AUTH_REAUTH_REQUIRED'});
        lookup.mockRejectedValue(new Error('synthetic-refresh'));
        try { await resolveSessionCredentials('fixture'); }
        catch (error: unknown) {
            expect(error).toMatchObject({code: 'NEX_AUTH_TEMPORARY'});
            expect(String(error)).not.toContain('synthetic');
            expect(error).not.toHaveProperty('cause');
        }
    });
    it('refuses stale SDK output and environment alias overrides', async () => {
        lookup.mockResolvedValue({...fresh, expires_at: 1});
        await expect(resolveSessionCredentials('fixture')).rejects.toMatchObject({code: 'NEX_AUTH_TEMPORARY'});
        lookup.mockClear();
        process.env.SN_SDK_SESSION_BEARER_TOKEN = 'synthetic-override';
        await expect(resolveSessionCredentials('fixture')).rejects.toMatchObject({code: 'NEX_AUTH_INVALID'});
        expect(lookup).not.toHaveBeenCalled();
    });
});
