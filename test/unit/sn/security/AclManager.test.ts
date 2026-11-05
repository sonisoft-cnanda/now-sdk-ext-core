import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AclManager } from '../../../../src/sn/security/AclManager';
import { AclError } from '../../../../src/sn/security/AclError';
import { RoleElevation } from '../../../../src/sn/security/RoleElevation';
import { MetadataFormWriter } from '../../../../src/sn/metadata/MetadataFormWriter';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';

const SCOPE = 'a'.repeat(32), SET = 'c'.repeat(32);
const ROLES: Record<string, string> = { admin: '1'.repeat(32), itil: '2'.repeat(32), snc_internal: '3'.repeat(32), security_admin: '4'.repeat(32) };
const TABLES: Record<string, string> = { incident: 'task', task: '', x_app_thing: '' };
const FIELDS: Record<string, string[]> = { task: ['short_description', 'number'], incident: ['caller_id'] };

let acls: Map<string, Record<string, string>>;
let aclRoles: Array<{ sys_id: string; sys_security_acl: string; sys_user_role: string }>;
let writes: string[];
let elevated: string[];
let next: number;
const id = () => (next++).toString(16).padStart(32, '0');

function rows(table: string, query: string): Array<Record<string, string>> {
    const q = query.replace(/\^ORDERBYsys_id$/, '');
    const eq = (field: string) => new RegExp(`(?:^|\\^)${field}=([^^]*)`).exec(q)?.[1];
    const inList = (field: string) => new RegExp(`(?:^|\\^)${field}IN([^^]*)`).exec(q)?.[1]?.split(',') ?? [];
    switch (table) {
        case 'sys_security_type': return ['record', 'ui_page'].includes(eq('name') ?? '') ? [{ sys_id: eq('name')!, name: eq('name')! }] : [];
        case 'sys_security_operation': return ['read', 'write', 'create', 'delete'].includes(eq('name') ?? '') ? [{ sys_id: eq('name')!, name: eq('name')! }] : [];
        case 'sys_db_object': { const name = eq('name') ?? ''; return name in TABLES ? [{ sys_id: id(), name, 'super_class.name': TABLES[name] }] : []; }
        case 'sys_dictionary': {
            if (eq('name') === 'sys_security_acl') return [{ sys_id: id(), element: 'decision_type' }];
            const element = eq('element') ?? '';
            return inList('name').some(t => FIELDS[t]?.includes(element)) ? [{ sys_id: id(), element }] : [];
        }
        case 'sys_user_role': return inList('name').filter(name => name in ROLES && (name !== 'security_admin' || elevated.length)).map(name => ({ sys_id: ROLES[name], name }));
        case 'sys_security_acl': {
            const sysId = eq('sys_id');
            if (sysId) return acls.has(sysId) ? [acls.get(sysId)!] : [];
            return [...acls.values()].filter(acl => q.includes(`name=${acl.name}`) || q.includes(`nameSTARTSWITH${acl.name.split('.')[0]}.`));
        }
        case 'sys_security_acl_role': {
            const names = Object.fromEntries(Object.entries(ROLES).map(([name, sysId]) => [sysId, name]));
            return aclRoles.filter(row => inList('sys_security_acl').includes(row.sys_security_acl))
                .map(row => ({ ...row, 'sys_user_role.name': names[row.sys_user_role] === 'security_admin' && !elevated.length ? '' : names[row.sys_user_role] }));
        }
    }
    return [];
}

function aclRow(sysId: string, fields: Record<string, unknown>): Record<string, string> {
    return { sys_id: sysId, name: String(fields.name), type: String(fields.type), 'type.name': String(fields.type), operation: String(fields.operation),
        'operation.name': String(fields.operation), active: String(fields.active), admin_overrides: String(fields.admin_overrides ?? true),
        advanced: String(fields.advanced ?? false), description: String(fields.description ?? ''), condition: String(fields.condition ?? ''),
        script: String(fields.script ?? ''), sys_scope: SCOPE, 'sys_scope.scope': 'x_app', sys_updated_on: '2026-11-05 00:00:00',
        decision_type: String(fields.decision_type ?? 'allow') };
}

beforeEach(() => {
    acls = new Map(); aclRoles = []; writes = []; elevated = ['security_admin']; next = 0x100;
    const request = { get: jest.fn(async (r: any) => {
        const table = r.path.split('/').at(-1);
        const found = rows(table, r.query.sysparm_query);
        const fields = String(r.query.sysparm_fields).split(',');
        const result = found.map(row => Object.fromEntries(fields.map(field => [field, row[field] ?? ''])));
        return { status: 200, headers: { 'x-total-count': String(result.length) }, bodyObject: { result } };
    }) };
    jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(request as any);
    jest.spyOn(RoleElevation.prototype, 'status').mockImplementation(async () => ({ available: [{ name: 'security_admin', description: '' }], elevated }));
    const result = (table: string, sysId: string, action: 'insert' | 'update' | 'delete') =>
        ({ table, sysId, action, scope: { sysId: SCOPE, scope: 'x_app' }, capture: {} as any, messages: [] });
    jest.spyOn(MetadataFormWriter.prototype, 'insert').mockImplementation(async (table: string, options: any) => {
        const sysId = id();
        writes.push(`insert ${table} ${JSON.stringify(options.fields)}`);
        if (table === 'sys_security_acl') {
            acls.set(sysId, aclRow(sysId, options.fields));
            // The platform puts snc_internal on an ACL that has no role.
            aclRoles.push({ sys_id: id(), sys_security_acl: sysId, sys_user_role: ROLES.snc_internal });
        } else {
            aclRoles.push({ sys_id: sysId, sys_security_acl: options.fields.sys_security_acl, sys_user_role: options.fields.sys_user_role });
        }
        return result(table, sysId, 'insert');
    });
    jest.spyOn(MetadataFormWriter.prototype, 'update').mockImplementation(async (table: string, sysId: string, options: any) => {
        writes.push(`update ${table} ${JSON.stringify(options.fields)}`);
        const row = acls.get(sysId)!;
        for (const [field, value] of Object.entries(options.fields)) row[field] = String(value);
        return result(table, sysId, 'update');
    });
    jest.spyOn(MetadataFormWriter.prototype, 'delete').mockImplementation(async (table: string, sysId: string) => {
        writes.push(`delete ${table}`);
        if (table === 'sys_security_acl') { acls.delete(sysId); aclRoles = aclRoles.filter(row => row.sys_security_acl !== sysId); }
        else {
            const row = aclRoles.find(r => r.sys_id === sysId)!;
            aclRoles = aclRoles.filter(r => r.sys_id !== sysId);
            // ... and puts it back when the last role goes.
            if (!aclRoles.some(r => r.sys_security_acl === row.sys_security_acl)) aclRoles.push({ sys_id: id(), sys_security_acl: row.sys_security_acl, sys_user_role: ROLES.snc_internal });
        }
        return result(table, sysId, 'delete');
    });
});
afterEach(() => jest.restoreAllMocks());

const manager = () => new AclManager(new ServiceNowInstance({ alias: 'unit-test' }));
const target = { scope: { sysId: SCOPE }, updateSet: SET };

describe('AclManager.create', () => {
    it('stages an ACL with roles: inactive, roles, platform role removed, then active', async () => {
        const result = await manager().create({ ...target, operation: 'read', table: 'incident', field: 'short_description', roles: ['itil', 'admin'] });
        expect(writes).toEqual([
            'insert sys_security_acl {"type":"record","operation":"read","name":"incident.short_description","active":false,"admin_overrides":true}',
            `insert sys_security_acl_role {"sys_security_acl":"${result.acl!.sysId}","sys_user_role":"${ROLES.itil}"}`,
            `insert sys_security_acl_role {"sys_security_acl":"${result.acl!.sysId}","sys_user_role":"${ROLES.admin}"}`,
            'delete sys_security_acl_role',
            'update sys_security_acl {"active":true}',
        ]);
        expect(result.removedAutomaticRoles).toEqual(['snc_internal']);
        expect(result.acl).toMatchObject({ name: 'incident.short_description', operation: 'read', active: true });
        expect(result.acl!.roles.map(r => r.role).sort()).toEqual(['admin', 'itil']);
        expect(result.warnings).toEqual([]);
        expect(result.writes).toHaveLength(5);
    });

    it('keeps snc_internal when it is one of the requested roles, without inserting it twice', async () => {
        const result = await manager().create({ ...target, operation: 'read', table: 'incident', roles: ['snc_internal'] });
        expect(writes.filter(w => w.includes('sys_security_acl_role'))).toEqual([]);
        expect(result.removedAutomaticRoles).toEqual([]);
        expect(result.acl!.roles.map(r => r.role)).toEqual(['snc_internal']);
    });

    it('inserts a script ACL active in one write, with advanced set, and leaves the platform role alone', async () => {
        const result = await manager().create({ ...target, type: 'ui_page', name: 'x_app_page', operation: 'read', script: 'answer = gs.hasRole("itil");' });
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('"advanced":true');
        expect(writes[0]).toContain('"active":true');
        expect(result.acl!.roles.map(r => r.role)).toEqual(['snc_internal']);
    });

    it('creates inactive when asked, still removing the platform role', async () => {
        const result = await manager().create({ ...target, operation: 'write', table: 'incident', roles: ['itil'], active: false });
        expect(writes.at(-1)).toBe('delete sys_security_acl_role');
        expect(result.acl!.active).toBe(false);
    });

    it.each([
        [{ operation: 'read', table: 'nope' }, 'table_not_found'],
        [{ operation: 'read', table: 'incident', field: 'nope' }, 'field_not_found'],
        [{ operation: 'read', table: 'incident', field: 'number' }, undefined],
        [{ operation: 'read', table: 'incident', field: '*' }, undefined],
        [{ operation: 'fly', table: 'incident' }, 'operation_not_found'],
        [{ operation: 'read', type: 'nope', name: 'x' }, 'type_not_found'],
        [{ operation: 'read', table: 'incident', roles: ['nope'] }, 'role_not_found'],
        [{ operation: 'read', table: 'incident^ORname=x' }, 'invalid_input'],
        [{ operation: 'read', table: 'incident', roles: ['admin,itil'] }, 'invalid_input'],
        [{ operation: 'read', type: 'ui_page', table: 'incident' }, 'invalid_input'],
        [{ operation: 'read', type: 'ui_page', name: 'a^b' }, 'invalid_input'],
        [{ operation: 'read', table: 'incident', decisionType: 'maybe' }, 'invalid_input'],
    ])('validates %j before writing', async (options, code) => {
        const run = manager().create({ ...target, ...options } as any);
        if (code) {
            await expect(run).rejects.toMatchObject({ code });
            expect(writes).toEqual([]);
        } else await expect(run).resolves.toBeDefined();
    });

    it('refuses without elevation, before any write', async () => {
        elevated = [];
        await expect(manager().create({ ...target, operation: 'read', table: 'incident', roles: ['itil'] })).rejects.toMatchObject({ code: 'elevation_required' });
        expect(writes).toEqual([]);
    });
});

describe('AclManager changes', () => {
    let acl: string;
    beforeEach(async () => {
        acl = (await manager().create({ ...target, operation: 'read', table: 'incident', roles: ['itil'] })).acl!.sysId;
        writes = [];
    });

    it('updates the given fields and returns before and after', async () => {
        const result = await manager().update(acl, { ...target, condition: 'active=true', description: 'Agents read incidents' });
        expect(writes).toEqual(['update sys_security_acl {"description":"Agents read incidents","condition":"active=true"}']);
        expect(result.previous!.condition).toBe('');
        expect(result.acl!.condition).toBe('active=true');
    });

    it('refuses an update with nothing to change', async () => {
        await expect(manager().update(acl, { ...target })).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('adds a role and refuses one already there', async () => {
        await manager().addRole(acl, 'admin', target);
        await expect(manager().addRole(acl, 'admin', target)).rejects.toMatchObject({ code: 'role_already_present' });
        expect(writes).toHaveLength(1);
    });

    it('warns when snc_internal sits beside other roles', async () => {
        const result = await manager().addRole(acl, 'snc_internal', target);
        expect(result.warnings.join(' ')).toContain('every internal user');
    });

    it('removes a role, and warns when the platform puts snc_internal back for the last one', async () => {
        await expect(manager().removeRole(acl, 'admin', target)).rejects.toMatchObject({ code: 'role_not_present' });
        const result = await manager().removeRole(acl, 'itil', target);
        expect(result.acl!.roles.map(r => r.role)).toEqual(['snc_internal']);
        expect(result.warnings[0]).toContain('platform added snc_internal');
    });

    it('deletes only with the sys_id repeated', async () => {
        await expect(manager().delete(acl, { ...target, confirm: 'x' })).rejects.toBeInstanceOf(AclError);
        const result = await manager().delete(acl, { ...target, confirm: acl });
        expect(result.previous!.sysId).toBe(acl);
        expect(acls.size).toBe(0);
    });

    it('lists by table and requires a filter', async () => {
        await expect(manager().list({})).rejects.toMatchObject({ code: 'filter_required' });
        const listed = await manager().list({ table: 'incident' });
        expect(listed.map(a => a.name)).toEqual(['incident']);
        expect(listed[0].roles.map(r => r.role)).toEqual(['itil']);
    });

    it('reads security_admin role rows without a name when not elevated', async () => {
        await manager().addRole(acl, 'security_admin', target);
        elevated = [];
        const read = await manager().get(acl);
        expect(read.roles.find(r => r.roleSysId === ROLES.security_admin)?.role).toBe('');
    });
});
