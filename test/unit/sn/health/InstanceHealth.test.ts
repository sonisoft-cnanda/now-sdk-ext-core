/**
 * Unit tests for InstanceHealth
 * Tests consolidated health check against multiple ServiceNow tables
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InstanceHealth } from '../../../../src/sn/health/InstanceHealth';
import { IHttpResponse } from '../../../../src/comm/http/IHttpResponse';
import { MockAuthenticationHandler, createGetCredentialsMock } from '../../__mocks__/servicenow-sdk-mocks';
import { AuthenticationHandlerFactory } from '../../../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../../../src/comm/http/RequestHandlerFactory';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { AggregateQuery } from '../../../../src/sn/aggregate/AggregateQuery';

// Mock dependencies
jest.mock('../../../../src/auth/AuthenticationHandlerFactory');
jest.mock('../../../../src/comm/http/RequestHandlerFactory');
jest.mock('@servicenow/sdk-cli/dist/auth/index.js', () => ({
    getCredentials: createGetCredentialsMock()
}));

const mockGetCredentials = createGetCredentialsMock();

// Mock request handler
class MockRequestHandler {
    get = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    post = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    put = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    delete = jest.fn<() => Promise<IHttpResponse<unknown>>>();
}

function createMockResponse(data: unknown, status: number = 200): IHttpResponse<unknown> {
    return {
        data,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: {},
        config: {},
        bodyObject: data
    };
}

describe('InstanceHealth - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let health: InstanceHealth;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;
    let mockAggregateQuery: { count: jest.Mock };

    beforeEach(async () => {
        jest.clearAllMocks();
        SessionManager.resetInstance();

        mockAuthHandler = new MockAuthenticationHandler();
        mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
        mockRequestHandler = new MockRequestHandler();

        jest.spyOn(AuthenticationHandlerFactory, 'createAuthHandler')
            .mockReturnValue(mockAuthHandler as unknown as ReturnType<typeof AuthenticationHandlerFactory.createAuthHandler>);
        jest.spyOn(RequestHandlerFactory, 'createRequestHandler')
            .mockReturnValue(mockRequestHandler as unknown as ReturnType<typeof RequestHandlerFactory.createRequestHandler>);

        const credential = await mockGetCredentials('test-instance');
        const snSettings: ServiceNowSettingsInstance = {
            alias: 'test-instance',
            credential: credential
        };
        instance = new ServiceNowInstance(snSettings);

        // Create a mock AggregateQuery
        mockAggregateQuery = {
            count: jest.fn<() => Promise<number>>()
        };

        health = new InstanceHealth(instance, mockAggregateQuery as unknown as AggregateQuery);
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(health).toBeInstanceOf(InstanceHealth);
        });

        it('should create instance without explicit AggregateQuery', () => {
            const h = new InstanceHealth(instance);
            expect(h).toBeInstanceOf(InstanceHealth);
        });
    });

    describe('checkHealth - all checks enabled', () => {
        it('should return consolidated health result with all data', async () => {
            // Mock version info
            mockRequestHandler.get.mockImplementation(async (req: any) => {
                const query = req?.query?.sysparm_query || '';

                if (query.includes('nameIN')) {
                    // sys_properties for version
                    return createMockResponse({
                        result: [
                            { sys_id: '1', name: 'glide.war', value: 'glide-rome-06-23-2022' },
                            { sys_id: '2', name: 'glide.build.date', value: '2022-06-23' },
                            { sys_id: '3', name: 'glide.build.tag', value: 'rome-patch5' }
                        ]
                    });
                }
                if (query.includes('state=0')) {
                    // sys_trigger for stuck jobs
                    return createMockResponse({
                        result: [
                            { sys_id: 'j1', name: 'StuckJob1', next_action: '2022-01-01', state: '0' }
                        ]
                    });
                }
                // sys_cluster_state or sys_semaphore (no specific query)
                return createMockResponse({
                    result: [
                        { sys_id: 'n1', node_id: 'node-1', status: 'online' },
                        { sys_id: 'n2', node_id: 'node-2', status: 'online' }
                    ]
                });
            });

            // Mock operational counts
            mockAggregateQuery.count
                .mockResolvedValueOnce(15)  // incidents
                .mockResolvedValueOnce(3)   // changes
                .mockResolvedValueOnce(7);  // problems

            const result = await health.checkHealth();

            expect(result.timestamp).toBeDefined();
            expect(result.version).toBeDefined();
            expect(result.version?.version).toBe('glide-rome-06-23-2022');
            expect(result.version?.buildDate).toBe('2022-06-23');
            expect(result.version?.buildTag).toBe('rome-patch5');
            expect(result.clusterNodes).toBeDefined();
            expect(result.stuckJobs).toBeDefined();
            expect(result.stuckJobs?.length).toBe(1);
            expect(result.operationalCounts).toBeDefined();
            expect(result.operationalCounts?.openIncidents).toBe(15);
            expect(result.operationalCounts?.openChanges).toBe(3);
            expect(result.operationalCounts?.openProblems).toBe(7);
            expect(result.summary).toBeDefined();
            expect(result.summary.length).toBeGreaterThan(0);
        });
    });

    describe('checkHealth - options disabled', () => {
        it('should skip version check when disabled', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));
            mockAggregateQuery.count.mockResolvedValue(0);

            const result = await health.checkHealth({ includeVersion: false });

            expect(result.version).toBeNull();
        });

        it('should skip cluster check when disabled', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));
            mockAggregateQuery.count.mockResolvedValue(0);

            const result = await health.checkHealth({ includeCluster: false });

            expect(result.clusterNodes).toBeNull();
        });

        it('should skip stuck jobs check when disabled', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));
            mockAggregateQuery.count.mockResolvedValue(0);

            const result = await health.checkHealth({ includeStuckJobs: false });

            expect(result.stuckJobs).toBeNull();
        });

        it('should skip semaphores check when disabled', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));
            mockAggregateQuery.count.mockResolvedValue(0);

            const result = await health.checkHealth({ includeSemaphores: false });

            expect(result.activeSemaphoreCount).toBeNull();
        });

        it('should skip operational counts when disabled', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            const result = await health.checkHealth({ includeOperationalCounts: false });

            expect(result.operationalCounts).toBeNull();
            expect(mockAggregateQuery.count).not.toHaveBeenCalled();
        });
    });

    describe('checkHealth - sub-check failure isolation', () => {
        it('should return null for version if API fails', async () => {
            mockRequestHandler.get.mockRejectedValueOnce(new Error('API timeout'))
                .mockResolvedValue(createMockResponse({ result: [] }));
            mockAggregateQuery.count.mockResolvedValue(0);

            const result = await health.checkHealth();

            expect(result.version).toBeNull();
            // Other fields should still be populated
            expect(result.timestamp).toBeDefined();
        });

        it('should return null for cluster if API fails', async () => {
            // Version succeeds
            mockRequestHandler.get
                .mockResolvedValueOnce(createMockResponse({
                    result: [{ sys_id: '1', name: 'glide.war', value: 'test' }]
                }))
                // Cluster fails
                .mockRejectedValueOnce(new Error('Cluster error'))
                // Stuck jobs succeeds
                .mockResolvedValueOnce(createMockResponse({ result: [] }))
                // Semaphores succeeds
                .mockResolvedValueOnce(createMockResponse({ result: [] }));

            mockAggregateQuery.count.mockResolvedValue(0);

            const result = await health.checkHealth();

            expect(result.version).toBeDefined();
            expect(result.clusterNodes).toBeNull();
        });

        it('should handle individual aggregate count failures gracefully', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            mockAggregateQuery.count
                .mockResolvedValueOnce(10)         // incidents ok
                .mockRejectedValueOnce(new Error('timeout'))  // changes fail
                .mockResolvedValueOnce(5);         // problems ok

            const result = await health.checkHealth();

            expect(result.operationalCounts).toBeDefined();
            expect(result.operationalCounts?.openIncidents).toBe(10);
            expect(result.operationalCounts?.openChanges).toBeNull();
            expect(result.operationalCounts?.openProblems).toBe(5);
        });
    });

    describe('checkHealth - summary', () => {
        it('should build summary with version info', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({
                result: [
                    { sys_id: '1', name: 'glide.war', value: 'tokyo' },
                    { sys_id: '2', name: 'glide.build.tag', value: 'tokyo-patch3' }
                ]
            }));
            mockAggregateQuery.count.mockResolvedValue(0);

            const result = await health.checkHealth({
                includeCluster: false,
                includeStuckJobs: false,
                includeSemaphores: false,
                includeOperationalCounts: false
            });

            expect(result.summary).toContain('tokyo');
            expect(result.summary).toContain('tokyo-patch3');
        });

        it('should return fallback summary when no data collected', async () => {
            const result = await health.checkHealth({
                includeVersion: false,
                includeCluster: false,
                includeStuckJobs: false,
                includeSemaphores: false,
                includeOperationalCounts: false
            });

            expect(result.summary).toBe('Health check completed (no data collected)');
        });
    });

    describe('checkHealth - stuck job threshold', () => {
        it('should use custom threshold in query', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));
            mockAggregateQuery.count.mockResolvedValue(0);

            await health.checkHealth({ stuckJobThresholdMinutes: 60 });

            // One of the get calls should contain the threshold
            const calls = mockRequestHandler.get.mock.calls;
            const stuckJobCall = calls.find((call: any) => {
                const query = call[0]?.query?.sysparm_query || call[1]?.sysparm_query || '';
                return query.includes('minutesAgoStart(60)');
            });

            expect(stuckJobCall).toBeDefined();
        });
    });
});
