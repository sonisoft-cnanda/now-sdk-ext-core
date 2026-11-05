const IDENTIFIER = /^[a-z0-9_.*]{1,120}$/i;

export type AclErrorCode =
    'invalid_input' | 'elevation_required' | 'filter_required' | 'acl_not_found' | 'type_not_found' |
    'operation_not_found' | 'table_not_found' | 'field_not_found' | 'role_not_found' | 'role_already_present' |
    'role_not_present' | 'confirmation_required' | 'scope_mismatch' | 'roles_not_applied' | 'partially_applied';

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
 * A create or delete that failed part way, after a write. `active` is the ACL's state read back afterwards (undefined
 * when it could not be read): a create activates only as its last step, and a failed delete is reactivated when it had
 * been deactivated for it. `cause` is the failure.
 */
export class AclPartialError extends AclError {
    public constructor(public readonly aclSysId: string, public readonly operation: 'create' | 'delete',
        public readonly active: boolean | undefined, public readonly cause: unknown) {
        super('partially_applied');
        this.name = 'AclPartialError';
        const state = active === undefined ? 'in an unknown state: read it back' : active ? 'ACTIVE' : 'inactive';
        this.message = `ACL ${aclSysId}: the ${operation} failed part way; the ACL is ${state}.`;
    }
}
