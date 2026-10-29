// This suite runs as real ESM (jest is invoked with --experimental-vm-modules),
// where the `jest` object is not injected as a global.
import { beforeAll, describe, expect, it } from '@jest/globals';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { SN_INSTANCE_ALIAS } from '../../../test_utils/test_config';
import { initCredentialStore } from '../../../../src/credentials/ensureShim';
import { ApplicationManager } from '../../../../src/sn/application/ApplicationManager';
import { StoreAppRepairError } from '../../../../src/sn/application/StoreAppRepairError';

/**
 * Live Repair Application. A repair reinstalls an app's files, so this suite runs only on
 * dev206299, against "Bubble trend" (sn_bubble_trend 1.0.0): a store app with three files, no
 * dependencies and no demo data, which nothing on the instance uses. Repairing it again leaves
 * it as it was. The instance queues installs, so a repair can wait minutes before it runs.
 */
const MINUTE = 60_000;
const APP = 'dfdf3c79ff4422104e80ffffffffffb7';
const SCOPE = 'sn_bubble_trend';

const onDev = SN_INSTANCE_ALIAS === 'dev206299';
const suite = onDev ? describe : describe.skip;

suite('ApplicationManager repair - Integration Tests (dev206299 only)', () => {
    let mgr: ApplicationManager;

    beforeAll(async () => {
        await initCredentialStore();
        const { resolveSessionCredentials } = await import('../../../../src/auth/CredentialProvider');
        const credential = await resolveSessionCredentials(SN_INSTANCE_ALIAS);
        const instance = new ServiceNowInstance({ alias: SN_INSTANCE_ALIAS, credential, credentialProvider: () => resolveSessionCredentials(SN_INSTANCE_ALIAS) });
        mgr = new ApplicationManager(instance);
    });

    it('repairs an installed store app by scope and reports the upgrade history it wrote', async () => {
        const result = await mgr.repairStoreApplicationAndWait({ app: SCOPE }, 5000, 20 * MINUTE);
        expect(result.error).toBeUndefined();
        expect(result.app).toMatchObject({ sysId: APP, scope: SCOPE, version: '1.0.0' });
        expect(result.endpoint).toBe('repair');
        expect(result.repaired).toBe(true);
        expect(result.history?.counts.updated + result.history!.counts.unchanged).toBeGreaterThan(0);
        expect(result.history?.skippedFiles).toEqual([]);
    }, 25 * MINUTE);

    it('refuses an app developed on the instance, and demo data the app does not have, without sending anything', async () => {
        const local = await mgr.repairStoreApplication({ app: 'x_2115789_flowdbg' }).catch(e => e);
        expect(local).toBeInstanceOf(StoreAppRepairError);
        expect((local as StoreAppRepairError).code).toBe('not_a_store_app');
        const demo = await mgr.repairStoreApplication({ app: APP, loadDemoData: true }).catch(e => e);
        expect((demo as StoreAppRepairError).code).toBe('no_demo_data');
    }, MINUTE);
});
