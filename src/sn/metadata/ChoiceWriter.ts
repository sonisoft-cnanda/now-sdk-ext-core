import { randomUUID } from 'node:crypto';
import { Parser } from 'xml2js';
import { InvalidParameterException } from '../../exception/InvalidParameterException';
import { FormSubmitError } from '../../exception/FormSubmitError';
import { createFormTransport } from '../../comm/http/FormRecordWriter';
import { SessionManager } from '../../comm/http/SessionManager';
import type { ServiceNowRequest } from '../../comm/http/ServiceNowRequest';
import { READ_ONLY } from '../../policy/PolicyTypes';
import { isPolicyRefusal } from '../../policy/PolicyRefusal';
import { stripSecretsFromError } from '../../util/redact';
import type { ServiceNowInstance } from '../ServiceNowInstance';
import type { CaptureReport, Choice, ChoiceColumn, ChoiceList, ChoiceListOptions, ChoiceRemoveOptions, ChoiceSetRef,
    ChoiceWriteOptions, ChoiceWriteResult } from './MetadataModels';
import { MetadataScopeError } from './MetadataScopeError';
import { MetadataVerificationError } from './MetadataVerificationError';
import { MetadataReader, type MetadataRow } from './internal/MetadataReader';
import { comparePreferences } from './internal/MetadataPreferences';
import { customizationEvidence, resolveScope } from './internal/MetadataScope';
import { ancestry } from './internal/MetadataTables';
import { requirePlatformDelete } from './internal/MetadataFormActions';

const ID = /^[a-f0-9]{32}$/i;
const NAME = /^[a-z0-9_]+$/i;
const LANGUAGE = /^[a-z][a-z_]{1,9}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CHOICE = 'sys_choice';
const CHOICE_FIELDS = 'sys_id,name,element,language,value,label,sequence,inactive,hint,dependent_value';
/** The fields a Choice list capture carries for each choice and that a commit applies on the target. */
const CAPTURED_FIELDS = ['value', 'label', 'sequence', 'inactive', 'hint', 'language', 'dependent_value'] as const;
const MAX_SEQUENCE = 2 ** 31 - 1;

type Operation = 'insert' | 'update' | 'delete';
interface Context { column: ChoiceColumn; maxLength: number; set?: MetadataRow; choices: MetadataRow[] }

/**
 * Adds, changes and removes a column's choices through the choice form (`sys_choice.do`), the path the platform itself
 * uses, and verifies what the platform did. Seen on dev206299:
 *
 * - A sys_choice row has no application. The list's application file is its sys_choice_set (one per table and column),
 *   which the platform creates with the list's first choice, in the form's application.
 * - Every change rewrites one capture, `sys_choice_<table>_<element>` (type Choice list), holding the choice set and
 *   every choice of the list. It goes to the update set posted with the form, which need not be the user's current set.
 *   Removing the list's last choice keeps the choice set; the capture then holds it with no choices.
 * - The form's Table field only offers the application's own tables (and tables it may alter). Loaded in another
 *   application it comes back empty, and posting it saves a choice with no table, captured as `sys_choice__<element>`.
 *   The writer refuses before posting when the loaded form does not name the table.
 *
 * The writer never changes the user's working set or current application. The Table API is not used: it inserts in the
 * session's current application and refuses another application's table.
 */
export class ChoiceWriter {
    public constructor(private _instance: ServiceNowInstance) {}

    /** The column's choice list in one language, with the column's dictionary setting and the list's application file. */
    public async getChoices(table: string, element: string, options: ChoiceListOptions = {}): Promise<ChoiceList> {
        const language = options?.language ?? 'en';
        if (!NAME.test(table ?? '') || !NAME.test(element ?? '') || typeof language !== 'string' || !LANGUAGE.test(language)) {
            throw new MetadataScopeError('invalid_input');
        }
        try {
            const context = await this.context(new MetadataReader(this.request()), table, element, language);
            return { table, element, language, column: context.column, ...(context.set ? { choiceSet: choiceSet(context.set) } : {}),
                choices: sorted(context.choices.map(toChoice)) };
        } catch (error) {
            if (isPolicyRefusal(error) || error instanceof MetadataScopeError) throw stripSecretsFromError(error);
            throw new MetadataScopeError('evidence_unavailable');
        }
    }

    /**
     * Add the choice `options.value` (with `options.label`), or change the label, sequence, inactive flag or hint of the
     * existing choice with that value. Reordering is a sequence change; inactivating keeps the choice for records that hold it.
     */
    public async setChoice(table: string, element: string, options: ChoiceWriteOptions): Promise<ChoiceWriteResult> {
        return this.write(table, element, options, false);
    }

    /**
     * Remove the choice `options.value`. Refused while records hold the value unless `options.confirmInUse` is set; the
     * records keep the value either way.
     */
    public async removeChoice(table: string, element: string, options: ChoiceRemoveOptions): Promise<ChoiceWriteResult> {
        return this.write(table, element, options, true);
    }

    private request(): ServiceNowRequest {
        return SessionManager.getInstance().getRequest(this._instance);
    }

    private async context(reader: MetadataReader, table: string, element: string, language: string): Promise<Context> {
        const hierarchy = await ancestry(reader, table);
        const definitions = await reader.rows('sys_dictionary', `nameIN${hierarchy.map(row => row.name).join(',')}^element=${element}`,
            'sys_id,name,element,internal_type,choice,max_length,sys_scope');
        // The nearest definition is the one that applies to the table.
        const definition = hierarchy.map(row => definitions.find(entry => entry.name === row.name && entry.element === element)).find(Boolean);
        if (!definition) throw new MetadataScopeError('column_not_found', { table, field: element });
        const sets = await reader.rows('sys_choice_set', `name=${table}^element=${element}`, 'sys_id,name,element,sys_scope,sys_update_name,sys_policy');
        if (sets.length > 1 || sets.some(set => set.name !== table || set.element !== element)) throw new MetadataScopeError('evidence_unavailable');
        const choices = await reader.rows(CHOICE, `name=${table}^element=${element}^language=${language}`, CHOICE_FIELDS);
        if (choices.some(row => row.name !== table || row.element !== element || row.language !== language)) throw new MetadataScopeError('evidence_unavailable');
        return { column: { table: definition.name, type: definition.internal_type, choice: definition.choice, scope: definition.sys_scope },
            maxLength: Number(definition.max_length), set: sets[0], choices };
    }

    private async write(table: string, element: string, options: ChoiceWriteOptions | ChoiceRemoveOptions, removing: boolean): Promise<ChoiceWriteResult> {
        const language = options?.language ?? 'en';
        if (!NAME.test(table ?? '') || !NAME.test(element ?? '') || typeof language !== 'string' || !LANGUAGE.test(language) ||
            !options?.updateSet || !ID.test(options.updateSet)) throw new MetadataScopeError('invalid_input');
        const { value } = options;
        // The value is also a query term (the in-use count): no condition separator, no script, no padding.
        if (typeof value !== 'string' || !value || value.length > 4000 || value !== value.trim() || CONTROL.test(value) || value.includes('^') ||
            /javascript:/i.test(value)) throw new MetadataScopeError('invalid_input', { field: 'value' });
        const changes = removing ? {} : changeFields(options);

        const request = this.request();
        const reader = new MetadataReader(request);
        let submitted = false;
        let recordId = '';
        let report: Partial<CaptureReport> = {};
        let messages: string[] = [];
        try {
            const { store, ...scope } = await resolveScope(reader, options.scope);
            if (store && options.storeCustomization?.acknowledgeUpgradeSkip !== true) throw new MetadataScopeError('store_scope');
            const context = await this.context(reader, table, element, language);
            if (context.set) {
                if (context.set.sys_scope !== scope.sysId) throw new MetadataScopeError('scope_mismatch', { table });
                if (store && ['read', 'protected'].includes(context.set.sys_policy)) throw new MetadataScopeError('protected_record', { table });
            } else {
                // A table without a list of its own shows the defining table's; a list of its own would replace it there.
                if (context.column.table !== table) throw new MetadataScopeError('choice_list_inherited', { table: context.column.table, field: element });
                if (context.column.scope !== scope.sysId) throw new MetadataScopeError('scope_mismatch', { table });
            }
            const matches = context.choices.filter(row => row.value === value);
            if (matches.length > 1) throw new MetadataScopeError('choice_ambiguous', { table, field: element });
            const existing = matches[0];
            const operation: Operation = removing ? 'delete' : existing ? 'update' : 'insert';
            if (removing && !existing) throw new MetadataScopeError('choice_not_found', { table, field: element });
            let fields: Record<string, string> = {};
            if (operation === 'insert') {
                if (changes.label === undefined) throw new MetadataScopeError('invalid_input', { field: 'label' });
                // Records store the value in the column: it must fit it.
                if (Number.isSafeInteger(context.maxLength) && context.maxLength > 0 && value.length > context.maxLength) {
                    throw new MetadataScopeError('invalid_input', { field: 'value' });
                }
                if (['integer', 'longint'].includes(context.column.type) && !/^-?\d+$/.test(value)) throw new MetadataScopeError('invalid_input', { field: 'value' });
                fields = { value, ...changes };
            } else if (operation === 'update') {
                fields = Object.fromEntries(Object.entries(changes).filter(([field, next]) => (existing[field] ?? '') !== next));
                if (!Object.keys(fields).length) throw new MetadataScopeError('choice_unchanged', { table, field: element });
            }

            const set = await reader.exact('sys_update_set', options.updateSet, 'application,state');
            if (!set || set.state !== 'in progress' || set.application !== scope.sysId) {
                throw new MetadataScopeError('invalid_input', set ? { updateSetState: set.state, updateSetApplication: set.application } : undefined);
            }
            let inUse: number | undefined;
            if (operation === 'delete') {
                inUse = await this.count(request, table, `${element}=${value}`);
                if (inUse > 0 && (options as ChoiceRemoveOptions).confirmInUse !== true) {
                    throw new MetadataScopeError('choice_in_use', { table, field: element, records: inUse });
                }
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

            const transport = createFormTransport(this._instance);
            const form = await transport.loadForm(CHOICE, existing?.sys_id ?? '-1', {
                ...(operation === 'insert' ? { initialQuery: `name=${table}^element=${element}^language=${language}` } : {}),
                query: { sysparm_transaction_scope: scope.sysId, sysparm_referring_url: `${CHOICE}.do`, sysparm_nofocus: 'true',
                    sysparm_nameofstack: `${randomUUID()}_bottomless` },
                captureRenderedInputs: true, tokenSource: 'page', sensitive: true });
            recordId = form.sysId;
            // Loaded in an application that may not use the table, the form drops the table and would save a choice without one.
            if (!ID.test(recordId) || (existing && recordId !== existing.sys_id) || form.renderedInputs?.sysparm_transaction_scope !== scope.sysId ||
                form.fields[`${CHOICE}.name`]?.value !== table || form.fields[`${CHOICE}.element`]?.value !== element ||
                form.fields[`${CHOICE}.language`]?.value !== language) throw new MetadataScopeError('scope_not_applied', { table });
            for (const field of Object.keys(fields)) if (!form.fields[`${CHOICE}.${field}`]) throw new MetadataScopeError('field_not_supported', { field, table: CHOICE });
            const action = operation === 'insert' ? 'sysverb_insert_and_stay' : operation === 'update' ? 'sysverb_update' : 'sysverb_delete';
            if (operation === 'update' && !form.actions[action]) throw new MetadataScopeError('not_permitted');
            if (operation === 'delete') await requirePlatformDelete(reader, form.actions);
            try { transport.validate(form, { fields }); } catch (error) {
                if (!(error instanceof InvalidParameterException)) throw error;
                throw new MetadataScopeError('field_not_supported', { table: CHOICE });
            }
            const loaded = await preferences();
            if (!comparePreferences(before, loaded).valid) throw new MetadataVerificationError('session_changed', CHOICE, recordId, undefined, [], false);
            const updateName = `sys_choice_${table}_${element}`;
            const prior = await reader.rows('sys_update_xml', `name=${updateName}`, 'sys_id,name,sys_mod_count');
            if (prior.some(row => row.name !== updateName || !/^\d+$/.test(row.sys_mod_count))) throw new MetadataScopeError('evidence_unavailable');
            const versions = new Map(prior.map(row => [row.sys_id, row.sys_mod_count]));
            if (operation === 'delete') {
                // Counted again just before the post: a record that took the value while the form loaded counts too.
                inUse = await this.count(request, table, `${element}=${value}`);
                if (inUse > 0 && (options as ChoiceRemoveOptions).confirmInUse !== true) {
                    throw new MetadataScopeError('choice_in_use', { table, field: element, records: inUse });
                }
            }
            const started = new Date().toISOString().slice(0, 19).replace('T', ' ');

            submitted = true;
            let submitFailure: unknown;
            try {
                const result = await transport.submit(form, action, { fields, postAllRenderedInputs: true, tokenSource: 'page',
                    actionValue: operation === 'update' ? form.actions[action] : action,
                    extraFields: { sysparm_transaction_scope: scope.sysId, sysparm_transaction_update_set: options.updateSet,
                        sysparm_record_scope: '', sysparm_goto_url: '' },
                    redirect: 'manual', landing: 'guarded', sensitive: true });
                messages = [...result.messages, ...(result.errors ?? [])];
            } catch (error) {
                if (isPolicyRefusal(error)) throw error;
                if (error instanceof FormSubmitError) messages = error.messages;
                submitFailure = error;
            }

            report = { predictedUpdateSetSysId: options.updateSet, updateName };
            const fail: (code: ConstructorParameters<typeof MetadataVerificationError>[0]) => never = code => {
                throw new MetadataVerificationError(code, CHOICE, recordId, report, messages);
            };
            const csrfRejected = submitFailure instanceof Error && submitFailure.message === 'csrf_rejected';
            const row = await reader.exact(CHOICE, recordId, CHOICE_FIELDS.slice('sys_id,'.length));
            if (operation === 'delete') {
                if (row) fail(csrfRejected ? 'csrf_rejected' : 'delete_not_applied');
            } else {
                if (!row) fail(csrfRejected ? 'csrf_rejected' : 'write_not_applied');
                if (row.name !== table || row.element !== element || row.language !== language || row.value !== value ||
                    Object.entries(fields).some(([field, next]) => (row[field] ?? '') !== next)) fail('write_not_applied');
                // Only the submitted form's row is this save's choice: another row of that value was written by someone else.
                const same = await reader.rows(CHOICE, `name=${table}^element=${element}^language=${language}`, 'sys_id,value');
                if (same.some(other => other.value === value && other.sys_id !== recordId)) fail('verification_unavailable');
            }
            // Every language: the capture holds the whole list.
            const remaining = await reader.rows(CHOICE, `name=${table}^element=${element}`, CHOICE_FIELDS);
            if (remaining.some(other => other.name !== table || other.element !== element)) fail('verification_unavailable');
            const sets = await reader.rows('sys_choice_set', `name=${table}^element=${element}`, 'sys_id,name,element,sys_scope,sys_update_name');
            if (sets.length > 1) fail('verification_unavailable');
            const savedSet = sets[0];
            if (savedSet || remaining.length) {
                if (!savedSet) fail('not_captured');
                report.recordScope = savedSet.sys_scope;
                if (savedSet.sys_scope !== scope.sysId) fail('scope_not_applied');
                if (savedSet.sys_update_name !== updateName) fail('not_captured');
            } else {
                report.recordScope = scope.sysId;
            }

            const observed = await reader.rows('sys_update_xml', `name=${updateName}^sys_updated_on>=${started}`,
                'sys_id,name,update_set,application,action,sys_updated_on,sys_mod_count');
            const comparison = comparePreferences(before, await preferences(), options.updateSet);
            Object.assign(report, { preferencesUnchanged: comparison.unchanged, preferenceRowsReplaced: comparison.replaced, currentUpdateSet: comparison.currentUpdateSet });
            if (observed.some(capture => capture.name !== updateName || capture.sys_updated_on < started)) fail('not_captured');
            const changed = observed.filter(capture => versions.get(capture.sys_id) !== capture.sys_mod_count);
            if (!changed.length) fail('not_captured');
            // One save rewrites one capture of the list; more than one changed row cannot be attributed to it.
            if (changed.length > 1) fail('verification_unavailable');
            const capture = changed[0];
            const target = ID.test(capture.update_set) ? await reader.exact('sys_update_set', capture.update_set, 'name,application') : undefined;
            if (!target) fail('not_captured');
            Object.assign(report, { updateSetSysId: target.sys_id, updateSetName: target.name, updateSetScope: target.application, action: capture.action });
            if (target.sys_id !== options.updateSet) fail('captured_elsewhere');
            if (target.application !== scope.sysId || capture.application !== scope.sysId) fail('mixed_scope_capture');
            // Emptying a list keeps its choice set, and the capture holds it with no choices; only a list with no choice set left is a DELETE.
            const emptied = !savedSet && !remaining.length;
            if (capture.action !== (emptied ? 'DELETE' : 'INSERT_OR_UPDATE')) fail('not_captured');
            if (!emptied) {
                // A commit replaces the target's list with the capture's, so the capture must be the list as it now is: every
                // choice, in every language, with every field a commit applies. That holds this save's choice as saved, and no
                // longer holds a removed one.
                const payload = await reader.exact('sys_update_xml', capture.sys_id, 'payload');
                const captured = payload ? await capturedChoices(payload.payload) : undefined;
                if (!captured) fail('verification_unavailable');
                if (captured.size !== remaining.length || remaining.some(saved => {
                    const entry = captured.get(saved.sys_id);
                    return !entry || CAPTURED_FIELDS.some(field => entry[field] !== (saved[field] ?? ''));
                })) fail('not_captured');
            }
            if (store) report.customization = await customizationEvidence(reader, capture.sys_id, updateName);
            if (!comparison.valid) fail('session_changed');
            if (submitFailure) fail(csrfRejected ? 'csrf_rejected' : 'verification_unavailable');

            const after = await reader.rows(CHOICE, `name=${table}^element=${element}^language=${language}`, CHOICE_FIELDS);
            return { table, element, language, value, action: operation, sysId: recordId,
                ...(row ? { choice: toChoice(row) } : {}), ...(existing ? { previous: toChoice(existing) } : {}),
                choices: sorted(after.map(toChoice)), column: context.column,
                ...(savedSet ? { choiceSet: { ...choiceSet(savedSet), created: !context.set } } : {}),
                ...(inUse !== undefined ? { inUse } : {}), scope, capture: report as CaptureReport, messages };
        } catch (error) {
            if (isPolicyRefusal(error) || (!submitted && error instanceof MetadataScopeError) || error instanceof MetadataVerificationError) throw stripSecretsFromError(error);
            if (!submitted && error instanceof Error && error.message === 'csrf_token_unavailable') throw new MetadataScopeError('csrf_token_unavailable');
            if (!submitted && error instanceof Error && error.message === 'form_redirect') {
                throw new MetadataScopeError('form_redirected', { table: CHOICE, redirectPath: (error as Error & { redirectPath?: string }).redirectPath });
            }
            if (!submitted) throw new MetadataScopeError('evidence_unavailable');
            throw new MetadataVerificationError(error instanceof Error && error.message === 'csrf_rejected' ? 'csrf_rejected' : 'verification_unavailable',
                CHOICE, recordId, report, messages);
        }
    }

    /** Records holding a value, from the Stats API: a paged read is bounded, a count is not. */
    private async count(request: ServiceNowRequest, table: string, query: string): Promise<number> {
        const response = await request.get<{ result?: { stats?: { count?: string } } }>({ path: `/api/now/stats/${table}`,
            headers: { Accept: 'application/json' }, body: null, requires: READ_ONLY, sensitive: true, query: { sysparm_query: query, sysparm_count: 'true' } });
        const count = Number(response.bodyObject?.result?.stats?.count);
        if (response.status !== 200 || !Number.isSafeInteger(count) || count < 0) throw new MetadataScopeError('evidence_unavailable');
        return count;
    }
}

/** The fields a set writes, as the form posts them; refuses values the platform would not keep as given. */
function changeFields(options: ChoiceWriteOptions): Record<string, string> {
    const { label, sequence, inactive, hint } = options;
    const fields: Record<string, string> = {};
    if (label !== undefined) {
        if (typeof label !== 'string' || !label.trim() || label !== label.trim() || label.length > 100 || CONTROL.test(label)) {
            throw new MetadataScopeError('invalid_input', { field: 'label' });
        }
        fields.label = label;
    }
    if (sequence !== undefined) {
        if (!Number.isSafeInteger(sequence) || Math.abs(sequence) > MAX_SEQUENCE) throw new MetadataScopeError('invalid_input', { field: 'sequence' });
        fields.sequence = String(sequence);
    }
    if (inactive !== undefined) {
        if (typeof inactive !== 'boolean') throw new MetadataScopeError('invalid_input', { field: 'inactive' });
        fields.inactive = String(inactive);
    }
    if (hint !== undefined) {
        if (typeof hint !== 'string' || hint.length > 255 || hint !== hint.trim() || CONTROL.test(hint)) throw new MetadataScopeError('invalid_input', { field: 'hint' });
        fields.hint = hint;
    }
    return fields;
}

function toChoice(row: MetadataRow): Choice {
    const sequence = /^-?\d+$/.test(row.sequence ?? '') ? Number(row.sequence) : undefined;
    return { sysId: row.sys_id, value: row.value, label: row.label, ...(sequence !== undefined ? { sequence } : {}),
        inactive: row.inactive === 'true', hint: row.hint ?? '', dependentValue: row.dependent_value ?? '', language: row.language };
}

function sorted(choices: Choice[]): Choice[] {
    const order = (choice: Choice): number => choice.sequence ?? Number.MAX_SAFE_INTEGER;
    return [...choices].sort((a, b) => order(a) - order(b) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

function choiceSet(row: MetadataRow): ChoiceSetRef {
    return { sysId: row.sys_id, scope: row.sys_scope, updateName: row.sys_update_name };
}

/** The choices a Choice list capture holds, by sys_id; undefined when the payload is not one. */
async function capturedChoices(payload: string): Promise<Map<string, Record<(typeof CAPTURED_FIELDS)[number], string>> | undefined> {
    let document: unknown;
    // xml2js ships no types that the type-aware lint can resolve (as in XMLRecordManager).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    try { document = await new Parser({ explicitArray: true }).parseStringPromise(payload); } catch {
        return undefined;
    }
    const list = (document as { record_update?: { sys_choice?: unknown[] } })?.record_update?.sys_choice;
    if (!Array.isArray(list) || list.length !== 1) return undefined;
    const rows = (list[0] as { sys_choice?: unknown[] }).sys_choice ?? [];
    const result = new Map<string, Record<(typeof CAPTURED_FIELDS)[number], string>>();
    for (const entry of rows) {
        const record = entry as Record<string, unknown>;
        const sysId = text(record.sys_id);
        if (!sysId || result.has(sysId)) return undefined;
        const fields = Object.fromEntries(CAPTURED_FIELDS.map(field => [field, text(record[field])]));
        // A field missing from the capture is not the same as an empty one.
        if (Object.values(fields).some(field => field === undefined)) return undefined;
        result.set(sysId, fields as Record<(typeof CAPTURED_FIELDS)[number], string>);
    }
    return result;
}

/** xml2js gives `['text']`, `[{ _: 'text', $: {...} }]` or `['']`/`[{ $: {...} }]` for an empty element. */
function text(node: unknown): string | undefined {
    if (!Array.isArray(node) || node.length !== 1) return undefined;
    const first: unknown = node[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') return typeof (first as { _?: unknown })._ === 'string' ? (first as { _: string })._ : '';
    return undefined;
}
