import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ActiveSessionRegistry } from '../../../../src/comm/http/ActiveSessionRegistry';

describe('ActiveSessionRegistry', () => {

    beforeEach(() => {
        ActiveSessionRegistry.resetInstance();
    });

    describe('singleton', () => {
        it('returns the same instance on multiple calls', () => {
            const a = ActiveSessionRegistry.getInstance();
            const b = ActiveSessionRegistry.getInstance();
            expect(a).toBe(b);
        });

        it('returns new instance after resetInstance', () => {
            const a = ActiveSessionRegistry.getInstance();
            ActiveSessionRegistry.resetInstance();
            const b = ActiveSessionRegistry.getInstance();
            expect(a).not.toBe(b);
        });
    });

    describe('createSession', () => {
        it('returns a UUID string', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
            });
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        });

        it('increments size', () => {
            const registry = ActiveSessionRegistry.getInstance();
            expect(registry.size).toBe(0);

            registry.createSession({ type: 'script-tracer', instanceAlias: 'dev01' });
            expect(registry.size).toBe(1);

            registry.createSession({ type: 'impersonation', instanceAlias: 'dev01' });
            expect(registry.size).toBe(2);
        });

        it('stores initial resources', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const mockTracer = { state: 'idle' };
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
                resources: { scriptTracer: mockTracer, ambClient: 'mock-amb' },
            });

            const session = registry.getSession(id);
            expect(session).not.toBeNull();
            expect(session!.resources.get('scriptTracer')).toBe(mockTracer);
            expect(session!.resources.get('ambClient')).toBe('mock-amb');
        });
    });

    describe('getSession', () => {
        it('returns the session by ID', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
            });

            const session = registry.getSession(id);
            expect(session).not.toBeNull();
            expect(session!.id).toBe(id);
            expect(session!.type).toBe('script-tracer');
            expect(session!.instanceAlias).toBe('dev01');
        });

        it('returns null for unknown ID', () => {
            const registry = ActiveSessionRegistry.getInstance();
            expect(registry.getSession('nonexistent')).toBeNull();
        });

        it('updates lastAccessedAt on access', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
            });

            const session1 = registry.getSession(id)!;
            const firstAccess = session1.lastAccessedAt;

            // Small delay to ensure time difference
            const session2 = registry.getSession(id)!;
            expect(session2.lastAccessedAt.getTime()).toBeGreaterThanOrEqual(firstAccess.getTime());
        });

        it('returns null for expired session', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
                ttlMs: 1, // 1ms TTL
            });

            // Force expiry by advancing time
            const session = registry.getSession(id)!;
            session.lastAccessedAt = new Date(Date.now() - 100);

            expect(registry.getSession(id)).toBeNull();
            expect(registry.size).toBe(0);
        });

        it('does not expire session accessed within TTL', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
                ttlMs: 60000, // 60s TTL
            });

            expect(registry.getSession(id)).not.toBeNull();
        });
    });

    describe('getResource', () => {
        it('returns typed resource', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const mockTracer = { state: 'tracing', sessionId: 'abc' };
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
                resources: { scriptTracer: mockTracer },
            });

            const tracer = registry.getResource<typeof mockTracer>(id, 'scriptTracer');
            expect(tracer).toBe(mockTracer);
            expect(tracer!.state).toBe('tracing');
        });

        it('returns null for missing key', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
            });

            expect(registry.getResource(id, 'nonexistent')).toBeNull();
        });

        it('returns null for unknown session', () => {
            const registry = ActiveSessionRegistry.getInstance();
            expect(registry.getResource('bad-id', 'anything')).toBeNull();
        });
    });

    describe('setResource', () => {
        it('attaches a new resource', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
            });

            const result = registry.setResource(id, 'scriptTracer', { state: 'tracing' });
            expect(result).toBe(true);
            expect(registry.getResource(id, 'scriptTracer')).toEqual({ state: 'tracing' });
        });

        it('overwrites an existing resource', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
                resources: { scriptTracer: { state: 'idle' } },
            });

            registry.setResource(id, 'scriptTracer', { state: 'tracing' });
            expect(registry.getResource(id, 'scriptTracer')).toEqual({ state: 'tracing' });
        });

        it('returns false for unknown session', () => {
            const registry = ActiveSessionRegistry.getInstance();
            expect(registry.setResource('bad-id', 'key', 'value')).toBe(false);
        });
    });

    describe('destroySession', () => {
        it('removes the session', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
            });

            expect(registry.destroySession(id)).toBe(true);
            expect(registry.getSession(id)).toBeNull();
            expect(registry.size).toBe(0);
        });

        it('returns false for unknown ID', () => {
            const registry = ActiveSessionRegistry.getInstance();
            expect(registry.destroySession('nonexistent')).toBe(false);
        });

        it('does not affect other sessions', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id1 = registry.createSession({ type: 'script-tracer', instanceAlias: 'dev01' });
            const id2 = registry.createSession({ type: 'impersonation', instanceAlias: 'dev01' });

            registry.destroySession(id1);

            expect(registry.getSession(id1)).toBeNull();
            expect(registry.getSession(id2)).not.toBeNull();
            expect(registry.size).toBe(1);
        });
    });

    describe('listSessions', () => {
        it('returns all sessions when no filter', () => {
            const registry = ActiveSessionRegistry.getInstance();
            registry.createSession({ type: 'script-tracer', instanceAlias: 'dev01' });
            registry.createSession({ type: 'impersonation', instanceAlias: 'prod01' });

            const all = registry.listSessions();
            expect(all).toHaveLength(2);
        });

        it('filters by type', () => {
            const registry = ActiveSessionRegistry.getInstance();
            registry.createSession({ type: 'script-tracer', instanceAlias: 'dev01' });
            registry.createSession({ type: 'impersonation', instanceAlias: 'dev01' });
            registry.createSession({ type: 'script-tracer', instanceAlias: 'prod01' });

            const tracers = registry.listSessions({ type: 'script-tracer' });
            expect(tracers).toHaveLength(2);
            expect(tracers.every(s => s.type === 'script-tracer')).toBe(true);
        });

        it('filters by instanceAlias', () => {
            const registry = ActiveSessionRegistry.getInstance();
            registry.createSession({ type: 'script-tracer', instanceAlias: 'dev01' });
            registry.createSession({ type: 'script-tracer', instanceAlias: 'prod01' });

            const devSessions = registry.listSessions({ instanceAlias: 'dev01' });
            expect(devSessions).toHaveLength(1);
            expect(devSessions[0].instanceAlias).toBe('dev01');
        });

        it('filters by both type and instanceAlias', () => {
            const registry = ActiveSessionRegistry.getInstance();
            registry.createSession({ type: 'script-tracer', instanceAlias: 'dev01' });
            registry.createSession({ type: 'impersonation', instanceAlias: 'dev01' });
            registry.createSession({ type: 'script-tracer', instanceAlias: 'prod01' });

            const result = registry.listSessions({ type: 'script-tracer', instanceAlias: 'dev01' });
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('script-tracer');
            expect(result[0].instanceAlias).toBe('dev01');
        });

        it('evicts expired sessions', () => {
            const registry = ActiveSessionRegistry.getInstance();
            const id = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
                ttlMs: 1,
            });
            registry.createSession({ type: 'impersonation', instanceAlias: 'dev01' });

            // Force expiry
            const session = registry.getSession(id)!;
            session.lastAccessedAt = new Date(Date.now() - 100);

            const all = registry.listSessions();
            expect(all).toHaveLength(1);
            expect(all[0].type).toBe('impersonation');
        });

        it('returns empty array when no sessions match', () => {
            const registry = ActiveSessionRegistry.getInstance();
            expect(registry.listSessions({ type: 'nonexistent' })).toHaveLength(0);
        });
    });

    describe('multiple sessions on same instance', () => {
        it('supports concurrent script-tracer and impersonation on same alias', () => {
            const registry = ActiveSessionRegistry.getInstance();

            const tracerId = registry.createSession({
                type: 'script-tracer',
                instanceAlias: 'dev01',
                resources: { scriptTracer: { state: 'tracing' } },
            });
            const impersonationId = registry.createSession({
                type: 'impersonation',
                instanceAlias: 'dev01',
                resources: { impersonatedUser: 'admin' },
            });

            expect(tracerId).not.toBe(impersonationId);

            const tracer = registry.getResource(tracerId, 'scriptTracer');
            const user = registry.getResource(impersonationId, 'impersonatedUser');

            expect(tracer).toEqual({ state: 'tracing' });
            expect(user).toBe('admin');
        });
    });
});
