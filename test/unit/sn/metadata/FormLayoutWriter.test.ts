import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FormLayoutWriter } from '../../../../src/sn/metadata/FormLayoutWriter';
import { MetadataScopeError } from '../../../../src/sn/metadata/MetadataScopeError';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { policyRefusal } from '../../../../src/policy/PolicyRefusal';

const APP = 'a'.repeat(32), SECTION = 'b'.repeat(32), SET = 'c'.repeat(32), OTHER = 'd'.repeat(32), USER = 'e'.repeat(32);
const FORMATTER = 'f'.repeat(32), SECTION2 = '1'.repeat(32), XML = '2'.repeat(32);
type Row = Record<string, string>;
let state: any;
let elements: Row[];
let captures: Row[];
let req: { get: jest.Mock<any>; post: jest.Mock<any> };
let writer: FormLayoutWriter;

const response = (rows: Row[], fields: string) => {
    const picked = rows.map(row => Object.fromEntries(fields.split(',').map(field => [field, row[field] ?? ''])));
    return { status: 200, headers: { 'x-total-count': String(picked.length) }, bodyObject: { result: picked } };
};
const layout = (values: string[]) => {
    elements = values.map((value, position) => value.startsWith('.formatter.')
        ? { sys_id: `${position}`.padStart(32, '0'), element: 'process_flow.xml', type: 'formatter', sys_ui_formatter: value.slice(11), position: String(position) }
        : { sys_id: `${position}`.padStart(32, '0'), element: value, type: value.startsWith('.') ? value : '', sys_ui_formatter: '', position: String(position) });
};
const page = () => `<html><form name="other"><input type="hidden" name="sysparm_ck" value="wrong"></form>
<FORM name="editPage" action="slushbucket.do" method="post">
<input name="sysparm_ck" id="sysparm_ck" type="hidden" value="page-token">
<input type="HIDDEN" id="sys_target" name="sys_target" value="${SECTION}"><input type="HIDDEN" name="sys_target">
<input type="HIDDEN" name="sysparm_referring_url" value="sn_compliance_policy.do?sys_id=-1">
<input type="HIDDEN" id="sysparm_record_scope" name="sysparm_record_scope" value="">
<input type="hidden" name="sysparm_transaction_scope" value="${state.pageScope}">
<select name="select_0" multiple><option value="url">URL</option><option value="active">Active</option><option value="a,b">Odd</option></select>
<select name="select_1" multiple><option value=".formatter.${FORMATTER}">Process Flow</option><option value="name">Name</option><option value=".begin_split">s</option><option value="type">Type</option><option value=".end_split">e</option></select>
${state.noSave ? '' : '<button type="submit" id="sysverb_save" name="saveButton">Save</button>'}
</FORM></html>`;

beforeEach(() => {
    state = { pageScope: APP, sectionScope: APP, store: false, policy: '', setApplication: APP, setState: 'in progress',
        current: SET, captureSet: SET, captureApplication: APP, apply: true };
    layout([`.formatter.${FORMATTER}`, 'name', '.begin_split', 'type', '.end_split']);
    captures = [];
    req = {
        get: jest.fn(async (r: any) => {
            if (r.path === '/slushbucket.do') return state.redirect ? { status: 302, headers: { location: '/login.do' }, data: '' } : { status: 200, data: page() };
            if (r.path === '/xmlhttp.do') return { status: 200, data: `<xml><Sections><choice value="${SECTION}"/><choice value="${SECTION2}"/></Sections></xml>` };
            const table = r.path.split('/').at(-1), q: string = r.query.sysparm_query, f: string = r.query.sysparm_fields;
            const id = q.match(/^sys_id=([^^]+)/)?.[1];
            switch (table) {
                case 'sys_scope': return response([{ sys_id: APP, scope: 'sn_compliance', active: 'true', sys_class_name: state.store ? 'sys_store_app' : 'sys_app' }], f);
                case 'sys_store_app': return response([], f);
                case 'sys_ui_section': return response([{ sys_id: SECTION, name: 'sn_compliance_policy', view: 'Default view', caption: '', sys_scope: state.sectionScope, sys_policy: state.policy }], f);
                case 'sys_update_set': return response([{ sys_id: id!, name: 'NSE-15', application: id === SET ? state.setApplication : OTHER, state: state.setState }], f);
                case 'sys_user': return response([{ sys_id: USER }], f);
                case 'sys_user_preference': return response([{ sys_id: '9'.repeat(32), user: USER, name: `updateSetForScope${APP}`, value: state.current },
                    { sys_id: '8'.repeat(32), user: USER, name: 'sys_update_set', value: state.current }], f);
                case 'sys_ui_element': return response(elements, f);
                case 'sys_update_xml': return response(id ? captures.filter(c => c.sys_id === id) : captures, f);
                case 'sys_update_version': return response([{ sys_id: XML, name: `sys_ui_section_${SECTION}` }], f);
                default: throw new Error(`unexpected ${table}`);
            }
        }),
        post: jest.fn(async (r: any) => {
            if (state.refusal) throw state.refusal;
            if (state.apply) layout(r.fields.lcodes_1.split(/(?<!\\),/).map((value: string) => value.replace(/\\,/g, ',')));
            if (!state.noCapture) captures = [{ sys_id: XML, name: `sys_ui_section_${SECTION}`, update_set: state.captureSet, application: state.captureApplication,
                action: 'INSERT_OR_UPDATE', sys_updated_on: '2099-01-01 00:00:00', sys_mod_count: '1', replace_on_upgrade: 'false' }];
            return { status: 302, headers: { location: '/sn_compliance_policy.do' }, data: '' };
        }),
    };
    jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(req as any);
    writer = new FormLayoutWriter(new ServiceNowInstance({ alias: 'unit-test' }));
});
afterEach(() => jest.restoreAllMocks());

const NEW = [`.formatter.${FORMATTER}`, 'name', '.begin_split', 'type', '.split', 'url', '.end_split'];
const options = (extra: object = {}) => ({ elements: NEW, scope: { sysId: APP }, updateSet: SET, ...extra });

describe('FormLayoutWriter', () => {
    it('reads a section layout in the page value grammar', async () => {
        await expect(writer.getFormLayout(SECTION)).resolves.toEqual({ section: SECTION, table: 'sn_compliance_policy', view: '', caption: '',
            scope: APP, elements: [`.formatter.${FORMATTER}`, 'name', '.begin_split', 'type', '.end_split'] });
    });
    it('posts the page save under the section scope and verifies layout and capture', async () => {
        const result = await writer.setFormLayout(SECTION, options());
        expect(result).toMatchObject({ section: SECTION, view: '', elements: NEW,
            previousElements: [`.formatter.${FORMATTER}`, 'name', '.begin_split', 'type', '.end_split'],
            capture: { updateSetSysId: SET, updateName: `sys_ui_section_${SECTION}`, recordScope: APP, preferencesUnchanged: true } });
        const load = req.get.mock.calls.find(([r]) => r.path === '/slushbucket.do')![0];
        expect(load.query).toEqual({ sysparm_form: 'section', sysparm_list: SECTION, sysparm_view: '', sysparm_transaction_scope: APP });
        const post = req.post.mock.calls[0][0];
        expect(post).toMatchObject({ path: '/slushbucket.do', redirect: 'manual', sensitive: true, fields: {
            sysparm_ck: 'page-token', sys_action: 'sysverb_save', sys_target: SECTION, sysparm_transaction_scope: APP,
            lcodes_1: NEW.join(','), lcodes_2: `${SECTION},${SECTION2},.new`, lcodes_0: 'active,a\\,b' } });
        expect(req.post).toHaveBeenCalledTimes(1);
    });
    it('requires the Store opt-in and reports the upgrade evidence with it', async () => {
        state.store = true;
        await expect(writer.setFormLayout(SECTION, options())).rejects.toMatchObject({ code: 'store_scope' });
        const result = await writer.setFormLayout(SECTION, options({ storeCustomization: { acknowledgeUpgradeSkip: true } }));
        expect(result.capture.customization).toEqual({ storeApplication: true, replaceOnUpgrade: false, baselineVersion: true });
    });
    it.each([
        ['scope_mismatch', () => { state.sectionScope = OTHER; }],
        ['protected_record', () => { state.store = true; state.policy = 'protected'; }],
        ['invalid_input', () => { state.setApplication = OTHER; }],
        ['invalid_input', () => { state.setState = 'complete'; }],
        ['update_set_not_current', () => { state.current = OTHER; }],
        ['scope_not_applied', () => { state.pageScope = OTHER; }],
        ['not_permitted', () => { state.noSave = true; }],
        ['form_redirected', () => { state.redirect = true; }],
    ])('refuses %s before the POST', async (code, setup) => {
        setup();
        await expect(writer.setFormLayout(SECTION, options({ storeCustomization: { acknowledgeUpgradeSkip: true } }))).rejects.toMatchObject({ code });
        expect(req.post).not.toHaveBeenCalled();
    });
    it.each([
        [['name', 'name'], 'invalid_input'],
        [[], 'invalid_input'],
        [['absent'], 'field_not_supported'],
        [['.annotation.x.y'], 'field_not_supported'],
        [['name; drop'], 'field_not_supported'],
    ])('refuses elements %o', async (elements, code) => {
        await expect(writer.setFormLayout(SECTION, options({ elements }))).rejects.toMatchObject({ code });
        expect(req.post).not.toHaveBeenCalled();
    });
    it('names a refused field', async () => {
        await expect(writer.setFormLayout(SECTION, options({ elements: ['absent'] }))).rejects.toMatchObject({ detail: { field: 'absent' } });
    });
    it.each([
        ['write_not_applied', () => { state.apply = false; }],
        ['not_captured', () => { state.noCapture = true; }],
        ['captured_elsewhere', () => { state.captureSet = OTHER; }],
        ['mixed_scope_capture', () => { state.captureApplication = 'global'; }],
    ])('reports %s after the POST', async (code, setup) => {
        setup();
        await expect(writer.setFormLayout(SECTION, options())).rejects.toMatchObject({ name: 'MetadataVerificationError', code, sysId: SECTION, writeAttempted: true });
        expect(req.post).toHaveBeenCalledTimes(1);
    });
    it('keeps a policy refusal intact', async () => {
        state.refusal = policyRefusal({ allowed: false, verbs: ['write'], decidingLayer: 'default' } as any);
        await expect(writer.setFormLayout(SECTION, options())).rejects.toBe(state.refusal);
    });
    it('rejects bad ids without requests', async () => {
        await expect(writer.setFormLayout('nope', options())).rejects.toBeInstanceOf(MetadataScopeError);
        await expect(writer.setFormLayout(SECTION, options({ updateSet: 'nope' }))).rejects.toBeInstanceOf(MetadataScopeError);
        expect(req.get).not.toHaveBeenCalled();
    });
});
