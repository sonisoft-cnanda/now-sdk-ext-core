// This suite runs as real ESM (jest is invoked with --experimental-vm-modules),
// where the `jest` object is not injected as a global.
import { jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { getCredentials } from "@servicenow/sdk-cli/dist/auth/index.js";
import { SN_INSTANCE_ALIAS } from '../../../test_utils/test_config';

import { FlowManager } from '../../../../src/sn/flow/FlowManager';
import { ProcessFlowRequest } from '../../../../src/comm/http/ProcessFlowRequest';
import { FlowExecutionResult, FlowContextStatusResult, FlowPublishResult, FlowDefinitionResult, FlowActionResult, FlowTestResult, FlowCopyResult, FlowContextDetailsResult, FlowLogResult, FlowArtifactDefinitionResult, ActionDefinitionResult } from '../../../../src/sn/flow/FlowModels';

const SECONDS = 1000;

describe('FlowManager - Integration Tests', () => {
    let instance: ServiceNowInstance;
    let flowMgr: FlowManager;

    beforeAll(async () => {
        const credential = await getCredentials(SN_INSTANCE_ALIAS);

        if (credential) {
            const snSettings: ServiceNowSettingsInstance = {
                alias: SN_INSTANCE_ALIAS,
                credential: credential
            };
            instance = new ServiceNowInstance(snSettings);
            flowMgr = new FlowManager(instance);
        }

        if (!flowMgr) {
            throw new Error('Could not get credentials.');
        }
    }, 60 * SECONDS);

    // ============================================================
    // Error Handling - Non-existent objects
    // ============================================================

    describe('error handling', () => {
        it('should handle non-existent flow gracefully', async () => {
            const result: FlowExecutionResult = await flowMgr.executeFlow({
                scopedName: 'global.nonexistent_flow_xyz_12345'
            });

            console.log('\n=== executeFlow (non-existent) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeDefined();
            expect(result.errorMessage).toContain('does not exist');
            expect(result.flowObjectName).toBe('global.nonexistent_flow_xyz_12345');
            expect(result.flowObjectType).toBe('flow');
        }, 120 * SECONDS);

        it('should handle non-existent subflow gracefully', async () => {
            const result: FlowExecutionResult = await flowMgr.executeSubflow({
                scopedName: 'global.nonexistent_subflow_xyz_12345'
            });

            console.log('\n=== executeSubflow (non-existent) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toContain('does not exist');
            expect(result.flowObjectType).toBe('subflow');
        }, 120 * SECONDS);

        it('should handle non-existent action gracefully', async () => {
            const result: FlowExecutionResult = await flowMgr.executeAction({
                scopedName: 'global.nonexistent_action_xyz_12345'
            });

            console.log('\n=== executeAction (non-existent) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toContain('does not exist');
            expect(result.flowObjectType).toBe('action');
        }, 120 * SECONDS);

        it('should return descriptive error when action receives wrong inputs', async () => {
            const result: FlowExecutionResult = await flowMgr.executeAction({
                scopedName: 'global.should_send_notification',
                inputs: {
                    table_name: 'incident',
                    sys_id: '0000000000000000000000000000dead'
                }
            });

            console.log('\n=== executeAction (wrong inputs) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeDefined();
            expect(result.errorMessage).toContain('inputs');
            expect(result.flowObjectName).toBe('global.should_send_notification');
        }, 120 * SECONDS);
    });

    // ============================================================
    // executeFlow - Background mode (proven to succeed)
    // ============================================================

    describe('executeFlow', () => {
        it('should execute a flow in background and return context ID', async () => {
            // "Change - Unauthorized - Review" is a known global OOB flow.
            // Background mode returns immediately with a context ID.
            const result: FlowExecutionResult = await flowMgr.executeFlow({
                scopedName: 'global.change__unauthorized__review',
                mode: 'background'
            });

            console.log('\n=== executeFlow (background) ===');
            console.log('Success:', result.success);
            console.log('Context ID:', result.contextId);
            console.log('Flow Object Name:', result.flowObjectName);
            console.log('Debug Output:', result.debugOutput?.substring(0, 300));

            expect(result.success).toBe(true);
            expect(result.flowObjectName).toBe('global.change__unauthorized__review');
            expect(result.flowObjectType).toBe('flow');
            expect(result.contextId).toBeDefined();
            expect(result.contextId).toMatch(/^[0-9a-f]{32}$/);
            expect(result.debugOutput).toContain('FlowRunnerResult');
            expect(result.debugOutput).toContain('global.change__unauthorized__review');
            expect(result.executionDate).toBeDefined();
        }, 120 * SECONDS);

        it('should execute a flow in foreground and get structured error for wait-state flow', async () => {
            // Foreground execution of a flow with approval/wait steps
            // produces a structured error "The current execution is in the waiting state"
            const result: FlowExecutionResult = await flowMgr.executeFlow({
                scopedName: 'global.change__unauthorized__review',
                mode: 'foreground',
                timeout: 30000
            });

            console.log('\n=== executeFlow (foreground, wait-state) ===');
            console.log('Success:', result.success);
            console.log('Error Message:', result.errorMessage);

            expect(result.success).toBe(false);
            expect(result.flowObjectName).toBe('global.change__unauthorized__review');
            expect(result.flowObjectType).toBe('flow');
            expect(result.errorMessage).toContain('waiting state');
            expect(result.rawScriptResult).toBeDefined();
        }, 120 * SECONDS);

        it('should execute a flow with quick mode', async () => {
            const result: FlowExecutionResult = await flowMgr.executeFlow({
                scopedName: 'global.change__unauthorized__review',
                mode: 'foreground',
                quick: true
            });

            console.log('\n=== executeFlow (quick mode) ===');
            console.log('Success:', result.success);
            console.log('Error Message:', result.errorMessage);

            // Quick mode on a complex flow should return a structured result
            expect(result.flowObjectName).toBe('global.change__unauthorized__review');
            expect(result.flowObjectType).toBe('flow');
            expect(result.rawScriptResult).toBeDefined();
        }, 120 * SECONDS);
    });

    // ============================================================
    // executeAction - Proven to succeed with outputs
    // ============================================================

    describe('executeAction', () => {
        it('should execute an action and return outputs', async () => {
            // "Get Notification Details" (should_send_notification) is a global action
            // that runs successfully without inputs and returns outputs.
            const result: FlowExecutionResult = await flowMgr.executeAction({
                scopedName: 'global.should_send_notification',
                mode: 'foreground'
            });

            console.log('\n=== executeAction (should_send_notification) ===');
            console.log('Success:', result.success);
            console.log('Flow Object Name:', result.flowObjectName);
            console.log('Flow Object Type:', result.flowObjectType);
            console.log('Context ID:', result.contextId);
            console.log('Outputs:', JSON.stringify(result.outputs));
            console.log('Debug Output:', result.debugOutput?.substring(0, 300));

            expect(result.success).toBe(true);
            expect(result.flowObjectName).toBe('global.should_send_notification');
            expect(result.flowObjectType).toBe('action');
            expect(result.contextId).toBeDefined();
            expect(result.contextId).toMatch(/^[0-9a-f]{32}$/);
            expect(result.outputs).toBeDefined();
            expect(result.outputs).toHaveProperty('send_va');
            expect(result.debugOutput).toContain('FlowRunnerResult');
            expect(result.debugOutput).toContain('action');
            expect(result.executionDate).toBeDefined();
        }, 120 * SECONDS);
    });

    // ============================================================
    // executeSubflow
    // ============================================================

    describe('executeSubflow', () => {
        it('should execute a subflow and return structured result', async () => {
            // "Placeholder Subflow for MFA Guided Setup" is a simple global subflow.
            // It may hit a wait state in foreground, but we verify envelope parsing works.
            const result: FlowExecutionResult = await flowMgr.executeSubflow({
                scopedName: 'global.placeholder_subflow_for_mfa_guided_setup',
                mode: 'foreground'
            });

            console.log('\n=== executeSubflow (placeholder_subflow_for_mfa_guided_setup) ===');
            console.log('Success:', result.success);
            console.log('Flow Object Name:', result.flowObjectName);
            console.log('Flow Object Type:', result.flowObjectType);
            console.log('Error Message:', result.errorMessage);

            expect(result.flowObjectName).toBe('global.placeholder_subflow_for_mfa_guided_setup');
            expect(result.flowObjectType).toBe('subflow');
            expect(result.rawScriptResult).toBeDefined();
        }, 120 * SECONDS);
    });

    // ============================================================
    // Scope handling
    // ============================================================

    describe('scope handling', () => {
        it('should execute with explicit global scope by name', async () => {
            const result: FlowExecutionResult = await flowMgr.executeFlow({
                scopedName: 'global.nonexistent_flow_xyz_12345',
                scope: 'global'
            });

            console.log('\n=== executeFlow (explicit scope: global) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            expect(result.success).toBe(false);
            // Error should be about the flow not existing, not scope resolution failure
            expect(result.errorMessage).toContain('does not exist');
        }, 120 * SECONDS);
    });

    // ============================================================
    // Flow Context Lifecycle
    // ============================================================

    describe('flow context lifecycle', () => {
        it('should get context status for a background flow execution', async () => {
            // Execute a flow in background to get a real context ID
            const execResult: FlowExecutionResult = await flowMgr.executeFlow({
                scopedName: 'global.change__unauthorized__review',
                mode: 'background'
            });

            console.log('\n=== lifecycle: executeFlow (background) ===');
            console.log('Success:', execResult.success);
            console.log('Context ID:', execResult.contextId);

            expect(execResult.success).toBe(true);
            expect(execResult.contextId).toBeDefined();
            expect(execResult.contextId).toMatch(/^[0-9a-f]{32}$/);

            // Now query the context status
            const statusResult: FlowContextStatusResult = await flowMgr.getFlowContextStatus(execResult.contextId!);

            console.log('\n=== lifecycle: getFlowContextStatus ===');
            console.log('Success:', statusResult.success);
            console.log('Found:', statusResult.found);
            console.log('State:', statusResult.state);
            console.log('Name:', statusResult.name);
            console.log('Started:', statusResult.started);

            expect(statusResult.success).toBe(true);
            expect(statusResult.found).toBe(true);
            expect(statusResult.state).toBeDefined();
            expect(['QUEUED', 'IN_PROGRESS', 'WAITING', 'COMPLETE', 'CANCELLED', 'ERROR']).toContain(statusResult.state);
            expect(statusResult.name).toBeDefined();
        }, 120 * SECONDS);

        it('should return found=false for non-existent context ID', async () => {
            const statusResult = await flowMgr.getFlowContextStatus('00000000000000000000000000000000');

            console.log('\n=== lifecycle: getFlowContextStatus (non-existent) ===');
            console.log('Success:', statusResult.success);
            console.log('Found:', statusResult.found);

            expect(statusResult.success).toBe(true);
            expect(statusResult.found).toBe(false);
            expect(statusResult.state).toBeUndefined();
        }, 120 * SECONDS);

        it('should get outputs for a completed action', async () => {
            // Execute an action in foreground (completes immediately)
            const execResult: FlowExecutionResult = await flowMgr.executeAction({
                scopedName: 'global.should_send_notification',
                mode: 'foreground'
            });

            console.log('\n=== lifecycle: executeAction (foreground) ===');
            console.log('Success:', execResult.success);
            console.log('Context ID:', execResult.contextId);

            expect(execResult.success).toBe(true);
            expect(execResult.contextId).toBeDefined();

            // Now get outputs via lifecycle API
            const outputsResult = await flowMgr.getFlowOutputs(execResult.contextId!);

            console.log('\n=== lifecycle: getFlowOutputs ===');
            console.log('Success:', outputsResult.success);
            console.log('Outputs:', JSON.stringify(outputsResult.outputs));

            expect(outputsResult.success).toBe(true);
            // Outputs may be empty object if the flow already returned them inline
            expect(outputsResult.outputs).toBeDefined();
        }, 120 * SECONDS);

        it('should get error message for a completed context', async () => {
            // Execute an action with wrong inputs to produce an error
            const execResult: FlowExecutionResult = await flowMgr.executeAction({
                scopedName: 'global.should_send_notification',
                inputs: {
                    table_name: 'incident',
                    sys_id: '0000000000000000000000000000dead'
                }
            });

            console.log('\n=== lifecycle: executeAction (wrong inputs) ===');
            console.log('Success:', execResult.success);

            // The action may fail or succeed depending on how it handles bad input.
            // Either way, we can query the error message.
            if (execResult.contextId) {
                const errorResult = await flowMgr.getFlowError(execResult.contextId);

                console.log('\n=== lifecycle: getFlowError ===');
                console.log('Success:', errorResult.success);
                console.log('Flow Error:', errorResult.flowErrorMessage);

                expect(errorResult.success).toBe(true);
                // flowErrorMessage may or may not be present depending on the error
            }
        }, 120 * SECONDS);

        it('should cancel a background flow', async () => {
            // Execute a flow in background
            const execResult: FlowExecutionResult = await flowMgr.executeFlow({
                scopedName: 'global.change__unauthorized__review',
                mode: 'background'
            });

            console.log('\n=== lifecycle: executeFlow for cancel ===');
            console.log('Success:', execResult.success);
            console.log('Context ID:', execResult.contextId);

            expect(execResult.success).toBe(true);
            expect(execResult.contextId).toBeDefined();

            // Cancel the flow
            const cancelResult = await flowMgr.cancelFlow(
                execResult.contextId!,
                'Cancelled by integration test'
            );

            console.log('\n=== lifecycle: cancelFlow ===');
            console.log('Success:', cancelResult.success);
            console.log('Error:', cancelResult.errorMessage);

            // Cancel should succeed (or fail gracefully if already completed)
            expect(cancelResult.contextId).toBe(execResult.contextId);
            expect(cancelResult.rawScriptResult).toBeDefined();
        }, 120 * SECONDS);
    });

    // ============================================================
    // Flow Publishing
    // ============================================================

    describe('publishFlow', () => {
        // Note: This test uses an ITSM OOTB flow. Requires the ITSM plugin on the target instance.
        // To run against a non-ITSM instance, set TEST_PUBLISH_FLOW env var to a valid scoped name.
        it('should publish a flow by scoped name', async () => {
            const flowName = process.env.TEST_PUBLISH_FLOW || 'global.change__unauthorized__review';
            const result: FlowPublishResult = await flowMgr.publishFlow(
                flowName
            );

            console.log('\n=== publishFlow (by scoped name) ===');
            console.log('Success:', result.success);
            console.log('Flow Name:', result.flowName);
            console.log('Flow SysId:', result.flowSysId);
            console.log('Error:', result.errorMessage);

            expect(result.flowSysId).toBeDefined();
            expect(result.flowSysId.length).toBe(32);
            expect(result.flowName).toBeDefined();
            // Publish may succeed or fail if already published — both are valid
            expect(result.rawScriptResult).toBeDefined();
        }, 120 * SECONDS);

        it('should handle non-existent flow gracefully', async () => {
            const result: FlowPublishResult = await flowMgr.publishFlow(
                'global.nonexistent_flow_xyz_99999'
            );

            console.log('\n=== publishFlow (non-existent) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeDefined();
            expect(result.errorMessage).toContain('Flow not found');
        }, 120 * SECONDS);
    });

    // ============================================================
    // getFlowDefinition (ProcessFlow REST API)
    // ============================================================

    describe('getFlowDefinition', () => {
        // Known flow on <dev_instance>: "Copy of Change - Standard"
        const KNOWN_FLOW_SYS_ID = process.env.TEST_FLOW_SYS_ID || '887dda5583237210fdb8f7b6feaad32c';

        it('should fetch a flow definition by sys_id', async () => {
            const result: FlowDefinitionResult = await flowMgr.getFlowDefinition(KNOWN_FLOW_SYS_ID);

            console.log('\n=== getFlowDefinition ===');
            console.log('Success:', result.success);
            console.log('Flow name:', result.definition?.name);
            console.log('Flow status:', result.definition?.status);
            console.log('Trigger count:', (result.definition?.triggerInstances as any[])?.length);
            console.log('Action count:', (result.definition?.actionInstances as any[])?.length);

            expect(result.success).toBe(true);
            expect(result.definition).toBeDefined();
            expect(result.definition!.id).toBe(KNOWN_FLOW_SYS_ID);
            expect(result.definition!.name).toBeDefined();
            expect(result.definition!.triggerInstances).toBeDefined();
            expect(result.definition!.actionInstances).toBeDefined();
        }, 120 * SECONDS);

        it('should handle non-existent flow sys_id', async () => {
            const result: FlowDefinitionResult = await flowMgr.getFlowDefinition(
                '00000000000000000000000000000000'
            );

            console.log('\n=== getFlowDefinition (non-existent) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            // The API may return an error or empty data
            expect(result.success).toBe(false);
        }, 120 * SECONDS);
    });

    // ============================================================
    // getFlowActions (ProcessFlow REST API)
    // ============================================================

    describe('getFlowActions', () => {
        // Known flow on <dev_instance>: "Copy of Change - Standard"
        // Used to discover an action_type sys_id from its actionInstances.
        const KNOWN_FLOW_SYS_ID = process.env.TEST_FLOW_SYS_ID || '887dda5583237210fdb8f7b6feaad32c';
        // Optional explicit action_type sys_id override
        const KNOWN_ACTION_SYS_ID = process.env.TEST_ACTION_SYS_ID;
        // Scope passed as sysparm_transaction_scope; override via TEST_SCOPE env var
        const KNOWN_SCOPE = process.env.TEST_SCOPE || 'global';

        it('should fetch a flow action by sys_id', async () => {
            // Resolve an action_type sys_id either from env or by inspecting a known flow definition
            let actionSysId = KNOWN_ACTION_SYS_ID;
            if (!actionSysId) {
                const defResult = await flowMgr.getFlowDefinition(KNOWN_FLOW_SYS_ID);
                expect(defResult.success).toBe(true);

                const actionInstances = (defResult.definition?.actionInstances as Array<Record<string, any>>) || [];
                const firstActionType = actionInstances.find(ai => ai?.actionType?.id)?.actionType?.id;
                expect(firstActionType).toBeDefined();
                actionSysId = firstActionType as string;
            }

            console.log('\n=== getFlowActions (resolving action_type sys_id) ===');
            console.log('Action SysId:', actionSysId);

            const result: FlowActionResult = await flowMgr.getFlowActions(actionSysId!);

            console.log('Success:', result.success);
            if (Array.isArray(result.action)) {
                console.log('Action (array length):', result.action.length);
            } else {
                console.log('Action name:', (result.action as Record<string, unknown>)?.name);
                console.log('Action label:', (result.action as Record<string, unknown>)?.label);
            }

            expect(result.success).toBe(true);
            expect(result.action).toBeDefined();
            expect(typeof result.action).toBe('object');
        }, 120 * SECONDS);

        it('should reject empty action sys_id', async () => {
            await expect(flowMgr.getFlowActions('')).rejects.toThrow('Action sys_id is required');
            await expect(flowMgr.getFlowActions('   ')).rejects.toThrow('Action sys_id is required');
        }, 60 * SECONDS);

        it('should handle non-existent action sys_id', async () => {
            const result: FlowActionResult = await flowMgr.getFlowActions(
                '00000000000000000000000000000000'
            );

            console.log('\n=== getFlowActions (non-existent) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            // The API may return an error or empty data
            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeDefined();
        }, 120 * SECONDS);

        it('should pass scope as transaction scope query param', async () => {
            // Smoke test: passing a scope (defaults to 'global', overridable via TEST_SCOPE)
            // should not break the call.
            let actionSysId = KNOWN_ACTION_SYS_ID;
            if (!actionSysId) {
                const defResult = await flowMgr.getFlowDefinition(KNOWN_FLOW_SYS_ID);
                const actionInstances = (defResult.definition?.actionInstances as Array<Record<string, any>>) || [];
                actionSysId = actionInstances.find(ai => ai?.actionType?.id)?.actionType?.id as string | undefined;
            }
            if (!actionSysId) {
                console.warn('Skipping scoped getFlowActions test: no action_type sys_id available');
                return;
            }

            const result: FlowActionResult = await flowMgr.getFlowActions(actionSysId, KNOWN_SCOPE);

            console.log('\n=== getFlowActions (with scope) ===');
            console.log('Scope:', KNOWN_SCOPE);
            console.log('Success:', result.success);

            expect(result.success).toBe(true);
            expect(result.action).toBeDefined();
        }, 120 * SECONDS);
    });

    // ============================================================
    // testFlow (ProcessFlow REST API)
    // ============================================================

    describe('testFlow', () => {
        // Known flow on <dev_instance>: "Copy of Change - Standard"
        // Trigger: record_create on change_request with chg_model = Standard
        const KNOWN_FLOW_SYS_ID = process.env.TEST_FLOW_SYS_ID || '887dda5583237210fdb8f7b6feaad32c';
        // A known change_request record on the dev instance
        const KNOWN_CHANGE_SYS_ID = process.env.TEST_CHANGE_SYS_ID || '0ecd7552db252200a6a2b31be0b8f5e6';

        it('should test a flow and return execution context ID', async () => {
            const result: FlowTestResult = await flowMgr.testFlow({
                flowId: KNOWN_FLOW_SYS_ID,
                outputMap: {
                    current: KNOWN_CHANGE_SYS_ID,
                    table_name: 'change_request'
                }
            });

            console.log('\n=== testFlow ===');
            console.log('Success:', result.success);
            console.log('Context ID:', result.contextId);
            console.log('Error Code:', result.errorCode);
            console.log('Error Message:', result.errorMessage);

            expect(result.success).toBe(true);
            expect(result.contextId).toBeDefined();
            expect(result.contextId).toMatch(/^[0-9a-f]{32}$/);
            expect(result.errorCode).toBe(0);
        }, 120 * SECONDS);

        it('should verify test context via getFlowContextStatus', async () => {
            const testResult: FlowTestResult = await flowMgr.testFlow({
                flowId: KNOWN_FLOW_SYS_ID,
                outputMap: {
                    current: KNOWN_CHANGE_SYS_ID,
                    table_name: 'change_request'
                }
            });

            console.log('\n=== testFlow + verify context ===');
            console.log('Test Success:', testResult.success);
            console.log('Context ID:', testResult.contextId);

            expect(testResult.success).toBe(true);
            expect(testResult.contextId).toBeDefined();

            // Verify the context was created
            const statusResult = await flowMgr.getFlowContextStatus(testResult.contextId!);

            console.log('Context Found:', statusResult.found);
            console.log('Context State:', statusResult.state);
            console.log('Context Name:', statusResult.name);

            expect(statusResult.success).toBe(true);
            expect(statusResult.found).toBe(true);
            expect(statusResult.state).toBeDefined();
        }, 120 * SECONDS);

        it('should handle non-existent flow gracefully', async () => {
            const result: FlowTestResult = await flowMgr.testFlow({
                flowId: 'global.nonexistent_flow_xyz_99999',
                outputMap: { current: 'some_id', table_name: 'incident' }
            });

            console.log('\n=== testFlow (non-existent) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeDefined();
        }, 120 * SECONDS);
    });

    // ============================================================
    // copyFlow (ProcessFlow REST API)
    // ============================================================

    describe('copyFlow', () => {
        // Source: "Change - Standard" OOB flow
        const SOURCE_FLOW_SYS_ID = process.env.TEST_COPY_SOURCE_FLOW || 'e89e3ade731310108ef62d2b04f6a744';
        // Target scope: "My Awesome App" on <dev_instance>
        const TARGET_SCOPE = process.env.TEST_COPY_TARGET_SCOPE || '4a5a6115402946939ee48e3fe80f60f8';

        it('should copy a flow into a target scope', async () => {
            const copyName = `IT Copy ${Date.now()}`;
            const result: FlowCopyResult = await flowMgr.copyFlow({
                sourceFlowId: SOURCE_FLOW_SYS_ID,
                name: copyName,
                targetScope: TARGET_SCOPE
            });

            console.log('\n=== copyFlow ===');
            console.log('Success:', result.success);
            console.log('New Flow SysId:', result.newFlowSysId);
            console.log('Error Code:', result.errorCode);
            console.log('Error Message:', result.errorMessage);

            expect(result.success).toBe(true);
            expect(result.newFlowSysId).toBeDefined();
            expect(result.newFlowSysId).toMatch(/^[0-9a-f]{32}$/);
            expect(result.errorCode).toBe(0);
        }, 120 * SECONDS);

        it('should return the new flow definition when fetched', async () => {
            const copyName = `IT Copy Verify ${Date.now()}`;
            const copyResult: FlowCopyResult = await flowMgr.copyFlow({
                sourceFlowId: SOURCE_FLOW_SYS_ID,
                name: copyName,
                targetScope: TARGET_SCOPE
            });

            console.log('\n=== copyFlow + verify ===');
            console.log('Copy Success:', copyResult.success);
            console.log('New Flow SysId:', copyResult.newFlowSysId);

            expect(copyResult.success).toBe(true);
            expect(copyResult.newFlowSysId).toBeDefined();

            // Verify the new flow exists by fetching its definition
            const defResult = await flowMgr.getFlowDefinition(copyResult.newFlowSysId!);

            console.log('Definition fetch success:', defResult.success);
            console.log('Flow name:', defResult.definition?.name);
            console.log('Flow status:', defResult.definition?.status);

            expect(defResult.success).toBe(true);
            expect(defResult.definition).toBeDefined();
            expect(defResult.definition!.name).toBe(copyName);
        }, 120 * SECONDS);

        it('should handle non-existent source flow gracefully', async () => {
            const result: FlowCopyResult = await flowMgr.copyFlow({
                sourceFlowId: 'global.nonexistent_flow_xyz_99999',
                name: 'Should Not Exist',
                targetScope: TARGET_SCOPE
            });

            console.log('\n=== copyFlow (non-existent source) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            expect(result.success).toBe(false);
            expect(result.errorMessage).toBeDefined();
        }, 120 * SECONDS);
    });

    // ============================================================
    // getFlowContextDetails
    // ============================================================

    describe('getFlowContextDetails', () => {
        // Instance-specific: context ID from "Copy of Change - Standard" test execution on <dev_instance>.
        // These tests will fail on other instances — update the ID and expected values accordingly.
        const KNOWN_CONTEXT_ID = '811e52d5702372105d88c5714b9b559b';

        it('should return detailed flow context for a known execution', async () => {
            const result: FlowContextDetailsResult = await flowMgr.getFlowContextDetails(KNOWN_CONTEXT_ID);

            console.log('\n=== getFlowContextDetails (known context) ===');
            console.log('Success:', result.success);
            console.log('Flow name:', result.flowContext?.name);
            console.log('State:', result.flowContext?.state);
            console.log('RunTime:', result.flowContext?.runTime, 'ms');
            console.log('Is test run:', result.flowContext?.isTestRun);
            console.log('Executed as:', result.flowContext?.executedAs);
            console.log('Calling source:', result.flowContext?.executionSource?.callingSource);
            console.log('Report available:', result.flowReportAvailabilityDetails?.errorMessage || 'yes');
            if (result.flowReport) {
                console.log('Flow report state:', result.flowReport.operationsCore.state);
                console.log('Action reports count:', Object.keys(result.flowReport.actionOperationsReports).length);
            }

            expect(result.success).toBe(true);
            expect(result.contextId).toBe(KNOWN_CONTEXT_ID);
            expect(result.flowContext).toBeDefined();
            expect(result.flowContext!.state).toBe('COMPLETE');
            expect(result.flowContext!.name).toBe('Copy of Change - Standard');
        }, 120 * SECONDS);

        it('should include flow definition when requested', async () => {
            const result: FlowContextDetailsResult = await flowMgr.getFlowContextDetails(
                KNOWN_CONTEXT_ID, undefined, true
            );

            console.log('\n=== getFlowContextDetails (with definition) ===');
            console.log('Success:', result.success);
            console.log('Flow definition present:', !!result.flowDefinition);
            if (result.flowDefinition) {
                console.log('Definition name:', result.flowDefinition.name);
            }

            expect(result.success).toBe(true);
            expect(result.flowDefinition).toBeDefined();
        }, 120 * SECONDS);

        it('should return execution report with per-action details', async () => {
            const result: FlowContextDetailsResult = await flowMgr.getFlowContextDetails(KNOWN_CONTEXT_ID);

            console.log('\n=== getFlowContextDetails (execution report) ===');
            if (result.flowReport) {
                const actionKeys = Object.keys(result.flowReport.actionOperationsReports);
                console.log('Action count:', actionKeys.length);
                for (const key of actionKeys) {
                    const action = result.flowReport.actionOperationsReports[key];
                    console.log(`  Action ${key}: state=${action.operationsCore.state}, runTime=${action.operationsCore.runTime}ms, step="${action.stepLabel ?? 'N/A'}"`);
                }
            }

            expect(result.success).toBe(true);
            expect(result.flowReport).toBeDefined();
            // The "Copy of Change - Standard" flow has action steps
            const actionCount = Object.keys(result.flowReport!.actionOperationsReports).length;
            expect(actionCount).toBeGreaterThan(0);
        }, 120 * SECONDS);

        it('should handle non-existent context gracefully', async () => {
            const result: FlowContextDetailsResult = await flowMgr.getFlowContextDetails(
                '00000000000000000000000000000000'
            );

            console.log('\n=== getFlowContextDetails (non-existent) ===');
            console.log('Success:', result.success);
            console.log('Error:', result.errorMessage);

            // The API may return an error or an empty response
            // Either way we should handle it without crashing
            expect(result.contextId).toBe('00000000000000000000000000000000');
        }, 120 * SECONDS);
    });

    // ============================================================
    // getFlowLogs
    // ============================================================

    describe('getFlowLogs', () => {
        const KNOWN_CONTEXT_ID = '811e52d5702372105d88c5714b9b559b';

        it('should query flow logs for a known context', async () => {
            const result: FlowLogResult = await flowMgr.getFlowLogs(KNOWN_CONTEXT_ID);

            console.log('\n=== getFlowLogs (known context) ===');
            console.log('Success:', result.success);
            console.log('Entry count:', result.entries.length);
            for (const entry of result.entries.slice(0, 5)) {
                console.log(`  [${entry.level}] ${entry.message} (action: ${entry.action})`);
            }

            expect(result.success).toBe(true);
            expect(result.contextId).toBe(KNOWN_CONTEXT_ID);
            expect(Array.isArray(result.entries)).toBe(true);
            // This context may or may not have logs - just verify the structure
        }, 120 * SECONDS);

        it('should support custom limit', async () => {
            const result: FlowLogResult = await flowMgr.getFlowLogs(KNOWN_CONTEXT_ID, { limit: 2 });

            console.log('\n=== getFlowLogs (limit 2) ===');
            console.log('Success:', result.success);
            console.log('Entry count:', result.entries.length);

            expect(result.success).toBe(true);
            expect(result.entries.length).toBeLessThanOrEqual(2);
        }, 120 * SECONDS);

        it('should return empty entries for context with no logs', async () => {
            // Use a non-existent context ID that won't have any logs
            const result: FlowLogResult = await flowMgr.getFlowLogs('00000000000000000000000000000000');

            console.log('\n=== getFlowLogs (no logs) ===');
            console.log('Success:', result.success);
            console.log('Entry count:', result.entries.length);

            expect(result.success).toBe(true);
            expect(result.entries).toHaveLength(0);
        }, 120 * SECONDS);
    });

    // ============================================================
    // Design-time definition retrieval (read-only ProcessFlow routes)
    //
    // One small artifact of each type, retrieved without executing it. Every
    // sys_id is overridable so this runs against any instance that has a
    // readable flow, subflow and action.
    //
    // Only names and collection sizes are printed. The definitions themselves
    // contain scripts and field values and are deliberately not logged.
    // ============================================================

    describe('design-time definition retrieval', () => {
        // Defaults are small OOB artifacts present on a stock developer instance.
        const FLOW_SYS_ID = process.env.TEST_DEFINITION_FLOW_SYS_ID || 'ae20de1b83a79210e84dcba2722bc06e';
        const SUBFLOW_SYS_ID = process.env.TEST_DEFINITION_SUBFLOW_SYS_ID || 'cb622e9624500210f8778ca667ee1a00';
        const ACTION_SYS_ID = process.env.TEST_DEFINITION_ACTION_SYS_ID || '1df3d0cb534e2010c232ddeeff7b12e1';

        /**
         * Records every mutating path a definition read must not take, so a live
         * run proves AC4 rather than merely asserting it in a mock.
         */
        function watchForExecution() {
            const executeScript = jest.spyOn(
                (flowMgr as any)._bgExecutor as { executeScript: (...args: unknown[]) => unknown },
                'executeScript'
            );
            const post = jest.spyOn(ProcessFlowRequest.prototype, 'post');
            return {
                executeScript,
                post,
                assertReadOnly() {
                    expect(executeScript).not.toHaveBeenCalled();
                    expect(post).not.toHaveBeenCalled();
                    executeScript.mockRestore();
                    post.mockRestore();
                }
            };
        }

        it('should retrieve a flow definition without a context or execution', async () => {
            const watch = watchForExecution();

            const result: FlowArtifactDefinitionResult = await flowMgr.getFlowArtifactDefinition(FLOW_SYS_ID);

            console.log('\n=== getFlowArtifactDefinition (flow) ===');
            console.log('Success:', result.success);
            console.log('Artifact type:', result.artifactType);
            console.log('Name:', result.summary?.name);
            console.log('Triggers/actions/logic:', result.summary?.triggerCount, result.summary?.actionCount, result.summary?.flowLogicCount);
            console.log('Failure reason:', result.failureReason);

            expect(result.success).toBe(true);
            expect(result.artifactType).toBe('flow');
            expect(result.reportedType).toBe('flow');
            expect(result.definition).toBeDefined();
            expect(result.definition!.actionInstances).toBeDefined();
            expect(result.definition!.triggerInstances).toBeDefined();

            // JSON-serializable, and round-trips without loss.
            const json = JSON.stringify(result.definition);
            expect(JSON.parse(json)).toEqual(result.definition);

            watch.assertReadOnly();
        }, 120 * SECONDS);

        it('should retrieve a subflow definition with its inputs, outputs and logic', async () => {
            const watch = watchForExecution();

            const result: FlowArtifactDefinitionResult = await flowMgr.getSubflowDefinition(SUBFLOW_SYS_ID);

            console.log('\n=== getSubflowDefinition ===');
            console.log('Success:', result.success);
            console.log('Artifact type:', result.artifactType);
            console.log('Name:', result.summary?.name);
            console.log('Inputs/outputs:', result.summary?.inputCount, result.summary?.outputCount);
            console.log('Actions/subflows/logic:', result.summary?.actionCount, result.summary?.subflowCount, result.summary?.flowLogicCount);
            console.log('Failure reason:', result.failureReason);

            expect(result.success).toBe(true);
            expect(result.artifactType).toBe('subflow');
            expect(result.definition!.inputs).toBeDefined();
            expect(result.definition!.outputs).toBeDefined();
            expect(result.definition!.actionInstances).toBeDefined();
            expect(result.definition!.subFlowInstances).toBeDefined();
            expect(result.definition!.flowLogicInstances).toBeDefined();

            const json = JSON.stringify(result.definition);
            expect(JSON.parse(json)).toEqual(result.definition);

            watch.assertReadOnly();
        }, 120 * SECONDS);

        it('should retrieve a complete action definition: metadata plus ordered steps', async () => {
            const watch = watchForExecution();

            const result: ActionDefinitionResult = await flowMgr.getActionDefinition(ACTION_SYS_ID);

            console.log('\n=== getActionDefinition ===');
            console.log('Success:', result.success);
            console.log('Name:', result.summary?.name);
            console.log('State:', result.summary?.state);
            console.log('Inputs/outputs:', result.summary?.inputCount, result.summary?.outputCount);
            console.log('Step count:', result.summary?.stepCount);
            console.log('Step order:', result.summary?.steps.map((s) => `${s.order}:${s.stepTypeName}`).join(', '));
            console.log('Failure reason:', result.failureReason);

            expect(result.success).toBe(true);
            expect(result.artifactType).toBe('action');
            expect(result.metadata).toBeDefined();
            expect(result.metadata!.inputs).toBeDefined();
            expect(result.metadata!.outputs).toBeDefined();
            expect(Array.isArray(result.steps)).toBe(true);

            // Steps are ordered ascending and the projection matches the raw list.
            const orders = result.summary!.steps.map((s) => s.order);
            expect([...orders].sort((a, b) => a - b)).toEqual(orders);
            expect(result.summary!.stepCount).toBe(result.steps!.length);

            const json = JSON.stringify({ metadata: result.metadata, steps: result.steps });
            expect(JSON.parse(json)).toEqual({ metadata: result.metadata, steps: result.steps });

            watch.assertReadOnly();
        }, 120 * SECONDS);

        it('should not relabel a subflow as a flow', async () => {
            const result: FlowArtifactDefinitionResult = await flowMgr.getFlowDesignDefinition(SUBFLOW_SYS_ID);

            console.log('\n=== getFlowDesignDefinition (subflow sys_id) ===');
            console.log('Success:', result.success);
            console.log('Failure reason:', result.failureReason);
            console.log('Reported type:', result.reportedType);

            expect(result.success).toBe(false);
            expect(result.failureReason).toBe('type_mismatch');
            expect(result.reportedType).toBe('subflow');
            expect(result.definition).toBeUndefined();
        }, 120 * SECONDS);

        it('should report a typed failure for an unknown sys_id', async () => {
            const result: FlowArtifactDefinitionResult = await flowMgr.getFlowArtifactDefinition(
                '00000000000000000000000000000000'
            );

            console.log('\n=== getFlowArtifactDefinition (unknown sys_id) ===');
            console.log('Success:', result.success);
            console.log('Failure reason:', result.failureReason);

            expect(result.success).toBe(false);
            expect(['not_found', 'api_error', 'malformed_response']).toContain(result.failureReason);
            expect(result.errorMessage).toBeDefined();
        }, 120 * SECONDS);

        it('should report a typed failure for a malformed sys_id without a request', async () => {
            const result: ActionDefinitionResult = await flowMgr.getActionDefinition('not-a-sys-id');

            expect(result.success).toBe(false);
            expect(result.failureReason).toBe('invalid_identifier');
        }, 30 * SECONDS);
    });
});
