import { IRequestHandler } from '../comm/http/IRequestHandler';
import { Logger } from '../util/Logger';
import { IAuthenticationHandler } from './IAuthenticationHandler';
import { ICookieStore } from '../comm/http/ICookieStore';
import { ServiceNowInstance } from '../sn/ServiceNowInstance';
import { getUserSession } from '@servicenow/sdk-cli/dist/auth/index.js';
import type { UserSession } from '@servicenow/sdk-cli/dist/auth/index.js';
import { sessionCredentials, SessionCredentials } from './CredentialProvider';
import { SessionAuthError } from './SessionAuthError';

export class NowSDKAuthenticationHandler implements IAuthenticationHandler {
    private _requestHandler: IRequestHandler;
    private _isLoggedIn = false;
    private _session: UserSession | undefined;
    private _credentials: SessionCredentials | undefined;
    private _pending: Promise<UserSession> | undefined;
    private _pinned = false;
    private _logger = new Logger('NowSDKAuthenticationHandler');

    constructor(private readonly _instance: ServiceNowInstance) {}

    public async doLogin(): Promise<UserSession> {
        return this.ensureSession(true);
    }

    public async ensureSession(force = false): Promise<UserSession> {
        if (this._pending !== undefined) return this._pending;
        const credentials = this._credentials;
        const due = credentials?.type === 'oauth' &&
            credentials.expires_at - Date.now() / 1000 <= 15 * 60;
        if (!force && this._isLoggedIn && !due) return this._session;
        if (this._pinned && this._session) {
            if (!force && credentials?.type === 'oauth' && credentials.expires_at > Date.now() / 1000) {
                return this._session;
            }
            throw new SessionAuthError('NEX_SESSION_EXPIRED', 'A stateful session expired. Restart the workflow at a safe boundary; it was not replayed.');
        }
        const pending = this.login();
        this._pending = pending;
        try { return await pending; }
        finally { if (this._pending === pending) this._pending = undefined; }
    }

    private async login(): Promise<UserSession> {
        try {
            const provider = this._instance.credentialProvider;
            const credentials = provider
                ? await provider()
                : sessionCredentials(this._instance.credential);
            const previous = this._credentials ?? sessionCredentials(this._instance.credential);
            if (new URL(credentials.instanceUrl).origin !== new URL(previous.instanceUrl).origin) {
                throw new SessionAuthError('NEX_AUTH_ORIGIN_CHANGED', 'The alias now resolves to another instance. Create a new connection explicitly.');
            }
            if (credentials.type === 'oauth' && credentials.expires_at <= Date.now() / 1000) {
                throw new SessionAuthError('NEX_SESSION_EXPIRED', 'Access token expired. Supply an alias-bound credentialProvider to enable automatic SDK renewal.');
            }
            const value: unknown = await getUserSession(credentials);
            if (!value || typeof value !== 'object' || !('cookie' in value) || !value.cookie) {
                throw new SessionAuthError('NEX_AUTH_TEMPORARY', 'The SDK did not create a session. Check connectivity and retry.');
            }
            const session = value as UserSession;
            this._requestHandler.setSession(session, this._instance);
            this._session = session;
            this._credentials = credentials;
            this._isLoggedIn = true;
            return session;
        } catch (error: unknown) {
            this._isLoggedIn = false;
            if (error instanceof SessionAuthError) throw error;
            throw new SessionAuthError('NEX_AUTH_TEMPORARY', 'Session renewal failed. Check credential storage and instance connectivity, then retry.');
        }
    }

    public pinSession(): void { this._pinned = true; }
    public getRequestHandler(): IRequestHandler { return this._requestHandler; }
    public setRequestHandler(handler: IRequestHandler): void { this._requestHandler = handler; }
    public isLoggedIn(): boolean { return this._isLoggedIn; }
    public setLoggedIn(value: boolean): void { this._isLoggedIn = value; }
    public getToken(): string { return this._session?.userToken ?? ''; }
    public getCookies(): ICookieStore { return this._session?.cookie; }
    public getSession(): UserSession | undefined { return this._session; }
}
