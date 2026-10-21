import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ColumnWriter } from '../../../../src/sn/metadata/ColumnWriter';
import { MetadataScopeError } from '../../../../src/sn/metadata/MetadataScopeError';
import { MetadataVerificationError } from '../../../../src/sn/metadata/MetadataVerificationError';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { policyRefusal } from '../../../../src/policy/PolicyRefusal';

const APP = 'a'.repeat(32), REC = 'b'.repeat(32), SET = 'c'.repeat(32), OTHER = 'd'.repeat(32), USER = 'e'.repeat(32);
const SECTION = 'f'.repeat(32), PARENT = '1'.repeat(32), TABLE_ID = '2'.repeat(32), OWNER = '3'.repeat(32);
const TABLE = 'x_app_ticket';
type Row = Record<string, string>;
let state: any;
let dictionary: Row[];
let labels: Row[];
let elements: Row[];
let captures: Row[];
let req: { get: jest.Mock<any>; post: jest.Mock<any>; getUserSession: jest.Mock<any> };
let writer: ColumnWriter;

const response = (rows: Row[], fields: string) => {
    const picked = rows.map(row => Object.fromEntries(fields.split(',').map(field => [field, row[field] ?? ''])));
    return { status: 200, headers: { 'x-total-count': String(picked.length) }, bodyObject: { result: picked } };
};
const form = () => `<form><input name="sys_target" value="sys_dictionary"><input name="sys_uniqueValue" value="${state.recId ?? REC}">
<input name="sys_row" value="-1"><input name="sysparm_encoded_record" value="signed-state">
<input name="sysparm_transaction_scope" value="${state.formScope}"><input name="sys_dictionary.sys_scope" value="${state.formScope}">
<input name="sysparm_ck" value="page-token"><input name="sys_dictionary.name" value="${state.formTable}">
<input name="sys_dictionary.element" value=""><input name="sys_dictionary.column_label" value=""><input name="sys_dictionary.internal_type" value="">
${state.noMaxLength ? '' : '<input name="sys_dictionary.max_length" value="">'}<input name="sys_dictionary.reference" value=""></form>`;
let serial = 0;
const capture = (name: string, extra: Row = {}): Row => ({ sys_id: `${++serial}`.padStart(32, '0'), name, update_set: state.captureSet,
    application: state.captureApplication, action: 'INSERT_OR_UPDATE', sys_updated_on: '2099-01-01 00:00:00', sys_mod_count: '0', replace_on_upgrade: 'false', ...extra });

beforeEach(() => {
    state = { formScope: APP, formTable: TABLE, store: false, tableScope: APP, parent: 'task', setApplication: APP, current: SET, captureSet: SET,
        captureApplication: APP, savedScope: APP, place: true, apply: true, prefsChange: false };
    dictionary = [{ sys_id: '5'.repeat(32), name: 'task', element: 'number' }];
    labels = []; elements = []; captures = [];
    req = {
        get: jest.fn(async (r: any) => {
            if (r.path === '/sys_dictionary.do') {
                state.loads = [...(state.loads ?? []), r.query];
                return state.redirect ? { status: 302, headers: { location: 'https://x.service-now.com/login.do?x=1' }, data: '' } : { status: 200, data: form() };
            }
            const table = r.path.split('/').at(-1), q: string = r.query.sysparm_query, f: string = r.query.sysparm_fields;
            const id = q.match(/^sys_id=([^^]+)/)?.[1];
            switch (table) {
                case 'sys_scope': return response([{ sys_id: APP, scope: 'x_app', active: 'true', sys_class_name: state.store ? 'sys_store_app' : 'sys_app' }], f);
                case 'sys_store_app': return response([], f);
                case 'sys_db_object': {
                    if (id === PARENT) return response([{ sys_id: PARENT, name: state.parent, super_class: '', sys_scope: 'global' }], f);
                    const name = q.match(/^name=([^^]+)/)?.[1];
                    if (name === TABLE) return response([{ sys_id: TABLE_ID, name: TABLE, super_class: PARENT, sys_scope: state.tableScope }], f);
                    if (name === 'sys_user') return response([{ sys_id: OWNER, name: 'sys_user', super_class: '', sys_scope: 'global' }], f);
                    return response([], f);
                }
                case 'sys_glide_object': return response(['string', 'reference', 'integer'].filter(type => q.startsWith(`name=${type}^`)).map(name => ({ sys_id: name.padEnd(32, '0'), name })), f);
                case 'sys_dictionary': {
                    if (id) return response(dictionary.filter(row => row.sys_id === id), f);
                    const element = q.match(/\^element=([^^]+)/)?.[1];
                    const names = q.startsWith('nameIN') ? q.slice(6).split('^')[0].split(',') : [q.match(/^name=([^^]+)/)?.[1]];
                    return response(dictionary.filter(row => names.includes(row.name) && row.element === element), f);
                }
                case 'sys_update_set': return response([{ sys_id: id!, name: 'SK-6', application: id === SET ? state.setApplication : OTHER, state: 'in progress' }], f);
                case 'sys_user': return response([{ sys_id: USER }], f);
                case 'sys_user_preference': state.prefReads = (state.prefReads ?? 0) + 1;
                    return response([{ sys_id: '9'.repeat(32), user: USER, name: `updateSetForScope${APP}`, value: state.current },
                        ...(state.prefsChange && state.prefReads > 1 ? [{ sys_id: '7'.repeat(32), user: USER, name: 'apps.current_app', value: OTHER }] : []),
                        { sys_id: '8'.repeat(32), user: USER, name: 'sys_update_set', value: state.current }], f);
                case 'sys_ui_section': return response(q.startsWith(`name=${TABLE}^`) ? [{ sys_id: SECTION, name: TABLE }] : [], f);
                case 'sys_documentation': return response(labels.filter(row => q.startsWith(`name=${row.name}^element=${row.element}^`)), f);
                case 'sys_ui_element': return response(elements.filter(row => q.startsWith(`element=${row.element}^`)), f);
                case 'sys_update_xml': state.captureQueries = [...(state.captureQueries ?? []), q];
                    return response(id ? captures.filter(c => c.sys_id === id) : captures, f);
                case 'sys_update_version': return response([{ sys_id: '6'.repeat(32), name: `sys_dictionary_${TABLE}_${state.column}` }], f);
                default: throw new Error(`unexpected ${table}`);
            }
        }),
        post: jest.fn(async (r: any) => {
            if (state.refusal) throw state.refusal;
            const element = r.fields['sys_dictionary.element'];
            state.column = element;
            if (state.apply) {
                dictionary.push({ sys_id: state.recId ?? REC, name: TABLE, element: state.renamed ?? element, internal_type: r.fields['sys_dictionary.internal_type'],
                    max_length: r.fields['sys_dictionary.max_length'] ?? '40', reference: r.fields['sys_dictionary.reference'] ?? '',
                    sys_scope: state.savedScope, sys_update_name: `sys_dictionary_${TABLE}_${element}` });
                labels.push({ sys_id: `${labels.length + 1}`.padStart(32, '4'), name: TABLE, element, language: 'en', label: r.fields['sys_dictionary.column_label'],
                    sys_scope: state.savedScope, sys_update_name: `sys_documentation_${TABLE}_${element}_en` });
                captures.push(capture(`sys_dictionary_${TABLE}_${element}`), ...(state.noLabelCapture ? [] : [capture(`sys_documentation_${TABLE}_${element}_en`)]));
                if (state.place) {
                    elements.push({ sys_id: '0'.repeat(31) + '1', element, sys_ui_section: SECTION });
                    if (!state.noFormCapture) captures.push(capture(`sys_ui_section_${SECTION}`, state.formCapture ?? {}));
                }
            }
            if (state.postError) throw new Error('socket hang up');
            return { status: 302, headers: { location: `/sys_dictionary.do?sys_id=${state.recId ?? REC}&sysparm_view=&sysparm_nameofstack=s&sysparm_transaction_scope=${r.fields.sysparm_transaction_scope}` }, data: '' };
        }),
        getUserSession: jest.fn(async () => ({ userToken: 'session-token', instanceUrl: 'https://x.service-now.com' })),
    };
    jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(req as any);
    writer = new ColumnWriter(new ServiceNowInstance({ alias: 'unit-test' }));
});
afterEach(() => jest.restoreAllMocks());

const options = (extra: object = {}) => ({ column: 'triage_note', label: 'Triage note', type: 'string', maxLength: 100, scope: { sysId: APP }, updateSet: SET, ...extra });
const refused = async (code: string, extra: object = {}, table = TABLE) => {
    const error = await writer.addColumn(table, options(extra) as any).catch(e => e);
    expect(error).toBeInstanceOf(MetadataScopeError);
    expect(error.code).toBe(code);
    expect(req.post).not.toHaveBeenCalled();
    return error;
};
const failed = async (code: string, extra: object = {}) => {
    const error = await writer.addColumn(TABLE, options(extra) as any).catch(e => e);
    expect(error).toBeInstanceOf(MetadataVerificationError);
    expect(error.code).toBe(code);
    expect(error.writeAttempted).toBe(true);
    expect(req.post).toHaveBeenCalledTimes(1);
    return error;
};

describe('ColumnWriter', () => {
    it('inserts and stays through the dictionary form in the scope, and verifies the column, label, placement and captures', async () => {
        const result = await writer.addColumn(TABLE, options());
        expect(result).toMatchObject({ table: TABLE, column: 'triage_note', sysId: REC, label: 'Triage note', type: 'string', scope: { sysId: APP, scope: 'x_app' },
            formSections: [SECTION], captures: [`sys_dictionary_${TABLE}_triage_note`, `sys_documentation_${TABLE}_triage_note_en`, `sys_ui_section_${SECTION}`],
            capture: { updateSetSysId: SET, updateName: `sys_dictionary_${TABLE}_triage_note`, recordScope: APP, action: 'INSERT_OR_UPDATE', preferencesUnchanged: true } });
        expect(state.loads[0]).toMatchObject({ sys_id: '-1', sysparm_query: `name=${TABLE}`, sysparm_transaction_scope: APP, sysparm_isdevstudio: 'true' });
        expect(state.loads[0].sysparm_nameofstack).toMatch(/_bottomless$/);
        expect(req.post).toHaveBeenCalledTimes(1);
        expect(req.post.mock.calls[0][0]).toMatchObject({ path: '/sys_dictionary.do', redirect: 'manual', sensitive: true, fields: {
            sys_action: 'sysverb_insert_and_stay', sysparm_ck: 'page-token', sysparm_transaction_scope: APP, sysparm_transaction_update_set: SET,
            'sys_dictionary.element': 'triage_note', 'sys_dictionary.column_label': 'Triage note', 'sys_dictionary.internal_type': 'string',
            'sys_dictionary.max_length': '100' } });
        expect(req.post.mock.calls[0][0].fields).not.toHaveProperty('sys_dictionary.reference');
        // The guarded landing followed the redirect back to this record's form.
        expect(state.loads).toHaveLength(2);
        expect(state.loads[1]).toMatchObject({ sys_id: REC, sysparm_transaction_scope: APP });
        // Snapshot and verification both cover every capture name the save can make, ORs grouped before the time filter.
        expect(state.captureQueries[0]).toBe(`name=sys_dictionary_${TABLE}_triage_note^ORnameSTARTSWITHsys_documentation_${TABLE}_triage_note_^ORnameINsys_ui_section_${SECTION}^ORDERBYsys_id`);
        expect(state.captureQueries[1].startsWith(`${state.captureQueries[0].replace('^ORDERBYsys_id', '')}^sys_updated_on>=`)).toBe(true);
    });
    it('names the column as the platform does: u_ in Global, the scope prefix on another application\'s table', async () => {
        state.tableScope = OTHER; state.place = false;
        const cross = await writer.addColumn(TABLE, options());
        expect(cross).toMatchObject({ column: 'x_app_triage_note', formSections: [], captures: [`sys_dictionary_${TABLE}_x_app_triage_note`, `sys_documentation_${TABLE}_x_app_triage_note_en`] });
        expect(req.post.mock.calls[0][0].fields['sys_dictionary.element']).toBe('x_app_triage_note');
        state.recId = OWNER;
        await expect(writer.addColumn(TABLE, options({ column: 'x_app_second' }))).resolves.toMatchObject({ column: 'x_app_second' });
    });
    it('adds the u_ prefix in Global', async () => {
        const get = req.get.getMockImplementation()!;
        req.get.mockImplementation(async (r: any) => {
            const table = r.path.split('/').at(-1);
            if (table === 'sys_scope') return response([{ sys_id: 'global', scope: 'global', active: 'true', sys_class_name: 'sys_scope' }], r.query.sysparm_fields);
            if (table === 'sys_user_preference') return response([{ sys_id: '9'.repeat(32), user: USER, name: 'updateSetForScopeglobal', value: SET }], r.query.sysparm_fields);
            if (table === 'sys_update_set') return response([{ sys_id: SET, name: 'SK-6', application: 'global', state: 'in progress' }], r.query.sysparm_fields);
            return get(r);
        });
        Object.assign(state, { formScope: 'global', savedScope: 'global', captureApplication: 'global' });
        const result = await writer.addColumn(TABLE, options({ scope: 'global' }));
        expect(result.column).toBe('u_triage_note');
    });
    it('posts the referenced table for a reference column and checks it was saved', async () => {
        const result = await writer.addColumn(TABLE, options({ type: 'reference', reference: 'sys_user', maxLength: undefined }));
        expect(result.type).toBe('reference');
        expect(req.post.mock.calls[0][0].fields).toMatchObject({ 'sys_dictionary.reference': 'sys_user', 'sys_dictionary.internal_type': 'reference' });
        expect(req.post.mock.calls[0][0].fields).not.toHaveProperty('sys_dictionary.max_length');
    });
    it('names a Store application\'s column u_, even on its own table, and reports customization evidence when the opt-in is given', async () => {
        state.store = true;
        await refused('store_scope');
        const result = await writer.addColumn(TABLE, options({ storeCustomization: { acknowledgeUpgradeSkip: true } }));
        expect(result.column).toBe('u_triage_note');
        expect(req.post.mock.calls[0][0].fields['sys_dictionary.element']).toBe('u_triage_note');
        expect(result.capture.customization).toEqual({ storeApplication: true, replaceOnUpgrade: false, baselineVersion: true });
    });

    describe('refuses before posting', () => {
        it('invalid input', async () => {
            await refused('invalid_input', { column: 'Triage' });
            await refused('invalid_input', { column: 'triage note' });
            await refused('invalid_input', { label: ' ' });
            await refused('invalid_input', { label: 'a<b' });
            await refused('invalid_input', { maxLength: 0 });
            await refused('invalid_input', { type: 'string;' });
            await refused('invalid_input', { type: 'reference' });
            await refused('invalid_input', { reference: 'sys_user' });
            await refused('invalid_input', { updateSet: 'nope' });
            await refused('invalid_input', { type: 'no_such_type' });
            await refused('invalid_input', { column: 'x'.repeat(81) });
        });
        it('a reference to a table that does not exist', async () => {
            const error = await refused('table_not_supported', { type: 'reference', reference: 'no_such_table', maxLength: undefined });
            expect(error.detail).toEqual({ table: 'no_such_table' });
        });
        it('a column the table or a parent already has', async () => {
            dictionary.push({ sys_id: '6'.repeat(32), name: 'task', element: 'triage_note' });
            const error = await refused('column_exists');
            expect(error.detail).toEqual({ table: 'task', field: 'triage_note' });
        });
        it('the platform\'s own schema tables, and tables extending them', async () => {
            await refused('table_not_supported', {}, 'sys_dictionary');
            state.parent = 'sys_metadata';
            await refused('table_not_supported');
        });
        it('an unknown table', async () => {
            await refused('table_not_supported', {}, 'no_such_table');
        });
        it('a set that is not the user\'s set for the application, or not of it', async () => {
            state.current = OTHER;
            await refused('update_set_not_current');
            state.current = SET; state.setApplication = OTHER;
            await refused('invalid_input');
        });
        it('a form that did not load in the scope or for the table', async () => {
            state.formScope = OTHER;
            await refused('scope_not_applied');
            state.formScope = APP; state.formTable = 'x_app_other';
            await refused('scope_not_applied');
        });
        it('a form without a field it needs', async () => {
            state.noMaxLength = true;
            const error = await refused('field_not_supported');
            expect(error.detail).toEqual({ field: 'max_length', table: 'sys_dictionary' });
        });
        it('a redirect instead of the form', async () => {
            state.redirect = true;
            const error = await refused('form_redirected');
            expect(error.detail).toEqual({ table: 'sys_dictionary', redirectPath: '/login.do' });
        });
        it('a policy refusal of the POST is rethrown as it is', async () => {
            state.refusal = policyRefusal({ allowed: false, verbs: ['write'], decidingLayer: 'default' } as any);
            await expect(writer.addColumn(TABLE, options())).rejects.toBe(state.refusal);
        });
    });

    describe('verifies after posting', () => {
        it('a column the platform did not create', async () => {
            state.apply = false;
            await failed('write_not_applied');
        });
        it('a column the platform named differently, reported with the name it used', async () => {
            state.renamed = 'u_triage_note';
            const error = await failed('write_not_applied');
            expect(error.sysId).toBe(REC);
            expect(error.messages).toEqual(['The platform saved the column as u_triage_note, not triage_note']);
        });
        it('a column saved in another application', async () => {
            state.savedScope = OTHER;
            const error = await failed('scope_not_applied');
            expect(error.sysId).toBe(REC);
        });
        it('a capture in another set or application', async () => {
            state.captureSet = OTHER;
            await failed('captured_elsewhere');
        });
        it('a form placement captured in another set', async () => {
            state.formCapture = { update_set: OTHER };
            await failed('captured_elsewhere');
        });
        it('a capture of another application in the set', async () => {
            state.captureApplication = OTHER;
            await failed('mixed_scope_capture');
        });
        it('a missing label or form capture', async () => {
            state.noLabelCapture = true;
            await failed('not_captured');
        });
        it('a placement without its Form Layout capture', async () => {
            state.noFormCapture = true;
            await failed('not_captured');
        });
        it('a capture that was there before and did not change', async () => {
            captures.push(capture(`sys_dictionary_${TABLE}_triage_note`, { sys_mod_count: '3' }));
            state.apply = true;
            const post = req.post.getMockImplementation()!;
            req.post.mockImplementation(async (r: any) => { const out = await post(r); captures = captures.filter(c => c.sys_mod_count === '3' || !c.name.startsWith('sys_dictionary_')); return out; });
            await failed('not_captured');
        });
        it('changed preferences', async () => {
            state.prefsChange = true;
            const error = await writer.addColumn(TABLE, options()).catch(e => e);
            expect(error.code).toBe('session_changed');
        });
        it('a POST that failed after the platform saved', async () => {
            state.postError = true;
            const error = await failed('verification_unavailable');
            expect(error.sysId).toBe(REC);
        });
    });
});
