import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ChoiceWriter } from '../../../../src/sn/metadata/ChoiceWriter';
import { MetadataScopeError } from '../../../../src/sn/metadata/MetadataScopeError';
import { MetadataVerificationError } from '../../../../src/sn/metadata/MetadataVerificationError';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { policyRefusal } from '../../../../src/policy/PolicyRefusal';

const APP = 'a'.repeat(32), NEW = 'b'.repeat(32), SET = 'c'.repeat(32), OTHER = 'd'.repeat(32), USER = 'e'.repeat(32);
const ACTION = 'f'.repeat(32), PARENT = '1'.repeat(32), TABLE_ID = '2'.repeat(32), CHOICE_SET = '3'.repeat(32);
const ONE = '4'.repeat(32), TWO = '5'.repeat(32);
const TABLE = 'x_app_ticket', ELEMENT = 'severity', NAME = `sys_choice_${TABLE}_${ELEMENT}`;
type Row = Record<string, string>;
let state: any;
let choices: Row[];
let sets: Row[];
let dictionary: Row[];
let captures: Row[];
let req: { get: jest.Mock<any>; post: jest.Mock<any>; getUserSession: jest.Mock<any> };
let writer: ChoiceWriter;

const response = (rows: Row[], fields: string) => {
    const picked = rows.map(row => Object.fromEntries(fields.split(',').map(field => [field, row[field] ?? ''])));
    return { status: 200, headers: { 'x-total-count': String(picked.length) }, bodyObject: { result: picked } };
};
const choice = (sys_id: string, value: string, label: string, sequence: string, extra: Row = {}): Row =>
    ({ sys_id, name: TABLE, element: ELEMENT, language: 'en', value, label, sequence, inactive: 'false', hint: '', dependent_value: '', ...extra });
const form = (id: string) => {
    const row = choices.find(c => c.sys_id === id);
    const name = state.formTable ?? (row?.name ?? state.query.name);
    return `<form><input name="sys_target" value="sys_choice"><input name="sys_uniqueValue" value="${id === '-1' ? NEW : id}">
<input name="sys_row" value="${id === '-1' ? '-1' : '0'}"><input name="sysparm_encoded_record" value="signed-state">
<input name="sysparm_transaction_scope" value="${state.formScope}"><input name="sysparm_ck" value="page-token">
<input name="sys_choice.name" value="${name}"><input name="sys_choice.element" value="${row?.element ?? state.query.element}">
<input name="sys_choice.language" value="${row?.language ?? state.query.language}"><input name="sys_choice.sequence" value="${row?.sequence ?? ''}">
<input name="sys_choice.inactive" value="${row?.inactive ?? 'false'}"><input name="sys_choice.label" value="${row?.label ?? ''}">
<textarea name="sys_choice.value">${row?.value ?? ''}</textarea>${state.noHint ? '' : `<input name="sys_choice.hint" value="${row?.hint ?? ''}">`}
${id === '-1' || state.missingAction ? '' : `<button data-action-name="sysverb_update" gsft_id="${ACTION}"></button><button data-action-name="sysverb_delete" gsft_id="${ACTION}"></button>`}</form>`;
};
let serial = 0;
const payload = () => `<?xml version="1.0" encoding="UTF-8"?><record_update><sys_choice action="INSERT_OR_UPDATE" field="${ELEMENT}" table="${TABLE}">` +
    `<sys_choice_set action="INSERT_OR_UPDATE"><sys_id>${CHOICE_SET}</sys_id></sys_choice_set>` +
    choices.filter(c => !state.dropFromPayload || c.sys_id !== state.dropFromPayload).map(c => `<sys_choice action="INSERT_OR_UPDATE"><hint/><label>${state.payloadLabel ?? c.label}</label>` +
        `<sys_id>${c.sys_id}</sys_id><value>${c.value}</value></sys_choice>`).join('') + '</sys_choice></record_update>';
const recapture = () => {
    const set = state.captureSet;
    if (!choices.length && state.dropSetWhenEmpty) sets = [];
    const action = state.forceAction ?? (sets.length ? 'INSERT_OR_UPDATE' : 'DELETE');
    const existing = captures.find(c => c.update_set === set);
    if (existing) Object.assign(existing, { action, sys_mod_count: String(Number(existing.sys_mod_count) + 1), sys_updated_on: '2099-01-01 00:00:00', payload: payload() });
    else captures.push({ sys_id: `${++serial}`.padStart(32, '0'), name: NAME, update_set: set, application: state.captureApplication, action,
        sys_updated_on: '2099-01-01 00:00:00', sys_mod_count: '0', replace_on_upgrade: 'false', payload: payload() });
    if (state.extraCapture) captures.push({ sys_id: '9'.repeat(31) + '0', name: NAME, update_set: set, application: state.captureApplication, action,
        sys_updated_on: '2099-01-01 00:00:00', sys_mod_count: '0', payload: payload() });
};

beforeEach(() => {
    state = { formScope: APP, store: false, setApplication: APP, current: OTHER, captureSet: SET, captureApplication: APP, savedSetScope: APP,
        apply: true, inUse: 0, actionTable: 'global', query: {} };
    choices = [choice(ONE, '1', 'Severity 1', '1'), choice(TWO, '2', 'Severity 2', '2')];
    sets = [{ sys_id: CHOICE_SET, name: TABLE, element: ELEMENT, sys_scope: APP, sys_update_name: NAME, sys_policy: '' }];
    dictionary = [{ sys_id: '6'.repeat(32), name: TABLE, element: ELEMENT, internal_type: 'integer', choice: '1', max_length: '40', sys_scope: APP }];
    captures = [{ sys_id: '7'.repeat(32), name: NAME, update_set: OTHER, application: APP, action: 'INSERT_OR_UPDATE', sys_updated_on: '2020-01-01 00:00:00',
        sys_mod_count: '3', payload: '' }];
    req = {
        get: jest.fn(async (r: any) => {
            if (r.path === '/sys_choice.do') {
                state.loads = [...(state.loads ?? []), r.query];
                if (r.query.sysparm_query) state.query = Object.fromEntries(r.query.sysparm_query.split('^').map((term: string) => term.split('=')));
                return { status: 200, data: form(r.query.sys_id) };
            }
            if (r.path.startsWith('/api/now/stats/')) {
                state.stats = r;
                return { status: 200, bodyObject: { result: { stats: { count: String(state.inUse) } } } };
            }
            const table = r.path.split('/').at(-1), q: string = r.query.sysparm_query, f: string = r.query.sysparm_fields;
            const id = q.match(/^sys_id=([^^]+)/)?.[1];
            const term = (name: string) => q.match(new RegExp(`(?:^|\\^)${name}=([^^]*)`))?.[1];
            switch (table) {
                case 'sys_scope': return response([{ sys_id: APP, scope: 'x_app', active: 'true', sys_class_name: state.store ? 'sys_store_app' : 'sys_app' }], f);
                case 'sys_store_app': return response([], f);
                case 'sys_db_object': {
                    if (id === PARENT) return response([{ sys_id: PARENT, name: 'task', super_class: '', sys_scope: 'global' }], f);
                    const name = term('name');
                    if (name === TABLE) return response([{ sys_id: TABLE_ID, name: TABLE, super_class: PARENT, sys_scope: APP }], f);
                    if (name === 'sys_choice') return response([{ sys_id: '8'.repeat(32), name: 'sys_choice', super_class: '', sys_scope: 'global' }], f);
                    return response([], f);
                }
                case 'sys_dictionary': {
                    const names = q.slice(6).split('^')[0].split(',');
                    return response(dictionary.filter(row => names.includes(row.name) && row.element === term('element')), f);
                }
                case 'sys_choice_set': return response(sets.filter(s => s.name === term('name') && s.element === term('element')), f);
                case 'sys_choice': {
                    if (id) return response(choices.filter(c => c.sys_id === id), f);
                    const language = term('language');
                    return response(choices.filter(c => c.name === term('name') && c.element === term('element') && (!language || c.language === language)), f);
                }
                case 'sys_update_set': return response([{ sys_id: id!, name: 'SK-9', application: id === SET ? state.setApplication : OTHER, state: 'in progress' }], f);
                case 'sys_user': return response([{ sys_id: USER }], f);
                case 'sys_user_preference': state.prefReads = (state.prefReads ?? 0) + 1;
                    return response([{ sys_id: '9'.repeat(32), user: USER, name: `updateSetForScope${APP}`, value: state.current },
                        ...(state.prefsChange && state.prefReads > 1 ? [{ sys_id: '7'.repeat(32), user: USER, name: 'apps.current_app', value: OTHER }] : [])], f);
                case 'sys_update_xml': {
                    if (id) return response(captures.filter(c => c.sys_id === id), f);
                    const since = q.match(/sys_updated_on>=([^^]+)/)?.[1];
                    return response(captures.filter(c => c.name === term('name') && (!since || c.sys_updated_on >= since)), f);
                }
                case 'sys_ui_action': return response([{ sys_id: ACTION, table: state.actionTable, action_name: 'sysverb_delete', name: 'Delete',
                    onclick: 'confirmAndDeleteFromForm();' }], f);
                case 'sys_update_version': return response([], f);
                default: throw new Error(`unexpected ${table}`);
            }
        }),
        post: jest.fn(async (r: any) => {
            if (state.refusal) throw state.refusal;
            const fields = r.fields, verb = fields.sys_action, id = fields.sys_uniqueValue;
            if (state.apply) {
                if (verb === 'sysverb_delete') choices = choices.filter(c => c.sys_id !== id);
                else {
                    const posted = Object.fromEntries(Object.entries(fields).filter(([k]) => k.startsWith('sys_choice.')).map(([k, v]) => [k.slice(11), v as string]));
                    const row = choices.find(c => c.sys_id === id);
                    if (row) Object.assign(row, posted, state.savedLabel ? { label: state.savedLabel } : {});
                    else choices.push({ ...choice(id, '', '', ''), ...posted, ...(state.savedLabel ? { label: state.savedLabel } : {}) });
                    if (!sets.length) sets.push({ sys_id: CHOICE_SET, name: TABLE, element: ELEMENT, sys_scope: state.savedSetScope, sys_update_name: NAME, sys_policy: '' });
                }
                if (!state.noCapture) recapture();
            }
            if (state.postError) throw new Error(state.postError);
            return { status: 302, headers: { location: `/sys_choice.do?sys_id=${id}&sysparm_view=&sysparm_nameofstack=s&sysparm_transaction_scope=${fields.sysparm_transaction_scope}` }, data: '' };
        }),
        getUserSession: jest.fn(async () => ({ userToken: 'session-token', instanceUrl: 'https://x.service-now.com' })),
    };
    jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(req as any);
    writer = new ChoiceWriter(new ServiceNowInstance({ alias: 'unit-test' }));
});
afterEach(() => jest.restoreAllMocks());

const options = (extra: object = {}) => ({ value: '3', label: 'Severity 3', sequence: 3, scope: { sysId: APP }, updateSet: SET, ...extra });
const refused = async (code: string, extra: object = {}, remove = false, table = TABLE) => {
    const error = await (remove ? writer.removeChoice(table, ELEMENT, options(extra) as any) : writer.setChoice(table, ELEMENT, options(extra) as any)).catch(e => e);
    expect(error).toBeInstanceOf(MetadataScopeError);
    expect(error.code).toBe(code);
    expect(req.post).not.toHaveBeenCalled();
    return error;
};
const again = () => {
    jest.clearAllMocks();
    choices = choices.filter(c => c.sys_id !== NEW);
};
const failed = async (code: string, extra: object = {}, remove = false) => {
    const error = await (remove ? writer.removeChoice(TABLE, ELEMENT, options(extra) as any) : writer.setChoice(TABLE, ELEMENT, options(extra) as any)).catch(e => e);
    expect(error).toBeInstanceOf(MetadataVerificationError);
    expect(error.code).toBe(code);
    expect(error.writeAttempted).toBe(true);
    expect(req.post).toHaveBeenCalledTimes(1);
    return error;
};

describe('ChoiceWriter.getChoices', () => {
    it('reads the list in list order with the column and its choice set', async () => {
        choices.push(choice('0'.repeat(31) + '1', '0', 'Zero', ''), choice('0'.repeat(31) + '2', 'fr', 'Un', '1', { language: 'fr' }));
        const list = await writer.getChoices(TABLE, ELEMENT);
        expect(list).toMatchObject({ table: TABLE, element: ELEMENT, language: 'en', column: { table: TABLE, type: 'integer', choice: '1', scope: APP },
            choiceSet: { sysId: CHOICE_SET, scope: APP, updateName: NAME } });
        expect(list.choices.map(c => c.value)).toEqual(['1', '2', '0']);
        expect(list.choices[0]).toEqual({ sysId: ONE, value: '1', label: 'Severity 1', sequence: 1, inactive: false, hint: '', dependentValue: '', language: 'en' });
        expect(list.choices[2]).not.toHaveProperty('sequence');
        expect((await writer.getChoices(TABLE, ELEMENT, { language: 'fr' })).choices.map(c => c.label)).toEqual(['Un']);
        expect(req.post).not.toHaveBeenCalled();
    });

    it('refuses a missing column, a schema table and bad input', async () => {
        await expect(writer.getChoices(TABLE, 'nope')).rejects.toMatchObject({ code: 'column_not_found', detail: { table: TABLE, field: 'nope' } });
        await expect(writer.getChoices('sys_choice', 'name')).rejects.toMatchObject({ code: 'table_not_supported' });
        await expect(writer.getChoices(TABLE, 'a^b')).rejects.toMatchObject({ code: 'invalid_input' });
        await expect(writer.getChoices(TABLE, ELEMENT, { language: 'e n' })).rejects.toMatchObject({ code: 'invalid_input' });
    });
});

describe('ChoiceWriter.setChoice', () => {
    it('adds a choice through the choice form in the scope and verifies the row, the choice set and the capture', async () => {
        const result = await writer.setChoice(TABLE, ELEMENT, options({ hint: 'Moderate' }));
        expect(result).toMatchObject({ table: TABLE, element: ELEMENT, language: 'en', value: '3', action: 'insert', sysId: NEW,
            choice: { sysId: NEW, value: '3', label: 'Severity 3', sequence: 3, inactive: false, hint: 'Moderate' },
            choiceSet: { sysId: CHOICE_SET, scope: APP, updateName: NAME, created: false }, scope: { sysId: APP, scope: 'x_app' },
            capture: { updateSetSysId: SET, updateName: NAME, recordScope: APP, action: 'INSERT_OR_UPDATE', preferencesUnchanged: true } });
        expect(result).not.toHaveProperty('previous');
        expect(result.choices.map(c => c.value)).toEqual(['1', '2', '3']);
        expect(state.loads[0]).toMatchObject({ sys_id: '-1', sysparm_query: `name=${TABLE}^element=${ELEMENT}^language=en`, sysparm_transaction_scope: APP });
        expect(req.post.mock.calls[0][0]).toMatchObject({ path: '/sys_choice.do', redirect: 'manual', sensitive: true, fields: {
            sys_action: 'sysverb_insert_and_stay', sysparm_ck: 'page-token', sysparm_transaction_scope: APP, sysparm_transaction_update_set: SET,
            'sys_choice.value': '3', 'sys_choice.label': 'Severity 3', 'sys_choice.sequence': '3', 'sys_choice.hint': 'Moderate' } });
        // The set was not the user's current set: the capture follows the posted set.
        expect(state.current).toBe(OTHER);
    });

    it('creates the list on a column without one, in the column\'s application', async () => {
        sets = []; choices = []; captures = [];
        const result = await writer.setChoice(TABLE, ELEMENT, options());
        expect(result.choiceSet).toEqual({ sysId: CHOICE_SET, scope: APP, updateName: NAME, created: true });
        expect(result.choices).toHaveLength(1);
    });

    it('changes only the fields that differ on an existing choice, and reports the previous row', async () => {
        const result = await writer.setChoice(TABLE, ELEMENT, options({ value: '2', label: 'Severity 2', sequence: 9, inactive: true }));
        expect(result).toMatchObject({ action: 'update', sysId: TWO, previous: { label: 'Severity 2', sequence: 2, inactive: false },
            choice: { label: 'Severity 2', sequence: 9, inactive: true } });
        expect(state.loads[0]).toMatchObject({ sys_id: TWO });
        const fields = req.post.mock.calls[0][0].fields;
        expect(fields).toMatchObject({ sys_action: ACTION, 'sys_choice.sequence': '9', 'sys_choice.inactive': 'true' });
        expect(result.choices.map(c => c.value)).toEqual(['1', '2']);
    });

    it('refuses a change that changes nothing, and an add without a label', async () => {
        await refused('choice_unchanged', { value: '2', label: 'Severity 2', sequence: 2 });
        await refused('invalid_input', { label: undefined });
        await refused('choice_unchanged', { value: '2', label: undefined, sequence: undefined });
    });

    it('refuses values it would not post as given, before any request', async () => {
        for (const [extra, field] of [[{ value: 'a^b' }, 'value'], [{ value: 'javascript:gs.log(1)' }, 'value'], [{ value: ' 3' }, 'value'],
            [{ value: '3\n' }, 'value'], [{ value: '' }, 'value'], [{ label: ' ' }, 'label'], [{ label: 'x'.repeat(101) }, 'label'],
            [{ label: 'a\u0007' }, 'label'], [{ sequence: 1.5 }, 'sequence'], [{ sequence: 2 ** 31 }, 'sequence'], [{ inactive: 'yes' }, 'inactive'],
            [{ hint: 'x'.repeat(256) }, 'hint']] as Array<[object, string]>) {
            const error = await refused('invalid_input', extra);
            expect(error.detail).toEqual({ field });
        }
        await refused('invalid_input', { updateSet: 'nope' });
        await refused('invalid_input', { language: '' });
        expect(req.get).not.toHaveBeenCalled();
    });

    it('refuses a value the column cannot hold', async () => {
        expect((await refused('invalid_input', { value: 'high' })).detail).toEqual({ field: 'value' });
        dictionary[0] = { ...dictionary[0], internal_type: 'choice', max_length: '4' };
        expect((await refused('invalid_input', { value: 'highest' })).detail).toEqual({ field: 'value' });
        await writer.setChoice(TABLE, ELEMENT, options({ value: 'high' }));
    });

    it('refuses a list of another application, a column of another application and an inherited list', async () => {
        sets[0].sys_scope = OTHER;
        await refused('scope_mismatch');
        sets = [];
        dictionary[0].sys_scope = OTHER;
        await refused('scope_mismatch');
        dictionary = [{ ...dictionary[0], name: 'task', sys_scope: APP }];
        expect((await refused('choice_list_inherited')).detail).toEqual({ table: 'task', field: ELEMENT });
    });

    it('allows an inherited column when the table has its own list', async () => {
        dictionary = [{ ...dictionary[0], name: 'task', sys_scope: 'global' }];
        expect((await writer.setChoice(TABLE, ELEMENT, options())).column).toMatchObject({ table: 'task', scope: 'global' });
    });

    it('refuses two choices of the value, an update set of another application and a missing column', async () => {
        choices.push(choice('0'.repeat(31) + '9', '2', 'Again', '5'));
        await refused('choice_ambiguous', { value: '2', label: 'X' });
        state.setApplication = OTHER;
        expect((await refused('invalid_input')).detail).toEqual({ updateSetState: 'in progress', updateSetApplication: OTHER });
        dictionary = [];
        await refused('column_not_found');
    });

    it('needs the opt-in for a Store application, refuses a protected list, and reports the customization', async () => {
        state.store = true;
        await refused('store_scope');
        sets[0].sys_policy = 'protected';
        await refused('protected_record', { storeCustomization: { acknowledgeUpgradeSkip: true } });
        sets[0].sys_policy = '';
        const result = await writer.setChoice(TABLE, ELEMENT, options({ storeCustomization: { acknowledgeUpgradeSkip: true } }));
        expect(result.capture.customization).toEqual({ storeApplication: true, replaceOnUpgrade: false, baselineVersion: false });
    });

    it('refuses a form that dropped the table (another application\'s table) before posting', async () => {
        state.formTable = '';
        expect((await refused('scope_not_applied')).detail).toEqual({ table: TABLE });
        state.formTable = undefined;
        state.formScope = OTHER;
        await refused('scope_not_applied');
    });

    it('refuses a field the form does not offer, and an update the form does not permit', async () => {
        state.noHint = true;
        expect((await refused('field_not_supported', { hint: 'x' })).detail).toEqual({ field: 'hint', table: 'sys_choice' });
        state.noHint = false;
        state.missingAction = true;
        await refused('not_permitted', { value: '2', label: 'Two' });
    });

    it('fails a save the platform did not apply, or applied differently', async () => {
        state.apply = false;
        await failed('write_not_applied');
        again();
        state.apply = true;
        state.savedLabel = 'Something else';
        await failed('write_not_applied');
    });

    it('fails a save captured elsewhere, in another application or not at all', async () => {
        state.captureSet = OTHER;
        await failed('captured_elsewhere');
        again();
        state.captureSet = SET;
        state.captureApplication = 'global';
        await failed('mixed_scope_capture');
        again();
        state.captureApplication = APP;
        state.noCapture = true;
        await failed('not_captured');
    });

    it('fails when the capture does not hold the saved choice, or two captures changed', async () => {
        state.dropFromPayload = NEW;
        await failed('not_captured');
        again();
        state.dropFromPayload = undefined;
        state.payloadLabel = 'Stale';
        await failed('not_captured');
        again();
        state.payloadLabel = undefined;
        state.extraCapture = true;
        await failed('verification_unavailable');
    });

    it('fails a new list created in another application, and a changed session', async () => {
        sets = [];
        state.savedSetScope = OTHER;
        await failed('scope_not_applied');
        again();
        sets = [{ sys_id: CHOICE_SET, name: TABLE, element: ELEMENT, sys_scope: APP, sys_update_name: NAME, sys_policy: '' }];
        state.prefsChange = true;
        state.prefReads = 0;
        const error = await writer.setChoice(TABLE, ELEMENT, options()).catch(e => e);
        expect(error).toMatchObject({ code: 'session_changed', writeAttempted: false });
        expect(req.post).not.toHaveBeenCalled();
    });

    it('fails closed on a lost response even when the evidence checks out, and passes a policy refusal through', async () => {
        state.postError = 'socket hang up';
        await failed('verification_unavailable');
        again();
        state.postError = undefined;
        state.refusal = policyRefusal({ allowed: false, verbs: ['write'], decidingLayer: 'default' } as any);
        await expect(writer.setChoice(TABLE, ELEMENT, options({ value: '4' }))).rejects.toBe(state.refusal);
    });
});

describe('ChoiceWriter.removeChoice', () => {
    it('counts the records holding the value and refuses while any do', async () => {
        state.inUse = 4;
        const error = await refused('choice_in_use', { value: '2' }, true);
        expect(error.detail).toEqual({ table: TABLE, field: ELEMENT, records: 4 });
        expect(state.stats).toMatchObject({ path: `/api/now/stats/${TABLE}`, query: { sysparm_query: `${ELEMENT}=2`, sysparm_count: 'true' } });
    });

    it('removes a choice through the platform Delete, with the in-use confirmation, and verifies the capture no longer holds it', async () => {
        state.inUse = 4;
        const result = await writer.removeChoice(TABLE, ELEMENT, options({ value: '2', confirmInUse: true }) as any);
        expect(result).toMatchObject({ action: 'delete', sysId: TWO, previous: { value: '2' }, inUse: 4, capture: { action: 'INSERT_OR_UPDATE' } });
        expect(result).not.toHaveProperty('choice');
        expect(result.choices.map(c => c.value)).toEqual(['1']);
        expect(req.post.mock.calls[0][0].fields).toMatchObject({ sys_action: 'sysverb_delete' });
        expect(req.post.mock.calls[0][0].fields).not.toHaveProperty('sys_choice.label');
    });

    it('keeps the choice set when the list\'s last choice goes, its capture holding no choices', async () => {
        choices = [choices[0]];
        const result = await writer.removeChoice(TABLE, ELEMENT, options({ value: '1' }) as any);
        expect(result).toMatchObject({ action: 'delete', inUse: 0, capture: { action: 'INSERT_OR_UPDATE' }, choices: [],
            choiceSet: { sysId: CHOICE_SET, created: false } });
    });

    it('accepts a DELETE capture only when no choice set is left, and refuses one while the set remains', async () => {
        choices = [choices[0]];
        state.dropSetWhenEmpty = true;
        const result = await writer.removeChoice(TABLE, ELEMENT, options({ value: '1' }) as any);
        expect(result).toMatchObject({ action: 'delete', capture: { action: 'DELETE', recordScope: APP }, choices: [] });
        expect(result).not.toHaveProperty('choiceSet');
        again();
        choices = [choice(ONE, '1', 'Severity 1', '1')];
        sets = [{ sys_id: CHOICE_SET, name: TABLE, element: ELEMENT, sys_scope: APP, sys_update_name: NAME, sys_policy: '' }];
        captures.forEach(c => { c.action = 'INSERT_OR_UPDATE'; });
        state.dropSetWhenEmpty = false;
        state.forceAction = 'DELETE';
        await failed('not_captured', { value: '1' }, true);
    });

    it('refuses a missing value and a table-specific Delete, and fails a delete that did not happen', async () => {
        await refused('choice_not_found', { value: '7' }, true);
        state.actionTable = TABLE;
        await refused('delete_not_supported', { value: '2' }, true);
        state.actionTable = 'global';
        state.apply = false;
        await failed('delete_not_applied', { value: '2' }, true);
    });
});
