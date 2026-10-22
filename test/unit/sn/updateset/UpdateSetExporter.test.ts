import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { UpdateSetExporter } from '../../../../src/sn/updateset/UpdateSetExporter';
import { UpdateSetExportError } from '../../../../src/sn/updateset/UpdateSetExportModels';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { BackgroundScriptExecutor } from '../../../../src/sn/BackgroundScriptExecutor';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { isPolicyRefusal, policyRefusal } from '../../../../src/policy/PolicyRefusal';
import { denyLayer, grantLayer, installPolicy, resetPolicyForTests } from '../../../../src/policy/Policy';
import { READ_ONLY } from '../../../../src/policy/PolicyTypes';

const SET = '1'.repeat(32), BASE = '2'.repeat(32), CHILD = '3'.repeat(32), WIP = '4'.repeat(32), GRAND = '5'.repeat(32);
const OPEN = '6'.repeat(32), REMOTE = '7'.repeat(32), RBASE = '8'.repeat(32), RCHILD = '9'.repeat(32), APP = 'a'.repeat(32);
type Row = Record<string, string>;
let db: Record<string, Row[]>;
let req: { get: jest.Mock<any>; delete: jest.Mock<any> };
let script: jest.SpiedFunction<BackgroundScriptExecutor['executeScript']>;
let platform: { keepCopy?: boolean; dropRecord?: boolean; status?: number; body?: string; extraElement?: boolean; deleteStatus?: number;
    noResult?: boolean; copyWithoutResult?: boolean; linger?: number };
let serial = 0;
let exporter: UpdateSetExporter;

function matchesTerm(row: Row, term: string): boolean {
    const inMatch = term.match(/^(\w+)IN(.*)$/);
    if (inMatch) return inMatch[2].split(',').includes(row[inMatch[1]] ?? '');
    const not = term.match(/^(\w+)!=(.*)$/);
    if (not) return (row[not[1]] ?? '') !== not[2];
    const [field, value] = term.split('=');
    return (row[field] ?? '') === value;
}
function matches(row: Row, query: string): boolean {
    const groups: string[][] = [];
    for (const term of query.split('^').filter(item => item && !item.startsWith('ORDERBY'))) {
        if (term.startsWith('OR') && groups.length) groups.at(-1)!.push(term.slice(2)); else groups.push([term]);
    }
    return groups.every(group => group.some(term => matchesTerm(row, term)));
}
const respond = (rows: Row[], fields: string) => {
    const picked = rows.map(row => Object.fromEntries(fields.split(',').map(field => [field, row[field] ?? ''])));
    return { status: 200, headers: { 'x-total-count': String(picked.length) }, bodyObject: { result: picked } };
};
const id = () => `${++serial}`.padStart(32, 'c');

/** UpdateSetExport.exportUpdateSet: a Retrieved Update Set copy of the set and its rows. */
function copySet(set: Row, base: string, parent: string): string {
    const sysId = id();
    db.sys_remote_update_set.push({ sys_id: sysId, name: set.name, state: parent ? 'in_hierarchy' : 'loaded', remote_sys_id: set.sys_id,
        remote_base_update_set: base, parent, application: set.application });
    for (const row of db.sys_update_xml.filter(item => item.update_set === set.sys_id)) {
        db.sys_update_xml.push({ ...row, sys_id: id(), update_set: '', remote_update_set: sysId });
    }
    return sysId;
}
function hierarchy(set: Row, onlyCompleted: boolean): string {
    const base = copySet(set, '', '');
    db.sys_remote_update_set.find(row => row.sys_id === base)!.remote_base_update_set = base;
    const walk = (parent: string, remoteParent: string) => {
        for (const child of db.sys_update_set.filter(row => row.parent === parent && (!onlyCompleted || row.state === 'complete'))) {
            walk(child.sys_id, copySet(child, base, remoteParent));
        }
    };
    walk(set.sys_id, base);
    return base;
}
let pending: string[] = [];
/** Deleting a Retrieved Update Set; with `linger`, the set and its rows go only after that many counts. */
function remove(sysId: string) {
    if (platform.linger) { pending.push(sysId); return; }
    db.sys_remote_update_set = db.sys_remote_update_set.filter(row => row.sys_id !== sysId);
    db.sys_update_xml = db.sys_update_xml.filter(row => row.remote_update_set !== sysId);
}
/** The export processors: one set, or every set whose base it is (the base twice, as the platform writes it). */
function unload(sysId: string, batch: boolean): string {
    const sets = batch ? [db.sys_remote_update_set.find(row => row.sys_id === sysId)!, ...db.sys_remote_update_set.filter(row => row.remote_base_update_set === sysId)]
        : db.sys_remote_update_set.filter(row => row.sys_id === sysId);
    if (!sets.length || !sets[0]) return '';
    let records = db.sys_update_xml.filter(row => sets.some(set => set.sys_id === row.remote_update_set));
    if (platform.dropRecord) records = records.slice(1);
    const setXml = sets.map(set => `<sys_remote_update_set action="INSERT_OR_UPDATE"><name>${set.name}</name><parent display_value=""/>` +
        `<remote_sys_id>${set.remote_sys_id ?? ''}</remote_sys_id><sys_id>${set.sys_id}</sys_id></sys_remote_update_set>`).join('');
    // A payload can itself mention sys_update_xml and remote_update_set: only the top-level elements count.
    const rowXml = records.map(row => `<sys_update_xml action="INSERT_OR_UPDATE"><payload><![CDATA[<record_update><sys_update_xml>` +
        `<remote_update_set>${'f'.repeat(32)}</remote_update_set></sys_update_xml></record_update>]]></payload>` +
        `<remote_update_set display_value="x">${row.remote_update_set}</remote_update_set><sys_id>${row.sys_id}</sys_id></sys_update_xml>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><unload unload_date="2026-10-22 00:00:00">${setXml}${rowXml}${platform.extraElement ? '<sys_user/>' : ''}</unload>`;
}

beforeEach(() => {
    serial = 0;
    pending = [];
    platform = {};
    db = {
        sys_update_set: [
            { sys_id: SET, name: 'STORY-1', state: 'complete', application: APP, parent: '', base_update_set: '' },
            { sys_id: OPEN, name: 'STORY-2', state: 'in progress', application: APP, parent: '', base_update_set: '' },
            { sys_id: BASE, name: 'Batch', state: 'complete', application: 'global', parent: '', base_update_set: BASE },
            { sys_id: CHILD, name: 'Batch done', state: 'complete', application: 'global', parent: BASE, base_update_set: BASE },
            { sys_id: WIP, name: 'Batch wip', state: 'in progress', application: 'global', parent: BASE, base_update_set: BASE },
            { sys_id: GRAND, name: 'Batch grandchild', state: 'complete', application: 'global', parent: WIP, base_update_set: BASE },
        ],
        sys_remote_update_set: [
            { sys_id: REMOTE, name: 'Retrieved', state: 'loaded', remote_sys_id: 'd'.repeat(32), remote_base_update_set: '', application: 'global' },
            { sys_id: RBASE, name: 'Retrieved batch', state: 'loaded', remote_sys_id: 'e'.repeat(32), remote_base_update_set: RBASE, application: 'global' },
            { sys_id: RCHILD, name: 'Retrieved child', state: 'in_hierarchy', remote_sys_id: 'b'.repeat(32), remote_base_update_set: RBASE, application: 'global' },
        ],
        sys_update_xml: [
            { sys_id: id(), update_set: SET, remote_update_set: '' }, { sys_id: id(), update_set: SET, remote_update_set: '' },
            { sys_id: id(), update_set: OPEN, remote_update_set: '' },
            { sys_id: id(), update_set: BASE, remote_update_set: '' }, { sys_id: id(), update_set: CHILD, remote_update_set: '' },
            { sys_id: id(), update_set: WIP, remote_update_set: '' }, { sys_id: id(), update_set: GRAND, remote_update_set: '' },
            { sys_id: id(), update_set: '', remote_update_set: REMOTE },
            { sys_id: id(), update_set: '', remote_update_set: RBASE }, { sys_id: id(), update_set: '', remote_update_set: RCHILD },
        ],
    };
    req = {
        get: jest.fn(async (r: any) => {
            if (r.path === '/upload.do') return { status: 200, data: '<input name="sysparm_ck" type="hidden" value="token-1">' };
            if (r.path === '/export_update_set.do' || r.path === '/export_base_update_set.do') {
                if (platform.status) return { status: platform.status, data: 'error' };
                if (platform.body !== undefined) return { status: 200, data: platform.body };
                const xml = unload(r.query.sysparm_sys_id, r.path === '/export_base_update_set.do');
                if (r.query.sysparm_delete_when_done === 'true' && !platform.keepCopy) {
                    const sysId = r.query.sysparm_sys_id;
                    for (const row of db.sys_remote_update_set.filter(set => set.remote_base_update_set === sysId || set.sys_id === sysId)) remove(row.sys_id);
                }
                return { status: 200, data: xml };
            }
            if (r.path.startsWith('/api/now/stats/')) {
                const table = r.path.split('/').at(-1);
                if (pending.length && platform.linger !== undefined && --platform.linger <= 0) {
                    db.sys_remote_update_set = db.sys_remote_update_set.filter(row => !pending.includes(row.sys_id));
                    db.sys_update_xml = db.sys_update_xml.filter(row => !pending.includes(row.remote_update_set));
                    pending = [];
                }
                return { status: 200, bodyObject: { result: { stats: { count: String(db[table].filter(row => matches(row, r.query.sysparm_query)).length) } } } };
            }
            const table = r.path.split('/').at(-1);
            return respond((db[table] ?? []).filter(row => matches(row, r.query.sysparm_query)), r.query.sysparm_fields);
        }),
        delete: jest.fn(async (r: any) => {
            if (platform.deleteStatus === 404) { remove(r.path.split('/').at(-1)); throw new Error('Request failed with status code 404'); }
            if (platform.deleteStatus) return { status: platform.deleteStatus };
            remove(r.path.split('/').at(-1));
            return { status: 204 };
        }),
    };
    jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue(req as any);
    script = jest.spyOn(BackgroundScriptExecutor.prototype, 'executeScript').mockImplementation(async (text: string) => {
        const params = JSON.parse(text.match(/var P = (.*);/)![1]);
        const set = db.sys_update_set.find(row => row.sys_id === params.id);
        const result = !set ? { error: 'not_found' } : { id: params.batch ? hierarchy(set, params.onlyCompleted) : copySet(set, '', '') };
        if (platform.noResult) return { rawResult: '', consoleResult: [], scriptResults: [] } as any;
        if (platform.copyWithoutResult) return { rawResult: 'x', consoleResult: [], scriptResults: [{ line: 'garbled' } as any] } as any;
        const line = `NEX_EXPORT_RESULT=${JSON.stringify(result)}<BR/>`.replace(/"/g, '&quot;');
        return { rawResult: line, consoleResult: [], scriptResults: [{ line } as any] } as any;
    });
    exporter = new UpdateSetExporter(new ServiceNowInstance({ alias: 'unit-test' }));
    (exporter as any)._poll.delayMs = 0;
});
afterEach(() => {
    jest.restoreAllMocks();
    resetPolicyForTests();
});

const copies = () => db.sys_remote_update_set.filter(row => ![REMOTE, RBASE, RCHILD].includes(row.sys_id));
const downloads = () => req.get.mock.calls.map(call => call[0] as any).filter(r => r.path.endsWith('update_set.do'));
const codeOf = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => {
    if (!(error instanceof UpdateSetExportError)) throw error;
    return { code: error.code, detail: error.detail };
});

describe('UpdateSetExporter', () => {
    it('exports a Complete set the way Export to XML does and leaves no temporary copy', async () => {
        const result = await exporter.exportUpdateSet(SET);
        expect(result).toMatchObject({ source: 'local', kind: 'single', recordCount: 2, excluded: [], messages: [],
            updateSet: { sysId: SET, name: 'STORY-1', state: 'complete', application: APP },
            sets: [{ sysId: SET, name: 'STORY-1', state: 'complete', records: 2 }], cleanup: { removedBy: 'platform' } });
        expect(result.xml).toContain('<unload');
        expect(script.mock.calls[0][0]).toContain('"batch":false');
        expect(script.mock.calls[0][0]).toContain('exporter.exportUpdateSet(set)');
        expect(downloads()).toHaveLength(1);
        expect(downloads()[0]).toMatchObject({ path: '/export_update_set.do', sensitive: true, responseFormat: 'text',
            query: { sysparm_sys_id: result.cleanup!.temporarySysId, sysparm_delete_when_done: 'true', sysparm_is_remote: 'false', sysparm_ck: 'token-1' } });
        expect(copies()).toEqual([]);
    });

    it('exports a batch base with its Complete children and reports what the platform leaves out', async () => {
        const result = await exporter.exportUpdateSet(BASE);
        expect(result.kind).toBe('batch');
        expect(result.sets.map(set => set.sysId)).toEqual([BASE, CHILD]);
        expect(result.excluded.map(set => set.sysId)).toEqual([WIP, GRAND]);
        expect(result.recordCount).toBe(2);
        expect(result.messages.join(' ')).toContain('2 batch member(s)');
        expect(downloads()[0].path).toBe('/export_base_update_set.do');
        expect(script.mock.calls[0][0]).toContain('"onlyCompleted":true');
        expect(copies()).toEqual([]);
    });

    it('includes every child of a batch with includeIncomplete', async () => {
        const result = await exporter.exportUpdateSet(BASE, { includeIncomplete: true });
        expect(result.sets.map(set => set.sysId)).toEqual([BASE, CHILD, WIP, GRAND]);
        expect(result.excluded).toEqual([]);
        expect(result.recordCount).toBe(4);
        expect(script.mock.calls[0][0]).toContain('"onlyCompleted":false');
    });

    it('refuses a batch member and names its base', async () => {
        await expect(codeOf(exporter.exportUpdateSet(CHILD))).resolves.toEqual({ code: 'batch_member', detail: { updateSet: CHILD, base: BASE } });
        expect(script).not.toHaveBeenCalled();
    });

    it('refuses a set that is not Complete unless asked, then warns that it is a snapshot', async () => {
        await expect(codeOf(exporter.exportUpdateSet(OPEN))).resolves.toEqual({ code: 'update_set_incomplete', detail: { updateSet: OPEN, state: 'in progress' } });
        expect(script).not.toHaveBeenCalled();
        const result = await exporter.exportUpdateSet(OPEN, { includeIncomplete: true });
        expect(result.recordCount).toBe(1);
        expect(result.messages[0]).toContain('snapshot of unfinished work');
    });

    it('refuses a malformed id before any request and an unknown one after reading', async () => {
        for (const bad of ['', 'abc', `${SET}' + gs.print(1) + '`, 'g'.repeat(32)]) {
            await expect(codeOf(exporter.exportUpdateSet(bad))).resolves.toEqual({ code: 'invalid_input', detail: undefined });
        }
        expect(req.get).not.toHaveBeenCalled();
        await expect(codeOf(exporter.exportUpdateSet('0'.repeat(32)))).resolves.toMatchObject({ code: 'update_set_not_found' });
        expect(script).not.toHaveBeenCalled();
    });

    it('accepts an upper-case id and exports the lower-case set', async () => {
        const MIXED = 'ab'.repeat(16);
        db.sys_update_set.push({ sys_id: MIXED, name: 'STORY-3', state: 'complete', application: APP, parent: '', base_update_set: '' });
        db.sys_update_xml.push({ sys_id: id(), update_set: MIXED, remote_update_set: '' });
        await expect(exporter.exportUpdateSet(` ${MIXED.toUpperCase()} `)).resolves.toMatchObject({ recordCount: 1, updateSet: { sysId: MIXED } });
    });

    it('reads a Retrieved Update Set without a script, a copy or a delete', async () => {
        const result = await exporter.exportUpdateSet(REMOTE);
        expect(result).toMatchObject({ source: 'retrieved', kind: 'single', recordCount: 1, sets: [{ sysId: REMOTE, records: 1 }] });
        expect(result.cleanup).toBeUndefined();
        expect(script).not.toHaveBeenCalled();
        expect(req.delete).not.toHaveBeenCalled();
        expect(downloads()[0]).toMatchObject({ path: '/export_update_set.do', requires: READ_ONLY, query: { sysparm_sys_id: REMOTE, sysparm_is_remote: 'true' } });
        expect(downloads()[0].query.sysparm_delete_when_done).toBeUndefined();
        expect(db.sys_remote_update_set).toHaveLength(3);
    });

    it('reads a retrieved batch base with its members through the batch processor', async () => {
        const result = await exporter.exportUpdateSet(RBASE);
        expect(result).toMatchObject({ source: 'retrieved', kind: 'batch', recordCount: 2 });
        expect(result.sets.map(set => set.sysId)).toEqual([RBASE, RCHILD]);
        expect(downloads()[0].path).toBe('/export_base_update_set.do');
    });

    it('refuses a retrieved member and a retrieved set that is not Loaded', async () => {
        await expect(codeOf(exporter.exportUpdateSet(RCHILD))).resolves.toEqual({ code: 'batch_member', detail: { updateSet: RCHILD, base: RBASE } });
        db.sys_remote_update_set[0].state = 'committed';
        await expect(codeOf(exporter.exportUpdateSet(REMOTE))).resolves.toEqual({ code: 'retrieved_state', detail: { updateSet: REMOTE, state: 'committed' } });
    });

    it('deletes the temporary copy itself when the download fails, then reports the failure', async () => {
        platform.status = 500;
        await expect(codeOf(exporter.exportUpdateSet(BASE))).resolves.toEqual({ code: 'export_failed', detail: { status: 500 } });
        expect(req.delete).toHaveBeenCalledTimes(2);
        expect(copies()).toEqual([]);
        expect(db.sys_update_xml.filter(row => row.remote_update_set && ![REMOTE, RBASE, RCHILD].includes(row.remote_update_set))).toEqual([]);
    });

    it('treats an empty 200 as a failed download', async () => {
        platform.body = '';
        await expect(codeOf(exporter.exportUpdateSet(SET))).resolves.toEqual({ code: 'export_failed', detail: { status: 200 } });
        expect(copies()).toEqual([]);
    });

    it('removes a copy the platform kept after a good download and says so', async () => {
        platform.keepCopy = true;
        const result = await exporter.exportUpdateSet(SET);
        expect(result.cleanup?.removedBy).toBe('nex');
        expect(copies()).toEqual([]);
    });

    it('waits for the platform to finish deleting a batch copy before deleting anything itself', async () => {
        platform.linger = 4;
        const result = await exporter.exportUpdateSet(BASE);
        expect(result.cleanup?.removedBy).toBe('platform');
        expect(req.delete).not.toHaveBeenCalled();
        expect(copies()).toEqual([]);
        expect(db.sys_update_xml.filter(row => row.remote_update_set === result.cleanup!.temporarySysId)).toEqual([]);
    });

    it('settles a delete that races the platform by reading back', async () => {
        platform.status = 500;
        platform.deleteStatus = 404;
        await expect(codeOf(exporter.exportUpdateSet(SET))).resolves.toEqual({ code: 'export_failed', detail: { status: 500 } });
        expect(req.delete).toHaveBeenCalledTimes(1);
        expect(copies()).toEqual([]);
    });

    it('deletes a copy that outlasts the wait and refuses success while it still remains', async () => {
        platform.linger = 1000;
        const outcome = await codeOf(exporter.exportUpdateSet(SET)) as any;
        expect(outcome.code).toBe('cleanup_unverified');
        expect(outcome.detail.temporary).toHaveLength(1);
        expect(req.delete).toHaveBeenCalledTimes(1);
    });

    it('names the copy it could not remove', async () => {
        platform.status = 500;
        platform.deleteStatus = 403;
        const outcome = await codeOf(exporter.exportUpdateSet(SET)) as any;
        expect(outcome.code).toBe('cleanup_unverified');
        expect(outcome.detail.temporary).toEqual([copies()[0].sys_id]);
    });

    it('refuses a file whose records do not match the set', async () => {
        platform.dropRecord = true;
        await expect(codeOf(exporter.exportUpdateSet(SET))).resolves.toEqual({ code: 'export_mismatch', detail: { updateSet: SET, expected: 2, actual: 1 } });
        expect(copies()).toEqual([]);
    });

    it('refuses a file with anything other than update set rows', async () => {
        platform.extraElement = true;
        await expect(codeOf(exporter.exportUpdateSet(REMOTE))).resolves.toMatchObject({ code: 'export_mismatch' });
        platform.extraElement = false;
        platform.body = 'not xml <';
        await expect(codeOf(exporter.exportUpdateSet(REMOTE))).resolves.toMatchObject({ code: 'export_mismatch' });
    });

    it('reports a copy made by a script whose result could not be read, without deleting it', async () => {
        platform.copyWithoutResult = true;
        const outcome = await codeOf(exporter.exportUpdateSet(SET)) as any;
        expect(outcome.code).toBe('script_result_unavailable');
        expect(outcome.detail.temporary).toEqual([copies()[0].sys_id]);
        expect(req.delete).not.toHaveBeenCalled();
    });

    it('names a batch copy\'s children too when the script result could not be read', async () => {
        platform.copyWithoutResult = true;
        const outcome = await codeOf(exporter.exportUpdateSet(BASE)) as any;
        expect(outcome.code).toBe('script_result_unavailable');
        expect([...outcome.detail.temporary].sort()).toEqual(copies().map(row => row.sys_id).sort());
        expect(outcome.detail.temporary).toHaveLength(2);
        expect(req.delete).not.toHaveBeenCalled();
    });

    it('refuses a local export under a write denial before anything is copied, though execute is granted', async () => {
        // The script scan cannot see UpdateSetExport's insert, so the script alone would pass with execute.
        installPolicy([denyLayer('flag', ['write']), grantLayer('default', ['write', 'execute'])]);
        const error = await exporter.exportUpdateSet(SET).catch((caught: unknown) => caught);
        expect(isPolicyRefusal(error)).toBe(true);
        expect(script).not.toHaveBeenCalled();
        expect(downloads()).toEqual([]);
        expect(copies()).toEqual([]);
    });

    it('still reads a Retrieved Update Set under a write and execute denial', async () => {
        installPolicy([denyLayer('flag', ['write', 'execute']), grantLayer('default', ['write', 'execute'])]);
        await expect(exporter.exportUpdateSet(REMOTE)).resolves.toMatchObject({ source: 'retrieved', recordCount: 1 });
    });

    it('reports an unreadable script result with no copy as such', async () => {
        platform.noResult = true;
        script.mockImplementationOnce(async () => ({ rawResult: '', consoleResult: [], scriptResults: [] }) as any);
        await expect(codeOf(exporter.exportUpdateSet(SET))).resolves.toEqual({ code: 'script_result_unavailable', detail: { updateSet: SET } });
    });

    it('passes a policy refusal of the script through untouched', async () => {
        const refusal = policyRefusal({ allowed: false, verbs: ['execute'], decidingLayer: 'flag' } as any);
        script.mockRejectedValueOnce(refusal);
        await expect(exporter.exportUpdateSet(SET)).rejects.toBe(refusal);
        expect(copies()).toEqual([]);
    });

    it('reports unreadable evidence as its own code', async () => {
        req.get.mockImplementationOnce(async () => ({ status: 500 }));
        await expect(codeOf(exporter.exportUpdateSet(SET))).resolves.toEqual({ code: 'evidence_unavailable', detail: undefined });
    });
});
