import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { MetadataFormWriter } from '../../../../src/sn/metadata/MetadataFormWriter';
import { MetadataScopeError } from '../../../../src/sn/metadata/MetadataScopeError';
import { MetadataVerificationError } from '../../../../src/sn/metadata/MetadataVerificationError';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { policyRefusal } from '../../../../src/policy/PolicyRefusal';

const S = 'a'.repeat(32), R = 'b'.repeat(32), SET = 'c'.repeat(32), OTHER = 'd'.repeat(32), U = 'e'.repeat(32), A = 'f'.repeat(32);
const TABLE = 'sys_script_include';
const response = (result: unknown) => ({ status: 200, headers:{'x-total-count':String(Array.isArray(result)?result.length:0)}, bodyObject: { result }, data: { result } });
let writer: MetadataFormWriter;
let req: { get: jest.Mock<any>; post: jest.Mock<any>; getUserSession: jest.Mock<any> };
let state: any;
let prefs: Array<any>;
let stored: any;
let captured: boolean;
let deleted: boolean;
function form(table = TABLE, id = '-1') {
    return `<form><input name="sys_target" value="${table}"><input name="sys_uniqueValue" value="${id === '-1' ? R : id}">
<input name="sys_row" value="${id === '-1' ? '-1' : '0'}"><input name="sysparm_encoded_record" value="signed-state">
<input name="sysparm_transaction_scope" value="${state.formScope}"><input name="${table}.sys_scope" value="${state.formScope}">
<input name="sysparm_ck" value="page-sentinel"><input name="sysparm_ck" id="duplicate" value="page-sentinel">
<input name="sys_original.name" value="original"><input name="${table}.name" value="old">
<textarea name="${table}.script">old</textarea><input name="${table}.active" value="false">
<textarea name="${table}.inputs.var__m_${A}.script"></textarea>
${state.missingAction ? '' : `<button data-action-name="sysverb_insert_and_stay" gsft_id="${A}"></button><button data-action-name="sysverb_update" gsft_id="${A}"></button><button data-action-name="sysverb_delete" gsft_id="${A}"></button>`}</form>`;
}
beforeEach(() => {
    state = { formScope: S, recordScope: S, scopeRows: [{ sys_id: S, scope: 'x_test', active: 'true',sys_class_name:'sys_app' }],
        ancestry: 'sys_metadata', captureSet: SET, captureScope: S, setScope: S, actionTable: 'global',
        onclick: 'confirmAndDeleteFromForm();', captureMod:0, missingAction: false, stale: false, mutate: undefined };
    stored = { sys_id: R, sys_scope: S }; captured = false; deleted = false;
    prefs = [{ sys_id: '1'.repeat(32), user: U, name: `updateSetForScope${S}`, value: SET },
        { sys_id: '2'.repeat(32), user: U, name: 'sys_update_set', value: OTHER },
        { sys_id: '3'.repeat(32), user: U, name: 'apps.current_app', value: 'global' }];
    req = { get: jest.fn(async (r: any) => {
        if (r.path.endsWith('.do')) return { status: 200, data: form(r.path.slice(1,-3), r.query?.sys_id ?? R) };
        const t = r.path.split('/').at(-1), q = r.query.sysparm_query;
        if (t === 'sys_scope') return response(state.scopeRows);
        if (t === 'sys_store_app') return response(state.store ? [{ sys_id: S, scope: 'x_test' }] : []);
        if (t === 'sys_db_object') {
            if (q.startsWith('name=')) return response([{ sys_id: '4'.repeat(32), name: q.split('=')[1].split('^')[0], super_class: '5'.repeat(32) }]);
            return response([{ sys_id: '5'.repeat(32), name: state.ancestry, super_class: state.cycle ? '5'.repeat(32) : '' }]);
        }
        if (t === 'sys_user') return response([{ sys_id: U }]);
        if (t === 'sys_user_preference') return response(state.incompletePreferences && captured ? [...prefs,prefs[0]] : prefs.map(x => ({...x})));
        if (t === 'sys_update_set') {
            const id = q.slice(7).split('^')[0];
            return response([{ sys_id: id, name: 'Test set', application: state.setScope, state: 'in progress' }]);
        }
        if (t === 'sys_ui_action') return response([{ sys_id: A, table: state.actionTable, action_name: 'sysverb_delete', onclick: state.onclick, name: 'Delete' }]);
        if (t === 'sys_update_xml') return response(captured && !state.noCapture ? [{ sys_id: A, name: `${TABLE}_${R}`,
            update_set: state.captureSet, application: state.captureScope, action: deleted ? 'DELETE' : 'INSERT_OR_UPDATE',
            sys_mod_count:String(state.captureMod), sys_updated_on: state.stale ? '2000-01-01 00:00:00' : '2099-01-01 00:00:00' }] : []);
        if (t === 'sys_metadata_delete') return response(deleted && !state.noDeleteEvidence ? [{ sys_id: A, sys_metadata: R, sys_scope: S, sys_created_on: '2099-01-01 00:00:00' }] : []);
        return response(stored ? [{...stored, sys_scope: state.recordScope}] : []);
    }), post: jest.fn(async (r: any) => {
        if (state.refusal) throw state.refusal;
        if (state.postError) throw new Error('private-script-sentinel');
        captured = true; if (!state.noCaptureChange) state.captureMod++;
        deleted = r.fields.sys_action === 'sysverb_delete';
        stored = deleted || state.notSaved ? undefined : { sys_id: R, sys_scope: S };
        if (state.mutate) state.mutate();
        return { status: 302, headers: { location: `/${TABLE}.do?sys_id=${R}` }, data: '' };
    }), getUserSession: jest.fn(async () => ({ userToken: 'session-sentinel', instanceUrl: 'https://example.service-now.com' })) };
    jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(req as any);
    writer = new MetadataFormWriter(new ServiceNowInstance({ alias: 'unit-test' }));
});
afterEach(() => jest.restoreAllMocks());
const options = () => ({ scope: { sysId: S }, fields: { name: 'private-name-sentinel', script: 'private-script-sentinel', active: false } });
describe('MetadataFormWriter', () => {
    it('reuses the form seam and verifies scoped insert, variables and wire ownership', async () => {
        const result = await writer.insert(TABLE, { ...options(), variables: { script: 'variable-script' } });
        expect(result).toMatchObject({ table: TABLE, sysId: R, action: 'insert', scope: { sysId: S },
            capture: { updateSetSysId: SET, predictedUpdateSetSysId: SET, recordScope: S, preferencesUnchanged: true } });
        const get = req.get.mock.calls.find(([r]) => r.path === `/${TABLE}.do`)[0];
        expect(get.query).toMatchObject({ sysparm_transaction_scope: S, sysparm_isdevstudio: 'true' });
        expect(get.query.sysparm_nameofstack).toMatch(/^[0-9a-f-]{36}_bottomless$/);
        const post = req.post.mock.calls[0][0];
        expect(post).toMatchObject({ sensitive: true, redirect: 'manual', fields: { sys_action: 'sysverb_insert_and_stay',
            sysparm_transaction_scope: S, sysparm_goto_url: '', sysparm_ck: 'page-sentinel', 'sys_original.name': 'original',
            [`${TABLE}.name`]: 'private-name-sentinel', [`${TABLE}.inputs.var__m_${A}.script`]: 'variable-script' } });
        expect(req.post).toHaveBeenCalledTimes(1);
        expect(req.get.mock.calls.every(([r]) => r.path.startsWith('/api/now/table/') || r.path === `/${TABLE}.do`)).toBe(true);
    });
    it('uses the offered update value and the name for protected delete', async () => {
        await writer.update(TABLE, R, options());
        expect(req.post.mock.calls[0][0].fields.sys_action).toBe(A);
        await writer.delete(TABLE, R, { scope: { sysId: S }, confirm: { table: TABLE, sysId: R } });
        expect(req.post.mock.calls[1][0].fields.sys_action).toBe('sysverb_delete');
    });
    it('sends and verifies an explicit update set instead of the prediction', async () => {
        state.captureSet = OTHER;
        const result = await writer.insert(TABLE, { ...options(), updateSet: OTHER });
        expect(req.post.mock.calls[0][0].fields.sysparm_transaction_update_set).toBe(OTHER);
        expect(result.capture.updateSetSysId).toBe(OTHER);
    });
    it.each(['missing', 'unknown', 'ambiguous', 'store'])('refuses %s scope before loading a form', async mode => {
        if (mode === 'unknown') state.scopeRows = [];
        if (mode === 'ambiguous') state.scopeRows.push({...state.scopeRows[0],sys_id:OTHER});
        if (mode === 'store') state.store = true;
        await expect(writer.insert(TABLE, mode === 'missing' ? {} as any : mode === 'ambiguous' ? {...options(),scope:{scope:'x_test'}} : options())).rejects.toMatchObject({code:{missing:'scope_required',unknown:'scope_unknown',ambiguous:'scope_ambiguous',store:'store_scope'}[mode]});
        expect(req.post).not.toHaveBeenCalled();
        expect(req.get.mock.calls.some(([r]) => r.path.endsWith('.do'))).toBe(false);
    });
    it.each(['sys_update_set','sys_update_xml','sys_scope','sys_app','sys_store_app','sys_db_object','sys_dictionary','sys_security_acl','sys_user_role'])('denies %s', async table => {
        await expect(writer.insert(table, options())).rejects.toMatchObject({code:'table_not_supported'});
        expect(req.post).not.toHaveBeenCalled();
    });
    it.each(['incident', 'sys_security_acl'])('refuses unsupported ancestry %s', async ancestry => {
        state.ancestry = ancestry;
        await expect(writer.insert(TABLE, options())).rejects.toMatchObject({code:'table_not_supported'});
    });
    it('refuses ancestry cycles', async () => {
        state.ancestry = 'extension'; state.cycle = true;
        await expect(writer.insert(TABLE, options())).rejects.toMatchObject({code:'table_not_supported'});
    });
    it.each(['update','delete'])('refuses wrong existing scope for %s before form load', async operation => {
        state.recordScope = 'global';
        await expect(operation === 'update' ? writer.update(TABLE,R,options()) : writer.delete(TABLE,R,{scope:{sysId:S},confirm:{table:TABLE,sysId:R}}))
            .rejects.toMatchObject({code:'scope_mismatch'});
        expect(req.post).not.toHaveBeenCalled();
        expect(req.get.mock.calls.some(([r]) => r.path.endsWith('.do'))).toBe(false);
    });
    it('refuses wrong form scope', async () => {
        state.formScope = 'global';
        await expect(writer.insert(TABLE, options())).rejects.toMatchObject({code:'scope_not_applied'});
        expect(req.post).not.toHaveBeenCalled();
    });
    it.each(['sys_scope', 'sys_id', 'sys_package', 'sys_action', 'absent'])('refuses caller field %s', async field => {
        await expect(writer.insert(TABLE,{...options(),fields:{[field]:'private-script-sentinel'}})).rejects.toMatchObject({code:'field_not_supported'});
        expect(req.post).not.toHaveBeenCalled();
    });
    it('refuses initialQuery system-field overrides', async () => {
        await expect(writer.insert(TABLE,{...options(),initialQuery:'sys_scope=global'})).rejects.toMatchObject({code:'field_not_supported'});
        expect(req.get).not.toHaveBeenCalled();
    });
    it('requires exact delete confirmation without requests', () => {
        expect(() => writer.delete(TABLE,R,{scope:{sysId:S},confirm:{table:TABLE,sysId:OTHER}})).toThrow();
        expect(req.get).not.toHaveBeenCalled();
    });
    it.each(['custom', 'client', 'missing'])('refuses %s delete action', async mode => {
        if (mode === 'custom') state.actionTable = TABLE;
        if (mode === 'client') state.onclick = 'deleteApplicationAndFiles();';
        if (mode === 'missing') state.missingAction = true;
        await expect(writer.delete(TABLE,R,{scope:{sysId:S},confirm:{table:TABLE,sysId:R}})).rejects.toMatchObject({code: mode === 'missing' ? 'not_permitted' : 'delete_not_supported'});
        expect(req.post).not.toHaveBeenCalled();
    });
    it.each(['not_captured','captured_elsewhere','mixed_scope_capture','scope_not_applied','session_changed','write_not_applied'])('reports confirmed submit mismatch %s', async code => {
        if (code === 'not_captured') state.noCapture = true;
        if (code === 'captured_elsewhere') state.captureSet = OTHER;
        if (code === 'mixed_scope_capture') state.captureScope = 'global';
        if (code === 'scope_not_applied') state.recordScope = 'global';
        if (code === 'session_changed') state.mutate = () => prefs[2].value = S;
        if (code === 'write_not_applied') state.notSaved = true;
        await expect(writer.insert(TABLE,options())).rejects.toMatchObject({code,sysId:R});
        expect(req.post).toHaveBeenCalledTimes(1);
    });
    it('rejects a stale capture', async () => {
        state.stale = true;
        await expect(writer.insert(TABLE,options())).rejects.toMatchObject({code:'not_captured'});
    });
    it('requires metadata-delete evidence after absence', async () => {
        state.noDeleteEvidence = true;
        await expect(writer.delete(TABLE,R,{scope:{sysId:S},confirm:{table:TABLE,sysId:R}})).rejects.toMatchObject({code:'delete_not_captured'});
        expect(req.post).toHaveBeenCalledTimes(1);
    });
    it('reports only the approved current-set movement and same-value row replacements', async () => {
        state.mutate = () => { prefs[1].value = SET; prefs[2].sys_id = OTHER; };
        const {capture} = await writer.insert(TABLE,options());
        expect(capture).toMatchObject({ preferencesUnchanged:false, preferenceRowsReplaced:['apps.current_app'],
            currentUpdateSet:{before:OTHER,after:SET,switched:true} });
    });
    it('fails a current-set movement to an unrelated destination', async () => {
        state.mutate = () => prefs[1].value = A;
        await expect(writer.insert(TABLE,options())).rejects.toMatchObject({code:'session_changed'});
    });
    it('preserves duplicate preference multiplicity', async () => {
        prefs.push({...prefs[2],sys_id:A});
        state.mutate = () => prefs.pop();
        await expect(writer.insert(TABLE,options())).rejects.toMatchObject({code:'session_changed'});
    });
    it('preserves policy refusal identity without replay', async () => {
        state.refusal = policyRefusal({allowed:false,verbs:['write'],decidingLayer:'default'} as any);
        await expect(writer.insert(TABLE,options())).rejects.toBe(state.refusal);
        expect(req.post).toHaveBeenCalledTimes(1);
    });
    it('keeps arbitrary transport errors and field values out of the public error', async () => {
        state.postError = true;
        let failure: unknown;
        try { await writer.insert(TABLE,options()); } catch(error) { failure = error; }
        expect(failure).toBeInstanceOf(MetadataVerificationError);
        expect(String(failure)).not.toContain('private-script-sentinel');
        expect(req.post).toHaveBeenCalledTimes(1);
    });
    it('resolves scope names and explicit global without a default', async () => {
        await expect(writer.insert(TABLE,{...options(),scope:{scope:'x_test'}})).resolves.toMatchObject({scope:{sysId:S,scope:'x_test'}});
        state.scopeRows=[{sys_id:'global',scope:'global',active:'true',sys_class_name:'sys_scope'}];state.formScope='global';state.recordScope='global';state.captureScope='global';state.setScope='global';
        await expect(writer.insert(TABLE,{...options(),scope:'global'})).resolves.toMatchObject({scope:{sysId:'global',scope:'global'}});
    });
    it('marks incomplete post-submit evidence as verification failure with the ledger ID', async () => {
        state.incompletePreferences=true;
        await expect(writer.insert(TABLE,options())).rejects.toMatchObject({name:'MetadataVerificationError',code:'verification_unavailable',sysId:R,writeAttempted:true});
        expect(req.post).toHaveBeenCalledTimes(1);
    });
    it('refuses a missing update action before POST', async () => {
        state.missingAction=true;
        await expect(writer.update(TABLE,R,options())).rejects.toMatchObject({code:'not_permitted'});
        expect(req.post).not.toHaveBeenCalled();
    });
    it.each(['sys_documentation','sys_package','sys_app_module'])('denies destructive metadata table %s', async table => {
        await expect(writer.delete(table,R,{scope:{sysId:S},confirm:{table,sysId:R}})).rejects.toMatchObject({code:'table_not_supported'});
        expect(req.post).not.toHaveBeenCalled();
    });
    it('permits explicit mixed-scope reporting without disabling the expected set check', async () => {
        state.captureScope='global';state.setScope='global';
        await expect(writer.insert(TABLE,{...options(),allowMixedScopeCapture:true})).resolves.toMatchObject({capture:{updateSetScope:'global'}});
    });

    it('allows either the predicted or explicit set movement while still checking the explicit capture', async () => {
        state.captureSet=OTHER;state.mutate=()=>prefs[1].value=SET;
        await expect(writer.insert(TABLE,{...options(),updateSet:OTHER})).resolves.toMatchObject({capture:{updateSetSysId:OTHER,currentUpdateSet:{after:SET,switched:true}}});
    });
    it('refuses a Store class even if the Store table read would hide it', async () => {
        state.scopeRows[0].sys_class_name='sys_store_app';
        await expect(writer.insert(TABLE,options())).rejects.toMatchObject({code:'store_scope'});
        expect(req.post).not.toHaveBeenCalled();
    });
    it('refuses unknown variables before POST with a safe typed error', async () => {
        await expect(writer.insert(TABLE,{...options(),variables:{absent:'private-script-sentinel'}})).rejects.toMatchObject({code:'field_not_supported'});
        expect(req.post).not.toHaveBeenCalled();
    });

    it('rejects an unchanged capture even when its timestamp is in the measured second', async () => {
        captured=true;state.noCaptureChange=true;
        await expect(writer.update(TABLE,R,options())).rejects.toMatchObject({code:'not_captured'});
        expect(req.post).toHaveBeenCalledTimes(1);
    });

});
