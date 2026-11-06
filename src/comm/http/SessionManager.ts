import { ServiceNowInstance } from "../../sn/ServiceNowInstance";
import { ServiceNowRequest } from "./ServiceNowRequest";
import { Logger } from "../../util/Logger";

/** Separates an elevated session's key from its alias: `dev#elevated:security_admin`. */
const ELEVATED_KEY = '#elevated:';

/**
 * Singleton registry of authenticated ServiceNowRequest instances keyed by instance alias (or host), plus the
 * instance's elevated roles when it has any: an elevated session is a separate server session.
 * Ensures all components sharing the same alias reuse the same HTTP session.
 */
export class SessionManager {

    private static _instance: SessionManager | null = null;
    private _sessions: Map<string, ServiceNowRequest> = new Map();
    private _authPromises: Map<string, Promise<ServiceNowRequest>> = new Map();
    private _logger: Logger = new Logger("SessionManager");

    private constructor() {}

    static getInstance(): SessionManager {
        if (!SessionManager._instance) {
            SessionManager._instance = new SessionManager();
        }
        return SessionManager._instance;
    }

    /** @internal Visible for testing only — not exported from index.ts */
    static resetInstance(): void {
        SessionManager._instance = null;
    }

    /**
     * Get or create a ServiceNowRequest for this instance.
     * Keyed by alias (falls back to host) and elevated roles.
     */
    getRequest(instance: ServiceNowInstance): ServiceNowRequest {
        const key = this.getKey(instance);
        let request = this._sessions.get(key);

        // The key is alias-or-host (and elevation), which says nothing about *which* ServiceNowInstance
        // object asked. A consumer that rebuilds its connection — now-sdk-ext-mcp evicts
        // on a 30-minute TTL — passes a new instance under the same alias and would
        // otherwise be handed the previous one's request, still holding the previous
        // session. Recreate instead: this is recoverable, so self-heal rather than throw.
        if (request && !this.isBoundTo(request, instance)) {
            this._logger.debug(`Instance replaced for alias: ${key}; discarding the cached session.`);
            this._sessions.delete(key);
            this._authPromises.delete(key);
            request = undefined;
        }

        if (!request) {
            this._logger.debug(`Creating new session for alias: ${key}`);
            request = new ServiceNowRequest(instance);
            this._sessions.set(key, request);
        }
        return request;
    }

    /**
     * True when the cached request was built for exactly this instance.
     *
     * Answers "leave the cache alone" whenever identity cannot be established on
     * either side — a request built without an instance, or a caller passing a
     * duck-typed instance that predates getInstanceId(). Evicting on unknown
     * identity would throw away a good session and force a fresh login on every
     * single lookup, which is a worse failure than the one being guarded against.
     */
    private isBoundTo(request: ServiceNowRequest, instance: ServiceNowInstance): boolean {
        const bound = request.getInstance?.();
        if (!bound) {
            return true;
        }

        const boundId = bound.getInstanceId?.();
        const requestedId = instance?.getInstanceId?.();
        if (boundId === undefined || requestedId === undefined) {
            return true;
        }

        return boundId === requestedId;
    }

    /**
     * Get or create a ServiceNowRequest and ensure it is authenticated.
     * Uses an in-flight promise guard to prevent duplicate concurrent auth calls.
     */
    async getAuthenticatedRequest(instance: ServiceNowInstance): Promise<ServiceNowRequest> {
        const key = this.getKey(instance);
        const request = this.getRequest(instance);

        if (request.isLoggedIn()) {
            await request.getUserSession();
            return request;
        }

        // Guard against concurrent callers both triggering auth
        const existing = this._authPromises.get(key);
        if (existing) {
            return existing;
        }

        const authPromise: Promise<ServiceNowRequest> = (async () => {
            try {
                this._logger.debug(`Authenticating session for alias: ${key}`);
                await request.getUserSession();
                return request;
            } finally {
                // Only clear our own entry. An instance swap on this alias evicts the
                // map and a fresh caller can install a NEW promise under the same key
                // while this one is still settling — an unconditional delete would
                // remove theirs, costing a duplicate login.
                if (this._authPromises.get(key) === authPromise) {
                    this._authPromises.delete(key);
                }
            }
        })();

        this._authPromises.set(key, authPromise);
        return authPromise;
    }

    /**
     * Remove the cached sessions of an alias (or host): the plain one and every elevated one.
     */
    clearSession(alias: string): void {
        this._logger.debug(`Clearing session for alias: ${alias}`);
        // The alias's elevated sessions go with it: they log in with the same credentials.
        const keys = [...new Set([...this._sessions.keys(), ...this._authPromises.keys()])]
            .filter(key => key === alias || key.startsWith(`${alias}${ELEVATED_KEY}`));
        for (const key of keys) {
            this._sessions.delete(key);
            // An auth started before the clear would otherwise resolve after it and hand
            // the caller the request we just evicted.
            this._authPromises.delete(key);
        }
    }

    /**
     * Remove all cached sessions.
     */
    clearAll(): void {
        this._logger.debug(`Clearing all ${this._sessions.size} sessions`);
        this._sessions.clear();
        this._authPromises.clear();
    }

    /**
     * Check if a session exists under a key: the alias (or host) for a plain session; an elevated
     * session's key is `alias#elevated:<roles, sorted, comma-separated>`.
     */
    hasSession(alias: string): boolean {
        return this._sessions.has(alias);
    }

    private getKey(instance: ServiceNowInstance): string {
        const key = instance.getAlias() ?? instance.getHost();
        if (!key) {
            throw new Error("ServiceNowInstance must have an alias or host to identify the session");
        }
        // The marker would let a plain instance's key equal an elevated one's.
        if (key.includes(ELEVATED_KEY)) {
            throw new Error(`ServiceNowInstance alias or host may not contain "${ELEVATED_KEY}"`);
        }
        // An elevated session is a different server session: a long-lived consumer (now-sdk-ext-mcp) keeps a plain
        // and an elevated instance for one alias side by side, and neither may replace the other's session.
        const elevated = instance.elevatedRoles ?? [];
        return elevated.length ? `${key}${ELEVATED_KEY}${[...elevated].sort().join(',')}` : key;
    }
}
