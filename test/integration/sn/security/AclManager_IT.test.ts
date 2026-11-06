// This suite runs as real ESM (jest is invoked with --experimental-vm-modules),
// where the `jest` object is not injected as a global.
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { SN_INSTANCE_ALIAS } from '../../../test_utils/test_config';
import { initCredentialStore } from '../../../../src/credentials/ensureShim';
import { AclManager } from '../../../../src/sn/security/AclManager';
import { RoleElevation } from '../../../../src/sn/security/RoleElevation';
import { UpdateSetManager } from '../../../../src/sn/updateset/UpdateSetManager';
import { BackgroundScriptExecutor } from '../../../../src/sn/BackgroundScriptExecutor';

/**
 * Live access controls with security_admin elevation. Writes ACLs, so it runs only on dev206299, in the
 * NSE-21 scratch application (x_2115789_flowdbg), in an update set of its own that it sets to Ignore at
 * the end. Every ACL it creates is deleted, and the user's update-set pointers are left as they were.
 */
const MINUTE = 60_000;
const SCOPE = '921fd9af4c554457a73ad246c71a17f7';
const NAME = `x_2115789_flowdbg_acl_it_${Date.now().toString(36)}`;

const onDev = SN_INSTANCE_ALIAS === 'dev206299';
const suite = onDev ? describe : describe.skip;

suite('AclManager with role elevation - Integration Tests (dev206299 only)', () => {
    let plain: ServiceNowInstance;
    let elevated: ServiceNowInstance;
    let set: string;
    const created: string[] = [];
    const target = () => ({ scope: { sysId: SCOPE }, updateSet: set });

    beforeAll(async () => {
        await initCredentialStore();
        const { resolveSessionCredentials } = await import('../../../../src/auth/CredentialProvider');
        const credential = await resolveSessionCredentials(SN_INSTANCE_ALIAS);
        const provider = () => resolveSessionCredentials(SN_INSTANCE_ALIAS);
        plain = new ServiceNowInstance({ alias: SN_INSTANCE_ALIAS, credential, credentialProvider: provider });
        elevated = new ServiceNowInstance({ alias: SN_INSTANCE_ALIAS, credential, credentialProvider: provider, elevatedRoles: ['security_admin'] });
        set = (await new UpdateSetManager(plain).createUpdateSet({ name: `NSE ACL IT ${NAME}`, application: SCOPE,
            description: 'AclManager_IT: throwaway, set to Ignore by the test.' })).sys_id;
    }, 2 * MINUTE);

    afterAll(async () => {
        const acls = new AclManager(elevated);
        for (const id of created) await acls.delete(id, { ...target(), confirm: id }).catch(() => undefined);
        if (set) {
            await new BackgroundScriptExecutor(plain, 'global').executeScript(`(function () {
                var s = new GlideRecord('sys_update_set');
                if (s.get('${set}') && s.getValue('name') === 'NSE ACL IT ${NAME}') { s.setValue('state', 'ignore'); s.update(); }
            })();`, 'global');
        }
    }, 5 * MINUTE);

    it('reports the elevation of each instance\'s session', async () => {
        expect((await new RoleElevation(plain).status()).elevated).not.toContain('security_admin');
        const status = await new RoleElevation(elevated).status();
        expect(status.available.map(role => role.name)).toContain('security_admin');
        expect(status.elevated).toContain('security_admin');
    }, MINUTE);

    it('refuses to write without elevation, before any write', async () => {
        await expect(new AclManager(plain).create({ ...target(), type: 'ui_page', name: NAME, operation: 'read', roles: ['itil'] }))
            .rejects.toMatchObject({ code: 'elevation_required' });
        expect(await new AclManager(plain).list({ name: NAME })).toEqual([]);
    }, MINUTE);

    it('creates, changes and deletes an ACL with its roles, every write captured in the set', async () => {
        const acls = new AclManager(elevated);
        const result = await acls.create({ ...target(), type: 'ui_page', name: NAME, operation: 'read', roles: ['itil'] });
        created.push(result.acl!.sysId);
        expect(result.acl).toMatchObject({ name: NAME, type: 'ui_page', operation: 'read', active: true, scope: SCOPE });
        expect(result.acl!.roles.map(role => role.role)).toEqual(['itil']);
        expect(result.removedAutomaticRoles).toEqual(['snc_internal']);
        const sets = (writes: typeof result.writes) => writes.map(write => write.capture.updateSetSysId);
        expect(new Set(sets(result.writes))).toEqual(new Set([set]));

        const changed = await acls.update(result.acl!.sysId, { ...target(), condition: '', adminOverrides: false });
        expect(changed.acl!.adminOverrides).toBe(false);
        const added = await acls.addRole(result.acl!.sysId, 'admin', target());
        expect(added.acl!.roles.map(role => role.role).sort()).toEqual(['admin', 'itil']);
        const removed = await acls.removeRole(result.acl!.sysId, 'itil', target());
        expect(removed.acl!.roles.map(role => role.role)).toEqual(['admin']);
        expect(new Set([...sets(changed.writes), ...sets(added.writes), ...sets(removed.writes)])).toEqual(new Set([set]));

        const deleted = await acls.delete(result.acl!.sysId, { ...target(), confirm: result.acl!.sysId });
        expect(deleted.writes.map(write => write.action)).toEqual(['delete']);
        created.length = 0;
        expect(await acls.list({ name: NAME })).toEqual([]);
    }, 10 * MINUTE);

    it('deactivates an active record ACL before deleting it, as the platform requires', async () => {
        const acls = new AclManager(elevated);
        // An extra read ACL only adds a way to pass (ACLs of the same name are alternatives): no one loses access meanwhile.
        const result = await acls.create({ ...target(), operation: 'read', table: 'cmn_location', roles: ['admin'] });
        created.push(result.acl!.sysId);
        expect(result.acl).toMatchObject({ name: 'cmn_location', type: 'record', active: true });
        const deleted = await acls.delete(result.acl!.sysId, { ...target(), confirm: result.acl!.sysId });
        expect(deleted.writes.map(write => write.action)).toEqual(['update', 'delete']);
        created.length = 0;
    }, 10 * MINUTE);

    it('surfaces the platform\'s reason when it refuses an ACL', async () => {
        // A scoped application may not put a field ACL on another application's field.
        const error = await new AclManager(elevated).create({ ...target(), operation: 'read', table: 'sys_user', field: 'mobile_phone', roles: ['admin'] })
            .catch(e => e);
        expect(error).toMatchObject({ code: 'write_not_applied' });
        expect(JSON.stringify(error.messages)).toContain('outside field');
    }, 5 * MINUTE);
});
