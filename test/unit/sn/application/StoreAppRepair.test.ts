import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ApplicationManager } from '../../../../src/sn/application/ApplicationManager';
import { StoreAppRepairError } from '../../../../src/sn/application/StoreAppRepairError';
import { STORE_APP_REPAIR_SKIPPED_LIMIT } from '../../../../src/sn/application/StoreApplicationModels';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { ServiceNowRequest } from '../../../../src/comm/http/ServiceNowRequest';
import { TableAPIRequest } from '../../../../src/comm/http/TableAPIRequest';
import { ProgressWorker } from '../../../../src/sn/ProgressWorker';
import type { HTTPRequest } from '../../../../src/comm/http/HTTPRequest';

/*
 * Repair Application, against a fake instance holding the tables the repair reads and the
 * App Client endpoints it calls. What the fake models was read from dev206299 (Zurich):
 * - the Repair dialog sends the INSTALLED version and the customization version found in
 *   sys_app_customization, unless the app has a sys_repo_config;
 * - with queued installation off, the repair endpoint drops the reinstall flag, so the
 *   repair must go through app/install with isReinstall=true;
 * - a repair writes a sys_upgrade_history row (to_version = scope) as it finishes, and the
 *   tracker reports success even when it reinstalled nothing.
 */

type Row = Record<string, string>;
const APP = 'dfdf3c79ff4422104e80ffffffffffb7';
const SCOPE = 'sn_bubble_trend';
const OLD_HISTORY = 'a'.repeat(32);
const NEW_HISTORY = 'b'.repeat(32);

interface World {
    tables: Record<string, Row[]>;
    /** What finishing the repair writes; none models a repair that reinstalled nothing. */
    writes?: { history: Row; logs: Row[] };
    progress: Array<Record<string, unknown>>;
    /** Finish the written history row after this many more reads of it: it starts unfinished. */
    finishHistoryAfter?: { reads: number; patch: Row };
    appClient?: (request: HTTPRequest) => Promise<unknown>;
}

function matches(row: Row, query: string): boolean {
    return query.split('^').every(term => {
        if (term.startsWith('ORDERBY')) return true;
        const inList = /^(\w+)IN(.*)$/.exec(term);
        if (inList) return inList[2].split(',').includes(row[inList[1]]);
        const [field, value] = term.split('=');
        return row[field] === value;
    });
}

function storeApp(over: Row = {}): Row {
    return { sys_id: APP, name: 'Bubble trend', scope: SCOPE, version: '1.0.0', active: 'true', contains_plugins: 'false', demo_data: 'no_demo_data', ...over };
}

function history(sysId: string, over: Row = {}): Row {
    return {
        sys_id: sysId, to_version: SCOPE, upgrade_started: '2026-10-29 13:30:15', upgrade_finished: '2026-10-29 13:30:26', summary_complete_status: 'complete',
        added: '0', updated: '2', deleted: '0', unchanged: '1', skipped: '0', skipped_error: '0', skipped_manual_merge: '0', skipped_apply_once: '0', ...over,
    };
}

describe('ApplicationManager store application repair', () => {
    let world: World;
    let appClientCalls: HTTPRequest[];
    let tableReads: Array<{ table: string; query: string }>;
    let mgr: ApplicationManager;

    beforeEach(() => {
        world = {
            tables: {
                sys_store_app: [storeApp()],
                sys_app: [],
                sys_repo_config: [],
                sys_app_customization: [],
                sys_properties: [{ name: 'sn_appclient.use_queued_installation', value: 'true' }],
                sys_upgrade_history: [history(OLD_HISTORY, { upgrade_started: '2026-01-01 00:00:00' })],
                sys_upgrade_history_log: [],
            },
            writes: { history: history(NEW_HISTORY), logs: [] },
            progress: [
                { percent_complete: 0, status: '0', status_label: 'Pending', status_message: '' },
                { percent_complete: 100, status: '2', status_label: 'Successful', status_message: 'Success!' },
            ],
        };
        appClientCalls = [];
        tableReads = [];

        jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
            fn();
            return 0 as unknown as NodeJS.Timeout;
        }) as never);
        jest.spyOn(TableAPIRequest.prototype, 'get').mockImplementation((async (table: string, query: Record<string, string>) => {
            tableReads.push({ table, query: query.sysparm_query });
            const finish = world.finishHistoryAfter;
            if (table === 'sys_upgrade_history' && finish && !world.writes && finish.reads-- <= 0) {
                Object.assign(world.tables.sys_upgrade_history[0], finish.patch);
                world.finishHistoryAfter = undefined;
            }
            const rows = (world.tables[table] ?? []).filter(row => matches(row, query.sysparm_query));
            const fields = query.sysparm_fields.split(',');
            const result = rows.slice(0, Number(query.sysparm_limit)).map(row => Object.fromEntries(fields.filter(f => f in row).map(f => [f, row[f]])));
            return { status: 200, bodyObject: { result } };
        }) as never);
        jest.spyOn(ServiceNowRequest.prototype, 'get').mockImplementation((async (request: HTTPRequest) => {
            appClientCalls.push(request);
            if (world.appClient) return world.appClient(request);
            return { status: 200, bodyObject: { result: { links: { progress: { id: 'TRK1', url: '' } }, status: '0' } } };
        }) as never);
        let step = 0;
        jest.spyOn(ProgressWorker.prototype, 'getProgress').mockImplementation((async () => {
            const progress = world.progress[Math.min(step++, world.progress.length - 1)];
            if (progress.percent_complete === 100 && world.writes) {
                world.tables.sys_upgrade_history.unshift(world.writes.history);
                world.tables.sys_upgrade_history_log.push(...world.writes.logs);
                world.writes = undefined;
            }
            return progress;
        }) as never);

        mgr = new ApplicationManager(new ServiceNowInstance({ alias: 'dev' }));
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('reinstalls the installed version through the repair endpoint and reports the history it wrote', async () => {
        const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 1, 60_000);

        expect(appClientCalls).toHaveLength(1);
        expect(appClientCalls[0].path).toBe('/api/sn_appclient/appmanager/app/repair');
        expect(appClientCalls[0].query).toEqual({ app_id: APP, version: '1.0.0', load_demo_data: 'false' });
        expect(result).toMatchObject({
            success: true,
            repaired: true,
            endpoint: 'repair',
            trackerId: 'TRK1',
            warnings: [],
            app: { sysId: APP, scope: SCOPE, version: '1.0.0', hasDemoData: false },
            history: {
                sysId: NEW_HISTORY,
                status: 'complete',
                counts: { added: 0, updated: 2, deleted: 0, unchanged: 1, skipped: 0, skippedError: 0, skippedManualMerge: 0, skippedApplyOnce: 0 },
                skippedFiles: [],
                skippedFilesTruncated: false,
            },
        });
        expect(result.app.customizationVersion).toBeUndefined();
    });

    it('takes the sys_store_app sys_id as well as the scope', async () => {
        const started = await mgr.repairStoreApplication({ app: APP });
        expect(started).toMatchObject({ app: { sysId: APP }, trackerId: 'TRK1', previousHistoryId: OLD_HISTORY, endpoint: 'repair' });
        expect(tableReads[0]).toEqual({ table: 'sys_store_app', query: `sys_id=${APP}` });
    });

    it.each([
        ['an installed customization version', [{ vendor_app: APP, version: '2.1.0' }], [], '2.1.0'],
        ['no customization version for an app under source control', [{ vendor_app: APP, version: '2.1.0' }], [{ sys_id: 'r', sys_app: APP }], undefined],
        ['no customization version when it is "none"', [{ vendor_app: APP, version: 'none' }], [], undefined],
    ])('sends %s, as the Repair dialog does', async (_label, customizations, repoConfigs, expected) => {
        world.tables.sys_app_customization = customizations as Row[];
        world.tables.sys_repo_config = repoConfigs as Row[];
        const started = await mgr.repairStoreApplication({ app: SCOPE });
        expect(started.app.customizationVersion).toBe(expected);
        expect(appClientCalls[0].query?.customization_version).toBe(expected);
    });

    it.each([['off', 'false'], ['unset', undefined]])(
        'with queued installation %s, reinstalls through app/install with isReinstall, which the repair endpoint drops',
        async (_label, value) => {
            world.tables.sys_properties = value === undefined ? [] : [{ name: 'sn_appclient.use_queued_installation', value }];
            const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 1, 60_000);
            expect(appClientCalls[0].path).toBe('/api/sn_appclient/appmanager/app/install');
            expect(appClientCalls[0].query).toMatchObject({ app_id: APP, version: '1.0.0', isReinstall: 'true' });
            expect(result).toMatchObject({ endpoint: 'install', repaired: true });
        },
    );

    it('loads demo data when asked, for an app that has some', async () => {
        world.tables.sys_store_app = [storeApp({ demo_data: 'has_demo_data' })];
        const started = await mgr.repairStoreApplication({ app: SCOPE, loadDemoData: true });
        expect(appClientCalls[0].query?.load_demo_data).toBe('true');
        expect(started.app.hasDemoData).toBe(true);
    });

    describe('refuses before sending anything', () => {
        const refused = async (app: string, code: string, extra: Record<string, unknown> = {}) => {
            const error = await mgr.repairStoreApplication({ app, ...extra }).catch(e => e);
            expect(error).toBeInstanceOf(StoreAppRepairError);
            expect((error as StoreAppRepairError).code).toBe(code);
            expect(appClientCalls).toHaveLength(0);
            return error as StoreAppRepairError;
        };

        it.each(['', '   ', `${SCOPE}^active=false`, 'x'.repeat(41), 'x-app.name', `${SCOPE},x_other`])('an app given as %j', async (app) => {
            const error = await refused(app, 'invalid_app');
            expect(error.detail).toBeUndefined();
            expect(tableReads).toHaveLength(0);
        });

        it('an app that is not installed', async () => {
            world.tables.sys_store_app = [];
            expect((await refused('x_nope_app', 'app_not_found')).detail).toEqual({ app: 'x_nope_app' });
        });

        it('an app developed on this instance', async () => {
            world.tables.sys_store_app = [];
            world.tables.sys_app = [{ sys_id: APP, scope: SCOPE }];
            const error = await refused(SCOPE, 'not_a_store_app');
            expect(error.message).toContain('no repository copy to repair it from');
        });

        it('an inactive app', async () => {
            world.tables.sys_store_app = [storeApp({ active: 'false' })];
            expect((await refused(SCOPE, 'app_inactive')).detail).toEqual({ app: APP, scope: SCOPE });
        });

        it('an app that contains plugins', async () => {
            world.tables.sys_store_app = [storeApp({ contains_plugins: 'true' })];
            await refused(SCOPE, 'contains_plugins');
        });

        it('demo data for an app that has none', async () => {
            await refused(SCOPE, 'no_demo_data', { loadDemoData: true });
        });
    });

    it('does not call it repaired when the App Client succeeds but writes no history', async () => {
        world.writes = undefined;
        const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 1, 60_000);
        expect(result.success).toBe(true);
        expect(result.repaired).toBe(false);
        expect(result.history).toBeUndefined();
        expect(result.warnings[0]).toContain('may not have reinstalled anything');
        // One read after the wait, then the settle retries.
        const historyReads = tableReads.filter(r => r.table === 'sys_upgrade_history');
        expect(historyReads).toHaveLength(1 + 1 + mgr.REPAIR_HISTORY_ATTEMPTS);
    });

    it('waits for the history row to finish: the tracker succeeds before its counts are filled', async () => {
        world.writes = { history: history(NEW_HISTORY, { upgrade_finished: '', summary_complete_status: 'in_progress', updated: '0', unchanged: '0' }), logs: [] };
        world.finishHistoryAfter = { reads: 2, patch: { upgrade_finished: '2026-10-29 13:39:53', summary_complete_status: 'complete', updated: '2', unchanged: '1' } };
        const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 1, 60_000);
        expect(result.history).toMatchObject({ status: 'complete', finished: '2026-10-29 13:39:53', counts: { updated: 2, unchanged: 1 } });
        expect(result.warnings).toEqual([]);
    });

    it('says so when the history row is still unfinished when the wait ends', async () => {
        world.writes = { history: history(NEW_HISTORY, { upgrade_finished: '', summary_complete_status: 'in_progress' }), logs: [] };
        const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 1, 60_000);
        expect(result.repaired).toBe(true);
        expect(result.warnings).toEqual([expect.stringContaining('still being written')]);
        expect(tableReads.filter(r => r.table === 'sys_upgrade_history')).toHaveLength(1 + 1 + mgr.REPAIR_HISTORY_ATTEMPTS);
    });

    it('also counts an app with no earlier history, whose first row is the repair', async () => {
        world.tables.sys_upgrade_history = [];
        const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 1, 60_000);
        expect(result.repaired).toBe(true);
        expect(result.history?.sysId).toBe(NEW_HISTORY);
    });

    it('lists the files the repair skipped, without their payloads', async () => {
        world.writes = {
            history: history(NEW_HISTORY, { skipped: '1', skipped_error: '1', skipped_apply_once: '1' }),
            logs: [
                { upgrade_history: NEW_HISTORY, file_name: 'sys_script_include_1', type: 'Script Include', target_name: 'Util', disposition: '4', reason: 'Customized', payload: '<secret/>' },
                { upgrade_history: NEW_HISTORY, file_name: 'sys_ui_page_2', type: 'UI Page', target_name: 'page', disposition: '9', reason: '' },
                { upgrade_history: NEW_HISTORY, file_name: 'sys_ux_3', type: 'UX', target_name: 'ok', disposition: '2', reason: '' },
                { upgrade_history: OLD_HISTORY, file_name: 'old', type: 'Old', target_name: 'old', disposition: '4', reason: '' },
            ],
        };
        const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 1, 60_000);
        expect(result.history?.skippedFiles).toEqual([
            { fileName: 'sys_script_include_1', type: 'Script Include', targetName: 'Util', disposition: '4', dispositionLabel: 'Skipped', reason: 'Customized' },
            { fileName: 'sys_ui_page_2', type: 'UI Page', targetName: 'page', disposition: '9', dispositionLabel: 'Skipped Error', reason: undefined },
        ]);
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(result.warnings).toEqual([expect.stringContaining('2 file(s) were not applied')]);
        const logRead = tableReads.find(r => r.table === 'sys_upgrade_history_log');
        expect(logRead?.query).toContain(`upgrade_history=${NEW_HISTORY}^dispositionIN`);
    });

    it('says when there were more skipped files than it lists', async () => {
        const logs = Array.from({ length: STORE_APP_REPAIR_SKIPPED_LIMIT + 5 }, (_, i) => (
            { upgrade_history: NEW_HISTORY, file_name: `f${i}`, type: 'T', target_name: 't', disposition: '4' }));
        world.writes = { history: history(NEW_HISTORY, { skipped: String(logs.length) }), logs };
        const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 1, 60_000);
        expect(result.history?.skippedFiles).toHaveLength(STORE_APP_REPAIR_SKIPPED_LIMIT);
        expect(result.history?.skippedFilesTruncated).toBe(true);
    });

    it('reports a failed repair, with the history it wrote, and does not call it repaired', async () => {
        world.progress = [{ percent_complete: 100, status: '3', status_label: 'Failed', status_message: 'Unable to install', error: 'Unable to install' }];
        const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 1, 60_000);
        expect(result).toMatchObject({ success: false, repaired: false, error: 'Unable to install' });
        expect(result.history?.sysId).toBe(NEW_HISTORY);
    });

    it('reports a repair still running when the wait ends', async () => {
        world.progress = [{ percent_complete: 40, status: '1', status_label: 'Running', status_message: '' }];
        jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_000);
        const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 1, 5_000);
        expect(result).toMatchObject({ success: false, repaired: false, error: 'Installation timed out' });
        expect(result.warnings).toEqual([]);
    });

    describe('when the App Client will not start it', () => {
        it('names the status and the App Client message', async () => {
            world.appClient = async () => {
                throw new Error('Error during request. Status: 403 Body: {"error":{"message":"You do not have read permission for required table: sys_store_app","detail":""}}');
            };
            const error = await mgr.repairStoreApplication({ app: SCOPE }).catch(e => e) as StoreAppRepairError;
            expect(error).toBeInstanceOf(StoreAppRepairError);
            expect(error.code).toBe('start_failed');
            expect(error.detail).toEqual({ app: APP, status: 403, serverMessage: 'You do not have read permission for required table: sys_store_app' });
            expect(error.cause).toBeInstanceOf(Error);
        });

        it('refuses a response without a tracker', async () => {
            world.appClient = async () => ({ status: 200, bodyObject: { result: { message: 'Application not found' } } });
            const error = await mgr.repairStoreApplication({ app: SCOPE }).catch(e => e) as StoreAppRepairError;
            expect(error.code).toBe('start_failed');
            expect(error.detail?.serverMessage).toBe('Application not found');
        });

        it('passes other failures, such as a policy refusal, through unchanged', async () => {
            const refusal = Object.assign(new Error('Refused by policy: write denied by a flag'), { name: 'PolicyRefusalError' });
            world.appClient = async () => {
                throw refusal;
            };
            await expect(mgr.repairStoreApplication({ app: SCOPE })).rejects.toBe(refusal);
        });
    });
});
