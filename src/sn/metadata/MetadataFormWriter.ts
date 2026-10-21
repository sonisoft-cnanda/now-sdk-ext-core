import { randomUUID } from 'node:crypto';
import { InvalidParameterException } from '../../exception/InvalidParameterException';
import { FormSubmitError } from '../../exception/FormSubmitError';
import { createFormTransport } from '../../comm/http/FormRecordWriter';
import { SessionManager } from '../../comm/http/SessionManager';
import { isPolicyRefusal } from '../../policy/PolicyRefusal';
import { stripSecretsFromError } from '../../util/redact';
import type { ServiceNowInstance } from '../ServiceNowInstance';
import type { MetadataWriteOptions, MetadataDeleteOptions, MetadataWriteResult, CaptureReport } from './MetadataModels';
import { MetadataScopeError } from './MetadataScopeError';
import { MetadataVerificationError } from './MetadataVerificationError';
import { MetadataReader, MetadataRow } from './internal/MetadataReader';
import { comparePreferences, preferenceValue } from './internal/MetadataPreferences';
import { updateName, updateNameFields } from './internal/MetadataUpdateNames';
import { customizationEvidence, resolveScope } from './internal/MetadataScope';

const ID = /^[a-f0-9]{32}$/i;
const NAME = /^[a-z0-9_]+$/i;
const WRITE_DENY = new Set(['sys_update_set', 'sys_update_xml', 'sys_scope', 'sys_app', 'sys_store_app',
    'sys_db_object', 'sys_dictionary', 'sys_security_acl', 'sys_user_role']);
const DELETE_DENY = new Set(['sys_documentation', 'sys_package', 'sys_app_module']);
/**
 * Choice fields that point at a catalog variable. The server renders them with only "-- None --" and the page's script
 * fills in IO:<item_option_new sys_id> options, so the form's own options cannot validate them. The writer checks the
 * reference itself: the variable must belong to the record's catalog item or variable set (found through `via` when the
 * record names neither, as a UI policy action does through its policy).
 */
interface VariableReferenceRule { field: string; item: string; via?: { field: string; table: string; item: string } }
const VARIABLE_REFERENCES: Record<string, VariableReferenceRule> = {
    catalog_script_client: { field: 'cat_variable', item: 'cat_item' },
    catalog_ui_policy_action: { field: 'catalog_variable', item: 'catalog_item',
        via: { field: 'ui_policy', table: 'catalog_ui_policy', item: 'catalog_item' } },
};
const VARIABLE_REFERENCE = /^IO:([0-9a-f]{32})$/;
/** The fields that decide which catalog item or variable set a record's variable must belong to. */
function ownerFields(rule: VariableReferenceRule): string[] {
    return [rule.item, 'variable_set', ...(rule.via ? [rule.via.field] : [])];
}

/** Scoped metadata CRUD. All form work uses the internal FormRecordWriter seam. */
export class MetadataFormWriter {
    public constructor(private _instance: ServiceNowInstance) {}
    public insert(table: string, options: MetadataWriteOptions): Promise<MetadataWriteResult> {
        return this.write('insert', table, '-1', options);
    }
    public update(table: string, sysId: string, options: MetadataWriteOptions): Promise<MetadataWriteResult> {
        return this.write('update', table, sysId, options);
    }
    public delete(table: string, sysId: string, options: MetadataDeleteOptions): Promise<MetadataWriteResult> {
        if (options?.confirm?.table !== table || options?.confirm?.sysId !== sysId) {
            throw new InvalidParameterException('Delete confirmation must match table and sysId');
        }
        return this.write('delete', table, sysId, options);
    }
    /**
     * The catalog variable a write points this record at, checked against the record's item or variable set. undefined when
     * the table has no such field or the write does not set it; '' (no variable) passes as written.
     */
    private async variableReference(reader: MetadataReader, table: string, recordId: string, options: MetadataWriteOptions,
        operation: string): Promise<{ field: string; value: string } | undefined> {
        const rule = VARIABLE_REFERENCES[table];
        const value = rule ? options.fields?.[rule.field] : undefined;
        if (!rule || value === undefined || operation === 'delete') return undefined;
        if (value === '') return { field: rule.field, value: '' };
        const match = typeof value === 'string' ? VARIABLE_REFERENCE.exec(value) : null;
        if (!match) throw new MetadataScopeError('field_not_supported', { field: rule.field, table });
        // The owner the record will have: written now, set by the initial query, or already stored.
        const query = new Map<string, string>();
        for (const term of (options.initialQuery ?? '').split('^').filter(Boolean)) {
            const at = term.indexOf('=');
            query.set(term.slice(0, at), term.slice(at + 1));
        }
        const stored = operation === 'update' ? await reader.exact(table, recordId, ownerFields(rule).join(',')) : undefined;
        const owner = (field: string): string => {
            const written = options.fields?.[field];
            const chosen = written !== undefined ? written : query.has(field) ? query.get(field) : stored?.[field] ?? '';
            // An owner is a sys_id or empty; anything else would be posted as something the check never saw.
            if (typeof chosen !== 'string' || (chosen !== '' && !ID.test(chosen))) throw new MetadataScopeError('field_not_supported', { field, table });
            return chosen;
        };
        await this.requireOwnedVariable(reader, rule, table, match[1], owner);
        return { field: rule.field, value: match[0] };
    }

    /**
     * The variable must belong to the record's catalog item or variable set. A UI policy action takes them from its policy;
     * an item or set of its own that disagrees with the policy is refused.
     */
    private async requireOwnedVariable(reader: MetadataReader, rule: VariableReferenceRule, table: string, variableId: string,
        owner: (field: string) => string): Promise<void> {
        const refuse = (): never => { throw new MetadataScopeError('field_not_supported', { field: rule.field, table }); };
        let item = owner(rule.item);
        let set = owner('variable_set');
        const policy = rule.via ? owner(rule.via.field) : '';
        if (rule.via && policy) {
            const parent = await reader.exact(rule.via.table, policy, `${rule.via.item},variable_set`);
            if (!parent) refuse();
            if ((item && item !== parent[rule.via.item]) || (set && set !== parent.variable_set)) refuse();
            item = parent[rule.via.item] ?? '';
            set = parent.variable_set ?? '';
        }
        const variable = await reader.exact('item_option_new', variableId, 'cat_item,variable_set');
        const belongs = !!variable && ((ID.test(item) && variable.cat_item === item) || (ID.test(set) && variable.variable_set === set));
        if (!belongs) refuse();
    }

    private async table(reader: MetadataReader, table: string, deleting: boolean): Promise<void> {
        const visited = new Set<string>();
        let rows = await reader.rows('sys_db_object', `name=${table}`, 'sys_id,name,super_class');
        if (rows.length !== 1 || rows[0].name !== table) throw new MetadataScopeError('table_not_supported');
        while (rows.length === 1) {
            const row = rows[0];
            if (visited.has(row.sys_id) || WRITE_DENY.has(row.name) || (deleting && DELETE_DENY.has(row.name))) {
                throw new MetadataScopeError('table_not_supported');
            }
            visited.add(row.sys_id);
            if (row.name === 'sys_metadata') return;
            if (!ID.test(row.super_class)) break;
            const parent = await reader.exact('sys_db_object', row.super_class, 'name,super_class');
            rows = parent ? [parent] : [];
        }
        throw new MetadataScopeError('table_not_supported');
    }
    private async write(operation: 'insert' | 'update' | 'delete', table: string, sysId: string,
        options: MetadataWriteOptions | MetadataDeleteOptions): Promise<MetadataWriteResult> {
        if (!NAME.test(table ?? '') || (operation !== 'insert' && !ID.test(sysId ?? ''))) throw new MetadataScopeError('invalid_input');
        if (!options?.scope) throw new MetadataScopeError('scope_required');
        if (options.updateSet !== undefined && !ID.test(options.updateSet)) throw new MetadataScopeError('invalid_input');
        const initialQuery = (options as MetadataWriteOptions).initialQuery;
        if (initialQuery && initialQuery.split('^').some(term => !/^(?!sys_)[a-z0-9_]+=[^^]*$/i.test(term) || /javascript:/i.test(term))) {
            throw new MetadataScopeError('field_not_supported');
        }
        let submitted = false;
        let recordId = sysId;
        let report: Partial<CaptureReport>;
        let messages: string[] = [];
        try {
            const request = SessionManager.getInstance().getRequest(this._instance);
            const reader = new MetadataReader(request);
            const { store, ...scope } = await resolveScope(reader, options.scope);
            if (store && options.storeCustomization?.acknowledgeUpgradeSkip !== true) throw new MetadataScopeError('store_scope');
            if (store && !options.updateSet) throw new MetadataScopeError('update_set_required');
            await this.table(reader, table, operation === 'delete');
            const nameFields = updateNameFields(table);
            let existing: MetadataRow | undefined;
            if (operation !== 'insert') {
                existing = await reader.exact(table, sysId, ['sys_scope', ...(store ? ['sys_policy'] : []), ...nameFields].join(','));
                if (!existing || existing.sys_scope !== scope.sysId) throw new MetadataScopeError('scope_mismatch');
                // A read-only or protected Store file cannot be customized; the form would refuse it anyway.
                if (store && ['read', 'protected'].includes(existing.sys_policy)) throw new MetadataScopeError('protected_record', { table });
            }
            // Use the existing WorkflowManager current-user read pattern on this session.
            const users = await reader.rows('sys_user', 'sys_id=javascript:gs.getUserID()', 'sys_id');
            if (users.length !== 1 || !ID.test(users[0].sys_id)) throw new MetadataScopeError('evidence_unavailable');
            const user = users[0].sys_id;
            const preferences = async (): Promise<MetadataRow[]> => {
                const rows = await reader.rows('sys_user_preference', `user=${user}`, 'sys_id,user,name,value');
                if (rows.some(row => row.user !== user)) throw new MetadataScopeError('evidence_unavailable');
                return rows;
            };
            const before = await preferences();
            const predicted = preferenceValue(before, `updateSetForScope${scope.sysId}`);
            const expected = options.updateSet ?? predicted;
            if (expected !== undefined && !ID.test(expected)) throw new MetadataScopeError('evidence_unavailable');
            if (options.updateSet) {
                const set = await reader.exact('sys_update_set', options.updateSet, 'application,state');
                if (!set || set.state !== 'in progress' || set.application !== scope.sysId) {
                    throw new MetadataScopeError('invalid_input', set ? { updateSetState: set.state, updateSetApplication: set.application } : undefined);
                }
            }
            const transport = createFormTransport(this._instance);
            const form = await transport.loadForm(table, sysId, { ...options,
                query: { sysparm_transaction_scope: scope.sysId, sysparm_isdevstudio: 'true',
                    sysparm_referring_url: `${table}.do`, sysparm_nofocus: 'true',
                    sysparm_nameofstack: `${randomUUID()}_bottomless` },
                captureRenderedInputs: true, tokenSource: 'page', sensitive: true });
            recordId = form.sysId;
            if (!ID.test(recordId) || form.fields[`${table}.sys_scope`]?.value !== scope.sysId ||
                form.renderedInputs?.sysparm_transaction_scope !== scope.sysId) throw new MetadataScopeError('scope_not_applied');
            const writeOptions = options as MetadataWriteOptions;
            for (const field of Object.keys(writeOptions.fields ?? {})) {
                if (!NAME.test(field) || /^sys_/i.test(field) || !form.fields[`${table}.${field}`]) throw new MetadataScopeError('field_not_supported', { field, table });
            }
            const variableReference = await this.variableReference(reader, table, recordId, writeOptions, operation);
            if (variableReference) {
                // As the page's script would: offer the verified option on the control before the form validates it.
                const control = form.fields[`${table}.${variableReference.field}`];
                if (control.choices && !control.choices.some(choice => choice.value === variableReference.value)) {
                    control.choices.push({ value: variableReference.value, label: variableReference.value });
                }
            }
            const action = operation === 'insert' ? 'sysverb_insert_and_stay' : operation === 'update' ? 'sysverb_update' : 'sysverb_delete';
            if (operation !== 'insert' && !form.actions[action]) throw new MetadataScopeError('not_permitted');
            if (operation === 'delete') {
                const actionId = form.actions[action];
                if (!ID.test(actionId)) throw new MetadataScopeError('delete_not_supported');
                const definition = await reader.exact('sys_ui_action', actionId, 'table,action_name,onclick,name');
                if (!definition || definition.table !== 'global' || definition.action_name !== 'sysverb_delete' ||
                    definition.name !== 'Delete' || !/^\s*(?:return\s+)?confirmAndDeleteFromForm\(\);?\s*$/.test(definition.onclick)) {
                    throw new MetadataScopeError('delete_not_supported');
                }
            }
            try { transport.validate(form, options); } catch (error) {
                if (!(error instanceof InvalidParameterException)) throw error;
                // Name the value the form refused: validate the fields one at a time.
                const rejected = Object.keys(writeOptions.fields ?? {}).find(field => {
                    try { transport.validate(form, { fields: { [field]: writeOptions.fields?.[field] ?? null } }); return false; } catch { return true; }
                });
                throw new MetadataScopeError('field_not_supported', rejected ? { field: rejected, table } : undefined);
            }
            // Form GETs are part of the measured interval: never replace the original baseline.
            const loaded = await preferences();
            if (!comparePreferences(before, loaded).valid) throw new MetadataVerificationError('session_changed', table, recordId, undefined, [], false);
            // A new label or choice list is named from the fields being inserted, so that the capture rows that already
            // carry that name are snapshotted before the POST like every other capture; an older row with the name must
            // never count as this write's evidence.
            const fields = (options as MetadataWriteOptions).fields ?? {};
            const insertedNames = Object.fromEntries(nameFields.map(field => [field, typeof fields[field] === 'string' ? fields[field] : '']));
            let captureName = updateName(table, recordId, operation === 'insert' ? insertedNames : existing);
            if (!captureName && operation === 'insert') {
                throw new MetadataScopeError('invalid_input', { table, field: nameFields.find(field => !/^[a-z0-9_]+$/i.test(insertedNames[field])) ?? nameFields[0] });
            }
            if (!captureName) throw new MetadataScopeError('evidence_unavailable');
            const predictedName = captureName;
            const previousCaptures = captureName ? await reader.rows('sys_update_xml', `name=${captureName}`, 'sys_id,name,sys_mod_count') : [];
            if (previousCaptures.some(row => row.name !== captureName || !/^\d+$/.test(row.sys_mod_count))) {
                throw new MetadataScopeError('evidence_unavailable');
            }
            const captureVersions = new Map(previousCaptures.map(row => [row.sys_id, row.sys_mod_count]));
            const started = new Date().toISOString().slice(0, 19).replace('T', ' ');
            submitted = true;
            let submitFailure: unknown;
            try {
                const result = await transport.submit(form, action, { ...options, postAllRenderedInputs: true,
                    tokenSource: 'page', actionValue: operation === 'update' ? form.actions[action] : action,
                    extraFields: { sysparm_transaction_scope: scope.sysId, sysparm_transaction_update_set: options.updateSet ?? '',
                        sysparm_record_scope: '', sysparm_goto_url: '' },
                    redirect: 'manual', landing: 'guarded', sensitive: true });
                messages = [...result.messages, ...(result.errors ?? [])];
            } catch (error) {
                if (isPolicyRefusal(error)) throw error;
                submitFailure = error;
            }
            report = { predictedUpdateSetSysId: predicted };
            // A confirmed interceptor rejection takes precedence, but must not omit obtainable evidence.
            const csrfRejected = submitFailure instanceof Error && submitFailure.message === 'csrf_rejected';
            // Guard interpretation as well as reads so ambiguous evidence cannot mask the rejection.
            const collectEvidence = async <T>(collect: () => T | Promise<T>): Promise<T | undefined> => {
                try { return await collect(); }
                catch (error) {
                    if (isPolicyRefusal(error) || !csrfRejected) throw error;
                    return undefined;
                }
            };
            const record = await collectEvidence(() => reader.exact(table, recordId,
                ['sys_scope', ...nameFields, ...(variableReference ? [variableReference.field, ...ownerFields(VARIABLE_REFERENCES[table])] : [])].join(',')));
            report.recordScope = record?.sys_scope ?? (!csrfRejected && operation === 'delete' ? scope.sysId : undefined);
            // The record as saved must carry the name its capture was snapshotted under.
            if (nameFields.length && record && updateName(table, recordId, record) !== predictedName) captureName = undefined;
            if (captureName) report.updateName = captureName;
            const observedCaptures = captureName ? await collectEvidence(() => reader.rows('sys_update_xml', `name=${captureName}^sys_updated_on>=${started}`,
                'sys_id,name,update_set,application,action,sys_updated_on,sys_mod_count')) ?? [] : [];
            const after = await collectEvidence(preferences);
            const comparison = after ? await collectEvidence(() => comparePreferences(before, after, [predicted, options.updateSet].filter(Boolean))) : undefined;
            if (comparison) Object.assign(report, { preferencesUnchanged: comparison.unchanged, preferenceRowsReplaced: comparison.replaced,
                currentUpdateSet: comparison.currentUpdateSet });
            const captures = observedCaptures.filter(row => captureVersions.get(row.sys_id) !== row.sys_mod_count);
            const fail = (code: ConstructorParameters<typeof MetadataVerificationError>[0]): never => {
                throw new MetadataVerificationError(code, table, recordId, report, messages);
            };
            if (!csrfRejected) {
                if (operation === 'delete' ? !!record : !record) fail(operation === 'delete' ? 'delete_not_applied' : 'write_not_applied');
                if (record && record.sys_scope !== scope.sysId) fail('scope_not_applied');
                if (record && variableReference && record[variableReference.field] !== variableReference.value) fail('write_not_applied');
                // The variable must belong to the owner the record actually saved, not only to the one checked beforehand.
                if (record && variableReference?.value) {
                    const saved = await collectEvidence(async () => {
                        try {
                            await this.requireOwnedVariable(reader, VARIABLE_REFERENCES[table], table, variableReference.value.slice(3), field => record[field] ?? '');
                            return true;
                        } catch (error) {
                            if (error instanceof MetadataScopeError) return false;
                            throw error;
                        }
                    });
                    if (saved === false) fail('write_not_applied');
                }
                if (observedCaptures.some(row => row.name !== captureName || row.sys_updated_on < started || !/^\d+$/.test(row.sys_mod_count))) fail('not_captured');
                if (!captures.length) fail('not_captured');
            }
            for (const capture of captures) {
                if (!ID.test(capture.update_set)) {
                    if (!csrfRejected) fail('not_captured');
                    continue;
                }
                const set = await collectEvidence(() => reader.exact('sys_update_set', capture.update_set, 'name,application'));
                if (!set) {
                    if (!csrfRejected) fail('not_captured');
                    continue;
                }
                Object.assign(report, { updateSetSysId: set.sys_id, updateSetName: set.name, updateSetScope: set.application, action: capture.action });
                if (!csrfRejected) {
                    if (expected && set.sys_id !== expected) fail('captured_elsewhere');
                    if (!options.allowMixedScopeCapture && (set.application !== scope.sysId || capture.application !== scope.sysId)) fail('mixed_scope_capture');
                    if (capture.action !== (operation === 'delete' ? 'DELETE' : 'INSERT_OR_UPDATE')) fail('not_captured');
                }
            }
            if (operation === 'delete') {
                const deleted = await collectEvidence(() => reader.rows('sys_metadata_delete', `sys_metadata=${recordId}^sys_created_on>=${started}`,
                    'sys_id,sys_metadata,sys_scope,sys_created_on'));
                if (!csrfRejected && (!deleted.length || deleted.some(row => row.sys_metadata !== recordId || row.sys_scope !== scope.sysId || row.sys_created_on < started))) fail('delete_not_captured');
            }
            if (store) report.customization = await customizationEvidence(reader, captures.at(-1)?.sys_id, captureName);
            if (csrfRejected) fail('csrf_rejected');
            if (!comparison.valid) fail('session_changed');
            if (submitFailure) fail(submitFailure instanceof Error && submitFailure.message === 'csrf_rejected' ? 'csrf_rejected' : 'verification_unavailable');
            return { table, sysId: recordId, action: operation, scope, capture: report as CaptureReport, messages };
        } catch (error) {
            if (isPolicyRefusal(error) || (!submitted && error instanceof MetadataScopeError) || error instanceof MetadataVerificationError) throw stripSecretsFromError(error);
            if (!submitted && error instanceof Error && error.message === 'csrf_token_unavailable') throw new MetadataScopeError('csrf_token_unavailable');
            if (!submitted && error instanceof Error && error.message === 'form_redirect') {
                throw new MetadataScopeError('form_redirected', { table, redirectPath: (error as Error & { redirectPath?: string }).redirectPath });
            }
            if (!submitted) throw new MetadataScopeError(error instanceof InvalidParameterException ? 'field_not_supported' : 'evidence_unavailable');
            if (error instanceof FormSubmitError) messages = error.messages;
            throw new MetadataVerificationError(error instanceof Error && error.message === 'csrf_rejected' ? 'csrf_rejected' :
                'verification_unavailable', table, recordId, report, messages);
        }
    }
}
