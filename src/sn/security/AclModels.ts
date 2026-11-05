import type { MetadataScopeRef, MetadataWriteResult, StoreCustomizationOptions } from '../metadata/MetadataModels';

/** A role on an access control (a sys_security_acl_role row). */
export interface AclRole {
    /** sys_id of the sys_security_acl_role row. */
    sysId: string;
    /** sys_user_role sys_id. */
    roleSysId: string;
    /** Role name; '' when the session may not read it (security_admin is hidden until elevated). */
    role: string;
}

/** An access control as read back from the instance. */
export interface AclRecord {
    sysId: string;
    /** `table`, `table.field` or `table.*` for record ACLs; the resource name for other types. */
    name: string;
    /** sys_security_type name: record, ui_page, rest_endpoint, client_callable_script_include, … */
    type: string;
    /** sys_security_operation name: read, write, create, delete, execute, … */
    operation: string;
    active: boolean;
    adminOverrides: boolean;
    /** The script runs only when advanced is true. */
    advanced: boolean;
    /** allow or deny; '' on a release without decision types. */
    decisionType: string;
    description: string;
    condition: string;
    script: string;
    /** sys_scope sys_id, and its scope name. */
    scope: string;
    scopeName: string;
    updatedOn: string;
    roles: AclRole[];
}

export interface AclListOptions {
    /** ACLs of this table: the table itself and its fields (`table`, `table.*`, `table.<field>`). */
    table?: string;
    /** Exact ACL name. */
    name?: string;
    /** Only this application's ACLs: 'global', a scope name or a sys_scope sys_id. */
    scope?: MetadataScopeRef;
    operation?: string;
    type?: string;
    active?: boolean;
}

/** Where a write goes: the application, and the in-progress update set that captures it. */
export interface AclWriteTarget {
    /** The ACL's application. */
    scope: MetadataScopeRef;
    /** In progress set of that application. The captures follow it; it need not be the user's current set. */
    updateSet?: string;
    /** Required when the application is an installed Store application (together with updateSet). */
    storeCustomization?: StoreCustomizationOptions;
}

export interface AclCreateOptions extends AclWriteTarget {
    /** sys_security_type name. Default record. */
    type?: string;
    /** sys_security_operation name, e.g. read, write, create, delete. */
    operation: string;
    /** record ACLs: the table, and optionally a field or '*' for every field. */
    table?: string;
    field?: string;
    /** Other types: the resource name (UI page, REST endpoint, script include, …). */
    name?: string;
    /** Role names. Any one of them passes the ACL. */
    roles?: string[];
    condition?: string;
    /** Script that sets `answer`; sets advanced, which the script needs to run. */
    script?: string;
    /** Default true, as on the form. */
    adminOverrides?: boolean;
    /** Default true. */
    active?: boolean;
    /** allow (default on the form) or deny. */
    decisionType?: string;
    description?: string;
}

export interface AclUpdateOptions extends AclWriteTarget {
    operation?: string;
    condition?: string;
    script?: string;
    adminOverrides?: boolean;
    active?: boolean;
    decisionType?: string;
    description?: string;
}

export interface AclDeleteOptions extends AclWriteTarget {
    /** Must repeat the ACL's sys_id. */
    confirm: string;
}

export interface AclWriteResult {
    /** The ACL as read back after the change; absent after a delete. */
    acl?: AclRecord;
    /** The ACL before the change; absent after a create. */
    previous?: AclRecord;
    /** Every verified write, in order (the ACL, its role rows). */
    writes: MetadataWriteResult[];
    /** Roles the platform added on its own that the write removed (snc_internal on a new ACL that was given roles). */
    removedAutomaticRoles: string[];
    /** Things to look at: e.g. snc_internal left beside other roles, which lets every internal user pass. */
    warnings: string[];
}
