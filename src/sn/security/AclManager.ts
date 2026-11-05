import { SessionManager } from '../../comm/http/SessionManager';
import type { FormValueInput } from '../../comm/http/FormRecordModels';
import { MetadataFormWriter } from '../metadata/MetadataFormWriter';
import type { MetadataWriteResult } from '../metadata/MetadataModels';
import { MetadataReader, MetadataRow } from '../metadata/internal/MetadataReader';
import { resolveScope } from '../metadata/internal/MetadataScope';
import type { ServiceNowInstance } from '../ServiceNowInstance';
import { AclError, AclPartialError } from './AclError';
import type { AclCreateOptions, AclDeleteOptions, AclListOptions, AclRecord, AclRole, AclUpdateOptions, AclWriteResult, AclWriteTarget } from './AclModels';
import { RoleElevation } from './RoleElevation';
import { accessControlWriters } from '../metadata/internal/AccessControlWriters';
import { isPolicyRefusal } from '../../policy/PolicyRefusal';

const ID = /^[a-f0-9]{32}$/i;
const IDENT = /^[a-z0-9_]{1,80}$/i;
const ROLE = /^[a-z][a-z0-9_.]{0,79}$/i;
/** Free-form ACL names (REST endpoints, UI pages, …) must not break an encoded query. */
const RESOURCE = /^[^^\p{Cc}]{1,200}$/u;
/** A query value the instance would evaluate as script. */
const SCRIPT = /javascript:/i;
const ACL = 'sys_security_acl';
const ACL_ROLE = 'sys_security_acl_role';
const REQUIRED_ROLE = 'security_admin';
/** The role the platform puts on an ACL that has none (Explicit Roles). Any internal user has it. */
const AUTOMATIC_ROLE = 'snc_internal';
const BASE_FIELDS = 'name,type,type.name,operation,operation.name,active,admin_overrides,advanced,description,condition,script,sys_scope,sys_scope.scope,sys_updated_on';

const bool = (value: string | undefined): boolean => value === 'true' || value === '1';

/**
 * Access controls (sys_security_acl) and their roles, written through their forms in a named
 * application and update set, each write verified by reading back its record and capture.
 *
 * Changing an ACL needs the elevated security_admin role on the writing session: construct the
 * ServiceNowInstance with `elevatedRoles: ['security_admin']`. Reading ACLs needs no elevation,
 * though a role row naming security_admin shows no role name until the session is elevated.
 *
 * Creating an ACL with roles inserts it inactive, adds the roles, removes the snc_internal role
 * the platform adds to an ACL that has none, then activates it: an ACL never stands active with
 * fewer restrictions than asked for. Roles on an ACL are alternatives, so snc_internal left
 * beside them would let every internal user pass.
 */
export class AclManager {
    private _decisionType: Promise<boolean> | undefined;

    public constructor(private readonly _instance: ServiceNowInstance) {}

    private reader(): MetadataReader {
        return new MetadataReader(SessionManager.getInstance().getRequest(this._instance));
    }

    /** ACLs matching every given filter. At least one of table, name or scope is required. */
    public async list(options: AclListOptions): Promise<AclRecord[]> {
        const reader = this.reader();
        const terms: string[] = [];
        if (options.table !== undefined) {
            if (!IDENT.test(options.table)) throw new AclError('invalid_input', 'table');
            terms.push(`name=${options.table}^ORnameSTARTSWITH${options.table}.`);
        }
        if (options.name !== undefined) {
            if (!RESOURCE.test(options.name) || SCRIPT.test(options.name)) throw new AclError('invalid_input', 'name');
            terms.push(`name=${options.name}`);
        }
        if (options.scope !== undefined) terms.push(`sys_scope=${(await resolveScope(reader, options.scope)).sysId}`);
        if (!terms.length) throw new AclError('filter_required');
        if (options.operation !== undefined) terms.push(`operation=${await this.lookup(reader, 'sys_security_operation', options.operation, 'operation_not_found')}`);
        if (options.type !== undefined) terms.push(`type=${await this.lookup(reader, 'sys_security_type', options.type, 'type_not_found')}`);
        if (options.active !== undefined) {
            if (typeof options.active !== 'boolean') throw new AclError('invalid_input', 'active');
            terms.push(`active=${options.active ? 'true' : 'false'}`);
        }
        const rows = await reader.rows(ACL, terms.join('^'), `sys_id,${await this.fields(reader)}`);
        return this.records(reader, rows);
    }

    /** One ACL with its roles. */
    public async get(sysId: string): Promise<AclRecord> {
        if (!ID.test(sysId ?? '')) throw new AclError('invalid_input', 'sysId');
        const reader = this.reader();
        const row = await reader.exact(ACL, sysId, await this.fields(reader));
        if (!row) throw new AclError('acl_not_found');
        return (await this.records(reader, [row]))[0];
    }

    public async create(options: AclCreateOptions): Promise<AclWriteResult> {
        const reader = this.reader();
        const type = options.type ?? 'record';
        const typeId = await this.lookup(reader, 'sys_security_type', type, 'type_not_found');
        const operationId = await this.lookup(reader, 'sys_security_operation', options.operation, 'operation_not_found');
        const name = await this.aclName(reader, type, options);
        const roles = await this.roles(reader, options.roles ?? []);
        await this.requireElevation();
        const fields = await this.fieldValues(reader, options);
        const target = this.target(options);
        const writer = this.writer();
        const writes: MetadataWriteResult[] = [];
        const active = options.active !== false;
        // With roles, the ACL stays inactive until they are on it and the platform's own role is gone.
        const staged = active && roles.length > 0;
        const inserted = await writer.insert(ACL, { ...target, fields: { ...fields, type: typeId, operation: operationId, name,
            active: active && !staged, admin_overrides: options.adminOverrides ?? true } });
        writes.push(inserted);
        const sysId = inserted.sysId;
        try {
            return await this.finishCreate(reader, writer, sysId, roles, staged, target, writes);
        } catch (error) {
            if (isPolicyRefusal(error)) throw error;
            throw new AclPartialError(sysId, 'create', await this.activeState(sysId), error);
        }
    }

    private async finishCreate(reader: MetadataReader, writer: MetadataFormWriter, sysId: string, roles: Array<{ sysId: string; name: string }>,
        staged: boolean, target: AclWriteTarget, writes: MetadataWriteResult[]): Promise<AclWriteResult> {
        const automatic = await this.roleRows(reader, [sysId]);
        const present = new Set(automatic.map(row => row.roleSysId));
        for (const role of roles) {
            if (present.has(role.sysId)) continue;
            writes.push(await writer.insert(ACL_ROLE, { ...target, fields: { sys_security_acl: sysId, sys_user_role: role.sysId } }));
        }
        const removedAutomaticRoles: string[] = [];
        if (roles.length) {
            for (const row of automatic) {
                if (roles.some(role => role.sysId === row.roleSysId)) continue;
                writes.push(await writer.delete(ACL_ROLE, row.sysId, { ...target, confirm: { table: ACL_ROLE, sysId: row.sysId } }));
                removedAutomaticRoles.push(row.role || row.roleSysId);
            }
        }
        if (roles.length) {
            // The roles must be exactly those asked for before the ACL goes live: any other row would be one more way to pass.
            const now = new Set((await this.roleRows(reader, [sysId])).map(row => row.roleSysId));
            if (now.size !== roles.length || roles.some(role => !now.has(role.sysId))) throw new AclError('roles_not_applied');
        }
        if (staged) writes.push(await writer.update(ACL, sysId, { ...target, fields: { active: true } }));
        const acl = await this.get(sysId);
        return { acl, writes, removedAutomaticRoles, warnings: this.warnings(acl) };
    }

    public async update(sysId: string, options: AclUpdateOptions): Promise<AclWriteResult> {
        const previous = await this.get(sysId);
        const reader = this.reader();
        const fields = await this.fieldValues(reader, options);
        if (options.operation !== undefined) fields.operation = await this.lookup(reader, 'sys_security_operation', options.operation, 'operation_not_found');
        if (options.adminOverrides !== undefined) fields.admin_overrides = options.adminOverrides;
        if (options.active !== undefined) fields.active = options.active;
        if (!Object.keys(fields).length) throw new AclError('invalid_input', 'nothing_to_change');
        await this.requireElevation();
        const write = await this.writer().update(ACL, sysId, { ...this.target(options), fields });
        const acl = await this.get(sysId);
        return { acl, previous, writes: [write], removedAutomaticRoles: [], warnings: this.warnings(acl) };
    }

    /**
     * Deletes the ACL. The platform deletes its role rows with it (each captured as a DELETE). It offers Delete on an
     * active record ACL only once it is inactive, so one is deactivated first, as a separate captured update.
     */
    public async delete(sysId: string, options: AclDeleteOptions): Promise<AclWriteResult> {
        if (options?.confirm !== sysId) throw new AclError('confirmation_required');
        const previous = await this.get(sysId);
        await this.requireElevation();
        const writer = this.writer();
        const target = this.target(options);
        const writes: MetadataWriteResult[] = [];
        const deactivate = previous.type === 'record' && previous.active;
        if (deactivate) writes.push(await writer.update(ACL, sysId, { ...target, fields: { active: false } }));
        try {
            writes.push(await writer.delete(ACL, sysId, { ...target, confirm: { table: ACL, sysId } }));
        } catch (error) {
            if (!deactivate || isPolicyRefusal(error)) throw error;
            // Put the restriction back: a failed delete must not leave the ACL switched off.
            await writer.update(ACL, sysId, { ...target, fields: { active: true } }).catch(() => undefined);
            throw new AclPartialError(sysId, 'delete', await this.activeState(sysId), error);
        }
        return { previous, writes, removedAutomaticRoles: [], warnings: [] };
    }

    public async addRole(sysId: string, role: string, target: AclWriteTarget): Promise<AclWriteResult> {
        const previous = await this.get(sysId);
        const [resolved] = await this.roles(this.reader(), [role]);
        if (previous.roles.some(row => row.roleSysId === resolved.sysId)) throw new AclError('role_already_present', resolved.name);
        await this.requireSameScope(previous, target);
        await this.requireElevation();
        const write = await this.writer().insert(ACL_ROLE, { ...this.target(target),
            fields: { sys_security_acl: sysId, sys_user_role: resolved.sysId } });
        const acl = await this.get(sysId);
        return { acl, previous, writes: [write], removedAutomaticRoles: [], warnings: this.warnings(acl) };
    }

    /** Removing the last role makes the platform add snc_internal back; the result warns when it did. */
    public async removeRole(sysId: string, role: string, target: AclWriteTarget): Promise<AclWriteResult> {
        const previous = await this.get(sysId);
        const [resolved] = await this.roles(this.reader(), [role]);
        const rows = previous.roles.filter(row => row.roleSysId === resolved.sysId);
        if (!rows.length) throw new AclError('role_not_present', resolved.name);
        await this.requireSameScope(previous, target);
        await this.requireElevation();
        const writer = this.writer();
        const writes: MetadataWriteResult[] = [];
        for (const row of rows) writes.push(await writer.delete(ACL_ROLE, row.sysId, { ...this.target(target), confirm: { table: ACL_ROLE, sysId: row.sysId } }));
        const acl = await this.get(sysId);
        const warnings = this.warnings(acl);
        if (acl.roles.some(row => row.roleSysId === resolved.sysId)) {
            warnings.unshift(`${resolved.name} is still on this ACL: the platform puts ${AUTOMATIC_ROLE} back on an ACL left without a role. Add the role it should have first.`);
        } else if (!previous.roles.some(row => row.role === AUTOMATIC_ROLE) && acl.roles.some(row => row.role === AUTOMATIC_ROLE)) {
            warnings.unshift(`The platform added ${AUTOMATIC_ROLE} when the last role was removed: every internal user now passes this ACL.`);
        }
        return { acl, previous, writes, removedAutomaticRoles: [], warnings };
    }

    private target(target: AclWriteTarget): AclWriteTarget {
        if (!target?.scope) throw new AclError('invalid_input', 'scope');
        if (target.updateSet !== undefined && !ID.test(target.updateSet)) throw new AclError('invalid_input', 'updateSet');
        return { scope: target.scope, ...(target.updateSet ? { updateSet: target.updateSet } : {}),
            ...(target.storeCustomization ? { storeCustomization: target.storeCustomization } : {}) };
    }

    /** A writer allowed the access-control tables (the generic one refuses them). */
    private writer(): MetadataFormWriter {
        const writer = new MetadataFormWriter(this._instance);
        accessControlWriters.add(writer);
        return writer;
    }

    /** The ACL's active flag read back after a failure; undefined when it cannot be read. */
    private async activeState(sysId: string): Promise<boolean | undefined> {
        try { return (await this.get(sysId)).active; } catch { return undefined; }
    }

    /** A role row is written in the target application; it must be the ACL's own. */
    private async requireSameScope(acl: AclRecord, target: AclWriteTarget): Promise<void> {
        if (!target?.scope) throw new AclError('invalid_input', 'scope');
        if ((await resolveScope(this.reader(), target.scope)).sysId !== acl.scope) throw new AclError('scope_mismatch');
    }

    private async requireElevation(): Promise<void> {
        let elevated: string[] = [];
        try { elevated = (await new RoleElevation(this._instance).status()).elevated; } catch { /* unreadable: not elevated */ }
        if (!elevated.includes(REQUIRED_ROLE)) throw new AclError('elevation_required', REQUIRED_ROLE);
    }

    /** decision_type exists from the release that added deny ACLs; read it only where it does. */
    private async fields(reader: MetadataReader): Promise<string> {
        // A failed read is not remembered: the next call asks again.
        this._decisionType ??= reader.rows('sys_dictionary', `name=${ACL}^element=decision_type`, 'sys_id,element').then(rows => rows.length > 0,
            (error: unknown) => { this._decisionType = undefined; throw error; });
        return `${BASE_FIELDS}${await this._decisionType ? ',decision_type' : ''}`;
    }

    private async fieldValues(reader: MetadataReader, options: AclUpdateOptions | AclCreateOptions): Promise<Record<string, FormValueInput>> {
        const fields: Record<string, FormValueInput> = {};
        if (options.description !== undefined) fields.description = options.description;
        if (options.condition !== undefined) fields.condition = options.condition;
        if (options.script !== undefined) Object.assign(fields, { advanced: true, script: options.script });
        if (options.decisionType !== undefined) {
            if (!['allow', 'deny'].includes(options.decisionType)) throw new AclError('invalid_input', 'decisionType');
            await this.fields(reader);
            if (!await this._decisionType) throw new AclError('invalid_input', 'decisionType');
            fields.decision_type = options.decisionType;
        }
        return fields;
    }

    private async lookup(reader: MetadataReader, table: string, name: string, missing: 'type_not_found' | 'operation_not_found'): Promise<string> {
        if (!IDENT.test(name ?? '')) throw new AclError('invalid_input', missing === 'type_not_found' ? 'type' : 'operation');
        const rows = await reader.rows(table, `name=${name}`, 'sys_id,name');
        if (rows.length !== 1 || rows[0].name !== name) throw new AclError(missing, name);
        return rows[0].sys_id;
    }

    private async aclName(reader: MetadataReader, type: string, options: AclCreateOptions): Promise<string> {
        if (type !== 'record') {
            if (options.table !== undefined || options.field !== undefined) throw new AclError('invalid_input', 'table');
            if (!RESOURCE.test(options.name ?? '') || SCRIPT.test(options.name ?? '')) throw new AclError('invalid_input', 'name');
            return options.name ?? '';
        }
        if (options.name !== undefined) throw new AclError('invalid_input', 'name');
        const table = options.table ?? '';
        if (!IDENT.test(table)) throw new AclError('invalid_input', 'table');
        const field = options.field;
        if (field !== undefined && field !== '*' && !IDENT.test(field)) throw new AclError('invalid_input', 'field');
        // The table and the tables it extends: a field may be defined on any of them.
        const tables: string[] = [];
        let next: string | undefined = table;
        while (next && tables.length < 20) {
            const rows: MetadataRow[] = await reader.rows('sys_db_object', `name=${next}`, 'sys_id,name,super_class.name');
            if (rows.length !== 1) break;
            tables.push(next);
            next = rows[0]['super_class.name'] || undefined;
        }
        if (!tables.length) throw new AclError('table_not_found', table);
        if (field && field !== '*') {
            const defined = await reader.rows('sys_dictionary', `nameIN${tables.join(',')}^element=${field}`, 'sys_id,element');
            if (!defined.length) throw new AclError('field_not_found', `${table}.${field}`);
        }
        return field ? `${table}.${field}` : table;
    }

    private async roles(reader: MetadataReader, names: string[]): Promise<Array<{ sysId: string; name: string }>> {
        const wanted = [...new Set(names.map(name => String(name).trim()).filter(Boolean))];
        const invalid = wanted.find(name => !ROLE.test(name));
        if (invalid !== undefined) throw new AclError('invalid_input', 'role');
        if (!wanted.length) return [];
        const rows = await reader.rows('sys_user_role', `nameIN${wanted.join(',')}`, 'sys_id,name');
        return wanted.map(name => {
            const matches = rows.filter(row => row.name === name);
            // security_admin is only readable once elevated: the check runs on the elevated session for writes.
            if (matches.length !== 1) throw new AclError('role_not_found', name);
            return { sysId: matches[0].sys_id, name };
        });
    }

    private async roleRows(reader: MetadataReader, acls: string[]): Promise<Array<AclRole & { acl: string }>> {
        if (!acls.length) return [];
        const rows: Array<AclRole & { acl: string }> = [];
        // Bounded IN lists: an encoded query of thousands of sys_ids is refused by the instance.
        for (let at = 0; at < acls.length; at += 100) {
            const batch = await reader.rows(ACL_ROLE, `sys_security_aclIN${acls.slice(at, at + 100).join(',')}`, 'sys_id,sys_security_acl,sys_user_role,sys_user_role.name');
            rows.push(...batch.map(row => ({ sysId: row.sys_id, roleSysId: row.sys_user_role, role: row['sys_user_role.name'], acl: row.sys_security_acl })));
        }
        return rows;
    }

    private async records(reader: MetadataReader, rows: MetadataRow[]): Promise<AclRecord[]> {
        const roles = await this.roleRows(reader, rows.map(row => row.sys_id));
        return rows.map(row => ({
            sysId: row.sys_id,
            name: row.name,
            type: row['type.name'] || row.type,
            operation: row['operation.name'] || row.operation,
            active: bool(row.active),
            adminOverrides: bool(row.admin_overrides),
            advanced: bool(row.advanced),
            decisionType: row.decision_type ?? '',
            description: row.description,
            condition: row.condition,
            script: row.script,
            scope: row.sys_scope,
            scopeName: row['sys_scope.scope'],
            updatedOn: row.sys_updated_on,
            roles: roles.filter(role => role.acl === row.sys_id).map(({ sysId, roleSysId, role }) => ({ sysId, roleSysId, role })),
        }));
    }

    private warnings(acl: AclRecord): string[] {
        const warnings: string[] = [];
        if (acl.roles.length > 1 && acl.roles.some(role => role.role === AUTOMATIC_ROLE)) {
            warnings.push(`${AUTOMATIC_ROLE} is one of this ACL's roles: any one role passes, so every internal user does.`);
        }
        const onlyAutomatic = acl.roles.length > 0 && acl.roles.every(role => role.role === AUTOMATIC_ROLE);
        if (acl.active && (onlyAutomatic || !acl.roles.length) && !acl.condition && !(acl.advanced && acl.script.trim())) {
            warnings.push(`This ACL has no role but ${AUTOMATIC_ROLE}, and no condition or script: every internal user passes it.`);
        }
        return warnings;
    }
}
