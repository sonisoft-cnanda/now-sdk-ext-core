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
            transport.validate(form, options);
            // Form GETs are part of the measured interval: never replace the original baseline.
            const loaded = await preferences();
            if (!comparePreferences(before, loaded).valid) throw new MetadataVerificationError('session_changed', table, recordId, undefined, [], false);
            // A coalescing name for a new record is only known once the record exists.
            let captureName = updateName(table, recordId, existing);
            if (!captureName && operation !== 'insert') throw new MetadataScopeError('evidence_unavailable');
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
            const record = await collectEvidence(() => reader.exact(table, recordId, ['sys_scope', ...nameFields].join(',')));
            report.recordScope = record?.sys_scope ?? (!csrfRejected && operation === 'delete' ? scope.sysId : undefined);
            captureName ??= updateName(table, recordId, record);
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
