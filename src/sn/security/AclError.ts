const IDENTIFIER = /^[a-z0-9_.*]{1,120}$/i;

export type AclErrorCode =
    'invalid_input' | 'elevation_required' | 'filter_required' | 'acl_not_found' | 'type_not_found' |
    'operation_not_found' | 'table_not_found' | 'field_not_found' | 'role_not_found' | 'role_already_present' |
    'role_not_present' | 'confirmation_required' | 'partially_applied';

/** A refusal of an ACL operation before anything was written. Detail carries names that passed a strict check only. */
export class AclError extends Error {
    public readonly detail?: string;
    public constructor(public readonly code: AclErrorCode, detail?: string) {
        const safe = detail && IDENTIFIER.test(detail) ? detail : undefined;
        super(`ACL operation refused: ${code}${safe ? ` (${safe})` : ''}`);
        this.name = 'AclError';
        this.detail = safe;
    }
}

/**
 * A create that failed after the ACL was inserted. The ACL stays inactive (it is activated only as
 * the last step), so it has no effect; `aclSysId` names it for a retry with addRole or a delete.
 */
export class AclPartialError extends AclError {
    public constructor(public readonly aclSysId: string, public readonly cause: unknown) {
        super('partially_applied');
        this.name = 'AclPartialError';
        this.message = `ACL ${aclSysId} was created but a later step failed; it is inactive unless it was created without roles.`;
    }
}
