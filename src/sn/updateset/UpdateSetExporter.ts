import { Parser } from 'xml2js';
import { SessionManager } from '../../comm/http/SessionManager';
import type { ServiceNowRequest } from '../../comm/http/ServiceNowRequest';
import { checkRequirement } from '../../policy/Policy';
import { policyRefusal } from '../../policy/PolicyRefusal';
import { READ_ONLY } from '../../policy/PolicyTypes';
import { CSRFTokenHelper } from '../../util/CSRFTokenHelper';
import { BackgroundScriptExecutor } from '../BackgroundScriptExecutor';
import type { ServiceNowInstance } from '../ServiceNowInstance';
import { MetadataScopeError } from '../metadata/MetadataScopeError';
import { MetadataReader, type MetadataRow } from '../metadata/internal/MetadataReader';
import type { ExportedUpdateSet, UpdateSetExportOptions, UpdateSetExportResult } from './UpdateSetExportModels';
import { UpdateSetExportError } from './UpdateSetExportModels';

const ID = /^[a-f0-9]{32}$/;
const MARKER = 'NEX_EXPORT_RESULT=';
const SINGLE = '/export_update_set.do';
const BATCH = '/export_base_update_set.do';
const MAX_DEPTH = 20;

interface Plan {
    source: 'local' | 'retrieved';
    kind: 'single' | 'batch';
    root: MetadataRow;
    sets: ExportedUpdateSet[];
    excluded: MetadataRow[];
}

/**
 * Exports an update set to the XML unload the platform's own UI actions produce, and checks the file.
 *
 * - A local set uses **Export to XML** (`UpdateSetExport.exportUpdateSet`, then `export_update_set.do`).
 * - A local batch base uses **Export Update Set Batch to XML** (`exportHierarchy`, then
 *   `export_base_update_set.do`).
 * - A Retrieved Update Set is a plain read of the same processors with `sysparm_is_remote=true`.
 *
 * A local export copies the set into a temporary Retrieved Update Set (state `loaded`), which the
 * download deletes. Left behind, it would sit under Retrieved Update Sets ready to preview and commit,
 * so the exporter reads it back afterwards, deletes it if the platform did not, and refuses to report
 * success while one remains. The file must hold exactly the expected sets and sys_update_xml rows.
 */
export class UpdateSetExporter {
    private readonly _request: ServiceNowRequest;
    private readonly _reader: MetadataReader;
    /** How long to wait for the platform to finish deleting a temporary copy's rows (about 15 seconds). */
    private readonly _poll = { attempts: 30, delayMs: 500 };

    public constructor(private readonly _instance: ServiceNowInstance) {
        this._request = SessionManager.getInstance().getRequest(_instance);
        this._reader = new MetadataReader(this._request);
    }

    /**
     * Export one update set, a batch base with its children, or a Retrieved Update Set.
     *
     * @param sysId A sys_update_set or sys_remote_update_set sys_id.
     * @throws UpdateSetExportError when the set cannot be exported as asked or the file does not match it.
     */
    public async exportUpdateSet(sysId: string, options: UpdateSetExportOptions = {}): Promise<UpdateSetExportResult> {
        const id = String(sysId ?? '').trim().toLowerCase();
        if (!ID.test(id)) throw new UpdateSetExportError('invalid_input');
        const plan = await this.evidence(() => this.plan(id, options.includeIncomplete === true));
        const token = await this.token();
        const messages: string[] = [];
        if (plan.root.state !== 'complete' && plan.source === 'local') {
            messages.push(`The set is ${plan.root.state}: the file is a snapshot of unfinished work.`);
        }
        if (plan.excluded.length) {
            messages.push(`${plan.excluded.length} batch member(s) that are not Complete were left out, as the platform does; pass includeIncomplete to add them.`);
        }

        if (plan.source === 'retrieved') {
            const xml = await this.download(plan.kind === 'batch' ? BATCH : SINGLE,
                { sysparm_sys_id: id, sysparm_ck: token, sysparm_is_remote: 'true' }, true);
            this.verify(await this.parse(xml), plan, set => set.sysId);
            return this.result(xml, plan, undefined, messages);
        }

        // The script's write is inside the platform's UpdateSetExport, which the script scan cannot see, so it
        // would be sent with execute alone. Its copy is deleted by a download and a cleanup that need write:
        // refuse here, before anything is copied, rather than leave a Loaded copy that cannot be removed.
        const decision = checkRequirement({ verbs: ['execute', 'write'], target: 'instance' });
        if (!decision.allowed) throw policyRefusal(decision);
        const before = await this.evidence(() => this.copies(id));
        const temporary = await this.copy(id, plan.kind === 'batch', options.includeIncomplete === true, before);
        let xml: string | undefined, failure: unknown;
        try {
            xml = await this.download(plan.kind === 'batch' ? BATCH : SINGLE,
                { sysparm_sys_id: temporary, sysparm_ck: token, sysparm_delete_when_done: 'true', sysparm_is_remote: 'false' }, false);
        } catch (error) {
            failure = error;
        }
        const removedBy = await this.cleanup(temporary, failure === undefined);
        if (failure !== undefined) throw failure;
        const parsed = await this.parse(xml);
        this.verify(parsed, plan, set => set.remoteSysId);
        return this.result(xml, plan, { temporarySysId: temporary, removedBy }, messages);
    }

    /** Which sets the platform will put in the file, refusing what its UI would not offer. */
    private async plan(id: string, includeIncomplete: boolean): Promise<Plan> {
        const local = await this._reader.exact('sys_update_set', id, 'name,state,application,parent,base_update_set');
        if (local) {
            const base = local.base_update_set;
            if (base && base !== id) throw new UpdateSetExportError('batch_member', { updateSet: id, base });
            if (local.state !== 'complete' && !includeIncomplete) throw new UpdateSetExportError('update_set_incomplete', { updateSet: id, state: local.state });
            const kind = base === id ? 'batch' : 'single';
            const { included, excluded } = kind === 'batch' ? await this.hierarchy(local, includeIncomplete) : { included: [local], excluded: [] };
            const sets = await Promise.all(included.map(async row => ({ sysId: row.sys_id, name: row.name, state: row.state,
                records: await this.count('sys_update_xml', `update_set=${row.sys_id}`) })));
            return { source: 'local', kind, root: local, sets, excluded };
        }
        const remote = await this._reader.exact('sys_remote_update_set', id, 'name,state,application,remote_base_update_set');
        if (!remote) throw new UpdateSetExportError('update_set_not_found', { updateSet: id });
        const base = remote.remote_base_update_set;
        if (base && base !== id) throw new UpdateSetExportError('batch_member', { updateSet: id, base });
        // The platform offers Export to XML on a Retrieved Update Set only while it is Loaded.
        if (remote.state !== 'loaded') throw new UpdateSetExportError('retrieved_state', { updateSet: id, state: remote.state });
        const kind = base === id ? 'batch' : 'single';
        const members = kind === 'batch'
            ? [remote, ...(await this._reader.rows('sys_remote_update_set', `remote_base_update_set=${id}^sys_id!=${id}`, 'sys_id,name,state'))]
            : [remote];
        const sets = await Promise.all(members.map(async row => ({ sysId: row.sys_id, name: row.name, state: row.state,
            records: await this.count('sys_update_xml', `remote_update_set=${row.sys_id}`) })));
        return { source: 'retrieved', kind, root: remote, sets, excluded: [] };
    }

    /** The sets exportHierarchy walks: children by parent, Complete only unless includeIncomplete. */
    private async hierarchy(base: MetadataRow, includeIncomplete: boolean): Promise<{ included: MetadataRow[]; excluded: MetadataRow[] }> {
        const included = [base], excluded: MetadataRow[] = [];
        let level = [base.sys_id];
        for (let depth = 0; level.length; depth++) {
            if (depth >= MAX_DEPTH) throw new MetadataScopeError('evidence_unavailable');
            const children = await this._reader.rows('sys_update_set', `parentIN${level.join(',')}`, 'sys_id,name,state,parent');
            const next: string[] = [];
            for (const child of children) {
                if (included.some(row => row.sys_id === child.sys_id)) throw new MetadataScopeError('evidence_unavailable');
                if (includeIncomplete || child.state === 'complete') { included.push(child); next.push(child.sys_id); } else excluded.push(child);
            }
            level = next;
        }
        // A left-out child's own children are never visited by the platform either.
        let skipped = excluded.map(row => row.sys_id);
        for (let depth = 0; skipped.length; depth++) {
            if (depth >= MAX_DEPTH) throw new MetadataScopeError('evidence_unavailable');
            const children = await this._reader.rows('sys_update_set', `parentIN${skipped.join(',')}`, 'sys_id,name,state,parent');
            excluded.push(...children);
            skipped = children.map(row => row.sys_id);
        }
        return { included, excluded };
    }

    /** Make the temporary copy with the platform's own UpdateSetExport, as the UI action does. */
    private async copy(id: string, batch: boolean, includeIncomplete: boolean, before: string[]): Promise<string> {
        const literal = JSON.stringify({ id, batch, onlyCompleted: !includeIncomplete });
        const script = `(function () {
            var P = ${literal};
            function out(value) { gs.print('${MARKER}' + JSON.stringify(value)); }
            var set = new GlideRecord('sys_update_set');
            if (!set.get(P.id)) { out({ error: 'not_found' }); return; }
            var exporter = new UpdateSetExport();
            exporter.onlyIncludeCompletedChildren = P.onlyCompleted;
            out({ id: String(P.batch ? exporter.exportHierarchy(set) : exporter.exportUpdateSet(set)) });
        })();`;
        let lines: string[];
        try {
            const result = await new BackgroundScriptExecutor(this._instance, 'global').executeScript(script, 'global', this._instance);
            lines = [...(result.scriptResults ?? []).map(line => line.line), ...(result.consoleResult ?? [])].map(decode);
        } catch (error) {
            return await this.leftovers(id, before, error);
        }
        const line = lines.find(text => text.includes(MARKER));
        let value: { id?: unknown; error?: unknown } | undefined;
        try { value = line ? JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length)) as typeof value : undefined; } catch { value = undefined; }
        if (typeof value?.id === 'string' && ID.test(value.id)) return value.id;
        if (value?.error === 'not_found') throw new UpdateSetExportError('update_set_not_found', { updateSet: id });
        return await this.leftovers(id, before, new UpdateSetExportError('script_result_unavailable', { updateSet: id }));
    }

    /**
     * The script's result is unknown: report any copy of this set that appeared meanwhile instead of
     * deleting it, because another session may be exporting the same set.
     */
    private async leftovers(id: string, before: string[], error: unknown): Promise<never> {
        let after: string[];
        try { after = await this.copies(id); } catch { throw error; }
        const copies = after.filter(sysId => !before.includes(sysId));
        if (!copies.length) throw error;
        // A batch copy's children carry their own remote_sys_id; they point at the copied base instead.
        let children: string[] = [];
        try {
            children = (await this._reader.rows('sys_remote_update_set', `remote_base_update_setIN${copies.join(',')}`, 'sys_id')).map(row => row.sys_id);
        } catch { /* report the copies found so far */ }
        const temporary = [...new Set([...copies, ...children])];
        throw new UpdateSetExportError(error instanceof UpdateSetExportError ? error.code : 'script_result_unavailable', { updateSet: id, temporary });
    }

    /** Retrieved Update Set copies of a local set, by remote_sys_id. */
    private async copies(id: string): Promise<string[]> {
        return (await this._reader.rows('sys_remote_update_set', `remote_sys_id=${id}`, 'sys_id')).map(row => row.sys_id);
    }

    private async download(path: string, query: Record<string, string>, readOnly: boolean): Promise<string> {
        const response = await this._request.get<string>({ path, query, body: null, responseFormat: 'text', sensitive: true,
            headers: { Accept: 'application/xml, text/xml, */*' }, ...(readOnly ? { requires: READ_ONLY } : {}) });
        const xml = typeof response.data === 'string' ? response.data : '';
        if (response.status !== 200 || !xml.trim()) throw new UpdateSetExportError('export_failed', { status: response.status });
        return xml;
    }

    /**
     * Remove the temporary copy if the download did not, and prove that neither it nor its rows remain.
     * The platform's delete runs after the download returns: live, a batch's copies and a set's rows were
     * still readable at first. So after a good download the exporter waits for the platform before
     * deleting anything itself, and a delete that races the platform's is settled by the read-back.
     */
    private async cleanup(temporary: string, downloaded: boolean): Promise<'platform' | 'nex'> {
        const query = `sys_id=${temporary}^ORremote_base_update_set=${temporary}`;
        let sets: string[] = [temporary];
        const remaining = async () => {
            const found = (await this._reader.rows('sys_remote_update_set', query, 'sys_id')).map(row => row.sys_id);
            sets = [...new Set([...sets, ...found])];
            return { found, rows: await this.count('sys_update_xml', `remote_update_setIN${sets.join(',')}`) };
        };
        const settle = async (left: { found: string[]; rows: number }) => {
            for (let attempt = 1; (left.found.length || left.rows) && attempt < this._poll.attempts; attempt++) {
                await new Promise(resolve => setTimeout(resolve, this._poll.delayMs));
                left = await remaining();
            }
            return left;
        };
        let removedBy: 'platform' | 'nex' = 'platform';
        let left: { found: string[]; rows: number };
        try {
            left = await remaining();
            if (downloaded) left = await settle(left);
            if (left.found.length) {
                removedBy = 'nex';
                // Children first; deleting a Retrieved Update Set deletes its sys_update_xml rows.
                for (const sysId of [...left.found.filter(sysId => sysId !== temporary), ...left.found.filter(sysId => sysId === temporary)]) {
                    try { await this._request.delete({ path: `/api/now/table/sys_remote_update_set/${sysId}`, headers: null, query: null, body: null }); }
                    catch { /* the read-back decides */ }
                }
                left = await settle(await remaining());
            }
        } catch {
            throw new UpdateSetExportError('cleanup_unverified', { temporary: sets });
        }
        if (left.found.length || left.rows) throw new UpdateSetExportError('cleanup_unverified', { temporary: sets });
        return removedBy;
    }

    private async parse(xml: string): Promise<ParsedUnload> {
        let document: { unload?: Record<string, unknown> };
        // xml2js ships no types that the type-aware lint can resolve (as in XMLRecordManager).
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        try { document = await new Parser({ explicitArray: true }).parseStringPromise(xml); } catch {
            throw new UpdateSetExportError('export_mismatch');
        }
        const unload = document?.unload;
        if (!unload || typeof unload !== 'object') throw new UpdateSetExportError('export_mismatch');
        const unexpected = Object.keys(unload).filter(key => !['$', 'sys_remote_update_set', 'sys_update_xml'].includes(key));
        if (unexpected.length) throw new UpdateSetExportError('export_mismatch');
        const sets = new Map<string, { sysId: string; remoteSysId: string }>();
        for (const element of array(unload.sys_remote_update_set)) {
            const sysId = text(field(element, 'sys_id'));
            if (!ID.test(sysId)) throw new UpdateSetExportError('export_mismatch');
            // The batch processor writes the base twice; the same row, imported once.
            sets.set(sysId, { sysId, remoteSysId: text(field(element, 'remote_sys_id')) });
        }
        const records = array(unload.sys_update_xml).map(element => text(field(element, 'remote_update_set')));
        return { sets: [...sets.values()], records };
    }

    /** The file holds exactly the planned sets, each with its own number of sys_update_xml rows. */
    private verify(parsed: ParsedUnload, plan: Plan, source: (set: { sysId: string; remoteSysId: string }) => string): void {
        const expected = plan.sets.reduce((sum, set) => sum + set.records, 0);
        const mismatch = () => new UpdateSetExportError('export_mismatch', { updateSet: plan.root.sys_id, expected, actual: parsed.records.length });
        if (parsed.sets.length !== plan.sets.length) throw mismatch();
        for (const set of plan.sets) {
            const inFile = parsed.sets.filter(entry => source(entry) === set.sysId);
            if (inFile.length !== 1) throw mismatch();
            if (parsed.records.filter(owner => owner === inFile[0].sysId).length !== set.records) throw mismatch();
        }
        if (parsed.records.length !== expected) throw mismatch();
    }

    private result(xml: string, plan: Plan, cleanup: UpdateSetExportResult['cleanup'], messages: string[]): UpdateSetExportResult {
        const root = plan.root;
        return { xml, source: plan.source, kind: plan.kind,
            updateSet: { sysId: root.sys_id, name: root.name, state: root.state, application: root.application },
            sets: plan.sets, excluded: plan.excluded.map(row => ({ sysId: row.sys_id, name: row.name, state: row.state })),
            recordCount: plan.sets.reduce((sum, set) => sum + set.records, 0), ...(cleanup ? { cleanup } : {}), messages };
    }

    private async token(): Promise<string> {
        const response = await this._request.get<string>({ path: '/upload.do', headers: null, query: null, body: null, responseFormat: 'text',
            requires: READ_ONLY, sensitive: true });
        const token = response.status === 200 && typeof response.data === 'string' ? CSRFTokenHelper.extractCSRFToken(response.data) : null;
        if (!token) throw new UpdateSetExportError('evidence_unavailable', { status: response.status });
        return token;
    }

    /** sys_update_xml counts come from the Stats API: a set can hold more rows than a paged read allows. */
    private async count(table: string, query: string): Promise<number> {
        const response = await this._request.get<{ result?: { stats?: { count?: string } } }>({ path: `/api/now/stats/${table}`,
            headers: { Accept: 'application/json' }, body: null, requires: READ_ONLY, query: { sysparm_query: query, sysparm_count: 'true' } });
        const count = Number(response.bodyObject?.result?.stats?.count);
        if (response.status !== 200 || !Number.isSafeInteger(count) || count < 0) throw new UpdateSetExportError('evidence_unavailable');
        return count;
    }

    /** Reads raise MetadataScopeError('evidence_unavailable'); export callers see their own code. */
    private async evidence<T>(read: () => Promise<T>): Promise<T> {
        try { return await read(); } catch (error) {
            if (error instanceof MetadataScopeError) throw new UpdateSetExportError('evidence_unavailable');
            throw error;
        }
    }
}

interface ParsedUnload {
    sets: Array<{ sysId: string; remoteSysId: string }>;
    /** The owning sys_remote_update_set of each sys_update_xml element. */
    records: string[];
}

function array(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

function field(element: Record<string, unknown>, name: string): unknown {
    return element && typeof element === 'object' ? element[name] : undefined;
}

/** xml2js gives `['id']`, `[{ _: 'id', $: {...} }]` or `[{ $: {...} }]` for an empty element. */
function text(value: unknown): string {
    if (Array.isArray(value)) return text(value[0]);
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object' && typeof (value as { _?: unknown })._ === 'string') return (value as { _: string })._.trim();
    return '';
}

function decode(text: string): string {
    return String(text ?? '').replace(/<BR\/?>/gi, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}
