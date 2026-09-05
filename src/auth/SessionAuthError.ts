/** Authentication failures safe to expose across CLI, MCP, and browser runners. */
export class SessionAuthError extends Error {
    constructor(
        public readonly code: 'NEX_AUTH_REAUTH_REQUIRED' | 'NEX_AUTH_TEMPORARY' |
            'NEX_SESSION_EXPIRED' | 'NEX_AUTH_INVALID' | 'NEX_AUTH_ORIGIN_CHANGED',
        public readonly remediation: string,
    ) {
        super(remediation);
        this.name = 'SessionAuthError';
    }
}
