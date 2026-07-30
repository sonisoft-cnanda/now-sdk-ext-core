import { ServiceNowInstance } from "../../sn/ServiceNowInstance";
import { ServiceNowRequest } from "./ServiceNowRequest";
import { Logger } from "../../util/Logger";

/**
 * Singleton registry of authenticated ServiceNowRequest instances keyed by instance alias.
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
     * Keyed by alias (falls back to host).
     */
    getRequest(instance: ServiceNowInstance): ServiceNowRequest {
        const key = this.getKey(instance);
        let request = this._sessions.get(key);

        // The key is alias-or-host, which says nothing about *which* ServiceNowInstance
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
     * Remove cached session for a given alias.
     */
    clearSession(alias: string): void {
        this._logger.debug(`Clearing session for alias: ${alias}`);
        this._sessions.delete(alias);
        // An auth started before the clear would otherwise resolve after it and hand
        // the caller the request we just evicted.
        this._authPromises.delete(alias);
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
     * Check if a session exists for a given alias.
     */
    hasSession(alias: string): boolean {
        return this._sessions.has(alias);
    }

    private getKey(instance: ServiceNowInstance): string {
        const key = instance.getAlias() ?? instance.getHost();
        if (!key) {
            throw new Error("ServiceNowInstance must have an alias or host to identify the session");
        }
        return key;
    }
}
