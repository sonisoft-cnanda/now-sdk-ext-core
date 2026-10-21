import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ListLayoutWriter } from '../../../../src/sn/metadata/ListLayoutWriter';
import { MetadataScopeError } from '../../../../src/sn/metadata/MetadataScopeError';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { policyRefusal } from '../../../../src/policy/PolicyRefusal';

const APP = 'a'.repeat(32), LIST = 'b'.repeat(32), SET = 'c'.repeat(32), OTHER = 'd'.repeat(32), USER = 'e'.repeat(32);
const SAVED = 'f'.repeat(32), XML = '2'.repeat(32), VIEW = '3'.repeat(32);
const TABLE = 'sn_compliance_policy', NAME = `sys_ui_list_${TABLE}_null`;
type Row = Record<string, string>;
let state: any;
let list: Row | undefined;
let elements: Row[];
let captures: Row[];
let req: { get: jest.Mock<any>; post: jest.Mock<any> };
let writer: ListLayoutWriter;
let getRow: (r: any) => Promise<any>;

const response = (rows: Row[], fields: string) => {
    const picked = rows.map(row => Object.fromEntries(fields.split(',').map(field => [field, row[field] ?? ''])));
    return { status: 200, headers: { 'x-total-count': String(picked.length) }, bodyObject: { result: picked } };
};
const columnsOf = (id: string, values: string[]) => values.map((element, position) =>
    ({ sys_id: `${id.slice(0, 1)}${position}`.padStart(32, '0'), list_id: id, element, position: String(position) }));
const page = () => `<html><form name="other"><input type="hidden" name="sysparm_ck" value="wrong"></form>
<FORM name="editPage" action="slushbucket.do" method="post">
<input name="sysparm_ck" id="sysparm_ck" type="hidden" value="page-token">
<input type="HIDDEN" id="sys_target" name="sys_target" value="${state.pageTable}"><input type="HIDDEN" name="sysparm_list" value="${state.pageTable}">
<input type="HIDDEN" id="sysparm_form" name="sysparm_form" value="list"><input type="HIDDEN" name="sysparm_collection" value="${state.collection}">
<input type="HIDDEN" name="sysparm_collection_relationship" value="${state.relationship}">
<input type="HIDDEN" name="sysparm_referring_url" value="${TABLE}_list.do">
<input type="HIDDEN" id="sysparm_record_scope" name="sysparm_record_scope" value="">
<input type="hidden" name="sysparm_transaction_scope" value="${state.pageScope}">
<select name="select_0" multiple><option value="url">URL</option><option value="active">Active</option><option value="a,b">Odd</option></select>
<select name="select_1" multiple>${state.pageSelected.map((value: string) => `<option value="${value}">${value}</option>`).join('')}</select>
${state.noSave ? '' : '<button type="submit" id="sysverb_save" name="saveButton">Save</button>'}
</FORM></html>`;

beforeEach(() => {
    state = { pageScope: APP, pageTable: TABLE, collection: '', relationship: '', userDomain: 'global', prefsChange: false, pageSelected: ['name', 'type', 'owner.email'], store: false, setApplication: APP,
        setState: 'in progress', current: SET, captureSet: SET, captureApplication: APP, apply: true, savedScope: APP };
    list = { sys_id: LIST, name: TABLE, view: 'Default view', sys_scope: APP, sys_update_name: NAME, sys_policy: '', sys_domain: 'global', sys_created_on: '2020-01-01 00:00:00' };
    elements = columnsOf(LIST, ['name', 'type', 'owner.email']);
    captures = [];
    req = {
        get: jest.fn(async (r: any) => {
            if (r.path === '/slushbucket.do') return state.redirect ? { status: 302, headers: { location: 'https://x.service-now.com/login.do?x=1' }, data: '' } : { status: 200, data: page() };
            const table = r.path.split('/').at(-1), q: string = r.query.sysparm_query, f: string = r.query.sysparm_fields;
            const id = q.match(/^sys_id=([^^]+)/)?.[1];
            switch (table) {
                case 'sys_scope': return response([{ sys_id: APP, scope: 'sn_compliance', active: 'true', sys_class_name: state.store ? 'sys_store_app' : 'sys_app' }], f);
                case 'sys_store_app': return response([], f);
                case 'sys_ui_view': return response(q.startsWith('name=sow^') ? [{ sys_id: VIEW, name: 'sow' }] : [], f);
                case 'sys_ui_list': {
                    const view = q.match(/\^view=([^^]+)/)?.[1];
                    const match = list && q.startsWith(`name=${list.name}^`) && list.view === view && q.includes('sys_userISEMPTY^parentISEMPTY^relationshipISEMPTY');
                    return response(match ? [list!, ...(state.extraList ? [{ ...list!, sys_id: OTHER, sys_created_on: '2099-01-02 00:00:00' }] : [])] : [], f);
                }
                case 'sys_update_set': return response([{ sys_id: id!, name: 'SK-5', application: id === SET ? state.setApplication : OTHER, state: state.setState }], f);
                case 'sys_user': return response([{ sys_id: USER, sys_domain: state.userDomain }], f);
                case 'sys_user_preference': state.prefReads = (state.prefReads ?? 0) + 1;
                    return response([{ sys_id: '9'.repeat(32), user: USER, name: `updateSetForScope${APP}`, value: state.current },
                    ...(state.prefsChange && state.prefReads > 1 ? [{ sys_id: '7'.repeat(32), user: USER, name: 'apps.current_app', value: OTHER }] : []),
                    { sys_id: '8'.repeat(32), user: USER, name: 'sys_update_set', value: state.current }], f);
                case 'sys_ui_list_element': return response(elements.filter(e => q.startsWith(`list_id=${e.list_id}^`)), f);
                case 'sys_update_xml': return response(id ? captures.filter(c => c.sys_id === id) : captures.filter(c => q.startsWith(`name=${c.name}^`)), f);
                case 'sys_update_version': return response([{ sys_id: XML, name: NAME }], f);
                default: throw new Error(`unexpected ${table}`);
            }
        }),
        post: jest.fn(async (r: any) => {
            if (state.refusal) throw state.refusal;
            // The platform deletes the list and inserts a new one.
            if (state.apply) {
                list = { sys_id: SAVED, name: TABLE, view: list?.view ?? state.newView ?? 'Default view', sys_scope: state.savedScope,
                    sys_update_name: state.savedName ?? NAME, sys_policy: '', sys_domain: state.savedDomain ?? 'global', sys_created_on: '2099-01-01 00:00:00' };
                elements = columnsOf(SAVED, r.fields.lcodes_1.split(/(?<!\\),/).map((value: string) => value.replace(/\\,/g, ',')));
            }
            if (!state.noCapture) captures = [{ sys_id: XML, name: NAME, update_set: state.captureSet, application: state.captureApplication,
                action: 'INSERT_OR_UPDATE', sys_updated_on: '2099-01-01 00:00:00', sys_mod_count: '1', replace_on_upgrade: 'false' }];
            if (state.postError) throw new Error('socket hang up');
            return { status: 302, headers: { location: `/slushbucket.do?sysparm_form=list&sysparm_list=${TABLE}` }, data: '' };
        }),
    };
    getRow = req.get.getMockImplementation()!;
    jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(req as any);
    writer = new ListLayoutWriter(new ServiceNowInstance({ alias: 'unit-test' }));
});
afterEach(() => jest.restoreAllMocks());

const NEW = ['name', 'active', 'owner.email', 'type'];
const options = (extra: object = {}) => ({ columns: NEW, scope: { sysId: APP }, updateSet: SET, ...extra });

describe('ListLayoutWriter', () => {
    it('reads a list by table and view', async () => {
        await expect(writer.getListLayout(TABLE)).resolves.toEqual({ table: TABLE, view: '', exists: true, sysId: LIST, scope: APP, updateName: NAME,
            columns: ['name', 'type', 'owner.email'] });
    });
    it('reports a table with no list of its own', async () => {
        list = undefined;
        await expect(writer.getListLayout(TABLE)).resolves.toEqual({ table: TABLE, view: '', exists: false, columns: [] });
    });
    it('posts the page save under the list scope and verifies the recreated list and its capture', async () => {
        const result = await writer.setListLayout(TABLE, options());
        expect(result).toMatchObject({ table: TABLE, view: '', sysId: SAVED, previousSysId: LIST, created: false, columns: NEW, previousColumns: ['name', 'type', 'owner.email'],
            capture: { updateSetSysId: SET, updateName: NAME, recordScope: APP, action: 'INSERT_OR_UPDATE', preferencesUnchanged: true } });
        const load = req.get.mock.calls.find(([r]) => r.path === '/slushbucket.do')![0];
        expect(load.query).toEqual({ sysparm_form: 'list', sysparm_list: TABLE, sysparm_view: '', sysparm_transaction_scope: APP });
        expect(req.post.mock.calls[0][0]).toMatchObject({ path: '/slushbucket.do', redirect: 'manual', sensitive: true, fields: {
            sysparm_ck: 'page-token', sys_action: 'sysverb_save', sys_target: TABLE, sysparm_list: TABLE, sysparm_form: 'list',
            sysparm_transaction_scope: APP, sysparm_collection: '', lcodes_1: NEW.join(','), lcodes_2: '', lcodes_0: 'url,a\\,b' } });
        expect(req.post).toHaveBeenCalledTimes(1);
    });
    it('creates a list for a table that has none and verifies it', async () => {
        list = undefined;
        const result = await writer.setListLayout(TABLE, options());
        expect(result).toMatchObject({ created: true, sysId: SAVED, previousColumns: [], columns: NEW, capture: { updateName: NAME, updateSetSysId: SET } });
        expect(result).not.toHaveProperty('previousSysId');
    });
    it('opens a non-default view by its name', async () => {
        list = { ...list!, view: VIEW };
        await writer.setListLayout(TABLE, options({ view: 'sow' }));
        const load = req.get.mock.calls.find(([r]) => r.path === '/slushbucket.do')![0];
        expect(load.query.sysparm_view).toBe('sow');
        expect(req.post.mock.calls[0][0].fields.sysparm_view).toBe('sow');
    });
    it('requires the Store opt-in and reports the upgrade evidence with it', async () => {
        state.store = true;
        await expect(writer.setListLayout(TABLE, options())).rejects.toMatchObject({ code: 'store_scope' });
        expect(req.post).not.toHaveBeenCalled();
        const result = await writer.setListLayout(TABLE, options({ storeCustomization: { acknowledgeUpgradeSkip: true } }));
        expect(result.capture.customization).toEqual({ storeApplication: true, replaceOnUpgrade: false, baselineVersion: true });
    });
    it.each([
        ['scope_mismatch', () => { list!.sys_scope = OTHER; }],
        ['protected_record', () => { state.store = true; list!.sys_policy = 'protected'; }],
        // A vendor lock refuses in any application, not only a Store one.
        ['protected_record', () => { list!.sys_policy = 'read'; }],
        ['domain_not_supported', () => { list!.sys_domain = OTHER; }],
        ['domain_not_supported', () => { state.userDomain = OTHER; }],
        ['scope_not_applied', () => { state.relationship = '1'.repeat(32); }],
        ['session_changed', () => { state.prefsChange = true; }],
        ['invalid_input', () => { state.setApplication = OTHER; }],
        ['invalid_input', () => { state.setState = 'complete'; }],
        ['update_set_not_current', () => { state.current = OTHER; }],
        ['scope_not_applied', () => { state.pageScope = OTHER; }],
        ['scope_not_applied', () => { state.pageTable = 'other_table'; }],
        ['scope_not_applied', () => { state.collection = 'incident'; }],
        ['not_permitted', () => { state.noSave = true; }],
        ['form_redirected', () => { state.redirect = true; }],
        // The page is not showing the list that was read: a save would rewrite something else.
        ['evidence_unavailable', () => { state.pageSelected = ['name', 'type']; }],
        ['evidence_unavailable', () => { state.extraList = true; }],
    ])('refuses %s before the POST', async (code, setup) => {
        setup();
        await expect(writer.setListLayout(TABLE, options({ storeCustomization: { acknowledgeUpgradeSkip: true } }))).rejects.toMatchObject({ code });
        expect(req.post).not.toHaveBeenCalled();
    });
    it('refuses a view that does not exist', async () => {
        await expect(writer.setListLayout(TABLE, options({ view: 'nosuchview' }))).rejects.toMatchObject({ code: 'invalid_input' });
        expect(req.post).not.toHaveBeenCalled();
    });
    it.each([
        [['name', 'name'], 'invalid_input'],
        [[], 'invalid_input'],
        [['absent'], 'field_not_supported'],
        [['.split'], 'field_not_supported'],
        [['name; drop'], 'field_not_supported'],
    ])('refuses columns %o', async (columns, code) => {
        await expect(writer.setListLayout(TABLE, options({ columns }))).rejects.toMatchObject({ code });
        expect(req.post).not.toHaveBeenCalled();
    });
    it('names a refused column, dot-walked ones included', async () => {
        await expect(writer.setListLayout(TABLE, options({ columns: ['absent'] }))).rejects.toMatchObject({ detail: { field: 'absent' } });
        await expect(writer.setListLayout(TABLE, options({ columns: ['manager.email'] }))).rejects.toMatchObject({ code: 'field_not_supported', detail: { field: 'manager.email' } });
    });
    it('names every list when the save leaves two, and points at the newest', async () => {
        const post = req.post.getMockImplementation()!;
        req.post.mockImplementationOnce(async (r: any) => { const result = await post(r); state.extraList = true; return result; });
        await expect(writer.setListLayout(TABLE, options())).rejects.toMatchObject({ code: 'verification_unavailable', sysId: OTHER,
            messages: [`sys_ui_list rows for ${TABLE} after the save: ${SAVED}, ${OTHER}`], writeAttempted: true });
    });
    it('does not report success when the POST throws, even if the write applied', async () => {
        state.postError = true;
        await expect(writer.setListLayout(TABLE, options())).rejects.toMatchObject({ code: 'verification_unavailable', sysId: SAVED, writeAttempted: true });
    });
    it('reports the redirect target of a page that does not load', async () => {
        state.redirect = true;
        await expect(writer.setListLayout(TABLE, options())).rejects.toMatchObject({ code: 'form_redirected', detail: { redirectPath: '/login.do' } });
    });
    it('does not attribute two changed captures to one save', async () => {
        const post = req.post.getMockImplementation()!;
        req.post.mockImplementationOnce(async (r: any) => {
            const result = await post(r);
            captures.push({ ...captures[0], sys_id: '4'.repeat(32) });
            return result;
        });
        await expect(writer.setListLayout(TABLE, options())).rejects.toMatchObject({ code: 'verification_unavailable', writeAttempted: true });
    });
    it.each([
        ['write_not_applied', () => { state.apply = false; }],
        ['not_captured', () => { state.noCapture = true; }],
        ['captured_elsewhere', () => { state.captureSet = OTHER; }],
        ['mixed_scope_capture', () => { state.captureApplication = 'global'; }],
        ['scope_not_applied', () => { state.savedScope = 'global'; }],
        ['not_captured', () => { state.savedName = 'sys_ui_list_other_null'; }],
        ['scope_not_applied', () => { state.savedDomain = OTHER; }],
    ])('reports %s after the POST', async (code, setup) => {
        setup();
        await expect(writer.setListLayout(TABLE, options())).rejects.toMatchObject({ name: 'MetadataVerificationError', code, writeAttempted: true });
        expect(req.post).toHaveBeenCalledTimes(1);
    });
    it('reports a list that is gone after the save', async () => {
        req.post.mockImplementationOnce(async () => { list = undefined; return { status: 302, headers: {}, data: '' }; });
        await expect(writer.setListLayout(TABLE, options())).rejects.toMatchObject({ code: 'write_not_applied', sysId: LIST });
    });
    it('refuses a page value it cannot encode the way the page does, before the POST', async () => {
        const original = page;
        req.get.mockImplementation(async (r: any) => r.path === '/slushbucket.do'
            ? { status: 200, data: original().replace('<option value="active">', '<option value="ac\\tive">') }
            : (await getRow(r)));
        await expect(writer.setListLayout(TABLE, options({ columns: ['name', 'type'] }))).rejects.toMatchObject({ code: 'evidence_unavailable' });
        expect(req.post).not.toHaveBeenCalled();
    });
    it('keeps a policy refusal intact', async () => {
        state.refusal = policyRefusal({ allowed: false, verbs: ['write'], decidingLayer: 'default' } as any);
        await expect(writer.setListLayout(TABLE, options())).rejects.toBe(state.refusal);
    });
    it('rejects bad tables, views and sets without requests', async () => {
        await expect(writer.setListLayout('bad^table', options())).rejects.toBeInstanceOf(MetadataScopeError);
        await expect(writer.setListLayout(TABLE, options({ view: 'a^b' }))).rejects.toBeInstanceOf(MetadataScopeError);
        await expect(writer.setListLayout(TABLE, options({ updateSet: 'nope' }))).rejects.toBeInstanceOf(MetadataScopeError);
        await expect(writer.getListLayout('bad^table')).rejects.toBeInstanceOf(MetadataScopeError);
        expect(req.get).not.toHaveBeenCalled();
    });
});
