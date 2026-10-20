import { SessionManager } from '../../comm/http/SessionManager';
import type { ServiceNowRequest } from '../../comm/http/ServiceNowRequest';
import { BackgroundScriptExecutor } from '../BackgroundScriptExecutor';
import type { ServiceNowInstance } from '../ServiceNowInstance';
import { MetadataReader, type MetadataRow } from '../metadata/internal/MetadataReader';
import type { CompleteUpdateSetOptions, CreateScopedUpdateSetOptions, MoveCaptureOptions, MoveCaptureResult,
    UpdateSetSummary, UseUpdateSetOptions, UseUpdateSetResult, WorkingSet, RestoreWorkingSetResult } from './WorkingSetModels';
import { WorkingSetError } from './WorkingSetModels';

const ID = /^[a-f0-9]{32}$/;
const MARKER = 'NEX_WORKING_SET_RESULT=';

/**
 * Update-set lifecycle for changes in any application, including installed Store applications and
 * Global: create a set that really belongs to the application, make it the user's working set in
 * every later session, move one capture into it, complete it, and restore the previous working set.
 *
 * Every step reads its outcome back and throws {@link WorkingSetError} rather than report success
 * it did not observe. Only creating a set and saving the working-set preferences run as background
 * scripts: the Table API drops sys_update_set.application, and no API persists apps.current_app.
 */
export class WorkingSetManager {
    private readonly _request: ServiceNowRequest;
    private readonly _reader: MetadataReader;

    public constructor(private readonly _instance: ServiceNowInstance) {
        this._request = SessionManager.getInstance().getRequest(_instance);
        this._reader = new MetadataReader(this._request);
    }

    /** The authenticated user's current application and update set. */
    public async getWorkingSet(): Promise<WorkingSet> {
        const user = await this.user();
        const rows = await this._reader.rows('sys_user_preference', `user=${user}^nameINapps.current_app,sys_update_set`, 'sys_id,user,name,value');
        const value = (name: string) => {
            const values = [...new Set(rows.filter(row => row.user === user && row.name === name).map(row => row.value))];
            if (values.length > 1) throw new WorkingSetError('evidence_unavailable');
            return values[0] ?? '';
        };
        return { application: value('apps.current_app'), updateSet: value('sys_update_set') };
    }

    /** Read one update set. */
    public async getUpdateSet(sysId: string): Promise<UpdateSetSummary> {
        if (!ID.test(sysId ?? '')) throw new WorkingSetError('invalid_input');
        const row = await this._reader.exact('sys_update_set', sysId, 'name,state,application,is_default');
        if (!row) throw new WorkingSetError('update_set_not_found');
        return summary(row);
    }

    /** Create an In progress set whose application is verified to be the requested one. */
    public async createUpdateSet(options: CreateScopedUpdateSetOptions): Promise<UpdateSetSummary> {
        const name = options?.name?.trim() ?? '';
        if (!name || name.length > 80 || /\p{Cc}/u.test(name) || /\p{Cc}/u.test(options.description ?? '')) throw new WorkingSetError('invalid_input');
        const application = await this.application(options.application);
        // The duplicate check runs with addQuery inside the script: the caller's name never becomes encoded-query text,
        // where '^' would split it and a javascript: term would run on the server.
        const created = await this.script(`
            var open = new GlideRecord('sys_update_set');
            open.addQuery('name', P.name);
            open.addQuery('application', P.application);
            open.addQuery('state', 'in progress');
            open.setLimit(1);
            open.query();
            if (open.hasNext()) { out({ exists: true }); return; }
            var set = new GlideRecord('sys_update_set');
            set.initialize();
            set.setValue('name', P.name);
            set.setValue('state', 'in progress');
            set.setValue('application', P.application);
            if (P.description) set.setValue('description', P.description);
            var id = set.insert();
            out({ sys_id: id ? '' + id : '' });`, { name, application, description: options.description ?? '' });
        if (created.exists === true) throw new WorkingSetError('update_set_exists');
        const createdId = typeof created.sys_id === 'string' ? created.sys_id : '';
        if (!ID.test(createdId)) throw new WorkingSetError('create_not_applied');
        const set = await this.getUpdateSet(createdId);
        if (set.application !== application || set.state !== 'in progress' || set.name !== name) {
            throw new WorkingSetError('application_not_applied', { updateSet: set.sysId, application: set.application });
        }
        return set;
    }

    /**
     * Make an In progress set the user's working set in every later session: apps.current_app,
     * sys_update_set and updateSetForScope<application> are saved and read back. A Default is
     * refused unless `allowDefault` (for restoring a previous context only).
     */
    public async useUpdateSet(sysId: string, options: UseUpdateSetOptions = {}): Promise<UseUpdateSetResult> {
        const set = await this.getUpdateSet(sysId);
        if (set.state !== 'in progress') throw new WorkingSetError('update_set_closed', { updateSet: set.sysId, state: set.state });
        if (set.isDefault && !options.allowDefault) throw new WorkingSetError('default_update_set', { updateSet: set.sysId });
        const previous = await this.getWorkingSet();
        try {
            return { previous, current: await this.persist(set.application, set.sysId), updateSet: set };
        } catch (error) {
            // The preferences may already have changed: the caller needs the pair to put back.
            if (error instanceof WorkingSetError) throw new WorkingSetError(error.code, { ...error.detail, previous });
            throw new WorkingSetError('working_set_not_applied', { updateSet: set.sysId, previous });
        }
    }

    /**
     * Put back a working set returned by {@link useUpdateSet}. When its set has closed since, the
     * application's single In progress Default is used instead and reported as the fallback.
     */
    public async restoreWorkingSet(previous: WorkingSet): Promise<RestoreWorkingSetResult> {
        // A user with no saved preference reads back as '': the platform's own default is Global and its Default set.
        const requested = previous?.application === '' ? 'global' : previous?.application;
        const application = requested === 'global' || ID.test(requested ?? '') ? requested : undefined;
        const updateSet = previous?.updateSet ?? '';
        if (!application || (updateSet !== '' && !ID.test(updateSet))) throw new WorkingSetError('invalid_input');
        let set: UpdateSetSummary | undefined;
        if (updateSet) {
            try { set = await this.getUpdateSet(updateSet); } catch (error) {
                if (!(error instanceof WorkingSetError && error.code === 'update_set_not_found')) throw error;
            }
        }
        if (set && set.application !== application) throw new WorkingSetError('scope_mismatch', { application, updateSet: set.sysId });
        if (set?.state === 'in progress') return { restored: await this.persist(application, set.sysId) };
        const defaults = await this._reader.rows('sys_update_set', `application=${application}^is_default=true^state=in progress`, 'sys_id,application');
        if (defaults.length !== 1 || defaults[0].application !== application) throw new WorkingSetError('no_single_default', { application });
        return { restored: await this.persist(application, defaults[0].sys_id), fallback: 'application_default' };
    }

    /**
     * Move one capture between two In progress sets of the same application, as the platform's
     * "Handle updates moving between sets" rule allows, and read the move back. Refused before the
     * move when the scopes differ, the target is a Default, the target already holds a capture of
     * the same record, or a newer capture of the same record exists elsewhere.
     */
    public async moveCapture(options: MoveCaptureOptions): Promise<MoveCaptureResult> {
        const { capture, sourceSet, targetSet } = options ?? {} as MoveCaptureOptions;
        if (![capture, sourceSet, targetSet].every(id => ID.test(id ?? '')) || sourceSet === targetSet) throw new WorkingSetError('invalid_input');
        if (/[^\p{L}\p{N} .,:;()/_-]/u.test(options.reason ?? '') || !options.reason?.trim()) throw new WorkingSetError('invalid_input');
        const row = await this._reader.exact('sys_update_xml', capture, 'name,update_set,application,sys_recorded_at,comments');
        if (!row || row.update_set !== sourceSet) throw new WorkingSetError('capture_not_in_source', { capture });
        const [source, target] = [await this.getUpdateSet(sourceSet), await this.getUpdateSet(targetSet)];
        if (source.state !== 'in progress' || target.state !== 'in progress') throw new WorkingSetError('update_set_closed', { updateSet: source.state !== 'in progress' ? source.sysId : target.sysId });
        if (target.isDefault) throw new WorkingSetError('default_update_set', { updateSet: target.sysId });
        if (target.application !== row.application) throw new WorkingSetError('scope_mismatch', { application: row.application, updateSet: target.sysId });
        const same = await this._reader.rows('sys_update_xml', `name=${row.name}`, 'sys_id,name,update_set,sys_recorded_at');
        if (same.some(other => other.name !== row.name)) throw new WorkingSetError('evidence_unavailable');
        if (same.some(other => other.update_set === targetSet)) throw new WorkingSetError('duplicate_capture', { updateSet: targetSet });
        if (same.some(other => other.sys_id !== capture && other.sys_recorded_at >= row.sys_recorded_at)) throw new WorkingSetError('newer_capture_exists', { capture });
        const comments = [row.comments, `Moved to ${target.name}: ${options.reason.trim()}`].filter(Boolean).join('\n');
        const response = await this._request.put<unknown>({ path: `/api/now/table/sys_update_xml/${capture}`, method: 'PUT',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, query: { sysparm_fields: 'sys_id' },
            body: null, json: { update_set: targetSet, comments } });
        const after = await this._reader.exact('sys_update_xml', capture, 'update_set,application');
        if (after?.update_set !== targetSet) throw new WorkingSetError('move_not_applied', { capture, status: response?.status });
        return { capture, name: row.name, application: row.application, from: source, to: target };
    }

    /**
     * Mark a set Complete after checking that it holds exactly `expectedCaptures` rows, all of the
     * set's own application, one per record, and that no other user is working in it. Reads the
     * state back. The caller restores its own working set afterwards ({@link restoreWorkingSet}).
     */
    public async completeUpdateSet(sysId: string, options: CompleteUpdateSetOptions): Promise<UpdateSetSummary> {
        if (!Number.isSafeInteger(options?.expectedCaptures) || options.expectedCaptures < 0) throw new WorkingSetError('invalid_input');
        const set = await this.getUpdateSet(sysId);
        if (set.state !== 'in progress') throw new WorkingSetError('update_set_closed', { updateSet: set.sysId, state: set.state });
        if (set.isDefault) throw new WorkingSetError('default_update_set', { updateSet: set.sysId });
        const rows = await this._reader.rows('sys_update_xml', `update_set=${sysId}`, 'sys_id,name,update_set,application');
        if (rows.some(row => row.update_set !== sysId)) throw new WorkingSetError('evidence_unavailable');
        if (rows.length !== options.expectedCaptures) throw new WorkingSetError('capture_count_mismatch', { expected: options.expectedCaptures, actual: rows.length });
        const strays = rows.filter(row => row.application !== set.application);
        if (strays.length) throw new WorkingSetError('mixed_scope_capture', { captures: strays.map(row => row.sys_id) });
        const names = rows.map(row => row.name);
        if (new Set(names).size !== names.length) throw new WorkingSetError('duplicate_capture', { updateSet: sysId });
        const user = await this.user();
        // Another user's current set, or the set remembered for the application, both still capture into it.
        const users = await this._reader.rows('sys_user_preference', `name=sys_update_set^ORnameSTARTSWITHupdateSetForScope^value=${sysId}`, 'sys_id,user,name,value');
        if (users.some(row => row.user !== user)) throw new WorkingSetError('update_set_in_use', { updateSet: sysId });
        await this._request.put<unknown>({ path: `/api/now/table/sys_update_set/${sysId}`, method: 'PUT',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, query: { sysparm_fields: 'sys_id' },
            body: null, json: { state: 'complete' } });
        const completed = await this.getUpdateSet(sysId);
        if (completed.state !== 'complete') throw new WorkingSetError('complete_not_applied', { updateSet: sysId, state: completed.state });
        // A capture that arrived between the checks and the state change is in the completed set: say so.
        const final = await this._reader.rows('sys_update_xml', `update_set=${sysId}`, 'sys_id,update_set');
        if (final.length !== rows.length || final.some(row => !rows.some(checked => checked.sys_id === row.sys_id))) {
            throw new WorkingSetError('capture_count_mismatch', { updateSet: sysId, state: completed.state, expected: rows.length, actual: final.length });
        }
        return completed;
    }

    private async user(): Promise<string> {
        const users = await this._reader.rows('sys_user', 'sys_id=javascript:gs.getUserID()', 'sys_id');
        if (users.length !== 1 || !ID.test(users[0].sys_id)) throw new WorkingSetError('evidence_unavailable');
        return users[0].sys_id;
    }

    /** The value a set of this application carries in sys_update_set.application. */
    private async application(ref: string): Promise<string> {
        if (ref === 'global') return 'global';
        if (!ID.test(ref ?? '') && !/^[a-z0-9_]{1,40}$/i.test(ref ?? '')) throw new WorkingSetError('invalid_input');
        // A scope name must resolve to exactly one active application; scope strings are not unique.
        const scopes = ID.test(ref) ? await this._reader.rows('sys_scope', `sys_id=${ref}`, 'sys_id,scope')
            : await this._reader.rows('sys_scope', `scope=${ref}^active=true`, 'sys_id,scope');
        if (scopes.length !== 1) throw new WorkingSetError(scopes.length ? 'invalid_input' : 'application_not_found', ID.test(ref) ? { application: ref } : undefined);
        return scopes[0].scope === 'global' ? 'global' : scopes[0].sys_id;
    }

    private async persist(application: string, updateSet: string): Promise<WorkingSet> {
        await this.script(`
            gs.getUser().savePreference('apps.current_app', P.application);
            gs.setCurrentApplicationId(P.application);
            new GlideUpdateSet().set(P.updateSet);
            out({ ok: true });`, { application, updateSet });
        const after = await this.getWorkingSet();
        const user = await this.user();
        const scoped = await this._reader.rows('sys_user_preference', `user=${user}^name=updateSetForScope${application}`, 'sys_id,user,name,value');
        if (after.application !== application || after.updateSet !== updateSet || !scoped.length || scoped.some(row => row.value !== updateSet)) {
            throw new WorkingSetError('working_set_not_applied', { application: after.application, updateSet: after.updateSet });
        }
        return after;
    }

    /** Run a global background script with JSON parameters `P`; `out(value)` returns one JSON result. */
    private async script(body: string, params: Record<string, string>): Promise<Record<string, unknown>> {
        const literal = JSON.stringify(params).replace(/[\u2028\u2029<>]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
        const script = `(function () {
            var P = ${literal};
            function out(value) { gs.print('${MARKER}' + JSON.stringify(value)); }
            ${body}
        })();`;
        const result = await new BackgroundScriptExecutor(this._instance, 'global').executeScript(script, 'global', this._instance);
        const lines = [...(result.scriptResults ?? []).map(line => line.line), ...(result.consoleResult ?? [])];
        const line = lines.map(decode).find(text => text.includes(MARKER));
        if (!line) throw new WorkingSetError('script_result_unavailable');
        try { return JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length)) as Record<string, unknown>; }
        catch { throw new WorkingSetError('script_result_unavailable'); }
    }
}

function decode(text: string): string {
    return String(text ?? '').replace(/<BR\/?>/gi, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

function summary(row: MetadataRow): UpdateSetSummary {
    return { sysId: row.sys_id, name: row.name, state: row.state, application: row.application,
        isDefault: row.is_default === 'true' || row.is_default === '1' };
}
