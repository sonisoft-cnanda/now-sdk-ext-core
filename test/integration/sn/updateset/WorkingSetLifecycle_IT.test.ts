import { afterAll, describe, expect, it } from '@jest/globals';
import { getCredentials } from "@servicenow/sdk-cli/dist/auth/index.js";

import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { FormLayoutWriter } from '../../../../src/sn/metadata/FormLayoutWriter';
import { MetadataFormWriter } from '../../../../src/sn/metadata/MetadataFormWriter';
import { MetadataReader } from '../../../../src/sn/metadata/internal/MetadataReader';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { WorkingSetManager } from '../../../../src/sn/updateset/WorkingSetManager';
import type { UpdateSetSummary, WorkingSet } from '../../../../src/sn/updateset/WorkingSetModels';
import { SN_INSTANCE_ALIAS } from '../../../test_utils/test_config';

/*
 * NSE-15 use case, live: change configuration in an installed Store application and in Global, land it in an update
 * set we create for that application, prove what was captured, and close the set.
 *
 * Store application: GRC: Policy and Compliance Management (sn_compliance), Policy form (sn_compliance_policy, Default
 * view, main section). The test adds one field to the layout and puts the layout back. The platform then treats that
 * section as customized (replace_on_upgrade=false) even though its content equals the original; that is the expected
 * consequence the Store acknowledgement covers. Global: an inactive Script Include, inserted and deleted.
 *
 * Every run leaves two Complete sets named "nex-it NSE-15 ... (test only, do not promote)". Customer Updates are never
 * deleted. A set this test leaves In progress after a failure is set to Ignore so it cannot be promoted. The user's
 * working set is restored in every case. Skipped when the instance has no active sn_compliance application.
 */
const MINUTE = 60_000;
const STORE_SCOPE = 'sn_compliance';
const STORE_TABLE = 'sn_compliance_policy';
const FIELD = 'url';
const STAMP = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const NOT_FOR_PROMOTION = 'NSE-15 integration test (test only, do not promote).';

const credential = await getCredentials(SN_INSTANCE_ALIAS);
const instance = credential ? new ServiceNowInstance({ alias: SN_INSTANCE_ALIAS, credential }) : undefined;
const reader = instance ? new MetadataReader(SessionManager.getInstance().getRequest(instance)) : undefined;
const store = reader ? (await reader.rows('sys_scope', `scope=${STORE_SCOPE}^active=true`, 'sys_id,scope,sys_class_name'))
    .find(row => row.sys_class_name === 'sys_store_app') : undefined;
const section = store && reader ? (await reader.rows('sys_ui_section',
    `name=${STORE_TABLE}^view=Default view^captionISEMPTY^sys_scope=${store.sys_id}`, 'sys_id,name'))[0] : undefined;
if (!instance) console.warn(`[WorkingSetLifecycle_IT] no credentials for ${SN_INSTANCE_ALIAS}: skipped`);
else if (!section) console.warn(`[WorkingSetLifecycle_IT] ${SN_INSTANCE_ALIAS} has no ${STORE_SCOPE} Policy form section: skipped`);

(section ? describe : describe.skip)(`NSE-15 changes in applications we do not own (${SN_INSTANCE_ALIAS}, live)`, () => {
    const sets = new WorkingSetManager(instance!);
    const layouts = new FormLayoutWriter(instance!);
    const forms = new MetadataFormWriter(instance!);
    const app = store!.sys_id;
    const sectionId = section!.sys_id;
    const created: string[] = [];
    let previous: WorkingSet | undefined;
    let original: string[] = [];
    let changed: string[] = [];
    let storeSet: UpdateSetSummary;
    let globalSet: UpdateSetSummary;
    const optIn = { storeCustomization: { acknowledgeUpgradeSkip: true as const } };
    const captures = (set: string) => reader!.rows('sys_update_xml', `update_set=${set}`, 'sys_id,name,application,action,replace_on_upgrade');

    afterAll(async () => {
        // Put the layout back if a failure left it changed, then the user's working set, then close any open set.
        try {
            const now = await layouts.getFormLayout(sectionId);
            if (original.length && JSON.stringify(now.elements) !== JSON.stringify(original) && storeSet) {
                await sets.useUpdateSet(storeSet.sysId).catch(() => undefined);
                await layouts.setFormLayout(sectionId, { elements: original, scope: { sysId: app }, updateSet: storeSet.sysId, ...optIn });
            }
        } finally {
            if (previous) await sets.restoreWorkingSet(previous);
            const request = SessionManager.getInstance().getRequest(instance!);
            for (const id of created) {
                const set = await sets.getUpdateSet(id);
                if (set.state === 'in progress') {
                    await request.put({ path: `/api/now/table/sys_update_set/${id}`, method: 'PUT', query: null, body: null,
                        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, json: { state: 'ignore' } });
                }
            }
        }
    }, 5 * MINUTE);

    it('creates an update set in the Store application, verified', async () => {
        storeSet = await sets.createUpdateSet({ application: app, name: `nex-it NSE-15 ${STORE_SCOPE} form ${STAMP}`,
            description: `${NOT_FOR_PROMOTION} Customizes ${STORE_TABLE} Default view (sys_ui_section ${sectionId}); upgrades skip it.` });
        created.push(storeSet.sysId);
        expect(storeSet).toMatchObject({ application: app, state: 'in progress', isDefault: false });
        await expect(sets.createUpdateSet({ application: app, name: storeSet.name })).rejects.toMatchObject({ code: 'update_set_exists' });
    }, 2 * MINUTE);

    it('refuses the layout change while the set is not the working set', async () => {
        original = (await layouts.getFormLayout(sectionId)).elements;
        changed = original.includes(FIELD) ? original.filter(item => item !== FIELD) : [...original, FIELD];
        await expect(layouts.setFormLayout(sectionId, { elements: changed, scope: { sysId: app }, updateSet: storeSet.sysId, ...optIn }))
            .rejects.toMatchObject({ code: 'update_set_not_current' });
        expect((await layouts.getFormLayout(sectionId)).elements).toEqual(original);
    }, 2 * MINUTE);

    it('makes the set the working set for later sessions', async () => {
        const used = await sets.useUpdateSet(storeSet.sysId);
        previous = used.previous;
        expect(used.current).toEqual({ application: app, updateSet: storeSet.sysId });
        expect(await sets.getWorkingSet()).toEqual({ application: app, updateSet: storeSet.sysId });
    }, 2 * MINUTE);

    it('refuses a Store write without the upgrade-skip acknowledgement', async () => {
        await expect(layouts.setFormLayout(sectionId, { elements: changed, scope: { sysId: app }, updateSet: storeSet.sysId }))
            .rejects.toMatchObject({ code: 'store_scope' });
        expect((await layouts.getFormLayout(sectionId)).elements).toEqual(original);
    }, 2 * MINUTE);

    it('changes the form layout, captured once in our set, and reports the upgrade skip', async () => {
        const result = await layouts.setFormLayout(sectionId, { elements: changed, scope: { sysId: app }, updateSet: storeSet.sysId, ...optIn });
        expect(result.elements).toEqual(changed);
        expect(result.previousElements).toEqual(original);
        expect(result.capture).toMatchObject({ updateSetSysId: storeSet.sysId, updateName: `sys_ui_section_${sectionId}`, recordScope: app,
            customization: { storeApplication: true, replaceOnUpgrade: false } });
        expect((await layouts.getFormLayout(sectionId)).elements).toEqual(changed);
    }, 3 * MINUTE);

    it('puts the layout back in the same capture', async () => {
        const result = await layouts.setFormLayout(sectionId, { elements: original, scope: { sysId: app }, updateSet: storeSet.sysId, ...optIn });
        expect(result.elements).toEqual(original);
        const rows = await captures(storeSet.sysId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: `sys_ui_section_${sectionId}`, application: app, action: 'INSERT_OR_UPDATE', replace_on_upgrade: 'false' });
    }, 3 * MINUTE);

    it('refuses to move the capture into another application\'s set', async () => {
        globalSet = await sets.createUpdateSet({ application: 'global', name: `nex-it NSE-15 global ${STAMP}`,
            description: `${NOT_FOR_PROMOTION} Inactive Script Include inserted and deleted.` });
        created.push(globalSet.sysId);
        const [row] = await captures(storeSet.sysId);
        await expect(sets.moveCapture({ capture: row.sys_id, sourceSet: storeSet.sysId, targetSet: globalSet.sysId, reason: 'NSE-15 integration negative test' }))
            .rejects.toMatchObject({ code: 'scope_mismatch' });
        expect((await captures(storeSet.sysId)).map(capture => capture.sys_id)).toEqual([row.sys_id]);
    }, 2 * MINUTE);

    it('completes the Store set only at the reviewed count', async () => {
        await expect(sets.completeUpdateSet(storeSet.sysId, { expectedCaptures: 2 })).rejects.toMatchObject({ code: 'capture_count_mismatch' });
        await expect(sets.completeUpdateSet(storeSet.sysId, { expectedCaptures: 1 })).resolves.toMatchObject({ state: 'complete' });
    }, 2 * MINUTE);

    it('runs the same lifecycle in Global', async () => {
        await sets.useUpdateSet(globalSet.sysId);
        const scope = 'global' as const;
        const inserted = await forms.insert('sys_script_include', { scope, updateSet: globalSet.sysId,
            fields: { name: `NexItNse15${STAMP}`, active: false, description: NOT_FOR_PROMOTION, script: '// NSE-15 integration test' } });
        expect(inserted.capture).toMatchObject({ updateSetSysId: globalSet.sysId, recordScope: 'global', updateName: `sys_script_include_${inserted.sysId}` });
        const removed = await forms.delete('sys_script_include', inserted.sysId, { scope, updateSet: globalSet.sysId,
            confirm: { table: 'sys_script_include', sysId: inserted.sysId } });
        expect(removed.capture).toMatchObject({ action: 'DELETE', updateSetSysId: globalSet.sysId });
        expect(await captures(globalSet.sysId)).toEqual([expect.objectContaining({ application: 'global', action: 'DELETE' })]);
        await expect(sets.completeUpdateSet(globalSet.sysId, { expectedCaptures: 1 })).resolves.toMatchObject({ state: 'complete' });
    }, 4 * MINUTE);

    it('restores the working set it found', async () => {
        const restored = await sets.restoreWorkingSet(previous!);
        expect(restored.restored.application).toBe(previous!.application || 'global');
        expect(await sets.getWorkingSet()).toEqual(restored.restored);
        previous = undefined;
    }, 2 * MINUTE);
});
