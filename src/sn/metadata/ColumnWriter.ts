import { randomUUID } from 'node:crypto';
import { InvalidParameterException } from '../../exception/InvalidParameterException';
import { FormSubmitError } from '../../exception/FormSubmitError';
import { createFormTransport } from '../../comm/http/FormRecordWriter';
import { SessionManager } from '../../comm/http/SessionManager';
import { isPolicyRefusal } from '../../policy/PolicyRefusal';
import { stripSecretsFromError } from '../../util/redact';
import type { ServiceNowInstance } from '../ServiceNowInstance';
import type { CaptureReport, ColumnWriteOptions, ColumnWriteResult } from './MetadataModels';
import { MetadataScopeError } from './MetadataScopeError';
import { MetadataVerificationError } from './MetadataVerificationError';
import { MetadataReader, type MetadataRow } from './internal/MetadataReader';
import { comparePreferences, preferenceValue } from './internal/MetadataPreferences';
import { customizationEvidence, resolveScope } from './internal/MetadataScope';

const ID = /^[a-f0-9]{32}$/i;
const NAME = /^[a-z0-9_]+$/i;
const COLUMN = /^[a-z][a-z0-9_]*$/;
const MAX_COLUMN = 80;
const DICTIONARY = 'sys_dictionary';
/**
 * Tables whose schema the platform's own metadata, capture and application model depend on. A column added to one of
 * them (or to a table extending one) is added to every record the platform keeps there.
 */
const TABLE_DENY = new Set(['sys_metadata', 'sys_dictionary', 'sys_db_object', 'sys_documentation', 'sys_choice', 'sys_glide_object',
    'sys_update_set', 'sys_update_xml', 'sys_update_version', 'sys_metadata_delete', 'sys_scope', 'sys_app', 'sys_store_app',
    'sys_user_preference']);

/**
 * Adds a column to a table through the dictionary form (`sys_dictionary.do`), the path the platform itself uses, and
 * verifies what the platform did:
 *
 * - The column's name. The platform renames it: `u_<name>` in Global and in an installed Store application,
 *   `<scope>_<name>` when an application adds it to another application's table, and unchanged on a scoped
 *   application's own table. The writer applies that rule before the
 *   save, so `column` in the result is the name to use, and checks the saved row has it.
 * - The Dictionary and Field Label captures (`sys_dictionary_<table>_<column>`, `sys_documentation_<table>_<column>_<lang>`).
 * - The Form Layout capture of every section the platform appended the field to. On Global tables and an application's
 *   own tables the platform adds it to the end of the Default view's main section; placing it is then a form-layout change.
 *
 * Every capture must be in the given set, of the given application. The writer never changes the user's working set:
 * the set must already be the user's set for that application (see `WorkingSetManager.useUpdateSet`), because the form
 * placement is captured there whatever the dictionary form is told. Removing a column is not part of this writer.
 */
export class ColumnWriter {
    public constructor(private _instance: ServiceNowInstance) {}

    /** Add `options.column` to `table` and verify the column, its label, the form placement and their captures. */
    public async addColumn(table: string, options: ColumnWriteOptions): Promise<ColumnWriteResult> {
        if (!NAME.test(table ?? '') || !options?.updateSet || !ID.test(options.updateSet)) throw new MetadataScopeError('invalid_input');
        const { column: requested, label, type, maxLength, reference } = options;
        if (typeof requested !== 'string' || !COLUMN.test(requested)) throw new MetadataScopeError('invalid_input', { field: 'column' });
        if (typeof label !== 'string' || !label.trim() || label.length > 80 || [...label].some(char => char.charCodeAt(0) < 32 || char === '<' || char === '>')) throw new MetadataScopeError('invalid_input', { field: 'label' });
        if (typeof type !== 'string' || !NAME.test(type)) throw new MetadataScopeError('invalid_input', { field: 'type' });
        if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 65000)) throw new MetadataScopeError('invalid_input', { field: 'max_length' });
        if (reference !== undefined && (typeof reference !== 'string' || !NAME.test(reference))) throw new MetadataScopeError('invalid_input', { field: 'reference' });
        if ((type === 'reference') !== (reference !== undefined) && type !== 'glide_list') throw new MetadataScopeError('invalid_input', { field: 'reference' });

        const reader = new MetadataReader(SessionManager.getInstance().getRequest(this._instance));
        let submitted = false;
        let report: Partial<CaptureReport> = {};
        let messages: string[] = [];
        let recordId = '';
        try {
            const { store, ...scope } = await resolveScope(reader, options.scope);
            if (store && options.storeCustomization?.acknowledgeUpgradeSkip !== true) throw new MetadataScopeError('store_scope');
            const hierarchy = await ancestry(reader, table);
            const column = columnName(requested, scope, store, hierarchy[0].sys_scope);
            if (column.length > MAX_COLUMN) throw new MetadataScopeError('invalid_input', { field: 'column' });
            const types = await reader.rows('sys_glide_object', `name=${type}`, 'sys_id,name');
            if (!types.some(row => row.name === type)) throw new MetadataScopeError('invalid_input', { field: 'type' });
            if (reference !== undefined) {
                const target = await reader.rows('sys_db_object', `name=${reference}`, 'sys_id,name');
                if (target.length !== 1 || target[0].name !== reference) throw new MetadataScopeError('table_not_supported', { table: reference });
            }
            // A column of that name on the table or a table it extends: the platform would refuse it, or shadow the parent's.
            const existing = await reader.rows(DICTIONARY, `nameIN${hierarchy.map(row => row.name).join(',')}^element=${column}`, 'sys_id,name,element');
            const clash = existing.find(row => row.element === column);
            if (clash) throw new MetadataScopeError('column_exists', { table: clash.name, field: column });

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
            // The form placement is captured in the user's set for the application, whatever the form is told.
            if (preferenceValue(before, `updateSetForScope${scope.sysId}`) !== options.updateSet) throw new MetadataScopeError('update_set_not_current');

            const transport = createFormTransport(this._instance);
            const form = await transport.loadForm(DICTIONARY, '-1', { initialQuery: `name=${table}`,
                query: { sysparm_transaction_scope: scope.sysId, sysparm_isdevstudio: 'true', sysparm_referring_url: `${DICTIONARY}.do`,
                    sysparm_nofocus: 'true', sysparm_nameofstack: `${randomUUID()}_bottomless` },
                captureRenderedInputs: true, tokenSource: 'page', sensitive: true });
            recordId = form.sysId;
            if (!ID.test(recordId) || form.fields[`${DICTIONARY}.name`]?.value !== table || form.fields[`${DICTIONARY}.sys_scope`]?.value !== scope.sysId ||
                form.renderedInputs?.sysparm_transaction_scope !== scope.sysId) throw new MetadataScopeError('scope_not_applied');
            const fields: Record<string, string> = { element: column, column_label: label, internal_type: type,
                ...(maxLength !== undefined ? { max_length: String(maxLength) } : {}), ...(reference !== undefined ? { reference } : {}) };
            for (const field of Object.keys(fields)) if (!form.fields[`${DICTIONARY}.${field}`]) throw new MetadataScopeError('field_not_supported', { field, table: DICTIONARY });
            try { transport.validate(form, { fields }); } catch (error) {
                if (!(error instanceof InvalidParameterException)) throw error;
                throw new MetadataScopeError('field_not_supported', { table: DICTIONARY });
            }

            const loaded = await preferences();
            if (!comparePreferences(before, loaded).valid) throw new MetadataVerificationError('session_changed', DICTIONARY, recordId, undefined, [], false);
            // Every capture this save can make, snapshotted so an older row of the same name never counts as evidence.
            const dictionaryName = `${DICTIONARY}_${table}_${column}`;
            const sections = await reader.rows('sys_ui_section', `name=${table}`, 'sys_id,name');
            if (sections.some(row => row.name !== table || !ID.test(row.sys_id))) throw new MetadataScopeError('evidence_unavailable');
            const captureQuery = [`name=${dictionaryName}`, `nameSTARTSWITHsys_documentation_${table}_${column}_`,
                ...(sections.length ? [`nameIN${sections.map(row => `sys_ui_section_${row.sys_id}`).join(',')}`] : [])].join('^OR');
            const prior = await reader.rows('sys_update_xml', captureQuery, 'sys_id,name,sys_mod_count');
            if (prior.some(row => !/^\d+$/.test(row.sys_mod_count))) throw new MetadataScopeError('evidence_unavailable');
            const versions = new Map(prior.map(row => [row.sys_id, row.sys_mod_count]));
            const started = new Date().toISOString().slice(0, 19).replace('T', ' ');

            submitted = true;
            let submitFailure: unknown;
            try {
                // Insert and stay: the platform returns to this record's form, the one landing the guarded submit accepts.
                const result = await transport.submit(form, 'sysverb_insert_and_stay', { fields, postAllRenderedInputs: true,
                    tokenSource: 'page', actionValue: 'sysverb_insert_and_stay',
                    extraFields: { sysparm_transaction_scope: scope.sysId, sysparm_transaction_update_set: options.updateSet,
                        sysparm_record_scope: '', sysparm_goto_url: '' },
                    redirect: 'manual', landing: 'guarded', sensitive: true });
                messages = [...result.messages, ...(result.errors ?? [])];
            } catch (error) {
                if (isPolicyRefusal(error)) throw error;
                if (error instanceof FormSubmitError) messages = error.messages;
                submitFailure = error;
            }

            report = { predictedUpdateSetSysId: options.updateSet, updateName: dictionaryName };
            const fail: (code: ConstructorParameters<typeof MetadataVerificationError>[0]) => never = code => {
                throw new MetadataVerificationError(code, DICTIONARY, recordId, report, messages);
            };
            // The form's record keeps its sys_id, so a name the platform chose differently is found and reported.
            const dictionaryFields = 'name,element,internal_type,max_length,reference,sys_scope,sys_update_name';
            const formRecord = await reader.exact(DICTIONARY, recordId, dictionaryFields);
            if (formRecord && formRecord.element !== column) {
                if (NAME.test(formRecord.element)) messages = [...messages, `The platform saved the column as ${formRecord.element}, not ${column}`];
                fail('write_not_applied');
            }
            const saved = await reader.rows(DICTIONARY, `name=${table}^element=${column}`, `sys_id,${dictionaryFields}`);
            if (saved.length > 1 || (formRecord && saved.some(other => other.sys_id !== recordId))) fail('verification_unavailable');
            const row = formRecord ?? saved[0];
            if (!row) fail('write_not_applied');
            recordId = row.sys_id;
            report.recordScope = row.sys_scope;
            if (row.name !== table || row.element !== column || row.internal_type !== type ||
                (maxLength !== undefined && row.max_length !== String(maxLength)) || (reference !== undefined && row.reference !== reference)) fail('write_not_applied');
            if (row.sys_scope !== scope.sysId) fail('scope_not_applied');
            if (row.sys_update_name !== dictionaryName) fail('not_captured');
            const labels = await reader.rows('sys_documentation', `name=${table}^element=${column}`, 'sys_id,name,element,language,label,sys_scope,sys_update_name');
            if (!labels.some(doc => doc.label === label)) fail('write_not_applied');
            if (labels.some(doc => doc.sys_scope !== scope.sysId)) fail('scope_not_applied');
            if (labels.some(doc => doc.sys_update_name !== `sys_documentation_${table}_${column}_${doc.language}`)) fail('not_captured');
            const placed = await reader.rows('sys_ui_element', `element=${column}^sys_ui_section.name=${table}`, 'sys_id,element,sys_ui_section');
            if (placed.some(element => element.element !== column || !sections.some(section => section.sys_id === element.sys_ui_section))) fail('verification_unavailable');
            const formSections = [...new Set(placed.map(element => element.sys_ui_section))];
            const expected = [dictionaryName, ...labels.map(doc => doc.sys_update_name), ...formSections.map(id => `sys_ui_section_${id}`)];

            const observed = await reader.rows('sys_update_xml', `${captureQuery}^sys_updated_on>=${started}`,
                'sys_id,name,update_set,application,action,sys_updated_on,sys_mod_count');
            const comparison = comparePreferences(before, await preferences(), options.updateSet);
            Object.assign(report, { preferencesUnchanged: comparison.unchanged, preferenceRowsReplaced: comparison.replaced, currentUpdateSet: comparison.currentUpdateSet });
            if (observed.some(capture => capture.sys_updated_on < started)) fail('not_captured');
            const changed = observed.filter(capture => versions.get(capture.sys_id) !== capture.sys_mod_count);
            const targets = new Map<string, MetadataRow | undefined>();
            let dictionaryCapture: MetadataRow | undefined;
            for (const name of expected) {
                const captures = changed.filter(capture => capture.name === name);
                if (!captures.length) fail('not_captured');
                // One save writes one capture of each file; more than one changed row cannot be attributed to it.
                if (captures.length > 1) fail('verification_unavailable');
                const capture = captures[0];
                if (!targets.has(capture.update_set)) {
                    targets.set(capture.update_set, ID.test(capture.update_set) ? await reader.exact('sys_update_set', capture.update_set, 'name,application') : undefined);
                }
                const target = targets.get(capture.update_set);
                if (!target) fail('not_captured');
                if (name === dictionaryName) {
                    dictionaryCapture = capture;
                    Object.assign(report, { updateSetSysId: target.sys_id, updateSetName: target.name, updateSetScope: target.application, action: capture.action });
                }
                if (target.sys_id !== options.updateSet) fail('captured_elsewhere');
                if (target.application !== scope.sysId || capture.application !== scope.sysId) fail('mixed_scope_capture');
                if (capture.action !== 'INSERT_OR_UPDATE') fail('not_captured');
            }
            if (store) report.customization = await customizationEvidence(reader, dictionaryCapture?.sys_id, dictionaryName);
            if (!comparison.valid) fail('session_changed');
            if (submitFailure) fail(submitFailure instanceof Error && submitFailure.message === 'csrf_rejected' ? 'csrf_rejected' : 'verification_unavailable');
            return { table, column, sysId: row.sys_id, label, type, scope, formSections, captures: expected, capture: report as CaptureReport, messages };
        } catch (error) {
            if (isPolicyRefusal(error) || (!submitted && error instanceof MetadataScopeError) || error instanceof MetadataVerificationError) throw stripSecretsFromError(error);
            if (!submitted && error instanceof Error && error.message === 'csrf_token_unavailable') throw new MetadataScopeError('csrf_token_unavailable');
            if (!submitted && error instanceof Error && error.message === 'form_redirect') {
                throw new MetadataScopeError('form_redirected', { table: DICTIONARY, redirectPath: (error as Error & { redirectPath?: string }).redirectPath });
            }
            if (!submitted) throw new MetadataScopeError('evidence_unavailable');
            throw new MetadataVerificationError(error instanceof Error && error.message === 'csrf_rejected' ? 'csrf_rejected' : 'verification_unavailable',
                DICTIONARY, recordId, report, messages);
        }
    }
}

/**
 * The name the platform gives a new column (seen on dev206299): `u_` in Global and in an installed Store application,
 * even on the Store application's own table; `<scope>_` when a scoped application adds it to another application's table;
 * unchanged on a scoped application's own table. A name that already carries the prefix keeps it.
 */
function columnName(requested: string, scope: { sysId: string; scope: string }, store: boolean, tableScope: string): string {
    const prefix = scope.sysId === 'global' || store ? 'u_' : tableScope === scope.sysId ? '' : `${scope.scope}_`;
    return requested.startsWith(prefix) ? requested : `${prefix}${requested}`;
}

/** The table and every table it extends, the table first. Refuses the platform's own schema tables. */
async function ancestry(reader: MetadataReader, table: string): Promise<MetadataRow[]> {
    const fields = 'sys_id,name,super_class,sys_scope';
    let rows = await reader.rows('sys_db_object', `name=${table}`, fields);
    if (rows.length !== 1 || rows[0].name !== table) throw new MetadataScopeError('table_not_supported', { table });
    const chain: MetadataRow[] = [];
    while (rows.length === 1) {
        const row = rows[0];
        if (chain.some(seen => seen.sys_id === row.sys_id) || chain.length > 30) throw new MetadataScopeError('evidence_unavailable');
        if (TABLE_DENY.has(row.name) || !NAME.test(row.name)) throw new MetadataScopeError('table_not_supported', { table: row.name });
        chain.push(row);
        if (!ID.test(row.super_class)) return chain;
        const parent = await reader.exact('sys_db_object', row.super_class, 'name,super_class,sys_scope');
        if (!parent) throw new MetadataScopeError('evidence_unavailable');
        rows = [parent];
    }
    throw new MetadataScopeError('evidence_unavailable');
}
