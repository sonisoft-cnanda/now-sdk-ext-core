import type { UserSession } from '@servicenow/sdk-cli-core/dist/auth/index.js';
import { SessionManager } from '../../comm/http/SessionManager';
import { readElevation, ElevationStatus } from '../../auth/SessionElevation';
import type { ServiceNowInstance } from '../ServiceNowInstance';

/**
 * Elevation state of the session SessionManager shares for an instance: the one the metadata
 * writers, AclManager and most managers use.
 *
 * To elevate, construct the ServiceNowInstance with `elevatedRoles`: every session then elevates
 * as it logs in. Elevation is per server session, so elevating one session at runtime would leave
 * any other session of the process (and any renewed session) without it.
 */
export class RoleElevation {
    public constructor(private readonly _instance: ServiceNowInstance) {}

    /** The roles the user may elevate to, and which of them the shared session has elevated. */
    public async status(): Promise<ElevationStatus> {
        const request = await SessionManager.getInstance().getAuthenticatedRequest(this._instance);
        return readElevation(await request.getUserSession() as UserSession);
    }
}
