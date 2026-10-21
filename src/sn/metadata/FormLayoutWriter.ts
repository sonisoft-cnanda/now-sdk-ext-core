import { SessionManager } from '../../comm/http/SessionManager';
import { isPolicyRefusal } from '../../policy/PolicyRefusal';
import { READ_ONLY } from '../../policy/PolicyTypes';
import { stripSecretsFromError } from '../../util/redact';
import type { ServiceNowInstance } from '../ServiceNowInstance';
import type { CaptureReport, FormLayout, FormLayoutWriteOptions, FormLayoutWriteResult } from './MetadataModels';
import { MetadataScopeError } from './MetadataScopeError';
import { MetadataVerificationError } from './MetadataVerificationError';
import { MetadataReader, type MetadataRow } from './internal/MetadataReader';
import { comparePreferences, preferenceValue } from './internal/MetadataPreferences';
import { customizationEvidence, resolveScope } from './internal/MetadataScope';
import { joinLayoutValues, parseSectionChoices, parseSlushbucketPage } from './internal/SlushbucketPage';

const ID = /^[a-f0-9]{32}$/i;
const SPLITS = new Set(['.begin_split', '.split', '.end_split']);
const FIELD = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/i;
const FORMATTER = /^\.formatter\.([a-f0-9]{32})$/i;

/**
 * Reads and replaces the layout of one form section (its ordered fields, splits and formatters)
 * through the classic Form Layout page, the path the platform itself uses. The platform rewrites
 * the section's elements and captures the whole section as one `sys_ui_section_<sys_id>` update.
 *
 * The writer never changes the user's working set. The target update set must already be the
 * user's set for the section's application (see `WorkingSetManager.useUpdateSet`); the capture is
 * then verified to be in it, of the section's application, together with the element order.
 */
export class FormLayoutWriter {
    public constructor(private _instance: ServiceNowInstance) {}

    /** The section's current layout, in the value grammar {@link setFormLayout} accepts. */
    public async getFormLayout(section: string): Promise<FormLayout> {
        if (!ID.test(section ?? '')) throw new MetadataScopeError('invalid_input');
        const reader = this.reader();
        const row = await reader.exact('sys_ui_section', section, 'name,view,caption,sys_scope');
        if (!row) throw new MetadataScopeError('scope_mismatch');
        return { section, table: row.name, view: await viewName(reader, row.view), caption: row.caption, scope: row.sys_scope, elements: await this.elements(reader, section) };
    }

    /** Replace the section's layout with `elements` and verify the result and its capture. */
    public async setFormLayout(section: string, options: FormLayoutWriteOptions): Promise<FormLayoutWriteResult> {
        if (!ID.test(section ?? '') || !options?.updateSet || !ID.test(options.updateSet)) throw new MetadataScopeError('invalid_input');
        const elements = options.elements;
        if (!Array.isArray(elements) || !elements.length || elements.some(value => typeof value !== 'string')) throw new MetadataScopeError('invalid_input');
        for (const value of elements) {
            if (!SPLITS.has(value) && !FORMATTER.test(value) && !FIELD.test(value)) throw new MetadataScopeError('field_not_supported', { field: value });
        }
        const fields = elements.filter(value => !SPLITS.has(value));
        if (new Set(fields).size !== fields.length) throw new MetadataScopeError('invalid_input');
        const reader = this.reader();
        const name = `sys_ui_section_${section}`;
        let submitted = false;
        let report: Partial<CaptureReport> = {};
        let previous: string[] = [];
        try {
            const { store, ...scope } = await resolveScope(reader, options.scope);
            if (store && options.storeCustomization?.acknowledgeUpgradeSkip !== true) throw new MetadataScopeError('store_scope');
            const row = await reader.exact('sys_ui_section', section, ['name', 'view', 'caption', 'sys_scope', ...(store ? ['sys_policy'] : [])].join(','));
            if (!row || row.sys_scope !== scope.sysId) throw new MetadataScopeError('scope_mismatch');
            if (store && ['read', 'protected'].includes(row.sys_policy)) throw new MetadataScopeError('protected_record', { table: 'sys_ui_section' });
            const set = await reader.exact('sys_update_set', options.updateSet, 'application,state');
            if (!set || set.state !== 'in progress' || set.application !== scope.sysId) {
                throw new MetadataScopeError('invalid_input', set ? { updateSetState: set.state, updateSetApplication: set.application } : undefined);
            }
            const users = await reader.rows('sys_user', 'sys_id=javascript:gs.getUserID()', 'sys_id');
            if (users.length !== 1 || !ID.test(users[0].sys_id)) throw new MetadataScopeError('evidence_unavailable');
            const user = users[0].sys_id;
            const preferences = async (): Promise<MetadataRow[]> => {
                const rows = await reader.rows('sys_user_preference', `user=${user}`, 'sys_id,user,name,value');
                if (rows.some(pref => pref.user !== user)) throw new MetadataScopeError('evidence_unavailable');
                return rows;
            };
            const before = await preferences();
            // The page saves into the user's set for the section's application; it takes no set parameter.
            if (preferenceValue(before, `updateSetForScope${scope.sysId}`) !== options.updateSet) throw new MetadataScopeError('update_set_not_current');
            previous = await this.elements(reader, section);
            // Annotations, charts and embedded lists cannot be written back through this save (the page does not offer an
            // embedded list at all): leaving them out of the list could delete them.
            const opaque = previous.find(value => /^\.(annotation|chart|list)\./.test(value));
            if (opaque) throw new MetadataScopeError('section_not_supported', { field: opaque.split('.')[1] });
            const view = await viewName(reader, row.view);

            const request = SessionManager.getInstance().getRequest(this._instance);
            const page = await request.get<string>({ method: 'GET', path: '/slushbucket.do', headers: null, body: null,
                query: { sysparm_form: 'section', sysparm_list: section, sysparm_view: view, sysparm_transaction_scope: scope.sysId },
                requires: READ_ONLY, responseFormat: 'text', redirect: 'manual', sensitive: true });
            if (page.status !== 200) throw Object.assign(new Error('form_redirect'), { redirectPath: locationPath(page.headers) });
            const form = parseSlushbucketPage(typeof page.data === 'string' ? page.data : '');
            const token = form.inputs.sysparm_ck;
            if (!token) throw new MetadataScopeError('csrf_token_unavailable');
            if (form.inputs.sysparm_transaction_scope !== scope.sysId || form.inputs.sys_target !== section) throw new MetadataScopeError('scope_not_applied');
            if (!form.canSave) throw new MetadataScopeError('not_permitted');
            const offered = new Set([...form.available, ...form.selected]);
            for (const value of fields) if (!offered.has(value)) throw new MetadataScopeError('field_not_supported', { field: value });
            const chosen = new Set(fields);
            const available = [...form.available, ...form.selected].filter(value => !chosen.has(value) && !SPLITS.has(value));

            const sectionsXml = await request.get<string>({ method: 'GET', path: '/xmlhttp.do', headers: { 'X-UserToken': token }, body: null,
                query: { sysparm_processor: 'GlideViewManager', sysparm_name: 'execute', sysparm_action: 'refreshSection',
                    sysparm_table: section, sysparm_form: 'section', sysparm_view: view, sysparm_transaction_scope: scope.sysId },
                requires: READ_ONLY, responseFormat: 'text', sensitive: true });
            const order = parseSectionChoices(typeof sectionsXml.data === 'string' ? sectionsXml.data : '');
            if (!order.includes(section) || order.some(id => !ID.test(id))) throw new MetadataScopeError('evidence_unavailable');

            const loaded = await preferences();
            if (!comparePreferences(before, loaded).valid) throw new MetadataVerificationError('session_changed', 'sys_ui_section', section, undefined, [], false);
            const priorCaptures = await reader.rows('sys_update_xml', `name=${name}`, 'sys_id,name,sys_mod_count');
            if (priorCaptures.some(capture => capture.name !== name || !/^\d+$/.test(capture.sys_mod_count))) throw new MetadataScopeError('evidence_unavailable');
            const versions = new Map(priorCaptures.map(capture => [capture.sys_id, capture.sys_mod_count]));
            const started = new Date().toISOString().slice(0, 19).replace('T', ' ');

            const [lcodes0, lcodes1, lcodes2] = [joinLayoutValues(available), joinLayoutValues(elements), joinLayoutValues([...order, '.new'])];
            if (lcodes0 === undefined || lcodes1 === undefined || lcodes2 === undefined) throw new MetadataScopeError('evidence_unavailable');

            submitted = true;
            let submitFailure: unknown;
            try {
                await request.post<string>({ method: 'POST', path: '/slushbucket.do', headers: null, query: null, body: null,
                    responseFormat: 'text', redirect: 'manual', sensitive: true, fields: {
                        sysparm_ck: token, sys_action: 'sysverb_save', sys_target: section, sysparm_list: section,
                        sysparm_form: 'section', sysparm_view: view, sysparm_section: section,
                        sysparm_collection: form.inputs.sysparm_collection ?? '', sysparm_collection_relationship: form.inputs.sysparm_collection_relationship ?? '',
                        sysparm_referring_url: form.inputs.sysparm_referring_url ?? '', sysparm_redirect_url: '', sysparm_sys_id: '',
                        sysparm_record_scope: form.inputs.sysparm_record_scope ?? '', sysparm_transaction_scope: scope.sysId,
                        lcodes_0: lcodes0, lcodes_1: lcodes1, lcodes_2: lcodes2,
                    } });
            } catch (error) {
                if (isPolicyRefusal(error)) throw error;
                submitFailure = error;
            }

            report = { predictedUpdateSetSysId: options.updateSet, updateName: name };
            const fail: (code: ConstructorParameters<typeof MetadataVerificationError>[0]) => never = code => {
                throw new MetadataVerificationError(code, 'sys_ui_section', section, report, []);
            };
            const after = await this.elements(reader, section);
            const sectionAfter = await reader.exact('sys_ui_section', section, 'sys_scope');
            report.recordScope = sectionAfter?.sys_scope;
            const observed = await reader.rows('sys_update_xml', `name=${name}^sys_updated_on>=${started}`,
                'sys_id,name,update_set,application,action,sys_updated_on,sys_mod_count');
            const comparison = comparePreferences(before, await preferences(), options.updateSet);
            Object.assign(report, { preferencesUnchanged: comparison.unchanged, preferenceRowsReplaced: comparison.replaced, currentUpdateSet: comparison.currentUpdateSet });
            if (JSON.stringify(after) !== JSON.stringify(elements)) fail('write_not_applied');
            if (sectionAfter?.sys_scope !== scope.sysId) fail('scope_not_applied');
            const captures = observed.filter(capture => versions.get(capture.sys_id) !== capture.sys_mod_count);
            if (!captures.length || observed.some(capture => capture.name !== name || capture.sys_updated_on < started)) fail('not_captured');
            // One save writes one Form Layout capture; more than one changed row cannot be attributed to this save.
            if (captures.length > 1) fail('verification_unavailable');
            for (const capture of captures) {
                const target = ID.test(capture.update_set) ? await reader.exact('sys_update_set', capture.update_set, 'name,application') : undefined;
                if (!target) fail('not_captured');
                Object.assign(report, { updateSetSysId: target.sys_id, updateSetName: target.name, updateSetScope: target.application, action: capture.action });
                if (target.sys_id !== options.updateSet) fail('captured_elsewhere');
                if (target.application !== scope.sysId || capture.application !== scope.sysId) fail('mixed_scope_capture');
                if (capture.action !== 'INSERT_OR_UPDATE') fail('not_captured');
            }
            if (store) report.customization = await customizationEvidence(reader, captures.at(-1)?.sys_id, name);
            if (!comparison.valid) fail('session_changed');
            if (submitFailure) fail('verification_unavailable');
            return { section, table: row.name, view, scope, elements: after, previousElements: previous, capture: report as CaptureReport };
        } catch (error) {
            if (isPolicyRefusal(error) || (!submitted && error instanceof MetadataScopeError) || error instanceof MetadataVerificationError) throw stripSecretsFromError(error);
            if (!submitted && error instanceof Error && error.message === 'form_redirect') {
                throw new MetadataScopeError('form_redirected', { table: 'sys_ui_section', redirectPath: (error as Error & { redirectPath?: string }).redirectPath });
            }
            if (!submitted) throw new MetadataScopeError('evidence_unavailable');
            throw new MetadataVerificationError('verification_unavailable', 'sys_ui_section', section, report, []);
        }
    }

    private reader(): MetadataReader {
        return new MetadataReader(SessionManager.getInstance().getRequest(this._instance));
    }

    /** The section's elements in position order, in the page's value grammar. */
    private async elements(reader: MetadataReader, section: string): Promise<string[]> {
        const rows = await reader.rows('sys_ui_element', `sys_ui_section=${section}`, 'sys_id,element,position,type,sys_ui_formatter');
        if (rows.some(row => !/^-?\d+$/.test(row.position))) throw new MetadataScopeError('evidence_unavailable');
        return rows.sort((a, b) => Number(a.position) - Number(b.position)).map(row => {
            if (row.type === 'formatter') {
                if (!ID.test(row.sys_ui_formatter)) throw new MetadataScopeError('evidence_unavailable');
                return `.formatter.${row.sys_ui_formatter}`;
            }
            // An annotation's or chart's element is the sys_id of its record, and an embedded list's is its relationship
            // (for example 12M.<table>.<field>): show them with a type prefix, so none can be mistaken for a field name.
            if (row.type === 'annotation' || row.type === 'chart' || row.type === 'list') return `.${row.type}.${row.element}`;
            return row.element;
        });
    }
}

/**
 * The page takes a view by name and calls the Default view ''. sys_ui_section.view references sys_ui_view: the Default
 * view's sys_id is literally 'Default view', every other view is a sys_id whose name the page needs.
 */
async function viewName(reader: MetadataReader, view: string): Promise<string> {
    if (!view || view === 'Default view') return '';
    if (!ID.test(view)) throw new MetadataScopeError('evidence_unavailable');
    const record = await reader.exact('sys_ui_view', view, 'name');
    if (!record?.name || !/^[a-z0-9_]+$/i.test(record.name)) throw new MetadataScopeError('evidence_unavailable');
    return record.name;
}

function locationPath(headers: unknown): string | undefined {
    const location = (headers as Record<string, unknown> | undefined)?.location;
    if (typeof location !== 'string') return undefined;
    try { return new URL(location, 'https://instance.invalid').pathname; } catch { return undefined; }
}
