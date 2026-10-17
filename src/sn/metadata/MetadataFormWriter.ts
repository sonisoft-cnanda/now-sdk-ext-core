import { randomUUID } from 'node:crypto';
import { InvalidParameterException } from '../../exception/InvalidParameterException';
import { FormSubmitError } from '../../exception/FormSubmitError';
import { createFormTransport } from '../../comm/http/FormRecordWriter';
import { SessionManager } from '../../comm/http/SessionManager';
import { isPolicyRefusal } from '../../policy/PolicyRefusal';
import { stripSecretsFromError } from '../../util/redact';
import type { ServiceNowInstance } from '../ServiceNowInstance';
import type { MetadataScopeRef, MetadataWriteOptions, MetadataDeleteOptions, MetadataWriteResult, CaptureReport } from './MetadataModels';
import { MetadataScopeError } from './MetadataScopeError';
import { MetadataVerificationError } from './MetadataVerificationError';
import { MetadataReader, MetadataRow } from './internal/MetadataReader';
import { comparePreferences, preferenceValue } from './internal/MetadataPreferences';

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
    private async scope(reader: MetadataReader, ref: MetadataScopeRef): Promise<{ sysId: string; scope: string }> {
        if (!ref) throw new MetadataScopeError('scope_required');
        const id = ref === 'global' ? 'global' : typeof ref === 'object' && 'sysId' in ref ? ref.sysId : undefined;
        const name = typeof ref === 'object' && 'scope' in ref ? ref.scope : undefined;
        if (id ? id !== 'global' && !ID.test(id) : !name || !NAME.test(name) || name === 'global') {
            throw new MetadataScopeError('invalid_input');
        }
        const rows = await reader.rows('sys_scope', id ? `sys_id=${id}` : `scope=${name}^active=true`, 'sys_id,scope,active,sys_class_name');
        if (rows.some(row => id ? row.sys_id !== id : row.scope !== name)) throw new MetadataScopeError('evidence_unavailable');
        if (!rows.length) throw new MetadataScopeError('scope_unknown');
        if (rows.length !== 1) throw new MetadataScopeError('scope_ambiguous');
        const app = rows[0];
        if ((!id && app.active !== 'true') || !app.scope || (app.sys_id !== 'global' && !ID.test(app.sys_id))) throw new MetadataScopeError('evidence_unavailable');
        if (app.sys_class_name === 'sys_store_app') throw new MetadataScopeError('store_scope');
        if (await reader.exact('sys_store_app', app.sys_id, 'scope')) throw new MetadataScopeError('store_scope');
        return { sysId: app.sys_id, scope: app.scope };
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
            const scope = await this.scope(reader, options.scope);
            await this.table(reader, table, operation === 'delete');
            if (operation !== 'insert') {
                const record = await reader.exact(table, sysId, 'sys_scope');
                if (!record || record.sys_scope !== scope.sysId) throw new MetadataScopeError('scope_mismatch');
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
                if (!set || set.state !== 'in progress' || set.application !== scope.sysId) throw new MetadataScopeError('invalid_input');
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
                if (!NAME.test(field) || /^sys_/i.test(field) || !form.fields[`${table}.${field}`]) throw new MetadataScopeError('field_not_supported');
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
            const previousCaptures = await reader.rows('sys_update_xml', `name=${table}_${recordId}`,
                'sys_id,name,sys_mod_count');
            if (previousCaptures.some(row => row.name !== `${table}_${recordId}` || !/^\d+$/.test(row.sys_mod_count))) {
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
            const readBack = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
                try { return await read(); }
                catch (error) {
                    if (isPolicyRefusal(error) || !csrfRejected) throw error;
                    return undefined;
                }
            };
            const record = await readBack(() => reader.exact(table, recordId, 'sys_scope'));
            report.recordScope = operation === 'delete' ? scope.sysId : record?.sys_scope;
            const observedCaptures = await readBack(() => reader.rows('sys_update_xml', `name=${table}_${recordId}^sys_updated_on>=${started}`,
                'sys_id,name,update_set,application,action,sys_updated_on,sys_mod_count')) ?? [];
            const after = await readBack(preferences);
            const comparison = after ? comparePreferences(before, after, [predicted, options.updateSet].filter(Boolean)) : undefined;
            if (comparison) Object.assign(report, { preferencesUnchanged: comparison.unchanged, preferenceRowsReplaced: comparison.replaced,
                currentUpdateSet: comparison.currentUpdateSet });
            const captures = observedCaptures.filter(row => captureVersions.get(row.sys_id) !== row.sys_mod_count);
            const sets = new Map<string, MetadataRow>();
            for (const capture of captures) {
                if (!ID.test(capture.update_set)) continue;
                const set = await readBack(() => reader.exact('sys_update_set', capture.update_set, 'name,application'));
                if (set) {
                    sets.set(capture.update_set, set);
                    Object.assign(report, { updateSetSysId: set.sys_id, updateSetName: set.name, updateSetScope: set.application, action: capture.action });
                }
            }
            const deleted = operation === 'delete' ? await readBack(() => reader.rows('sys_metadata_delete',
                `sys_metadata=${recordId}^sys_created_on>=${started}`, 'sys_id,sys_metadata,sys_scope,sys_created_on')) : undefined;
            const fail = (code: ConstructorParameters<typeof MetadataVerificationError>[0]): never => {
                throw new MetadataVerificationError(code, table, recordId, report, messages);
            };
            if (csrfRejected) fail('csrf_rejected');
            if (operation === 'delete' ? !!record : !record) fail(operation === 'delete' ? 'delete_not_applied' : 'write_not_applied');
            if (record && record.sys_scope !== scope.sysId) fail('scope_not_applied');
            if (observedCaptures.some(row => row.name !== `${table}_${recordId}` || row.sys_updated_on < started || !/^\d+$/.test(row.sys_mod_count))) fail('not_captured');
            if (!captures.length) fail('not_captured');
            for (const capture of captures) {
                if (!ID.test(capture.update_set)) fail('not_captured');
                const set = sets.get(capture.update_set);
                if (!set) fail('not_captured');
                if (expected && set.sys_id !== expected) fail('captured_elsewhere');
                if (!options.allowMixedScopeCapture && (set.application !== scope.sysId || capture.application !== scope.sysId)) fail('mixed_scope_capture');
                if (capture.action !== (operation === 'delete' ? 'DELETE' : 'INSERT_OR_UPDATE')) fail('not_captured');
            }
            if (operation === 'delete') {
                if (!deleted.length || deleted.some(row => row.sys_metadata !== recordId || row.sys_scope !== scope.sysId || row.sys_created_on < started)) fail('delete_not_captured');
            }
            if (!comparison.valid) fail('session_changed');
            if (submitFailure) fail(submitFailure instanceof Error && submitFailure.message === 'csrf_rejected' ? 'csrf_rejected' : 'verification_unavailable');
            return { table, sysId: recordId, action: operation, scope, capture: report as CaptureReport, messages };
        } catch (error) {
            if (isPolicyRefusal(error) || (!submitted && error instanceof MetadataScopeError) || error instanceof MetadataVerificationError) throw stripSecretsFromError(error);
            if (!submitted && error instanceof Error && error.message === 'csrf_token_unavailable') throw new MetadataScopeError('csrf_token_unavailable');
            if (!submitted) throw new MetadataScopeError(error instanceof InvalidParameterException ? 'field_not_supported' : 'evidence_unavailable');
            if (error instanceof FormSubmitError) messages = error.messages;
            throw new MetadataVerificationError(error instanceof Error && error.message === 'csrf_rejected' ? 'csrf_rejected' :
                'verification_unavailable', table, recordId, report, messages);
        }
    }
}
