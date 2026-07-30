/**
 * Unit tests for the cross-instance credential binding guard (NEX-52).
 *
 * The defect being guarded against is not "a request gets rejected". makeRequest
 * derives the destination host from auth.instanceUrl, so dispatching with a session
 * minted for another instance sends a *valid* session to the *wrong* instance — a
 * write meant for dev can land on prod and succeed. These tests pin the invariant
 * at the point it matters: immediately before the session is bound into the config.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { RequestHandler } from '../../../../src/comm/http/RequestHandler';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { ServiceNowRequest } from '../../../../src/comm/http/ServiceNowRequest';
import { StaleInstanceError, isStaleInstanceError } from '../../../../src/exception/StaleInstanceError';
import { MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { SNRequestBase } from '../../../../src/sn/SNRequestBase';

function anInstance(alias: string): ServiceNowInstance {
    return new ServiceNowInstance({ alias, host: `${alias}.service-now.com` });
}

/** Minimal HTTPRequest shape — getRequestConfig only reads these fields. */
function aRequest(): any {
    return { method: 'GET', path: '/api/now/table/incident', query: {}, headers: {} };
}

describe('ServiceNowInstance identity', () => {
    it('gives every instance a distinct id', () => {
        expect(anInstance('dev').getInstanceId()).not.toBe(anInstance('dev').getInstanceId());
    });

    it('keeps an instance id stable across reads', () => {
        const instance = anInstance('dev');
        expect(instance.getInstanceId()).toBe(instance.getInstanceId());
    });
});

describe('StaleInstanceError', () => {
    it('carries a stable code and a remediation', () => {
        const err = new StaleInstanceError('boom', 'do the thing');
        expect(err.code).toBe('INSTANCE_STALE_DURING_REQUEST');
        expect(err.remediation).toBe('do the thing');
        expect(err.name).toBe('StaleInstanceError');
        expect(err).toBeInstanceOf(Error);
    });

    it('is recognised structurally, so it survives a module boundary', () => {
        expect(isStaleInstanceError(new StaleInstanceError('a', 'b'))).toBe(true);
        // A plain object carrying the code — what a deserialized error looks like.
        expect(isStaleInstanceError({ code: 'INSTANCE_STALE_DURING_REQUEST' })).toBe(true);
        expect(isStaleInstanceError(new Error('unrelated'))).toBe(false);
        expect(isStaleInstanceError(undefined)).toBe(false);
    });

    it('preserves a cause when given one', () => {
        const cause = new Error('underlying');
        expect(new StaleInstanceError('a', 'b', { cause }).cause).toBe(cause);
    });
});

describe('RequestHandler instance binding', () => {
    let handler: RequestHandler;

    beforeEach(() => {
        handler = new RequestHandler(new MockAuthenticationHandler() as any);
    });

    it('refuses to build a config when the session belongs to another instance', async () => {
        const dev = anInstance('dev');
        const prod = anInstance('prod');

        handler.bindInstance(dev);
        handler.setSession({ instanceUrl: 'https://prod.service-now.com' }, prod);

        await expect((handler as any).getRequestConfig(aRequest())).rejects.toThrow(StaleInstanceError);
    });

    it('names both instances so the mismatch is diagnosable', async () => {
        const dev = anInstance('dev');
        const prod = anInstance('prod');
        handler.bindInstance(dev);
        handler.setSession({}, prod);

        const err: any = await (handler as any)
            .getRequestConfig(aRequest())
            .catch((e: unknown) => e);

        expect(err.code).toBe('INSTANCE_STALE_DURING_REQUEST');
        expect(err.message).toContain(String(dev.getInstanceId()));
        expect(err.message).toContain(String(prod.getInstanceId()));
        expect(err.remediation).toMatch(/retry/i);
    });

    it('builds the config when the session matches the bound instance', async () => {
        const dev = anInstance('dev');
        const session = { instanceUrl: 'https://dev.service-now.com' };

        handler.bindInstance(dev);
        handler.setSession(session, dev);

        const { config } = await (handler as any).getRequestConfig(aRequest());
        expect(config.auth).toBe(session);
    });

    // Permissive paths. A handler with no instance (ATFTestExecutor constructs one,
    // then replaces it) or a caller predating the second setSession parameter was
    // never actually unsafe, and must not start throwing.
    it('allows dispatch when the session owner is unknown', async () => {
        handler.bindInstance(anInstance('dev'));
        handler.setSession({ instanceUrl: 'https://dev.service-now.com' });

        await expect((handler as any).getRequestConfig(aRequest())).resolves.toBeDefined();
    });

    it('allows dispatch when nothing was bound', async () => {
        handler.setSession({ instanceUrl: 'https://dev.service-now.com' }, anInstance('dev'));

        await expect((handler as any).getRequestConfig(aRequest())).resolves.toBeDefined();
    });

    it('goes permissive again when a session is replaced without an owner', async () => {
        const dev = anInstance('dev');
        handler.bindInstance(dev);
        handler.setSession({}, dev);
        // Re-set without an owner: we no longer know whose session this is, so the
        // guard must stop asserting rather than keep comparing against the old owner.
        handler.setSession({ replaced: true });

        await expect((handler as any).getRequestConfig(aRequest())).resolves.toBeDefined();
    });
});

describe('RequestHandler error propagation', () => {
    // Previously every verb did `throw new Error(ex)`, which stringified the cause,
    // discarded the stack, and flattened typed errors so instanceof failed at every
    // call site. The guard is worthless if its error cannot be identified.
    it.each(['get', 'post', 'put', 'delete'] as const)(
        'propagates a typed error unflattened through %s()',
        async (verb) => {
            const handler = new RequestHandler(new MockAuthenticationHandler() as any);
            handler.bindInstance(anInstance('dev'));
            handler.setSession({}, anInstance('prod'));

            const err: unknown = await (handler as any)[verb](aRequest()).catch((e: unknown) => e);

            expect(err).toBeInstanceOf(StaleInstanceError);
            expect((err as StaleInstanceError).code).toBe('INSTANCE_STALE_DURING_REQUEST');
        },
    );

    it('still wraps a non-Error throw', async () => {
        const handler = new RequestHandler(new MockAuthenticationHandler() as any);
        jest.spyOn(handler as any, 'doRequest').mockRejectedValue('a bare string' as never);

        const err: unknown = await handler.get(aRequest()).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('a bare string');
    });
});

describe('SNRequestBase instance swap', () => {
    // The public snInstance setter used to change the instance while leaving _req
    // bound to the previous one. Both ids on that handler stayed pointed at the old
    // instance, so they still MATCHED and the dispatch guard saw nothing wrong —
    // requests silently kept going to the old instance through exported API.
    class Manager extends SNRequestBase {}

    it('rebuilds the bound request when the instance is swapped', () => {
        const dev = anInstance('dev');
        const prod = anInstance('prod');
        const manager = new Manager(dev);
        const before = manager.request;

        manager.snInstance = prod;

        expect(manager.request).not.toBe(before);
        expect(manager.request.getInstance()).toBe(prod);
        expect((manager.request._requestHandler as any)._boundInstanceId).toBe(prod.getInstanceId());
    });

    it('leaves the request alone when set to the same instance', () => {
        const dev = anInstance('dev');
        const manager = new Manager(dev);
        const before = manager.request;

        manager.snInstance = dev;

        expect(manager.request).toBe(before);
    });
});

describe('ServiceNowRequest binding', () => {
    it('binds its handler to the instance it was constructed for', () => {
        const dev = anInstance('dev');
        const req = new ServiceNowRequest(dev);

        expect(req.getInstance()).toBe(dev);
        expect((req._requestHandler as any)._boundInstanceId).toBe(dev.getInstanceId());
    });

    it('tolerates construction without an instance', () => {
        expect(() => new ServiceNowRequest()).not.toThrow();
    });
});
