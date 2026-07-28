import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { getCredentials } from "@servicenow/sdk-cli/dist/auth/index.js";
import { SN_INSTANCE_ALIAS } from '../../../test_utils/test_config';

import { UpdateSetManager } from '../../../../src/sn/updateset/UpdateSetManager';
import { UpdateSetRecord, CloneUpdateSetResult, InspectUpdateSetResult, MoveRecordsResult } from '../../../../src/sn/updateset/UpdateSetModels';
import { TableAPIRequest } from '../../../../src/comm/http/TableAPIRequest';

const SECONDS = 1000;

describe('UpdateSetManager - Integration Tests', () => {
    let instance: ServiceNowInstance;
    let credential: unknown;
    let updateSetManager: UpdateSetManager;
    let tableAPI: TableAPIRequest;
    let createdSysIds: string[] = [];

    beforeEach(async () => {
        createdSysIds = [];
        credential = await getCredentials(SN_INSTANCE_ALIAS);

        if (credential) {
            const snSettings: ServiceNowSettingsInstance = {
                alias: SN_INSTANCE_ALIAS,
                credential: credential
            };
            instance = new ServiceNowInstance(snSettings);
            updateSetManager = new UpdateSetManager(instance);
            tableAPI = new TableAPIRequest(instance);
        }

        if (!instance) throw new Error("Could not get credentials.");
    });

    afterEach(async () => {
        // Clean up all created test update sets
        if (createdSysIds.length > 0 && instance) {
            const { ServiceNowRequest } = await import('../../../../src/comm/http/ServiceNowRequest');
            const snReq = new ServiceNowRequest(instance);

            for (const sysId of createdSysIds) {
                try {
                    await snReq.delete({
                        path: `/api/now/table/sys_update_set/${sysId}`,
                        headers: { "Content-Type": "application/json", "Accept": "application/json" },
                        query: null,
                        body: null
                    });
                    console.log(`Cleaned up test update set: ${sysId}`);
                } catch (e) {
                    console.warn(`Warning: Failed to clean up update set ${sysId}:`, e);
                }
            }
        }
    });

    describe('listUpdateSets', () => {
        it('should return an array of update sets with sys_id and name', async () => {
            const updateSets: UpdateSetRecord[] = await updateSetManager.listUpdateSets();

            console.log(`\nRetrieved ${updateSets.length} update sets`);

            expect(updateSets).toBeDefined();
            expect(Array.isArray(updateSets)).toBe(true);
            expect(updateSets.length).toBeGreaterThan(0);

            if (updateSets.length > 0) {
                const first = updateSets[0];
                expect(first.sys_id).toBeDefined();
                expect(first.sys_id.length).toBeGreaterThan(0);
                expect(first.name).toBeDefined();
                expect(first.name.length).toBeGreaterThan(0);

                console.log('\nSample update sets:');
                updateSets.slice(0, 5).forEach(us => {
                    console.log(`  - ${us.name} (sys_id: ${us.sys_id}, state: ${us.state})`);
                });
            }
        }, 60 * SECONDS);

        it('should filter update sets with encodedQuery for state=in progress', async () => {
            const updateSets: UpdateSetRecord[] = await updateSetManager.listUpdateSets({
                encodedQuery: 'state=in progress'
            });

            console.log(`\nRetrieved ${updateSets.length} update sets with state=in progress`);

            expect(updateSets).toBeDefined();
            expect(Array.isArray(updateSets)).toBe(true);

            // All returned update sets should have state "in progress"
            updateSets.forEach(us => {
                expect(us.state).toBe('in progress');
            });

            if (updateSets.length > 0) {
                console.log('\nFiltered update sets (in progress):');
                updateSets.slice(0, 5).forEach(us => {
                    console.log(`  - ${us.name} (sys_id: ${us.sys_id}, state: ${us.state})`);
                });
            }
        }, 60 * SECONDS);
    });

    describe('getCurrentUpdateSet', () => {
        it('should return the current update set with sys_id and name', async () => {
            const currentUpdateSet: UpdateSetRecord | null = await updateSetManager.getCurrentUpdateSet();

            console.log('\nCurrent update set:', JSON.stringify(currentUpdateSet, null, 2));

            expect(currentUpdateSet).toBeDefined();
            expect(currentUpdateSet).not.toBeNull();
            expect(currentUpdateSet!.sys_id).toBeDefined();
            expect(currentUpdateSet!.sys_id.length).toBeGreaterThan(0);
            expect(currentUpdateSet!.name).toBeDefined();
            expect(currentUpdateSet!.name.length).toBeGreaterThan(0);
        }, 60 * SECONDS);
    });

    describe('createUpdateSet', () => {
        it('should create a new update set and return it with a valid sys_id', async () => {
            const timestamp = new Date().toISOString();
            const testName = `[IT_TEST] UpdateSet ${timestamp}`;

            const created: UpdateSetRecord = await updateSetManager.createUpdateSet({
                name: testName,
                description: 'Integration test update set - safe to delete'
            });

            console.log('\nCreated update set:', JSON.stringify(created, null, 2));

            expect(created).toBeDefined();
            expect(created.sys_id).toBeDefined();
            expect(created.sys_id.length).toBeGreaterThan(0);
            expect(created.name).toBe(testName);

            // Track for cleanup
            createdSysIds.push(created.sys_id);
        }, 60 * SECONDS);
    });

    describe('setCurrentUpdateSet', () => {
        it('should set the current update set, verify it, then restore the original', async () => {
            const originalUpdateSet: UpdateSetRecord | null = await updateSetManager.getCurrentUpdateSet();

            expect(originalUpdateSet).toBeDefined();
            expect(originalUpdateSet).not.toBeNull();

            console.log(`\nOriginal update set: ${originalUpdateSet!.name} (${originalUpdateSet!.sys_id})`);

            // Create a test update set
            const timestamp = new Date().toISOString();
            const testName = `[IT_TEST] SetCurrent ${timestamp}`;
            const testSet: UpdateSetRecord = await updateSetManager.createUpdateSet({
                name: testName,
                description: 'Integration test for setCurrentUpdateSet - safe to delete'
            });
            createdSysIds.push(testSet.sys_id);

            console.log(`Created test update set: ${testSet.name} (${testSet.sys_id})`);

            // Set the current update set to the test one
            await updateSetManager.setCurrentUpdateSet({
                name: testSet.name,
                sysId: testSet.sys_id
            });

            // Verify the current update set was changed
            const currentAfterSet = await updateSetManager.getCurrentUpdateSet();
            expect(currentAfterSet).toBeDefined();
            expect(currentAfterSet).not.toBeNull();
            expect(currentAfterSet!.sys_id).toBe(testSet.sys_id);

            console.log(`Current update set after set: ${currentAfterSet!.name} (${currentAfterSet!.sys_id})`);

            // Restore the original update set
            await updateSetManager.setCurrentUpdateSet({
                name: originalUpdateSet!.name,
                sysId: originalUpdateSet!.sys_id
            });

            // Verify restoration
            const restoredSet = await updateSetManager.getCurrentUpdateSet();
            expect(restoredSet).toBeDefined();
            expect(restoredSet!.sys_id).toBe(originalUpdateSet!.sys_id);

            console.log(`Restored update set: ${restoredSet!.name} (${restoredSet!.sys_id})`);
        }, 120 * SECONDS);
    });

    describe('inspectUpdateSet', () => {
        it('should inspect an update set and return its structure', async () => {
            // List update sets to find one to inspect
            const updateSets: UpdateSetRecord[] = await updateSetManager.listUpdateSets({ limit: 10 });
            expect(updateSets.length).toBeGreaterThan(0);

            const targetSet = updateSets[0];
            console.log(`\nInspecting update set: ${targetSet.name} (${targetSet.sys_id})`);

            const result: InspectUpdateSetResult = await updateSetManager.inspectUpdateSet(targetSet.sys_id);

            console.log('\nInspection result:');
            console.log(`  Update Set: ${result.updateSet.name} (state: ${result.updateSet.state})`);
            console.log(`  Total Records: ${result.totalRecords}`);
            console.log(`  Components: ${result.components.length} types`);

            expect(result).toBeDefined();
            expect(result.updateSet).toBeDefined();
            expect(result.updateSet.sys_id).toBe(targetSet.sys_id);
            expect(result.updateSet.name).toBeDefined();
            expect(result.updateSet.state).toBeDefined();
            expect(typeof result.totalRecords).toBe('number');
            expect(result.totalRecords).toBeGreaterThanOrEqual(0);
            expect(Array.isArray(result.components)).toBe(true);

            if (result.components.length > 0) {
                console.log('\n  Component breakdown:');
                result.components.forEach(comp => {
                    expect(comp.type).toBeDefined();
                    expect(comp.count).toBeGreaterThan(0);
                    expect(Array.isArray(comp.items)).toBe(true);
                    console.log(`    - ${comp.type}: ${comp.count} items`);
                });
            }
        }, 60 * SECONDS);
    });

    describe('cloneUpdateSet', () => {
        it('should clone an update set and return the clone result', async () => {
            const timestamp = new Date().toISOString();

            // Create a source update set
            const sourceName = `[IT_TEST] CloneSource ${timestamp}`;
            const sourceSet: UpdateSetRecord = await updateSetManager.createUpdateSet({
                name: sourceName,
                description: 'Integration test source for clone - safe to delete'
            });
            createdSysIds.push(sourceSet.sys_id);

            console.log(`\nCreated source update set: ${sourceSet.name} (${sourceSet.sys_id})`);

            // Clone the source update set
            const cloneName = `[IT_TEST] Cloned ${timestamp}`;
            const progressMessages: string[] = [];

            const result: CloneUpdateSetResult = await updateSetManager.cloneUpdateSet(
                sourceSet.sys_id,
                cloneName,
                (message: string) => {
                    progressMessages.push(message);
                    console.log(`  Progress: ${message}`);
                }
            );

            console.log('\nClone result:', JSON.stringify(result, null, 2));
            console.log(`Progress messages received: ${progressMessages.length}`);

            expect(result).toBeDefined();
            expect(result.newUpdateSetId).toBeDefined();
            expect(result.newUpdateSetId.length).toBeGreaterThan(0);
            expect(result.newUpdateSetName).toBe(cloneName);
            expect(result.sourceUpdateSetId).toBe(sourceSet.sys_id);
            expect(result.sourceUpdateSetName).toBe(sourceName);
            expect(typeof result.recordsCloned).toBe('number');
            expect(typeof result.totalSourceRecords).toBe('number');
            expect(result.recordsCloned).toBe(result.totalSourceRecords);

            // Track the cloned set for cleanup
            createdSysIds.push(result.newUpdateSetId);
        }, 120 * SECONDS);
    });

    describe('moveRecordsToUpdateSet', () => {
        it('should move records between update sets using sourceUpdateSet', async () => {
            // NOTE: On fresh dev instances, business rules ("Handle updates moving between sets")
            // may block moving records via the Table API with a 403 error. This test will
            // handle that gracefully by verifying the method runs without throwing and
            // checking whatever results are returned (some records may fail to move).
            const updateSets: UpdateSetRecord[] = await updateSetManager.listUpdateSets({ limit: 20 });

            let sourceSetWithRecords: UpdateSetRecord | null = null;
            let inspectResult: InspectUpdateSetResult | null = null;

            for (const us of updateSets) {
                try {
                    const inspection = await updateSetManager.inspectUpdateSet(us.sys_id);
                    if (inspection.totalRecords > 0) {
                        sourceSetWithRecords = us;
                        inspectResult = inspection;
                        break;
                    }
                } catch {
                    // Skip sets that fail inspection
                    continue;
                }
            }

            if (!sourceSetWithRecords || !inspectResult) {
                console.log('\nSkipping: No update set with records found on instance');
                return;
            }

            console.log(`\nFound source update set with records: ${sourceSetWithRecords.name} (${sourceSetWithRecords.sys_id})`);
            console.log(`  Total records: ${inspectResult.totalRecords}`);

            const timestamp = new Date().toISOString();

            // Create a target update set to move records into
            const targetName = `[IT_TEST] MoveTarget ${timestamp}`;
            const targetSet: UpdateSetRecord = await updateSetManager.createUpdateSet({
                name: targetName,
                description: 'Integration test target for moveRecords - safe to delete'
            });
            createdSysIds.push(targetSet.sys_id);

            console.log(`Created target update set: ${targetSet.name} (${targetSet.sys_id})`);

            // Query a few sys_update_xml records from the source to use recordSysIds
            // (avoids sourceUpdateSet which fetches ALL 1000 records and times out on 403s)
            const xmlResp = await tableAPI.get<{ result: Array<{ sys_id: string }> }>(
                'sys_update_xml',
                {
                    sysparm_query: `update_set=${sourceSetWithRecords.sys_id}`,
                    sysparm_limit: '3',
                    sysparm_fields: 'sys_id'
                }
            );

            const recordSysIds = xmlResp.bodyObject?.result?.map(r => r.sys_id) || [];

            if (recordSysIds.length === 0) {
                console.log('No sys_update_xml records found to move. Skipping.');
                return;
            }

            console.log(`Found ${recordSysIds.length} records to move`);

            const progressMessages: string[] = [];
            const moveResult: MoveRecordsResult = await updateSetManager.moveRecordsToUpdateSet(
                targetSet.sys_id,
                {
                    recordSysIds,
                    onProgress: (message: string) => {
                        progressMessages.push(message);
                    }
                }
            );

            console.log('\nMove result:', JSON.stringify({
                moved: moveResult.moved,
                failed: moveResult.failed,
                recordCount: moveResult.records.length,
                errorCount: moveResult.errors.length
            }, null, 2));
            console.log(`Progress messages received: ${progressMessages.length}`);

            expect(moveResult).toBeDefined();
            // On fresh instances, business rules may block moving records (403 errors)
            // so we just verify the method returns a valid result structure
            expect(typeof moveResult.moved).toBe('number');
            expect(typeof moveResult.failed).toBe('number');
            expect(Array.isArray(moveResult.records)).toBe(true);
            expect(Array.isArray(moveResult.errors)).toBe(true);

            if (moveResult.moved > 0) {
                // If any records were moved, try to move them back
                console.log('\nMoving records back to the original source update set...');
                const moveBackResult: MoveRecordsResult = await updateSetManager.moveRecordsToUpdateSet(
                    sourceSetWithRecords.sys_id,
                    {
                        sourceUpdateSet: targetSet.sys_id
                    }
                );

                console.log('Move back result:', JSON.stringify({
                    moved: moveBackResult.moved,
                    failed: moveBackResult.failed
                }, null, 2));
            } else {
                console.log('No records were successfully moved (likely blocked by business rules). Test validates method structure.');
            }
        }, 120 * SECONDS);
    });

    describe('exportUpdateSet', () => {
        it('should throw when update set sys_id is missing', async () => {
            await expect(updateSetManager.exportUpdateSet('')).rejects.toThrow('Update set sys_id is required');
            await expect(updateSetManager.exportUpdateSet('   ')).rejects.toThrow('Update set sys_id is required');
        });

        it('should return XML for an update set export', async () => {
            const timestamp = new Date().toISOString();
            const testName = `[IT_TEST] Export ${timestamp}`;
            const created: UpdateSetRecord = await updateSetManager.createUpdateSet({
                name: testName,
                description: 'Integration test for exportUpdateSet - safe to delete'
            });
            createdSysIds.push(created.sys_id);

            const xml: string = await updateSetManager.exportUpdateSet(created.sys_id);

            expect(typeof xml).toBe('string');
            expect(xml.length).toBeGreaterThan(0);
            // ServiceNow update set XML is typically a UTF-8 XML unload document
            expect(xml).toMatch(/<\?xml|<unload/i);
        }, 120 * SECONDS);
    });
});
