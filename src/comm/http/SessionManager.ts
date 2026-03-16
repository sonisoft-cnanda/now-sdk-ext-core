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
    private _logger: Logger = new Logger("SessionManager");

    private constructor() {}

    static getInstance(): SessionManager {
        if (!SessionManager._instance) {
            SessionManager._instance = new SessionManager();
        }
        return SessionManager._instance;
    }

    /**
     * Reset singleton (for testing only)
     */
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
        if (!request) {
            this._logger.debug(`Creating new session for alias: ${key}`);
            request = new ServiceNowRequest(instance);
            this._sessions.set(key, request);
        }
        return request;
    }

    /**
     * Get or create a ServiceNowRequest and ensure it is authenticated.
     */
    async getAuthenticatedRequest(instance: ServiceNowInstance): Promise<ServiceNowRequest> {
        const request = this.getRequest(instance);
        if (!request.isLoggedIn()) {
            this._logger.debug(`Authenticating session for alias: ${this.getKey(instance)}`);
            await request.getUserSession();
        }
        return request;
    }

    /**
     * Remove cached session for a given alias.
     */
    clearSession(alias: string): void {
        this._logger.debug(`Clearing session for alias: ${alias}`);
        this._sessions.delete(alias);
    }

    /**
     * Remove all cached sessions.
     */
    clearAll(): void {
        this._logger.debug(`Clearing all ${this._sessions.size} sessions`);
        this._sessions.clear();
    }

    /**
     * Check if a session exists for a given alias.
     */
    hasSession(alias: string): boolean {
        return this._sessions.has(alias);
    }

    private getKey(instance: ServiceNowInstance): string {
        return instance.getAlias() ?? instance.getHost() ?? 'default';
    }
}
