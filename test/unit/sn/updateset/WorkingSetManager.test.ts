import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { WorkingSetManager } from '../../../../src/sn/updateset/WorkingSetManager';
import { WorkingSetError } from '../../../../src/sn/updateset/WorkingSetModels';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { BackgroundScriptExecutor } from '../../../../src/sn/BackgroundScriptExecutor';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';

const USER = 'e'.repeat(32), APP = 'a'.repeat(32), OTHER_APP = 'b'.repeat(32);
const SET = '1'.repeat(32), DEFAULT = '2'.repeat(32), NEW = '3'.repeat(32), CLOSED = '4'.repeat(32), XML = '5'.repeat(32), XML2 = '6'.repeat(32);
type Row = Record<string, string>;
let db: Record<string, Row[]>;
let req: { get: jest.Mock<any>; put: jest.Mock<any> };
let script: jest.SpiedFunction<BackgroundScriptExecutor['executeScript']>;
let scriptBehaviour: { createApplication?: string; ignorePersist?: boolean };
let manager: WorkingSetManager;

function matches(row: Row, query: string): boolean {
    return query.split('^').filter(term => term && !term.startsWith('ORDERBY')).every(term => {
        if (term === 'sys_id=javascript:gs.getUserID()') return row.sys_id === USER;
        const inMatch = term.match(/^(\w+)IN(.*)$/);
        if (inMatch) return inMatch[2].split(',').includes(row[inMatch[1]]);
        const [field, value] = term.split('=');
        return (row[field] ?? '') === value;
    });
}
const respond = (rows: Row[], fields: string) => {
    const picked = rows.map(row => Object.fromEntries(fields.split(',').map(field => [field, row[field] ?? ''])));
    return { status: 200, headers: { 'x-total-count': String(picked.length) }, bodyObject: { result: picked } };
};
function preference(name: string, value: string) {
    const rows = db.sys_user_preference;
    const existing = rows.find(row => row.user === USER && row.name === name);
    if (existing) existing.value = value; else rows.push({ sys_id: `${rows.length}`.padStart(32, '9'), user: USER, name, value });
}
beforeEach(() => {
    scriptBehaviour = {};
    db = {
        sys_user: [{ sys_id: USER }],
        sys_scope: [{ sys_id: APP, scope: 'sn_compliance' }, { sys_id: OTHER_APP, scope: 'x_other' }, { sys_id: 'global', scope: 'global' }],
        sys_update_set: [
            { sys_id: SET, name: 'Ours', state: 'in progress', application: APP, is_default: 'false' },
            { sys_id: DEFAULT, name: 'Default', state: 'in progress', application: APP, is_default: 'true' },
            { sys_id: CLOSED, name: 'Old', state: 'complete', application: APP, is_default: 'false' },
        ],
        sys_update_xml: [],
        sys_user_preference: [
            { sys_id: '7'.repeat(32), user: USER, name: 'apps.current_app', value: 'global' },
            { sys_id: '8'.repeat(32), user: USER, name: 'sys_update_set', value: 'f'.repeat(32) },
        ],
    };
    req = {
        get: jest.fn(async (r: any) => {
            const table = r.path.split('/').at(-1);
            return respond((db[table] ?? []).filter(row => matches(row, r.query.sysparm_query)), r.query.sysparm_fields);
        }),
        put: jest.fn(async (r: any) => {
            const [, , , , table, id] = r.path.split('/');
            const row = db[table].find(item => item.sys_id === id)!;
            // The platform's "Handle updates moving between sets" rule aborts a cross-scope move.
            const target = table === 'sys_update_xml' && db.sys_update_set.find(set => set.sys_id === r.json.update_set);
            if (!target || target.application === row.application) Object.assign(row, r.json);
            return { status: 200, bodyObject: { result: { sys_id: id } } };
        }),
    };
    jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(req as any);
    script = jest.spyOn(BackgroundScriptExecutor.prototype, 'executeScript').mockImplementation(async (text: string) => {
        const params = JSON.parse(text.match(/var P = (.*);/)![1]);
        let result: unknown;
        if (text.includes("GlideRecord('sys_update_set')")) {
            const open = db.sys_update_set.some(set => set.name === params.name && set.application === params.application && set.state === 'in progress');
            if (open) result = { exists: true };
            else db.sys_update_set.push({ sys_id: NEW, name: params.name, state: 'in progress', is_default: 'false',
                application: scriptBehaviour.createApplication ?? params.application });
            result ??= { sys_id: NEW };
        } else {
            if (!scriptBehaviour.ignorePersist) {
                preference('apps.current_app', params.application);
                preference('sys_update_set', params.updateSet);
                preference(`updateSetForScope${params.application}`, params.updateSet);
            }
            result = { ok: true };
        }
        const line = `NEX_WORKING_SET_RESULT=${JSON.stringify(result)}`.replace(/"/g, '&quot;');
        return { rawResult: line, consoleResult: [line], scriptResults: [{ line } as any] } as any;
    });
    manager = new WorkingSetManager(new ServiceNowInstance({ alias: 'unit-test' }));
});
afterEach(() => jest.restoreAllMocks());

describe('WorkingSetManager', () => {
    it('creates a set in a Store application through a script and verifies its application', async () => {
        await expect(manager.createUpdateSet({ application: APP, name: 'NSE-15 form', description: 'test' }))
            .resolves.toEqual({ sysId: NEW, name: 'NSE-15 form', state: 'in progress', application: APP, isDefault: false });
        const text = script.mock.calls[0][0];
        expect(text).toContain(`"application":"${APP}"`);
        expect(script.mock.calls[0][1]).toBe('global');
    });
    it('maps the global scope to the global application value', async () => {
        await expect(manager.createUpdateSet({ application: 'global', name: 'Global fix' })).resolves.toMatchObject({ application: 'global' });
    });
    it('fails when the created set lands in another application', async () => {
        scriptBehaviour.createApplication = 'global';
        await expect(manager.createUpdateSet({ application: APP, name: 'x' })).rejects.toMatchObject({ code: 'application_not_applied', detail: { application: 'global' } });
    });
    it.each([
        [{ application: APP, name: '' }, 'invalid_input'],
        [{ application: APP, name: 'a'.repeat(81) }, 'invalid_input'],
        [{ application: 'not-an-id', name: 'x' }, 'invalid_input'],
        [{ application: '9'.repeat(32), name: 'x' }, 'application_not_found'],
    ])('refuses %o before any script', async (options, code) => {
        await expect(manager.createUpdateSet(options)).rejects.toMatchObject({ code });
        expect(script).not.toHaveBeenCalled();
    });
    it('refuses a name already open in the application, checked inside the script', async () => {
        await expect(manager.createUpdateSet({ application: APP, name: 'Ours' })).rejects.toMatchObject({ code: 'update_set_exists' });
        expect(db.sys_update_set.filter(set => set.name === 'Ours')).toHaveLength(1);
    });
    it('never puts the name into an encoded query', async () => {
        const name = "x^nameSTARTSWITHjavascript:gs.getUser().savePreference('a','b')";
        await manager.createUpdateSet({ application: APP, name });
        expect(req.get.mock.calls.some(([r]: any) => JSON.stringify(r.query ?? {}).includes('javascript:gs.getUser'))).toBe(false);
        expect(script.mock.calls[0][0]).toContain(JSON.stringify(name).slice(1, 20));
    });
    it('makes a set the working set and returns the previous one', async () => {
        const result = await manager.useUpdateSet(SET);
        expect(result.previous).toEqual({ application: 'global', updateSet: 'f'.repeat(32) });
        expect(result.current).toEqual({ application: APP, updateSet: SET });
    });
    it('fails when the preferences do not read back', async () => {
        scriptBehaviour.ignorePersist = true;
        await expect(manager.useUpdateSet(SET)).rejects.toMatchObject({ code: 'working_set_not_applied' });
    });
    it.each([[CLOSED, 'update_set_closed'], [DEFAULT, 'default_update_set'], ['9'.repeat(32), 'update_set_not_found']])('refuses %s', async (id, code) => {
        await expect(manager.useUpdateSet(id)).rejects.toMatchObject({ code });
        expect(script).not.toHaveBeenCalled();
    });
    it('allows a Default only when restoring', async () => {
        await expect(manager.useUpdateSet(DEFAULT, { allowDefault: true })).resolves.toMatchObject({ current: { updateSet: DEFAULT } });
    });
    it('restores a previous working set, falling back to the Default when it has closed', async () => {
        await expect(manager.restoreWorkingSet({ application: APP, updateSet: SET })).resolves.toEqual({ restored: { application: APP, updateSet: SET } });
        await expect(manager.restoreWorkingSet({ application: APP, updateSet: CLOSED }))
            .resolves.toEqual({ restored: { application: APP, updateSet: DEFAULT }, fallback: 'application_default' });
        await expect(manager.restoreWorkingSet({ application: OTHER_APP, updateSet: '' })).rejects.toMatchObject({ code: 'no_single_default' });
    });
    it('restores an unset context to the application Default', async () => {
        await expect(manager.restoreWorkingSet({ application: APP, updateSet: '' }))
            .resolves.toEqual({ restored: { application: APP, updateSet: DEFAULT }, fallback: 'application_default' });
    });
    it('refuses a previous pair whose set belongs to another application', async () => {
        await expect(manager.restoreWorkingSet({ application: OTHER_APP, updateSet: SET })).rejects.toMatchObject({ code: 'scope_mismatch' });
        expect(script).not.toHaveBeenCalled();
    });

    describe('moveCapture', () => {
        beforeEach(() => {
            db.sys_update_set.push({ sys_id: NEW, name: 'Target', state: 'in progress', application: APP, is_default: 'false' });
            db.sys_update_xml.push({ sys_id: XML, name: 'sys_ui_section_x', update_set: DEFAULT, application: APP, sys_recorded_at: '1a0000000000000002', comments: '' });
        });
        const move = () => manager.moveCapture({ capture: XML, sourceSet: DEFAULT, targetSet: NEW, reason: 'NSE-15 collect form layout' });
        it('moves one capture and reads it back', async () => {
            await expect(move()).resolves.toMatchObject({ capture: XML, from: { sysId: DEFAULT }, to: { sysId: NEW } });
            expect(db.sys_update_xml[0]).toMatchObject({ update_set: NEW, comments: 'Moved to Target: NSE-15 collect form layout' });
        });
        it('refuses a cross-scope move before the PUT', async () => {
            db.sys_update_set.find(set => set.sys_id === NEW)!.application = OTHER_APP;
            await expect(move()).rejects.toMatchObject({ code: 'scope_mismatch' });
            expect(req.put).not.toHaveBeenCalled();
        });
        it.each([
            ['duplicate_capture', () => db.sys_update_xml.push({ sys_id: XML2, name: 'sys_ui_section_x', update_set: NEW, application: APP, sys_recorded_at: '1a0000000000000001' })],
            ['newer_capture_exists', () => db.sys_update_xml.push({ sys_id: XML2, name: 'sys_ui_section_x', update_set: SET, application: APP, sys_recorded_at: '1a0000000000000003' })],
            ['default_update_set', () => { db.sys_update_set.find(set => set.sys_id === NEW)!.is_default = 'true'; }],
            ['update_set_closed', () => { db.sys_update_set.find(set => set.sys_id === NEW)!.state = 'complete'; }],
            ['capture_not_in_source', () => { db.sys_update_xml[0].update_set = SET; }],
        ])('refuses %s', async (code, setup) => {
            setup();
            await expect(move()).rejects.toMatchObject({ code });
            expect(req.put).not.toHaveBeenCalled();
        });
        it('reports a move the platform did not apply', async () => {
            req.put.mockResolvedValueOnce({ status: 200 });
            await expect(move()).rejects.toMatchObject({ code: 'move_not_applied' });
        });
        it('refuses a reason that could carry markup', async () => {
            await expect(manager.moveCapture({ capture: XML, sourceSet: DEFAULT, targetSet: NEW, reason: '<b>x</b>' })).rejects.toMatchObject({ code: 'invalid_input' });
        });
    });

    describe('completeUpdateSet', () => {
        beforeEach(() => {
            db.sys_update_xml.push({ sys_id: XML, name: 'sys_ui_section_x', update_set: SET, application: APP });
        });
        it('completes a clean set and reads the state back', async () => {
            await expect(manager.completeUpdateSet(SET, { expectedCaptures: 1 })).resolves.toMatchObject({ sysId: SET, state: 'complete' });
        });
        it.each([
            ['capture_count_mismatch', () => undefined, 2],
            ['mixed_scope_capture', () => db.sys_update_xml.push({ sys_id: XML2, name: 'sys_script_y', update_set: SET, application: 'global' }), 2],
            ['duplicate_capture', () => db.sys_update_xml.push({ sys_id: XML2, name: 'sys_ui_section_x', update_set: SET, application: APP }), 2],
            ['update_set_in_use', () => db.sys_user_preference.push({ sys_id: 'c'.repeat(32), user: 'd'.repeat(32), name: 'sys_update_set', value: SET }), 1],
        ] as const)('refuses %s', async (code, setup, expected) => {
            setup();
            await expect(manager.completeUpdateSet(SET, { expectedCaptures: expected })).rejects.toMatchObject({ code });
            expect(req.put).not.toHaveBeenCalled();
        });
        it('refuses a Default or closed set', async () => {
            await expect(manager.completeUpdateSet(DEFAULT, { expectedCaptures: 0 })).rejects.toMatchObject({ code: 'default_update_set' });
            await expect(manager.completeUpdateSet(CLOSED, { expectedCaptures: 0 })).rejects.toMatchObject({ code: 'update_set_closed' });
        });
        it('reports a capture that arrived while the set was being completed', async () => {
            const put = req.put.getMockImplementation()!;
            req.put.mockImplementationOnce(async (r: any) => {
                db.sys_update_xml.push({ sys_id: XML2, name: 'sys_script_late', update_set: SET, application: APP });
                return put(r);
            });
            await expect(manager.completeUpdateSet(SET, { expectedCaptures: 1 }))
                .rejects.toMatchObject({ code: 'capture_count_mismatch', detail: { state: 'complete', expected: 1, actual: 2 } });
        });
        it('reports a completion that did not read back', async () => {
            req.put.mockResolvedValueOnce({ status: 403 });
            await expect(manager.completeUpdateSet(SET, { expectedCaptures: 1 })).rejects.toBeInstanceOf(WorkingSetError);
        });
    });
});
