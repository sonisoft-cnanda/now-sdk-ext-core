/**
 * Unit tests for WorkflowManager
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { WorkflowManager } from '../../../../src/sn/workflow/WorkflowManager';
import { IHttpResponse } from '../../../../src/comm/http/IHttpResponse';
import { AuthenticationHandlerFactory } from '../../../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../../../src/comm/http/RequestHandlerFactory';
import { SessionManager } from '../../../../src/comm/http/SessionManager';

// Mock getCredentials
const mockGetCredentials = createGetCredentialsMock();
jest.mock('@servicenow/sdk-cli/dist/auth/index.js', () => ({
    getCredentials: mockGetCredentials
}));

// Mock factories
jest.mock('../../../../src/auth/AuthenticationHandlerFactory');
jest.mock('../../../../src/comm/http/RequestHandlerFactory');

// Mock request handler
class MockRequestHandler {
    get = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    post = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    put = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    delete = jest.fn<() => Promise<IHttpResponse<unknown>>>();
}

/**
 * Creates a mock successful POST response with a sys_id and optional name.
 */
function createMockPostResponse(sysId: string, name?: string, status: number = 201) {
    const result: any = { sys_id: sysId };
    if (name !== undefined) {
        result.name = name;
    }
    return {
        data: { result },
        status,
        statusText: status === 201 ? 'Created' : 'OK',
        headers: {},
        config: {},
        bodyObject: { result }
    } as IHttpResponse<any>;
}

/**
 * Creates a mock successful PUT response.
 */
function createMockPutResponse(sysId: string, status: number = 200) {
    return {
        data: { result: { sys_id: sysId } },
        status,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: { sys_id: sysId } }
    } as IHttpResponse<any>;
}

/**
 * Creates a non-200 error response.
 */
function createErrorResponse(status: number = 500) {
    return {
        data: null,
        status,
        statusText: 'Error',
        headers: {},
        config: {},
        bodyObject: null
    } as IHttpResponse<any>;
}

describe('WorkflowManager - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let wfManager: WorkflowManager;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;

    beforeEach(async () => {
        jest.clearAllMocks();
        SessionManager.resetInstance();

        mockAuthHandler = new MockAuthenticationHandler();
        mockRequestHandler = new MockRequestHandler();

        jest.spyOn(AuthenticationHandlerFactory, 'createAuthHandler')
            .mockReturnValue(mockAuthHandler as unknown as ReturnType<typeof AuthenticationHandlerFactory.createAuthHandler>);
        jest.spyOn(RequestHandlerFactory, 'createRequestHandler')
            .mockReturnValue(mockRequestHandler as unknown as ReturnType<typeof RequestHandlerFactory.createRequestHandler>);

        const alias = 'test-instance';
        const credential = await mockGetCredentials(alias);

        if (credential) {
            const snSettings: ServiceNowSettingsInstance = {
                alias: alias,
                credential: credential
            };
            instance = new ServiceNowInstance(snSettings);
            wfManager = new WorkflowManager(instance);
        }
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(wfManager).toBeInstanceOf(WorkflowManager);
            expect((wfManager as any)._instance).toBe(instance);
        });

        it('should initialize logger', () => {
            expect((wfManager as any)._logger).toBeDefined();
        });

        it('should initialize ServiceNowRequest', () => {
            expect((wfManager as any)._req).toBeDefined();
        });

        it('should initialize TableAPIRequest', () => {
            expect((wfManager as any)._tableAPI).toBeDefined();
        });
    });

    describe('Constants', () => {
        it('should have WF_WORKFLOW constant', () => {
            expect((WorkflowManager as any).WF_WORKFLOW).toBe('wf_workflow');
        });

        it('should have WF_WORKFLOW_VERSION constant', () => {
            expect((WorkflowManager as any).WF_WORKFLOW_VERSION).toBe('wf_workflow_version');
        });

        it('should have WF_ACTIVITY constant', () => {
            expect((WorkflowManager as any).WF_ACTIVITY).toBe('wf_activity');
        });

        it('should have WF_TRANSITION constant', () => {
            expect((WorkflowManager as any).WF_TRANSITION).toBe('wf_transition');
        });

        it('should have WF_CONDITION constant', () => {
            expect((WorkflowManager as any).WF_CONDITION).toBe('wf_condition');
        });
    });

    describe('createWorkflow', () => {
        it('should create a workflow successfully', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-123', 'My Workflow'));

            const result = await wfManager.createWorkflow({ name: 'My Workflow' });

            expect(result.workflowSysId).toBe('wf-123');
            expect(result.name).toBe('My Workflow');
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(1);
        });

        it('should create a workflow with all options', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-456', 'Template WF'));

            const result = await wfManager.createWorkflow({
                name: 'Template WF',
                description: 'A template workflow',
                template: true,
                access: 'public'
            });

            expect(result.workflowSysId).toBe('wf-456');
            expect(result.name).toBe('Template WF');
        });

        it('should throw error if name is empty', async () => {
            await expect(wfManager.createWorkflow({ name: '' }))
                .rejects.toThrow('Workflow name is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(wfManager.createWorkflow({ name: 'Test' }))
                .rejects.toThrow('Failed to create workflow');
        });

        it('should accept status 200 as success', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-789', 'WF', 200));

            const result = await wfManager.createWorkflow({ name: 'WF' });
            expect(result.workflowSysId).toBe('wf-789');
        });
    });

    describe('createWorkflowVersion', () => {
        it('should create a workflow version successfully', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-123', 'Version 1'));

            const result = await wfManager.createWorkflowVersion({
                name: 'Version 1',
                workflowSysId: 'wf-123',
                table: 'incident'
            });

            expect(result.versionSysId).toBe('ver-123');
            expect(result.name).toBe('Version 1');
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(1);
        });

        it('should create version with all options', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-456', 'Version 2'));

            const result = await wfManager.createWorkflowVersion({
                name: 'Version 2',
                workflowSysId: 'wf-123',
                table: 'incident',
                description: 'Second version',
                active: true,
                published: false,
                condition: 'priority=1',
                order: 100
            });

            expect(result.versionSysId).toBe('ver-456');
        });

        it('should throw error if name is empty', async () => {
            await expect(wfManager.createWorkflowVersion({
                name: '',
                workflowSysId: 'wf-123',
                table: 'incident'
            })).rejects.toThrow('Workflow version name is required');
        });

        it('should throw error if workflowSysId is empty', async () => {
            await expect(wfManager.createWorkflowVersion({
                name: 'Version 1',
                workflowSysId: '',
                table: 'incident'
            })).rejects.toThrow('Workflow sys_id is required');
        });

        it('should throw error if table is empty', async () => {
            await expect(wfManager.createWorkflowVersion({
                name: 'Version 1',
                workflowSysId: 'wf-123',
                table: ''
            })).rejects.toThrow('Table name is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(wfManager.createWorkflowVersion({
                name: 'Version 1',
                workflowSysId: 'wf-123',
                table: 'incident'
            })).rejects.toThrow('Failed to create workflow version');
        });
    });

    describe('createActivity', () => {
        it('should create an activity successfully', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-123', 'Begin'));

            const result = await wfManager.createActivity({
                name: 'Begin',
                workflowVersionSysId: 'ver-123'
            });

            expect(result.activitySysId).toBe('act-123');
            expect(result.name).toBe('Begin');
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(1);
        });

        it('should create activity with all options', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-456', 'Run Script'));

            const result = await wfManager.createActivity({
                name: 'Run Script',
                workflowVersionSysId: 'ver-123',
                activityDefinitionSysId: 'def-999',
                x: 100,
                y: 200,
                width: 80,
                height: 40,
                script: 'gs.log("hello");',
                vars: 'input=test'
            });

            expect(result.activitySysId).toBe('act-456');
            expect(result.name).toBe('Run Script');
        });

        it('should throw error if name is empty', async () => {
            await expect(wfManager.createActivity({
                name: '',
                workflowVersionSysId: 'ver-123'
            })).rejects.toThrow('Activity name is required');
        });

        it('should throw error if workflowVersionSysId is empty', async () => {
            await expect(wfManager.createActivity({
                name: 'Begin',
                workflowVersionSysId: ''
            })).rejects.toThrow('Workflow version sys_id is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(wfManager.createActivity({
                name: 'Begin',
                workflowVersionSysId: 'ver-123'
            })).rejects.toThrow('Failed to create activity');
        });
    });

    describe('createTransition', () => {
        it('should create a transition successfully', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('trans-123'));

            const result = await wfManager.createTransition({
                fromActivitySysId: 'act-1',
                toActivitySysId: 'act-2'
            });

            expect(result.transitionSysId).toBe('trans-123');
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(1);
        });

        it('should create transition with condition and order', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('trans-456'));

            const result = await wfManager.createTransition({
                fromActivitySysId: 'act-1',
                toActivitySysId: 'act-2',
                conditionSysId: 'cond-789',
                order: 10
            });

            expect(result.transitionSysId).toBe('trans-456');
        });

        it('should throw error if fromActivitySysId is empty', async () => {
            await expect(wfManager.createTransition({
                fromActivitySysId: '',
                toActivitySysId: 'act-2'
            })).rejects.toThrow('From activity sys_id is required');
        });

        it('should throw error if toActivitySysId is empty', async () => {
            await expect(wfManager.createTransition({
                fromActivitySysId: 'act-1',
                toActivitySysId: ''
            })).rejects.toThrow('To activity sys_id is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(wfManager.createTransition({
                fromActivitySysId: 'act-1',
                toActivitySysId: 'act-2'
            })).rejects.toThrow('Failed to create transition');
        });
    });

    describe('createCondition', () => {
        it('should create a condition successfully', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('cond-123', 'Yes'));

            const result = await wfManager.createCondition({
                activitySysId: 'act-1',
                name: 'Yes'
            });

            expect(result.conditionSysId).toBe('cond-123');
            expect(result.name).toBe('Yes');
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(1);
        });

        it('should create condition with all options', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('cond-456', 'Otherwise'));

            const result = await wfManager.createCondition({
                activitySysId: 'act-1',
                name: 'Otherwise',
                description: 'Else branch',
                condition: 'current.priority > 2',
                order: 200,
                elseFlag: true
            });

            expect(result.conditionSysId).toBe('cond-456');
            expect(result.name).toBe('Otherwise');
        });

        it('should throw error if activitySysId is empty', async () => {
            await expect(wfManager.createCondition({
                activitySysId: '',
                name: 'Yes'
            })).rejects.toThrow('Activity sys_id is required');
        });

        it('should throw error if name is empty', async () => {
            await expect(wfManager.createCondition({
                activitySysId: 'act-1',
                name: ''
            })).rejects.toThrow('Condition name is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(wfManager.createCondition({
                activitySysId: 'act-1',
                name: 'Yes'
            })).rejects.toThrow('Failed to create condition');
        });
    });

    describe('publishWorkflow', () => {
        it('should publish a workflow version successfully', async () => {
            mockRequestHandler.put.mockResolvedValueOnce(createMockPutResponse('ver-123'));

            await expect(wfManager.publishWorkflow({
                versionSysId: 'ver-123',
                startActivitySysId: 'act-1'
            })).resolves.toBeUndefined();

            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
        });

        it('should throw error if versionSysId is empty', async () => {
            await expect(wfManager.publishWorkflow({
                versionSysId: '',
                startActivitySysId: 'act-1'
            })).rejects.toThrow('Workflow version sys_id is required');
        });

        it('should throw error if startActivitySysId is empty', async () => {
            await expect(wfManager.publishWorkflow({
                versionSysId: 'ver-123',
                startActivitySysId: ''
            })).rejects.toThrow('Start activity sys_id is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.put.mockResolvedValueOnce(createErrorResponse(500));

            await expect(wfManager.publishWorkflow({
                versionSysId: 'ver-123',
                startActivitySysId: 'act-1'
            })).rejects.toThrow('Failed to publish workflow version');
        });
    });

    describe('createCompleteWorkflow', () => {
        it('should create a complete workflow with activities and transitions', async () => {
            // Mock: createWorkflow
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-100', 'My Workflow'));
            // Mock: createWorkflowVersion
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-100', 'My Workflow'));
            // Mock: createActivity (Begin)
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-begin', 'Begin'));
            // Mock: createActivity (End)
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-end', 'End'));
            // Mock: createTransition
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('trans-1'));

            const result = await wfManager.createCompleteWorkflow({
                name: 'My Workflow',
                description: 'Test workflow',
                table: 'incident',
                activities: [
                    { id: 'begin', name: 'Begin', x: 0, y: 0 },
                    { id: 'end', name: 'End', x: 200, y: 0 }
                ],
                transitions: [
                    { from: 'begin', to: 'end' }
                ]
            });

            expect(result.workflowSysId).toBe('wf-100');
            expect(result.versionSysId).toBe('ver-100');
            expect(result.activitySysIds['begin']).toBe('act-begin');
            expect(result.activitySysIds['end']).toBe('act-end');
            expect(result.activitySysIds['0']).toBe('act-begin');
            expect(result.activitySysIds['1']).toBe('act-end');
            expect(result.transitionSysIds).toHaveLength(1);
            expect(result.transitionSysIds[0]).toBe('trans-1');
            expect(result.published).toBe(false);
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(5);
        });

        it('should create and publish a workflow', async () => {
            // Mock: createWorkflow
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-200', 'Published WF'));
            // Mock: createWorkflowVersion
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-200', 'Published WF'));
            // Mock: createActivity (Start)
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-start', 'Start'));
            // Mock: publishWorkflow (PUT)
            mockRequestHandler.put.mockResolvedValueOnce(createMockPutResponse('ver-200'));

            const result = await wfManager.createCompleteWorkflow({
                name: 'Published WF',
                table: 'incident',
                activities: [
                    { id: 'start', name: 'Start' }
                ],
                publish: true,
                startActivity: 'start'
            });

            expect(result.workflowSysId).toBe('wf-200');
            expect(result.published).toBe(true);
            expect(result.startActivity).toBe('start');
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(3);
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
        });

        it('should reference activities by index when no id is provided', async () => {
            // Mock: createWorkflow
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-300', 'Index WF'));
            // Mock: createWorkflowVersion
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-300', 'Index WF'));
            // Mock: createActivity (First)
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-first', 'First'));
            // Mock: createActivity (Second)
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-second', 'Second'));
            // Mock: createTransition
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('trans-idx'));

            const result = await wfManager.createCompleteWorkflow({
                name: 'Index WF',
                table: 'incident',
                activities: [
                    { name: 'First' },
                    { name: 'Second' }
                ],
                transitions: [
                    { from: '0', to: '1' }
                ]
            });

            expect(result.activitySysIds['0']).toBe('act-first');
            expect(result.activitySysIds['1']).toBe('act-second');
            expect(result.transitionSysIds).toHaveLength(1);
        });

        it('should throw error if name is empty', async () => {
            await expect(wfManager.createCompleteWorkflow({
                name: '',
                table: 'incident',
                activities: [{ name: 'Begin' }]
            })).rejects.toThrow('Workflow name is required');
        });

        it('should throw error if activities list is empty', async () => {
            await expect(wfManager.createCompleteWorkflow({
                name: 'Test',
                table: 'incident',
                activities: []
            })).rejects.toThrow('At least one activity is required');
        });

        it('should throw error if publish=true but no startActivity', async () => {
            // Mock: createWorkflow
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-err', 'WF'));
            // Mock: createWorkflowVersion
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-err', 'WF'));
            // Mock: createActivity
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-err', 'Begin'));

            await expect(wfManager.createCompleteWorkflow({
                name: 'WF',
                table: 'incident',
                activities: [{ name: 'Begin' }],
                publish: true
            })).rejects.toThrow('startActivity is required when publish=true');
        });

        it('should throw error if transition references unknown activity', async () => {
            // Mock: createWorkflow
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-bad', 'WF'));
            // Mock: createWorkflowVersion
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-bad', 'WF'));
            // Mock: createActivity
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-1', 'Begin'));

            await expect(wfManager.createCompleteWorkflow({
                name: 'WF',
                table: 'incident',
                activities: [{ id: 'begin', name: 'Begin' }],
                transitions: [{ from: 'begin', to: 'nonexistent' }]
            })).rejects.toThrow("Transition 'to' activity 'nonexistent' not found");
        });

        it('should throw error if startActivity references unknown activity', async () => {
            // Mock: createWorkflow
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-bad2', 'WF'));
            // Mock: createWorkflowVersion
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-bad2', 'WF'));
            // Mock: createActivity
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-1', 'Begin'));

            await expect(wfManager.createCompleteWorkflow({
                name: 'WF',
                table: 'incident',
                activities: [{ id: 'begin', name: 'Begin' }],
                publish: true,
                startActivity: 'nonexistent'
            })).rejects.toThrow("Start activity 'nonexistent' not found");
        });

        it('should invoke onProgress callback', async () => {
            // Mock: createWorkflow
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-prog', 'WF'));
            // Mock: createWorkflowVersion
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-prog', 'WF'));
            // Mock: createActivity
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-prog', 'Begin'));

            const progressMessages: string[] = [];
            const onProgress = (message: string) => progressMessages.push(message);

            await wfManager.createCompleteWorkflow({
                name: 'WF',
                table: 'incident',
                activities: [{ name: 'Begin' }]
            }, onProgress);

            expect(progressMessages.length).toBeGreaterThan(0);
            expect(progressMessages[0]).toContain("Creating workflow 'WF'");
            expect(progressMessages[progressMessages.length - 1]).toContain('created successfully');
        });

        it('should create workflow without transitions', async () => {
            // Mock: createWorkflow
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-no-trans', 'WF'));
            // Mock: createWorkflowVersion
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-no-trans', 'WF'));
            // Mock: createActivity
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-solo', 'Solo'));

            const result = await wfManager.createCompleteWorkflow({
                name: 'WF',
                table: 'incident',
                activities: [{ name: 'Solo' }]
            });

            expect(result.transitionSysIds).toHaveLength(0);
            expect(result.published).toBe(false);
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(3);
        });

        it('should propagate createWorkflow errors', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(wfManager.createCompleteWorkflow({
                name: 'WF',
                table: 'incident',
                activities: [{ name: 'Begin' }]
            })).rejects.toThrow('Failed to create workflow');
        });

        it('should propagate createActivity errors', async () => {
            // Mock: createWorkflow
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-act-err', 'WF'));
            // Mock: createWorkflowVersion
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-act-err', 'WF'));
            // Mock: createActivity - fails
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(wfManager.createCompleteWorkflow({
                name: 'WF',
                table: 'incident',
                activities: [{ name: 'Begin' }]
            })).rejects.toThrow('Failed to create activity');
        });

        it('should create workflow with multiple activities and transitions', async () => {
            // Mock: createWorkflow
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('wf-multi', 'Multi WF'));
            // Mock: createWorkflowVersion
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('ver-multi', 'Multi WF'));
            // Mock: 3 activities
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-a', 'A'));
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-b', 'B'));
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('act-c', 'C'));
            // Mock: 2 transitions
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('trans-ab'));
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('trans-bc'));

            const result = await wfManager.createCompleteWorkflow({
                name: 'Multi WF',
                table: 'incident',
                activities: [
                    { id: 'a', name: 'A' },
                    { id: 'b', name: 'B' },
                    { id: 'c', name: 'C' }
                ],
                transitions: [
                    { from: 'a', to: 'b' },
                    { from: 'b', to: 'c' }
                ]
            });

            expect(result.activitySysIds['a']).toBe('act-a');
            expect(result.activitySysIds['b']).toBe('act-b');
            expect(result.activitySysIds['c']).toBe('act-c');
            expect(result.transitionSysIds).toHaveLength(2);
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(7);
        });
    });
});
