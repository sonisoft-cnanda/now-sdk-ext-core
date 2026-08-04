/**
 * Message-string redaction (NEX-3).
 *
 * `Logger.redactSecrets` deliberately skips `info.message`, and `redactValue` is
 * key-based — so a secret interpolated into a template literal reached disk verbatim.
 * The confirmed sites were ScriptTracer (a live session token, at info level) and
 * AMBClient (session cookies, truncated but not redacted).
 *
 * Fixing those six call sites fixes today's leaks and none of tomorrow's, which is the
 * same argument Logger.ts already makes for metadata. Hence a scrub over the message
 * itself, matched on the secret's NAME rather than the shape of its value — the same
 * rule redact.ts uses for keys, for the same reason.
 *
 * The over-redaction risk is real and deliberate: losing "30s" from "token refresh: 30s"
 * costs a diagnostic, leaking a session token costs an instance.
 */

import { describe, it, expect } from '@jest/globals';
import { redactMessage, redactValue, isSecretKey } from '../../../src/util/redact';

describe('redactMessage', () => {
    describe('the leaks that motivated it', () => {
        it('redacts the ScriptTracer session token (was logged at info level)', () => {
            const out = redactMessage('Session ID from debugger/start: A1B2C3D4E5F6A1B2C3D4E5F6');
            expect(out).not.toContain('A1B2C3D4E5F6');
            expect(out).toContain('Session ID from debugger/start');
        });

        it('redacts the ScriptTracer user-token fallback', () => {
            const out = redactMessage(
                'No token in debugger/start response, derived from user token: DEADBEEFCAFE1234',
            );
            expect(out).not.toContain('DEADBEEFCAFE1234');
        });

        it('redacts AMBClient session cookies (truncation is not redaction)', () => {
            const out = redactMessage(
                'Cookies: JSESSIONID=8A7B6C5D4E3F; glide_user_route=glide.abc123def456...',
            );
            expect(out).not.toContain('8A7B6C5D4E3F');
            expect(out).not.toContain('glide.abc123def456');
        });

        it('redacts a bare JSESSIONID wherever it appears', () => {
            const out = redactMessage('handshake used JSESSIONID=0123456789ABCDEF for the channel');
            expect(out).not.toContain('0123456789ABCDEF');
            expect(out).toContain('JSESSIONID');
        });

        it('redacts a Cookie header to end of line, not just the first pair', () => {
            const out = redactMessage('Cookie: a=one; glide_session_store=SECRETVALUE; b=two');
            expect(out).not.toContain('SECRETVALUE');
        });

        it('redacts a bearer token', () => {
            const out = redactMessage('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
            expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
        });

        it('redacts a password given as key=value', () => {
            expect(redactMessage('login failed for password=hunter2')).not.toContain('hunter2');
        });
    });

    describe('does not destroy ordinary diagnostics', () => {
        it.each([
            'Successfully authenticated and obtained session cookies',
            'Could not extract session cookies!',
            'Extracted 3 cookies via getCookiesSync',
            'Instance URL configured: https://dev12345.service-now.com',
            'Error during request. Status: 401',
            'Retrieved Configuration',
            'CSRF token received.',
        ])('leaves %p unchanged', (message) => {
            expect(redactMessage(message)).toBe(message);
        });

        it('keeps the non-secret part of a mixed message', () => {
            const out = redactMessage('subscribe to /channel/x failed, JSESSIONID=ABCDEF123456');
            expect(out).toContain('/channel/x failed');
        });
    });

    describe('degrades safely', () => {
        it.each([['', ''], [undefined, undefined], [null, null]])(
            'passes %p straight through',
            (input, expected) => {
                expect(redactMessage(input as unknown as string)).toBe(expected);
            },
        );

        it('returns non-strings untouched', () => {
            const obj = { a: 1 };
            expect(redactMessage(obj as unknown as string)).toBe(obj);
        });

        it('is bounded — a long run of non-delimiters cannot hang it', () => {
            const message = `token: ${'x'.repeat(200_000)}`;
            const started = process.hrtime.bigint();
            const out = redactMessage(message);
            const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
            expect(out).not.toContain('xxxxxxxxxx');
            expect(elapsedMs).toBeLessThan(250);
        });
    });
});

describe('key-based redaction of AMB/CometD session material', () => {
    // SubscriptionCommandSender logs whole CometD responses as metadata on the
    // grounds that metadata is redacted. That is only true if the key list actually
    // covers what a Bayeux response carries.
    it.each(['clientId', 'client_id', 'JSESSIONID', 'glide_session_store', 'glide_user_route'])(
        'treats %s as secret',
        (key) => {
            expect(isSecretKey(key)).toBe(true);
        },
    );

    it('redacts a Bayeux handshake response', () => {
        const out = redactValue({
            channel: '/meta/handshake',
            clientId: 'CLIENTID_SENTINEL_1234',
            ext: { glide_session_store: 'STORE_SENTINEL_5678', replay: true },
            successful: true,
        });
        const text = JSON.stringify(out);
        expect(text).not.toContain('CLIENTID_SENTINEL_1234');
        expect(text).not.toContain('STORE_SENTINEL_5678');
        // and stays useful for debugging
        expect(text).toContain('/meta/handshake');
        expect(text).toContain('successful');
    });

    it('does not redact the non-secret session diagnostics the AMB code relies on', () => {
        // AMBClient deliberately logs key NAMES and shapes, never values. Broadening
        // to a `session` fragment would have destroyed these.
        expect(isSecretKey('sessionKeys')).toBe(false);
        expect(isSecretKey('sessionType')).toBe(false);
        expect(isSecretKey('extendSession')).toBe(false);
    });
});
