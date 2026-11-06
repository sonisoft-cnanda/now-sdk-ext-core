import { makeRequest } from '@servicenow/sdk-cli-core/dist/http/index.js';
import type { UserSession } from '@servicenow/sdk-cli-core/dist/auth/index.js';

/**
 * The UI Impersonate API's role resource: what the Elevate Role dialog calls. GET lists the roles the
 * user may elevate to and the session's active roles; POST sets the session's elevated roles.
 */
export const ELEVATE_ROLE_PATH = '/api/now/ui/impersonate/role';

const ROLE = /^[a-z][a-z0-9_.]{0,79}$/i;

/** A role the session's user may elevate to. */
export interface ElevatableRole {
    name: string;
    description: string;
}

/** The elevation state of one session. */
export interface ElevationStatus {
    /** Roles the user may elevate to (elevated privilege roles assigned to them). */
    available: ElevatableRole[];
    /** The available roles that are elevated in this session now. */
    elevated: string[];
}

export type RoleElevationErrorCode =
    /** A requested name is not a role name. */
    'invalid_role' |
    /** The user may not elevate to a requested role (not assigned, or not an elevated privilege role). */
    'not_elevatable' |
    /** The instance did not offer the elevate API (disabled through glide.rest.apis.disabled, or no UI access). */
    'api_unavailable' |
    /** The instance accepted the request but the session does not have the role afterwards. */
    'not_applied' |
    /** Any other failure reaching the API. */
    'request_failed';

/** Elevation failed. Messages carry role names and HTTP statuses only, never response bodies. */
export class RoleElevationError extends Error {
    public constructor(
        public readonly code: RoleElevationErrorCode,
        public readonly roles: string[] = [],
        public readonly available: string[] = [],
        public readonly status?: number,
    ) {
        super(`Role elevation failed: ${code}${roles.length ? ` (${roles.join(', ')})` : ''}${status ? `, HTTP ${status}` : ''}`);
        this.name = 'RoleElevationError';
    }
}

/** Trimmed, de-duplicated role names; refuses anything that is not a role name. */
export function normalizeRoles(roles: readonly string[] | undefined): string[] {
    const names = [...new Set((roles ?? []).map(role => String(role).trim()).filter(Boolean))];
    const invalid = names.filter(role => !ROLE.test(role));
    if (invalid.length) throw new RoleElevationError('invalid_role', invalid.filter(role => /^[\w.-]{1,80}$/.test(role)));
    return names;
}

/** Reads `{ result: { roles, activeRoles } }`. Undefined when the body is not that shape. */
export function parseElevation(body: unknown): ElevationStatus | undefined {
    const result = body && typeof body === 'object' ? (body as { result?: unknown }).result : undefined;
    if (!result || typeof result !== 'object') return undefined;
    const { roles, activeRoles } = result as { roles?: unknown; activeRoles?: unknown };
    if (!Array.isArray(roles) || !Array.isArray(activeRoles)) return undefined;
    const available = roles
        .filter((role): role is { name: string; description?: unknown } =>
            !!role && typeof role === 'object' && typeof (role as { name?: unknown }).name === 'string' && ROLE.test((role as { name: string }).name))
        .map(role => ({ name: role.name, description: typeof role.description === 'string' ? role.description : '' }));
    const active = new Set(activeRoles.filter((role): role is string => typeof role === 'string'));
    return { available, elevated: available.map(role => role.name).filter(name => active.has(name)) };
}

async function call(session: UserSession, method: 'GET' | 'POST', roles?: string): Promise<ElevationStatus> {
    let response: Response;
    try {
        response = method === 'GET'
            ? await makeRequest({ auth: session, path: ELEVATE_ROLE_PATH, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
            : await makeRequest({ auth: session, path: ELEVATE_ROLE_PATH, method: 'POST', json: { roles },
                headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    } catch {
        throw new RoleElevationError('request_failed');
    }
    if (!response.ok) {
        // A disabled or missing REST API answers 400 "Requested URI does not represent any resource".
        const text = response.status === 400 ? await response.text().catch(() => '') : '';
        const unavailable = [403, 404, 405].includes(response.status) || /does not represent any resource/i.test(text);
        throw new RoleElevationError(unavailable ? 'api_unavailable' : 'request_failed', [], [], response.status);
    }
    const status = parseElevation(await response.json().catch(() => undefined));
    if (!status) throw new RoleElevationError('request_failed', [], [], response.status);
    return status;
}

/** The session's elevation state. */
export function readElevation(session: UserSession): Promise<ElevationStatus> {
    return call(session, 'GET');
}

/**
 * Elevate a session to `roles`, keeping any role it already has elevated, and prove it took: the
 * roles must be active when the session is read again.
 *
 * Elevation belongs to the server session that asked for it and ends with it. It is sent the same
 * way every request of that session is sent (the SDK's makeRequest, with the session's own
 * credentials), so it lands on the session those requests use. It is deliberately not a policy
 * write: it changes no instance data, and `--read-only` must be able to elevate for reads that
 * need the role. Whatever the elevated session then changes is classified as usual.
 */
export async function elevateSession(session: UserSession, roles: readonly string[]): Promise<ElevationStatus> {
    const wanted = normalizeRoles(roles);
    if (!wanted.length) return readElevation(session);
    const before = await readElevation(session);
    const names = before.available.map(role => role.name);
    const missing = wanted.filter(role => !names.includes(role));
    if (missing.length) throw new RoleElevationError('not_elevatable', missing, names);
    if (wanted.every(role => before.elevated.includes(role))) return before;
    // The POST names the complete elevated set: anything left out would be dropped.
    await call(session, 'POST', [...new Set([...before.elevated, ...wanted])].join(','));
    const after = await readElevation(session);
    const absent = wanted.filter(role => !after.elevated.includes(role));
    if (absent.length) throw new RoleElevationError('not_applied', absent, names);
    return after;
}
