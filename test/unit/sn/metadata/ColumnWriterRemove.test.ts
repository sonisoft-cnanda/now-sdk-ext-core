import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ColumnWriter } from '../../../../src/sn/metadata/ColumnWriter';
import { MetadataScopeError } from '../../../../src/sn/metadata/MetadataScopeError';
import { MetadataVerificationError } from '../../../../src/sn/metadata/MetadataVerificationError';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { policyRefusal } from '../../../../src/policy/PolicyRefusal';

const APP = 'a'.repeat(32), REC = 'b'.repeat(32), SET = 'c'.repeat(32), OTHER = 'd'.repeat(32), USER = 'e'.repeat(32);
const ACTION = 'f'.repeat(32), TABLE_ID = '2'.repeat(32), LABEL = '3'.repeat(32), SCRIPT = '4'.repeat(32), POLICY = '5'.repeat(32);
const TABLE = 'x_app_ticket', COLUMN = 'triage', DICT = `sys_dictionary_${TABLE}_${COLUMN}`, DOC = `sys_documentation_${TABLE}_${COLUMN}_en`;
type Row = Record<string, string>;
let state: any;
let dictionary: Row[];
let labels: Row[];
let scripts: Row[];
let policies: Row[];
let captures: Row[];
let deletions: Row[];
let req: { get: jest.Mock<any>; post: jest.Mock<any>; getUserSession: jest.Mock<any> };
let writer: ColumnWriter;

const response = (rows: Row[], fields: string) => {
    const picked = rows.map(row => Object.fromEntries(fields.split(',').map(field => [field, row[field] ?? ''])));
    return { status: 200, headers: { 'x-total-count': String(picked.length) }, bodyObject: { result: picked } };
};
const form = (id: string) => {
    const row = dictionary.find(entry => entry.sys_id === id);
    return `<form><input name="sys_target" value="sys_dictionary"><input name="sys_uniqueValue" value="${id}"><input name="sys_row" value="0">
<input name="sysparm_encoded_record" value="signed-state"><input name="sysparm_transaction_scope" value="${state.formScope}">
<input name="sysparm_ck" value="page-token"><input name="sys_dictionary.name" value="${row?.name ?? ''}"><input name="sys_dictionary.element" value="${row?.element ?? ''}">
<input name="sys_dictionary.sys_scope" value="${state.formScope}"><textarea name="sys_dictionary.default_value">\n</textarea>
${state.noDrop ? '' : `<button data-action-name="drop_table_element" gsft_id="${ACTION}"></button>`}<button data-action-name="sysverb_update" gsft_id="${'9'.repeat(32)}"></button></form>`;
};
let serial = 0;
const toDelete = (name: string) => {
    if (state.noCapture === name) return;
    const existing = captures.find(capture => capture.name === name && capture.update_set === state.captureSet);
    const fields = { action: state.captureAction ?? 'DELETE', sys_updated_on: '2099-01-01 00:00:00' };
    if (existing) Object.assign(existing, fields, { application: state.captureApplication, sys_mod_count: String(Number(existing.sys_mod_count) + 1) });
    else captures.push({ sys_id: `${++serial}`.padStart(32, '0'), name, update_set: state.captureSet, application: state.captureApplication, sys_mod_count: '0',
        replace_on_upgrade: 'false', ...fields });
};

beforeEach(() => {
    state = { formScope: APP, store: false, scopeName: 'x_app', setApplication: APP, captureSet: SET, captureApplication: APP, apply: true, records: 0,
        actionTable: 'sys_dictionary', actionName: 'Delete Column' };
    dictionary = [{ sys_id: REC, name: TABLE, element: COLUMN, internal_type: 'string', sys_scope: APP, sys_update_name: DICT }];
    labels = [{ sys_id: LABEL, name: TABLE, element: COLUMN, language: 'en', sys_update_name: DOC }];
    scripts = []; policies = []; deletions = [];
    captures = [
        { sys_id: '6'.repeat(32), name: DICT, update_set: SET, application: APP, action: 'INSERT_OR_UPDATE', sys_mod_count: '0', sys_updated_on: '2020-01-01 00:00:00' },
        { sys_id: '7'.repeat(32), name: DOC, update_set: SET, application: APP, action: 'INSERT_OR_UPDATE', sys_mod_count: '0', sys_updated_on: '2020-01-01 00:00:00' },
    ];
    req = {
        get: jest.fn(async (r: any) => {
            if (r.path === '/sys_dictionary.do') {
                state.loads = [...(state.loads ?? []), r.query];
                return { status: 200, data: form(r.query.sys_id) };
            }
            if (r.path.startsWith('/api/now/stats/')) {
                state.stats = r;
                return { status: 200, bodyObject: { result: { stats: { count: String(state.records) } } } };
            }
            const table = r.path.split('/').at(-1), q: string = r.query.sysparm_query, f: string = r.query.sysparm_fields;
            const id = q.match(/^sys_id=([^^]+)/)?.[1];
            const term = (name: string) => q.match(new RegExp(`(?:^|\\^)${name}=([^^]*)`))?.[1];
            switch (table) {
                case 'sys_scope': return response([{ sys_id: state.scopeId ?? APP, scope: state.scopeName, active: 'true', sys_class_name: state.store ? 'sys_store_app' : 'sys_app' }], f);
                case 'sys_store_app': return response([], f);
                case 'sys_db_object': return response(term('name') === TABLE ? [{ sys_id: TABLE_ID, name: TABLE, super_class: '', sys_scope: APP }]
                    : term('name') === 'sys_choice' ? [{ sys_id: '8'.repeat(32), name: 'sys_choice', super_class: '', sys_scope: 'global' }] : [], f);
                case 'sys_dictionary': return response(id ? dictionary.filter(row => row.sys_id === id) : dictionary.filter(row => row.name === term('name') && row.element === term('element')), f);
                case 'sys_documentation': return response(labels, f);
                case 'sys_script_client': return response(id ? scripts.filter(row => row.sys_id === id) : scripts, f);
                case 'sys_ui_policy_action': return response(id ? policies.filter(row => row.sys_id === id) : policies, f);
                case 'sys_update_set': return response([{ sys_id: id!, name: 'SK-10', application: id === SET ? state.setApplication : OTHER, state: 'in progress' }], f);
                case 'sys_user': return response([{ sys_id: USER }], f);
                case 'sys_user_preference': state.prefReads = (state.prefReads ?? 0) + 1;
                    return response([{ sys_id: '9'.repeat(32), user: USER, name: `updateSetForScope${APP}`, value: OTHER },
                        ...(state.prefsChange && state.prefReads > (state.prefsChangeAfter ?? 1) ? [{ sys_id: '1'.repeat(32), user: USER, name: 'apps.current_app', value: OTHER }] : [])], f);
                case 'sys_ui_action': return response([{ sys_id: ACTION, table: state.actionTable, action_name: 'drop_table_element', name: state.actionName, client: 'false' }], f);
                case 'sys_update_xml': {
                    if (id) return response(captures.filter(c => c.sys_id === id), f);
                    const names = q.startsWith('nameIN') ? q.slice(6).split('^')[0].split(',') : [];
                    const since = q.match(/sys_updated_on>=([^^]+)/)?.[1];
                    return response(captures.filter(c => names.includes(c.name) && (!since || c.sys_updated_on >= since)), f);
                }
                case 'sys_update_version': return response(state.versions ?? [], f);
                case 'sys_metadata_delete': return response(deletions, f);
                case 'sys_choice': return response(state.leftChoices ?? [], f);
                case 'sys_choice_set': return response(state.leftChoiceSet ?? [], f);
                case 'sys_ui_element': return response([{ sys_id: '0'.repeat(31) + '1', sys_ui_section: '0'.repeat(31) + '2' }], f);
                case 'sys_ui_list_element': return response([], f);
                default: throw new Error(`unexpected ${table}`);
            }
        }),
        post: jest.fn(async (r: any) => {
            if (state.refusal) throw state.refusal;
            if (state.apply) {
                dictionary = dictionary.filter(row => row.sys_id !== REC);
                labels = [];
                if (!state.keepScripts) { scripts = []; policies = []; }
                for (const name of [DICT, DOC, ...state.dependentNames ?? []]) toDelete(name);
                if (!state.noDeletion) deletions.push({ sys_id: '0'.repeat(31) + '3', sys_metadata: REC, sys_scope: state.deletionScope ?? APP, sys_created_on: '2099-01-01 00:00:00' });
            }
            if (state.postError) throw new Error(state.postError);
            return { status: 302, headers: { location: `/sys_dictionary.do?sys_id=${REC}&sysparm_transaction_scope=${r.fields.sysparm_transaction_scope}&sysparm_nameofstack=s&sysparm_referring_url=x` }, data: '' };
        }),
        getUserSession: jest.fn(async () => ({ userToken: 'session-token', instanceUrl: 'https://x.service-now.com' })),
    };
    jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(req as any);
    writer = new ColumnWriter(new ServiceNowInstance({ alias: 'unit-test' }));
});
afterEach(() => jest.restoreAllMocks());

const options = (extra: object = {}) => ({ confirm: { table: TABLE, column: COLUMN }, scope: { sysId: APP }, updateSet: SET, ...extra });
const refused = async (code: string, extra: object = {}, table = TABLE, column = COLUMN) => {
    const error = await writer.removeColumn(table, column, options(extra) as any).catch(e => e);
    expect(error).toBeInstanceOf(MetadataScopeError);
    expect(error.code).toBe(code);
    expect(req.post).not.toHaveBeenCalled();
    return error;
};
const failed = async (code: string, extra: object = {}) => {
    const error = await writer.removeColumn(TABLE, COLUMN, options(extra) as any).catch(e => e);
    expect(error).toBeInstanceOf(MetadataVerificationError);
    expect(error.code).toBe(code);
    expect(error.writeAttempted).toBe(true);
    expect(req.post).toHaveBeenCalledTimes(1);
    return error;
};

describe('ColumnWriter.removeColumn', () => {
    it('posts the platform\'s Delete Column action in the scope and verifies the DELETE captures, the deletion record and the leftovers', async () => {
        const result = await writer.removeColumn(TABLE, COLUMN, options());
        expect(result).toMatchObject({ table: TABLE, column: COLUMN, sysId: REC, scope: { sysId: APP, scope: 'x_app' }, records: 0, createdInThisSet: true,
            deleted: { labels: [DOC], clientScripts: [], uiPolicyActions: [] }, captures: [DICT, DOC],
            leftovers: { choices: 0, formElements: [{ sysId: '0'.repeat(31) + '1', section: '0'.repeat(31) + '2' }], listElements: [] },
            capture: { updateSetSysId: SET, updateName: DICT, action: 'DELETE', recordScope: APP, preferencesUnchanged: true } });
        expect(state.loads[0]).toMatchObject({ sys_id: REC, sysparm_transaction_scope: APP });
        expect(req.post.mock.calls[0][0]).toMatchObject({ path: '/sys_dictionary.do', redirect: 'manual', sensitive: true,
            fields: { sys_action: ACTION, sysparm_ck: 'page-token', sysparm_transaction_scope: APP, sysparm_transaction_update_set: SET } });
        // The rendered textarea is posted back as a browser would post it.
        expect(req.post.mock.calls[0][0].fields['sys_dictionary.default_value']).toBe('');
        expect(state.stats).toMatchObject({ path: `/api/now/stats/${TABLE}`, query: { sysparm_query: `${COLUMN}ISNOTEMPTY`, sysparm_count: 'true' } });
    });

    it('says when the column was not created in this set: another set holds its capture', async () => {
        captures[0].update_set = OTHER;
        const result = await writer.removeColumn(TABLE, COLUMN, options());
        expect(result.createdInThisSet).toBe(false);
        // The DELETE is a new capture in this set; the other set keeps its INSERT_OR_UPDATE.
        expect(captures.filter(capture => capture.name === DICT).map(capture => [capture.update_set, capture.action])).toEqual([[OTHER, 'INSERT_OR_UPDATE'], [SET, 'DELETE']]);
    });

    it('says when the column was not created in this set: a version came from elsewhere', async () => {
        state.versions = [{ sys_id: '0'.repeat(31) + '8', name: DICT, source_table: 'sys_remote_update_set', source: OTHER }];
        expect((await writer.removeColumn(TABLE, COLUMN, options())).createdInThisSet).toBe(false);
    });

    it('refuses without a confirmation naming the table and column, before any request', async () => {
        await refused('confirmation_required', { confirm: undefined });
        await refused('confirmation_required', { confirm: { table: TABLE, column: 'other' } });
        await refused('confirmation_required', { confirm: { table: 'other', column: COLUMN } });
        await refused('invalid_input', {}, TABLE, 'Bad Column');
        await refused('invalid_input', { updateSet: 'nope' });
        expect(req.get).not.toHaveBeenCalled();
    });

    it('refuses a missing column, another application\'s column, a vendor column and a Store column without the opt-in', async () => {
        await refused('column_not_found', { confirm: { table: TABLE, column: 'nope' } }, TABLE, 'nope');
        dictionary[0].sys_scope = OTHER;
        await refused('scope_mismatch');
        dictionary[0].sys_scope = 'global';
        Object.assign(state, { scopeId: 'global', scopeName: 'global' });
        expect((await refused('column_not_deletable', { scope: 'global' })).detail).toEqual({ table: TABLE, field: COLUMN });
        Object.assign(state, { scopeId: undefined, scopeName: 'x_app', store: true });
        dictionary[0].sys_scope = APP;
        await refused('store_scope');
        await refused('column_not_deletable', { storeCustomization: { acknowledgeUpgradeSkip: true } });
        state.store = false;
        await refused('table_not_supported', { confirm: { table: 'sys_choice', column: 'name' } }, 'sys_choice', 'name');
    });

    it('allows a u_ column of a Store application with the opt-in and reports the customization', async () => {
        state.store = true;
        const column = 'u_triage';
        dictionary = [{ sys_id: REC, name: TABLE, element: column, internal_type: 'string', sys_scope: APP, sys_update_name: `sys_dictionary_${TABLE}_${column}` }];
        labels = [{ sys_id: LABEL, name: TABLE, element: column, language: 'en', sys_update_name: `sys_documentation_${TABLE}_${column}_en` }];
        captures = [];
        state.dependentNames = [];
        const post = req.post.getMockImplementation()!;
        req.post.mockImplementation(async (r: any) => {
            dictionary = []; labels = [];
            for (const name of [`sys_dictionary_${TABLE}_${column}`, `sys_documentation_${TABLE}_${column}_en`]) toDelete(name);
            deletions.push({ sys_id: '0'.repeat(31) + '3', sys_metadata: REC, sys_scope: APP, sys_created_on: '2099-01-01 00:00:00' });
            return { ...(await post({ ...r, fields: r.fields })), status: 302 };
        });
        state.apply = false;
        const result = await writer.removeColumn(TABLE, column, options({ confirm: { table: TABLE, column }, storeCustomization: { acknowledgeUpgradeSkip: true } }));
        expect(result.capture.customization).toEqual({ storeApplication: true, replaceOnUpgrade: false, baselineVersion: false });
        expect(result.createdInThisSet).toBe(false);
    });

    it('refuses an update set of another application, and rows holding a value without acknowledgeDataLoss', async () => {
        state.setApplication = OTHER;
        expect((await refused('invalid_input')).detail).toEqual({ updateSetState: 'in progress', updateSetApplication: OTHER });
        state.setApplication = APP;
        state.records = 12;
        expect((await refused('column_has_data')).detail).toEqual({ table: TABLE, field: COLUMN, records: 12 });
        expect((await writer.removeColumn(TABLE, COLUMN, options({ acknowledgeDataLoss: true }))).records).toBe(12);
    });

    it('refuses dependents the platform would delete, refuses another application\'s, and verifies the ones acknowledged', async () => {
        scripts = [{ sys_id: SCRIPT, table: TABLE, field: COLUMN, sys_scope: APP }];
        policies = [{ sys_id: POLICY, table: TABLE, field: COLUMN, sys_scope: APP }];
        expect((await refused('column_has_dependents')).detail).toEqual({ table: TABLE, field: COLUMN, records: 2 });
        policies[0].sys_scope = OTHER;
        expect((await refused('column_referenced', { acknowledgeDependentDeletes: true })).detail).toEqual({ table: 'sys_ui_policy_action', field: COLUMN });
        policies[0].sys_scope = APP;
        state.dependentNames = [`sys_script_client_${SCRIPT}`, `sys_ui_policy_action_${POLICY}`];
        const result = await writer.removeColumn(TABLE, COLUMN, options({ acknowledgeDependentDeletes: true }));
        expect(result.deleted).toEqual({ labels: [DOC], clientScripts: [SCRIPT], uiPolicyActions: [POLICY] });
        expect(result.captures).toEqual([DICT, DOC, `sys_script_client_${SCRIPT}`, `sys_ui_policy_action_${POLICY}`]);
    });

    it('fails when a dependent survives the removal or its DELETE is not captured', async () => {
        scripts = [{ sys_id: SCRIPT, table: TABLE, field: COLUMN, sys_scope: APP }];
        state.keepScripts = true;
        await failed('delete_not_applied', { acknowledgeDependentDeletes: true });
        jest.clearAllMocks();
        dictionary = [{ sys_id: REC, name: TABLE, element: COLUMN, internal_type: 'string', sys_scope: APP, sys_update_name: DICT }];
        labels = [{ sys_id: LABEL, name: TABLE, element: COLUMN, language: 'en', sys_update_name: DOC }];
        state.keepScripts = false;
        scripts = [{ sys_id: SCRIPT, table: TABLE, field: COLUMN, sys_scope: APP }];
        await failed('not_captured', { acknowledgeDependentDeletes: true });
    });

    it('refuses a form without the platform\'s Delete Column, another action under that name, or loaded in another scope', async () => {
        state.noDrop = true;
        await refused('column_not_deletable');
        state.noDrop = false;
        state.actionTable = 'global';
        await refused('delete_not_supported');
        state.actionTable = 'sys_dictionary';
        state.formScope = OTHER;
        await refused('scope_not_applied');
    });

    it('fails a removal the platform did not apply, captured elsewhere, in another application, not as a DELETE, or without a deletion record', async () => {
        const reset = () => {
            jest.clearAllMocks();
            dictionary = [{ sys_id: REC, name: TABLE, element: COLUMN, internal_type: 'string', sys_scope: APP, sys_update_name: DICT }];
            labels = [{ sys_id: LABEL, name: TABLE, element: COLUMN, language: 'en', sys_update_name: DOC }];
            deletions = [];
        };
        state.apply = false;
        await failed('delete_not_applied');
        reset(); state.apply = true; state.captureSet = OTHER;
        await failed('captured_elsewhere');
        reset(); state.captureSet = SET; state.captureApplication = 'global';
        await failed('mixed_scope_capture');
        reset(); state.captureApplication = APP; state.captureAction = 'INSERT_OR_UPDATE';
        await failed('delete_not_captured');
        reset(); state.captureAction = undefined; state.noDeletion = true;
        await failed('delete_not_captured');
        reset(); state.noDeletion = false; state.deletionScope = OTHER;
        await failed('delete_not_captured');
        reset(); state.deletionScope = undefined; state.noCapture = DOC;
        await failed('not_captured');
    });

    it('fails a changed session, a rejected token and a lost response, and passes a policy refusal through', async () => {
        state.prefsChange = true;
        const early = await writer.removeColumn(TABLE, COLUMN, options()).catch(e => e);
        expect(early).toMatchObject({ code: 'session_changed', writeAttempted: false });
        expect(req.post).not.toHaveBeenCalled();
        state.prefReads = 0;
        state.prefsChangeAfter = 2;
        await failed('session_changed');
        jest.clearAllMocks();
        dictionary = [{ sys_id: REC, name: TABLE, element: COLUMN, internal_type: 'string', sys_scope: APP, sys_update_name: DICT }];
        labels = [{ sys_id: LABEL, name: TABLE, element: COLUMN, language: 'en', sys_update_name: DOC }];
        Object.assign(state, { prefsChange: false, apply: false, postError: 'csrf_rejected' });
        await failed('csrf_rejected');
        jest.clearAllMocks();
        Object.assign(state, { apply: true, postError: 'socket hang up' });
        await failed('verification_unavailable');
        jest.clearAllMocks();
        dictionary = [{ sys_id: REC, name: TABLE, element: COLUMN, internal_type: 'string', sys_scope: APP, sys_update_name: DICT }];
        state.postError = undefined;
        state.refusal = policyRefusal({ allowed: false, verbs: ['write'], decidingLayer: 'default' } as any);
        await expect(writer.removeColumn(TABLE, COLUMN, options())).rejects.toBe(state.refusal);
    });

    it('reports the choices and choice set left behind', async () => {
        state.leftChoices = [{ sys_id: '0'.repeat(31) + '4' }, { sys_id: '0'.repeat(31) + '5' }];
        state.leftChoiceSet = [{ sys_id: '0'.repeat(31) + '6' }];
        expect((await writer.removeColumn(TABLE, COLUMN, options())).leftovers).toMatchObject({ choices: 2, choiceSet: '0'.repeat(31) + '6' });
    });
});
