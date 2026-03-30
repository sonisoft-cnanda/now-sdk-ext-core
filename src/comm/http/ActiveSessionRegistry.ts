import { randomUUID } from "crypto";
import { Logger } from "../../util/Logger";

/**
 * Represents a managed, stateful workflow session (e.g., script tracing, impersonation).
 *
 * Unlike SessionManager (which caches HTTP sessions by instance alias), an ActiveSession
 * bundles together the stateful resources needed for a multi-step workflow under a unique ID.
 * This allows stateless callers (MCP tools, CLI commands) to start a workflow, receive a
 * session handle, and reference it in subsequent operations.
 */
export interface ActiveSession {
    /** Unique session identifier (UUID v4) */
    readonly id: string;
    /** Session type discriminator (e.g., 'script-tracer', 'impersonation') */
    readonly type: string;
    /** The ServiceNow instance alias this session targets */
    readonly instanceAlias: string;
    /** When the session was created */
    readonly createdAt: Date;
    /** When the session was last accessed (updated on every getSession/getResource call) */
    lastAccessedAt: Date;
    /** Arbitrary keyed resources attached to this session (e.g., ScriptTracer, AMBClient) */
    resources: Map<string, unknown>;
}

export interface CreateSessionOptions {
    /** Session type discriminator */
    type: string;
    /** The ServiceNow instance alias */
    instanceAlias: string;
    /** Initial resources to attach (key → value) */
    resources?: Record<string, unknown>;
    /** Time-to-live in milliseconds. Session expires if not accessed within this window. */
    ttlMs?: number;
}

/**
 * Singleton registry of active workflow sessions.
 *
 * Provides a unique-ID-based lookup for stateful sessions that span multiple
 * operations (e.g., start tracing → execute script → get results → stop tracing).
 *
 * Intended consumers:
 *  - MCP tools: create a session on "start", return the ID, retrieve on subsequent tool calls
 *  - CLI commands: same pattern when a command stays alive, or via future file-based persistence
 *
 * Resources are stored as opaque values — the registry does not know about ScriptTracer,
 * AMBClient, etc. Callers use typed getResource<T>() to retrieve them.
 */
export class ActiveSessionRegistry {

    private static _instance: ActiveSessionRegistry | null = null;
    private _sessions: Map<string, ActiveSession> = new Map();
    private _ttls: Map<string, number> = new Map();
    private _logger: Logger = new Logger("ActiveSessionRegistry");

    private constructor() {}

    static getInstance(): ActiveSessionRegistry {
        if (!ActiveSessionRegistry._instance) {
            ActiveSessionRegistry._instance = new ActiveSessionRegistry();
        }
        return ActiveSessionRegistry._instance;
    }

    /** @internal Visible for testing only */
    static resetInstance(): void {
        ActiveSessionRegistry._instance = null;
    }

    /**
     * Create a new active session and return its unique ID.
     */
    createSession(options: CreateSessionOptions): string {
        const id = randomUUID();
        const now = new Date();
        const session: ActiveSession = {
            id,
            type: options.type,
            instanceAlias: options.instanceAlias,
            createdAt: now,
            lastAccessedAt: now,
            resources: new Map(Object.entries(options.resources ?? {})),
        };
        this._sessions.set(id, session);
        if (options.ttlMs) {
            this._ttls.set(id, options.ttlMs);
        }
        this._logger.info(`Created ${options.type} session ${id} for instance ${options.instanceAlias}`);
        return id;
    }

    /**
     * Retrieve an active session by ID. Returns null if not found or expired.
     * Updates lastAccessedAt on access.
     */
    getSession(id: string): ActiveSession | null {
        const session = this._sessions.get(id);
        if (!session) return null;

        if (this.isExpired(session)) {
            this._logger.info(`Session ${id} expired`);
            this.destroySession(id);
            return null;
        }

        session.lastAccessedAt = new Date();
        return session;
    }

    /**
     * Typed convenience for retrieving a single resource from a session.
     * Returns null if the session doesn't exist, is expired, or the key is missing.
     */
    getResource<T>(sessionId: string, key: string): T | null {
        const session = this.getSession(sessionId);
        return (session?.resources.get(key) as T) ?? null;
    }

    /**
     * Attach or update a resource on an existing session.
     */
    setResource(sessionId: string, key: string, value: unknown): boolean {
        const session = this.getSession(sessionId);
        if (!session) return false;
        session.resources.set(key, value);
        return true;
    }

    /**
     * Destroy a session and remove all its resources.
     * Callers are responsible for cleanup of resources (e.g., stopping a ScriptTracer)
     * before calling this method.
     */
    destroySession(id: string): boolean {
        const existed = this._sessions.delete(id);
        this._ttls.delete(id);
        if (existed) {
            this._logger.info(`Destroyed session ${id}`);
        }
        return existed;
    }

    /**
     * List active (non-expired) sessions, optionally filtered by type and/or instance alias.
     */
    listSessions(filter?: { type?: string; instanceAlias?: string }): ActiveSession[] {
        // Evict expired sessions first
        for (const [id, session] of this._sessions) {
            if (this.isExpired(session)) {
                this.destroySession(id);
            }
        }

        let sessions = Array.from(this._sessions.values());
        if (filter?.type) {
            sessions = sessions.filter(s => s.type === filter.type);
        }
        if (filter?.instanceAlias) {
            sessions = sessions.filter(s => s.instanceAlias === filter.instanceAlias);
        }
        return sessions;
    }

    /**
     * Number of active sessions.
     */
    get size(): number {
        return this._sessions.size;
    }

    private isExpired(session: ActiveSession): boolean {
        const ttl = this._ttls.get(session.id);
        if (!ttl) return false;
        return (Date.now() - session.lastAccessedAt.getTime()) > ttl;
    }
}
