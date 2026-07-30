/**
 * Unit tests for credential redaction (NEX-53).
 *
 * The leak these guard against was live: RequestHandler built
 * `{auth: this._session, ...}` and logged that object at debug level on every
 * request, writing cookies and tokens into logs/app-debug.log. That is what forced
 * the `^logs/` allowlist in .gitleaks.toml.
 */

import { describe, it, expect } from '@jest/globals';
import {
    redactValue,
    redactError,
    stripSecretsFromError,
    isSecretKey,
    REDACTED,
} from '../../../src/util/redact';

/** Shape of a real SDK basic-auth session, per sdk-cli-core's UserSession type. */
function aBasicSession() {
    return {
        instanceUrl: 'https://dev.service-now.com',
        type: 'basic',
        userToken: 'SUPER-SECRET-USER-TOKEN',
        cookie: { getCookieStringSync: () => 'JSESSIONID=SUPER-SECRET-COOKIE' },
    };
}

describe('isSecretKey', () => {
    it('matches the key names credentials actually arrive under', () => {
        for (const key of [
            'auth', 'Authorization', 'session', 'credential', 'credentials',
            'password', 'client_secret', 'access_token', 'refresh_token',
            'userToken', 'cookie', 'set-cookie', 'csrfToken', 'sysparm_ck',
        ]) {
            expect(isSecretKey(key)).toBe(true);
        }
    });

    it('matches compound names, since secrets rarely arrive bare', () => {
        expect(isSecretKey('sessionToken')).toBe(true);
        expect(isSecretKey('myPasswordField')).toBe(true);
        expect(isSecretKey('CookieJar')).toBe(true);
    });

    it('leaves ordinary keys alone', () => {
        for (const key of ['instanceUrl', 'method', 'path', 'status', 'table', 'query', '']) {
            expect(isSecretKey(key)).toBe(false);
        }
    });
});

describe('redactValue', () => {
    it('removes the session from a request config — the actual leak', () => {
        const config = {
            auth: aBasicSession(),
            method: 'GET',
            path: '/api/now/table/incident',
        };

        const out = JSON.stringify(redactValue(config));

        expect(out).not.toContain('SUPER-SECRET-USER-TOKEN');
        expect(out).not.toContain('SUPER-SECRET-COOKIE');
        // Non-secret context must survive, or the logs stop being useful.
        expect(out).toContain('/api/now/table/incident');
        expect(out).toContain('GET');
    });

    it('redacts nested secrets, not just top-level ones', () => {
        const out = JSON.stringify(redactValue({
            response: { config: { headers: { Authorization: 'Bearer LEAKED' } } },
        }));
        expect(out).not.toContain('LEAKED');
    });

    it('does not mutate the input', () => {
        const config = { auth: aBasicSession() };
        redactValue(config);
        expect(config.auth.userToken).toBe('SUPER-SECRET-USER-TOKEN');
    });

    it('survives cycles', () => {
        const cyclic: Record<string, unknown> = { name: 'root' };
        cyclic.self = cyclic;
        expect(() => redactValue(cyclic)).not.toThrow();
        expect(JSON.stringify(redactValue(cyclic))).toContain('[circular]');
    });

    it('survives a throwing getter rather than taking the log line down', () => {
        const hostile = {
            get boom(): string { throw new Error('nope'); },
            safe: 'kept',
        };
        const out = redactValue(hostile) as Record<string, unknown>;
        expect(out.boom).toBe('[unreadable]');
        expect(out.safe).toBe('kept');
    });

    it('redacts a CookieJar wholesale rather than walking into it', () => {
        class CookieJar { constructor(public store = 'JSESSIONID=LEAKED') {} }
        expect(redactValue({ jar: new CookieJar() })).toEqual({ jar: REDACTED });
    });

    it('passes primitives and dates through untouched', () => {
        const when = new Date();
        expect(redactValue('plain')).toBe('plain');
        expect(redactValue(42)).toBe(42);
        expect(redactValue(null)).toBeNull();
        expect(redactValue(when)).toBe(when);
    });

    it('walks arrays', () => {
        const out = JSON.stringify(redactValue([{ password: 'LEAKED' }, { ok: 1 }]));
        expect(out).not.toContain('LEAKED');
        expect(out).toContain('"ok":1');
    });
});

describe('redactError', () => {
    it('scrubs credentials hanging off a thrown error', () => {
        const err: any = new Error('Request failed');
        err.config = { auth: aBasicSession(), path: '/api/now/table/incident' };
        err.response = { config: { headers: { Cookie: 'JSESSIONID=LEAKED' } } };

        const out = JSON.stringify(redactError(err));

        expect(out).not.toContain('SUPER-SECRET-USER-TOKEN');
        expect(out).not.toContain('LEAKED');
        expect(out).toContain('Request failed');
    });

    it('keeps the diagnostic parts', () => {
        const out = redactError(new Error('boom')) as Record<string, unknown>;
        expect(out.name).toBe('Error');
        expect(out.message).toBe('boom');
        expect(typeof out.stack).toBe('string');
    });

    it('scrubs a cause chain', () => {
        const cause: any = new Error('inner');
        cause.password = 'LEAKED';
        const out = JSON.stringify(redactError(new Error('outer', { cause })));
        expect(out).not.toContain('LEAKED');
        expect(out).toContain('outer');
    });
});

describe('stripSecretsFromError', () => {
    it('scrubs in place so the error stays throwable and identifiable', () => {
        class TypedError extends Error {
            code = 'SOMETHING_SPECIFIC';
        }
        const err: any = new TypedError('failed');
        err.config = { auth: aBasicSession() };
        const stack = err.stack;

        const returned = stripSecretsFromError(err);

        // Same object, same prototype, same stack — consumers do instanceof on these.
        expect(returned).toBe(err);
        expect(returned).toBeInstanceOf(TypedError);
        expect(returned.stack).toBe(stack);
        expect(returned.code).toBe('SOMETHING_SPECIFIC');
        expect(JSON.stringify(returned.config)).not.toContain('SUPER-SECRET-USER-TOKEN');
    });

    it('redacts a secret-shaped own property outright', () => {
        const err: any = new Error('failed');
        err.password = 'LEAKED';
        expect((stripSecretsFromError(err) as any).password).toBe(REDACTED);
    });

    it('leaves the diagnostic fields intact', () => {
        const err: any = new Error('failed');
        err.status = 401;
        const out: any = stripSecretsFromError(err);
        expect(out.message).toBe('failed');
        expect(out.status).toBe(401);
    });

    it('passes non-objects straight through', () => {
        expect(stripSecretsFromError('a string')).toBe('a string');
        expect(stripSecretsFromError(null)).toBeNull();
        expect(stripSecretsFromError(undefined)).toBeUndefined();
    });

    // `new Error(msg, {cause})` installs cause as a NON-ENUMERABLE own property, so an
    // Object.keys walk never sees it. A wrapped network or auth failure is exactly the
    // shape that carries a credential-bearing cause, so missing it would defeat the
    // function's stated purpose.
    it('scrubs a non-enumerable cause', () => {
        const cause: any = new Error('inner');
        cause.config = { auth: aBasicSession() };
        const err = new Error('outer', { cause });

        const out: any = stripSecretsFromError(err);

        expect(JSON.stringify(out.cause)).not.toContain('SUPER-SECRET-USER-TOKEN');
        expect(out.cause.message).toBe('inner');
    });

    it('keeps cause non-enumerable after scrubbing', () => {
        // Re-adding it as enumerable would make it start appearing in JSON.stringify
        // output everywhere an error is serialized.
        const err = new Error('outer', { cause: new Error('inner') });
        stripSecretsFromError(err);
        expect(Object.getOwnPropertyDescriptor(err, 'cause')?.enumerable).toBe(false);
        expect(Object.keys(err)).not.toContain('cause');
    });

    it('does not throw when cause cannot be replaced', () => {
        const err = new Error('outer');
        Object.defineProperty(err, 'cause', {
            value: { password: 'LEAKED' },
            enumerable: false,
            writable: false,
            configurable: false,
        });
        expect(() => stripSecretsFromError(err)).not.toThrow();
    });
});
