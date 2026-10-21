import { SessionManager } from '../../comm/http/SessionManager';
import { isPolicyRefusal } from '../../policy/PolicyRefusal';
import { READ_ONLY } from '../../policy/PolicyTypes';
import { stripSecretsFromError } from '../../util/redact';
import type { ServiceNowInstance } from '../ServiceNowInstance';
import type { CaptureReport, ListLayout, ListLayoutWriteOptions, ListLayoutWriteResult } from './MetadataModels';
import { MetadataScopeError } from './MetadataScopeError';
import { MetadataVerificationError } from './MetadataVerificationError';
import { MetadataReader, type MetadataRow } from './internal/MetadataReader';
import { comparePreferences, preferenceValue } from './internal/MetadataPreferences';
import { customizationEvidence, resolveScope } from './internal/MetadataScope';
import { joinLayoutValues, parseSlushbucketPage } from './internal/SlushbucketPage';

const ID = /^[a-f0-9]{32}$/i;
const NAME = /^[a-z0-9_]+$/i;
const COLUMN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i;
const UPDATE_NAME = /^sys_ui_list_[a-z0-9_]+$/i;
const LIST_FIELDS = 'name,view,sys_scope,sys_update_name,sys_policy,sys_domain,sys_created_on';
/** Lists are domain data: only the global domain is handled, where every session reads and writes the same list. */
const GLOBAL_DOMAIN = new Set(['', 'global']);

/**
 * Reads and replaces the columns of a table's list (one view, not a related list, not a user's
 * personalized list) through the classic List Layout page, the path the platform itself uses.
 *
 * A save deletes the list's `sys_ui_list` record and inserts a new one (a new sys_id each time),
 * captured as one `sys_ui_list_<table>_<view>` update. So the list is found by table and view,
 * never by sys_id, and after the save its application, update name and columns are read back.
 * A table with no list of its own shows its parent's; saving then creates its own list.
 *
 * The writer never changes the user's working set. The target update set must already be the
 * user's set for the list's application (see `WorkingSetManager.useUpdateSet`).
 */
export class ListLayoutWriter {
    public constructor(private _instance: ServiceNowInstance) {}

    /** The list's current columns. `exists` is false when the table has no list of its own for the view. */
    public async getListLayout(table: string, view = ''): Promise<ListLayout> {
        if (!NAME.test(table ?? '') || !(view === '' || NAME.test(view ?? ''))) throw new MetadataScopeError('invalid_input');
        const reader = this.reader();
        const list = await findList(reader, table, await viewId(reader, view));
        if (!list) return { table, view, exists: false, columns: [] };
        return { table, view, exists: true, sysId: list.sys_id, scope: list.sys_scope, updateName: list.sys_update_name, columns: await columns(reader, list.sys_id) };
    }

    /** Replace the list's columns with `columns`, in order, and verify the result and its capture. */
    public async setListLayout(table: string, options: ListLayoutWriteOptions): Promise<ListLayoutWriteResult> {
        const view = options?.view ?? '';
        if (!NAME.test(table ?? '') || !(view === '' || NAME.test(view)) || !options?.updateSet || !ID.test(options.updateSet)) {
            throw new MetadataScopeError('invalid_input');
        }
        const wanted = options.columns;
        if (!Array.isArray(wanted) || !wanted.length || wanted.some(value => typeof value !== 'string')) throw new MetadataScopeError('invalid_input');
        for (const value of wanted) if (!COLUMN.test(value)) throw new MetadataScopeError('field_not_supported', { field: value });
        if (new Set(wanted).size !== wanted.length) throw new MetadataScopeError('invalid_input');
        const reader = this.reader();
        let submitted = false;
        let report: Partial<CaptureReport> = {};
        let name = `sys_ui_list_${table}_${view || 'null'}`;
        let savedId = '';
        try {
            const { store, ...scope } = await resolveScope(reader, options.scope);
            if (store && options.storeCustomization?.acknowledgeUpgradeSkip !== true) throw new MetadataScopeError('store_scope');
            const viewSysId = await viewId(reader, view);
            const list = await findList(reader, table, viewSysId);
            if (list) {
                if (list.sys_scope !== scope.sysId) throw new MetadataScopeError('scope_mismatch');
                if (['read', 'protected'].includes(list.sys_policy)) throw new MetadataScopeError('protected_record', { table: 'sys_ui_list' });
                if (!GLOBAL_DOMAIN.has(list.sys_domain)) throw new MetadataScopeError('domain_not_supported');
                if (!UPDATE_NAME.test(list.sys_update_name)) throw new MetadataScopeError('evidence_unavailable');
                name = list.sys_update_name;
            }
            const set = await reader.exact('sys_update_set', options.updateSet, 'application,state');
            if (!set || set.state !== 'in progress' || set.application !== scope.sysId) {
                throw new MetadataScopeError('invalid_input', set ? { updateSetState: set.state, updateSetApplication: set.application } : undefined);
            }
            const users = await reader.rows('sys_user', 'sys_id=javascript:gs.getUserID()', 'sys_id,sys_domain');
            if (users.length !== 1 || !ID.test(users[0].sys_id)) throw new MetadataScopeError('evidence_unavailable');
            // A user in another domain would save a new list in that domain and leave this one as it is.
            if (!GLOBAL_DOMAIN.has(users[0].sys_domain)) throw new MetadataScopeError('domain_not_supported');
            const user = users[0].sys_id;
            const preferences = async (): Promise<MetadataRow[]> => {
                const rows = await reader.rows('sys_user_preference', `user=${user}`, 'sys_id,user,name,value');
                if (rows.some(pref => pref.user !== user)) throw new MetadataScopeError('evidence_unavailable');
                return rows;
            };
            const before = await preferences();
            // The page saves into the user's set for the transaction scope; it takes no set parameter.
            if (preferenceValue(before, `updateSetForScope${scope.sysId}`) !== options.updateSet) throw new MetadataScopeError('update_set_not_current');
            const previous = list ? await columns(reader, list.sys_id) : [];

            const request = SessionManager.getInstance().getRequest(this._instance);
            const page = await request.get<string>({ method: 'GET', path: '/slushbucket.do', headers: null, body: null,
                query: { sysparm_form: 'list', sysparm_list: table, sysparm_view: view, sysparm_transaction_scope: scope.sysId },
                requires: READ_ONLY, responseFormat: 'text', redirect: 'manual', sensitive: true });
            if (page.status !== 200) throw Object.assign(new Error('form_redirect'), { redirectPath: locationPath(page.headers) });
            const form = parseSlushbucketPage(typeof page.data === 'string' ? page.data : '');
            const token = form.inputs.sysparm_ck;
            if (!token) throw new MetadataScopeError('csrf_token_unavailable');
            if (form.inputs.sysparm_transaction_scope !== scope.sysId || form.inputs.sys_target !== table || form.inputs.sysparm_form !== 'list' ||
                form.inputs.sysparm_list !== table || form.inputs.sysparm_collection || form.inputs.sysparm_collection_relationship) {
                throw new MetadataScopeError('scope_not_applied');
            }
            if (!form.canSave) throw new MetadataScopeError('not_permitted');
            // The page must be showing the list read above: otherwise the save would rewrite a different one.
            if (list && JSON.stringify(form.selected) !== JSON.stringify(previous)) throw new MetadataScopeError('evidence_unavailable');
            const offered = new Set([...form.available, ...form.selected]);
            for (const value of wanted) if (!offered.has(value)) throw new MetadataScopeError('field_not_supported', { field: value });
            const chosen = new Set(wanted);
            const available = [...form.available, ...form.selected].filter(value => !chosen.has(value));

            const loaded = await preferences();
            if (!comparePreferences(before, loaded).valid) throw new MetadataVerificationError('session_changed', 'sys_ui_list', list?.sys_id ?? '', undefined, [], false);
            const priorCaptures = await reader.rows('sys_update_xml', `name=${name}`, 'sys_id,name,sys_mod_count');
            if (priorCaptures.some(capture => capture.name !== name || !/^\d+$/.test(capture.sys_mod_count))) throw new MetadataScopeError('evidence_unavailable');
            const versions = new Map(priorCaptures.map(capture => [capture.sys_id, capture.sys_mod_count]));
            const started = new Date().toISOString().slice(0, 19).replace('T', ' ');

            const [lcodes0, lcodes1] = [joinLayoutValues(available), joinLayoutValues(wanted)];
            if (lcodes0 === undefined || lcodes1 === undefined) throw new MetadataScopeError('evidence_unavailable');

            submitted = true;
            let submitFailure: unknown;
            try {
                await request.post<string>({ method: 'POST', path: '/slushbucket.do', headers: null, query: null, body: null,
                    responseFormat: 'text', redirect: 'manual', sensitive: true, fields: {
                        sysparm_ck: token, sys_action: 'sysverb_save', sys_target: table, sysparm_list: table,
                        sysparm_form: 'list', sysparm_view: view, sysparm_collection: '', sysparm_collection_relationship: '',
                        sysparm_referring_url: form.inputs.sysparm_referring_url ?? '', sysparm_redirect_url: '', sysparm_sys_id: '',
                        sysparm_record_scope: form.inputs.sysparm_record_scope ?? '', sysparm_transaction_scope: scope.sysId,
                        lcodes_0: lcodes0, lcodes_1: lcodes1, lcodes_2: '',
                    } });
            } catch (error) {
                if (isPolicyRefusal(error)) throw error;
                submitFailure = error;
            }

            report = { predictedUpdateSetSysId: options.updateSet, updateName: name };
            const fail: (code: ConstructorParameters<typeof MetadataVerificationError>[0], id?: string, messages?: string[]) => never = (code, id, messages) => {
                throw new MetadataVerificationError(code, 'sys_ui_list', id ?? list?.sys_id ?? '', report, messages ?? []);
            };
            // The save replaced the record: find the list again. More than one means the save added a list
            // (another domain, or the old row kept): name every row so the extra one can be removed.
            const lists = await listRows(reader, table, viewSysId);
            if (lists.length > 1) {
                const newest = [...lists].sort((a, b) => b.sys_created_on.localeCompare(a.sys_created_on))[0];
                fail('verification_unavailable', newest.sys_id, [`sys_ui_list rows for ${table} after the save: ${lists.map(row => row.sys_id).join(', ')}`]);
            }
            const saved = lists[0];
            if (!saved) fail('write_not_applied');
            savedId = saved.sys_id;
            report.recordScope = saved.sys_scope;
            const after = await columns(reader, saved.sys_id);
            const observed = await reader.rows('sys_update_xml', `name=${name}^sys_updated_on>=${started}`,
                'sys_id,name,update_set,application,action,sys_updated_on,sys_mod_count');
            const comparison = comparePreferences(before, await preferences(), options.updateSet);
            Object.assign(report, { preferencesUnchanged: comparison.unchanged, preferenceRowsReplaced: comparison.replaced, currentUpdateSet: comparison.currentUpdateSet });
            if (JSON.stringify(after) !== JSON.stringify(wanted)) fail('write_not_applied', saved.sys_id);
            if (saved.sys_scope !== scope.sysId) fail('scope_not_applied', saved.sys_id);
            if (saved.sys_update_name !== name) fail('not_captured', saved.sys_id);
            if (!GLOBAL_DOMAIN.has(saved.sys_domain)) fail('scope_not_applied', saved.sys_id);
            const captures = observed.filter(capture => versions.get(capture.sys_id) !== capture.sys_mod_count);
            if (!captures.length || observed.some(capture => capture.name !== name || capture.sys_updated_on < started)) fail('not_captured', saved.sys_id);
            // One save writes one List Layout capture; more than one changed row cannot be attributed to this save.
            if (captures.length > 1) fail('verification_unavailable', saved.sys_id);
            const capture = captures[0];
            const target = ID.test(capture.update_set) ? await reader.exact('sys_update_set', capture.update_set, 'name,application') : undefined;
            if (!target) fail('not_captured', saved.sys_id);
            Object.assign(report, { updateSetSysId: target.sys_id, updateSetName: target.name, updateSetScope: target.application, action: capture.action });
            if (target.sys_id !== options.updateSet) fail('captured_elsewhere', saved.sys_id);
            if (target.application !== scope.sysId || capture.application !== scope.sysId) fail('mixed_scope_capture', saved.sys_id);
            if (capture.action !== 'INSERT_OR_UPDATE') fail('not_captured', saved.sys_id);
            if (store) report.customization = await customizationEvidence(reader, capture.sys_id, name);
            if (!comparison.valid) fail('session_changed', saved.sys_id);
            if (submitFailure) fail('verification_unavailable', saved.sys_id);
            return { table, view, scope, sysId: saved.sys_id, ...(list ? { previousSysId: list.sys_id } : {}), created: !list, columns: after,
                previousColumns: previous, capture: report as CaptureReport };
        } catch (error) {
            if (isPolicyRefusal(error) || (!submitted && error instanceof MetadataScopeError) || error instanceof MetadataVerificationError) throw stripSecretsFromError(error);
            if (!submitted && error instanceof Error && error.message === 'form_redirect') {
                throw new MetadataScopeError('form_redirected', { table: 'sys_ui_list', redirectPath: (error as Error & { redirectPath?: string }).redirectPath });
            }
            if (!submitted) throw new MetadataScopeError('evidence_unavailable');
            throw new MetadataVerificationError('verification_unavailable', 'sys_ui_list', savedId, report, []);
        }
    }

    private reader(): MetadataReader {
        return new MetadataReader(SessionManager.getInstance().getRequest(this._instance));
    }
}

/**
 * The view's sys_ui_view sys_id. The page takes a view by name and calls the Default view '';
 * sys_ui_list.view references sys_ui_view, whose Default view's sys_id is literally 'Default view'.
 */
async function viewId(reader: MetadataReader, view: string): Promise<string> {
    if (view === '') return 'Default view';
    const rows = await reader.rows('sys_ui_view', `name=${view}`, 'sys_id,name');
    const exact = rows.filter(row => row.name === view);
    if (!exact.length) throw new MetadataScopeError('invalid_input');
    if (exact.length > 1 || !ID.test(exact[0].sys_id)) throw new MetadataScopeError('evidence_unavailable');
    return exact[0].sys_id;
}

/** Every list of the table for the view that is not a related list or a user's personalized list. */
async function listRows(reader: MetadataReader, table: string, view: string): Promise<MetadataRow[]> {
    const rows = await reader.rows('sys_ui_list', `name=${table}^view=${view}^sys_userISEMPTY^parentISEMPTY^relationshipISEMPTY`, `sys_id,${LIST_FIELDS}`);
    if (rows.some(row => row.name !== table || row.view !== view || !ID.test(row.sys_id))) throw new MetadataScopeError('evidence_unavailable');
    return rows;
}

/** The table's own list for the view; more than one (for example one per domain) cannot be told apart. */
async function findList(reader: MetadataReader, table: string, view: string): Promise<MetadataRow | undefined> {
    const rows = await listRows(reader, table, view);
    if (rows.length > 1) throw new MetadataScopeError('evidence_unavailable');
    return rows[0];
}

/** The list's columns in position order. */
async function columns(reader: MetadataReader, list: string): Promise<string[]> {
    const rows = await reader.rows('sys_ui_list_element', `list_id=${list}`, 'sys_id,list_id,element,position');
    if (rows.some(row => row.list_id !== list || !/^-?\d+$/.test(row.position) || !COLUMN.test(row.element))) throw new MetadataScopeError('evidence_unavailable');
    return rows.sort((a, b) => Number(a.position) - Number(b.position)).map(row => row.element);
}

function locationPath(headers: unknown): string | undefined {
    const location = (headers as Record<string, unknown> | undefined)?.location;
    if (typeof location !== 'string') return undefined;
    try { return new URL(location, 'https://instance.invalid').pathname; } catch { return undefined; }
}
