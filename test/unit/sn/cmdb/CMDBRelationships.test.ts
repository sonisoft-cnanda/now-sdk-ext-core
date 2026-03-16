/**
 * Unit tests for CMDBRelationships
 * Tests CMDB relationship queries and BFS graph traversal
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CMDBRelationships } from '../../../../src/sn/cmdb/CMDBRelationships';
import { IHttpResponse } from '../../../../src/comm/http/IHttpResponse';
import { MockAuthenticationHandler, createGetCredentialsMock } from '../../__mocks__/servicenow-sdk-mocks';
import { AuthenticationHandlerFactory } from '../../../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../../../src/comm/http/RequestHandlerFactory';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';

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

// Helper to create a CI record
function mockCI(sysId: string, name: string, className: string = 'cmdb_ci_server') {
    return { sys_id: sysId, name, sys_class_name: className };
}

// Helper to create a relationship record with string fields
function mockRelString(sysId: string, parent: string, child: string, type: string = 'Depends on') {
    return { sys_id: sysId, parent, child, type };
}

// Helper to create a relationship record with object fields
function mockRelObject(sysId: string, parentId: string, childId: string, typeValue: string = 'depends_on', typeDisplay: string = 'Depends on') {
    return {
        sys_id: sysId,
        parent: { value: parentId, link: `https://test/api/now/table/cmdb_ci/${parentId}` },
        child: { value: childId, link: `https://test/api/now/table/cmdb_ci/${childId}` },
        type: { value: typeValue, display_value: typeDisplay, link: `https://test/api/now/table/cmdb_rel_type/${typeValue}` }
    };
}

/**
 * Mock router: inspects the HTTPRequest path and query to return appropriate responses.
 * TableAPIRequest calls _doRequest which creates HTTPRequest { path, query, ... }
 * and the mock RequestHandler.get receives this object.
 */
function createMockRouter(ciMap: Record<string, any>, relMap: Record<string, any[]>) {
    return async (req: any) => {
        const path: string = req?.path || '';
        const query: string = req?.query?.sysparm_query || '';

        // cmdb_ci table
        if (path.includes('/cmdb_ci')) {
            // Batch lookup: sys_idINid1,id2,...
            if (query.startsWith('sys_idIN')) {
                const ids = query.replace('sys_idIN', '').split(',');
                const results = ids.map((id: string) => ciMap[id]).filter(Boolean);
                return createMockResponse({ result: results });
            }
            // Single lookup: sys_id=xxx
            if (query.startsWith('sys_id=')) {
                const id = query.replace('sys_id=', '');
                const ci = ciMap[id];
                return createMockResponse({ result: ci ? [ci] : [] });
            }
        }

        // cmdb_rel_ci table
        if (path.includes('/cmdb_rel_ci')) {
            // parent=xxx or child=xxx
            for (const [key, rels] of Object.entries(relMap)) {
                if (query.startsWith(key) || query === key) {
                    return createMockResponse({ result: rels });
                }
            }
            return createMockResponse({ result: [] });
        }

        return createMockResponse({ result: [] });
    };
}

describe('CMDBRelationships - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let cmdb: CMDBRelationships;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;

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
        cmdb = new CMDBRelationships(instance);
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(cmdb).toBeInstanceOf(CMDBRelationships);
        });
    });

    describe('getRelationships', () => {
        it('should throw on empty ciSysId', async () => {
            await expect(cmdb.getRelationships({ ciSysId: '' })).rejects.toThrow('CI sys_id is required');
        });

        it('should throw on whitespace ciSysId', async () => {
            await expect(cmdb.getRelationships({ ciSysId: '   ' })).rejects.toThrow('CI sys_id is required');
        });

        it('should throw if CI not found', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await expect(cmdb.getRelationships({ ciSysId: 'nonexistent' }))
                .rejects.toThrow("CI with sys_id 'nonexistent' not found");
        });

        it('should return downstream relationships', async () => {
            const router = createMockRouter(
                {
                    'root': mockCI('root', 'RootServer'),
                    'child1': mockCI('child1', 'ChildApp', 'cmdb_ci_app')
                },
                {
                    'parent=root': [mockRelString('rel1', 'root', 'child1', 'Depends on')]
                }
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.getRelationships({ ciSysId: 'root', direction: 'downstream' });

            expect(result.ci.sys_id).toBe('root');
            expect(result.relationships).toHaveLength(1);
            expect(result.relationships[0].relatedCI.sys_id).toBe('child1');
            expect(result.relationships[0].direction).toBe('downstream');
            expect(result.relationships[0].typeName).toBe('Depends on');
        });

        it('should return upstream relationships', async () => {
            const router = createMockRouter(
                {
                    'child1': mockCI('child1', 'ChildApp'),
                    'parent1': mockCI('parent1', 'ParentServer')
                },
                {
                    'child=child1': [mockRelString('rel1', 'parent1', 'child1', 'Hosts')]
                }
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.getRelationships({ ciSysId: 'child1', direction: 'upstream' });

            expect(result.ci.sys_id).toBe('child1');
            expect(result.relationships).toHaveLength(1);
            expect(result.relationships[0].relatedCI.sys_id).toBe('parent1');
            expect(result.relationships[0].direction).toBe('upstream');
        });

        it('should return both directions by default', async () => {
            const router = createMockRouter(
                {
                    'mid': mockCI('mid', 'MidServer'),
                    'child1': mockCI('child1', 'Child'),
                    'parent1': mockCI('parent1', 'Parent')
                },
                {
                    'parent=mid': [mockRelString('rel1', 'mid', 'child1')],
                    'child=mid': [mockRelString('rel2', 'parent1', 'mid')]
                }
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.getRelationships({ ciSysId: 'mid' });

            expect(result.relationships).toHaveLength(2);
            const directions = result.relationships.map(r => r.direction);
            expect(directions).toContain('downstream');
            expect(directions).toContain('upstream');
        });

        it('should handle object-format relationship fields', async () => {
            const router = createMockRouter(
                {
                    'root': mockCI('root', 'Root'),
                    'child1': mockCI('child1', 'Child')
                },
                {
                    'parent=root': [mockRelObject('rel1', 'root', 'child1', 'dep_type', 'Depends on')]
                }
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.getRelationships({ ciSysId: 'root', direction: 'downstream' });

            expect(result.relationships).toHaveLength(1);
            expect(result.relationships[0].typeName).toBe('Depends on');
            expect(result.relationships[0].relatedCI.sys_id).toBe('child1');
        });

        it('should filter by relationType when provided', async () => {
            mockRequestHandler.get.mockImplementation(async (req: any) => {
                const path: string = req?.path || '';
                const query: string = req?.query?.sysparm_query || '';

                if (path.includes('/cmdb_ci')) {
                    return createMockResponse({ result: [mockCI('root', 'Root')] });
                }
                if (path.includes('/cmdb_rel_ci')) {
                    // Return empty but verify query includes type filter
                    return createMockResponse({ result: [] });
                }
                return createMockResponse({ result: [] });
            });

            await cmdb.getRelationships({ ciSysId: 'root', direction: 'downstream', relationType: 'Depends on' });

            // Verify the relationship query included the type filter
            const relCalls = mockRequestHandler.get.mock.calls.filter((call: any) => {
                const path = call[0]?.path || '';
                return path.includes('/cmdb_rel_ci');
            });
            expect(relCalls.length).toBeGreaterThan(0);
            const queryStr = (relCalls[0] as any)[0]?.query?.sysparm_query || '';
            expect(queryStr).toContain('type.name=Depends on');
        });

        it('should return empty relationships when none exist', async () => {
            const router = createMockRouter(
                { 'lonely': mockCI('lonely', 'LonelyServer') },
                {}
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.getRelationships({ ciSysId: 'lonely' });

            expect(result.ci.sys_id).toBe('lonely');
            expect(result.relationships).toHaveLength(0);
        });
    });

    describe('traverseGraph', () => {
        it('should throw on empty ciSysId', async () => {
            await expect(cmdb.traverseGraph({ ciSysId: '' })).rejects.toThrow('CI sys_id is required');
        });

        it('should throw if root CI not found', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await expect(cmdb.traverseGraph({ ciSysId: 'nonexistent' }))
                .rejects.toThrow("CI with sys_id 'nonexistent' not found");
        });

        it('should traverse downstream graph with BFS', async () => {
            // Graph: root -> child1, root -> child2
            const router = createMockRouter(
                {
                    'root': mockCI('root', 'Root'),
                    'child1': mockCI('child1', 'Child1'),
                    'child2': mockCI('child2', 'Child2')
                },
                {
                    'parent=root': [
                        mockRelString('rel1', 'root', 'child1'),
                        mockRelString('rel2', 'root', 'child2')
                    ]
                }
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.traverseGraph({ ciSysId: 'root', direction: 'downstream', maxDepth: 2 });

            expect(result.rootCI.sys_id).toBe('root');
            expect(result.nodes.length).toBe(3); // root + 2 children
            expect(result.edges.length).toBe(2);
            expect(result.nodes[0].depth).toBe(0);
            expect(result.nodes[1].depth).toBe(1);
            expect(result.nodes[2].depth).toBe(1);
            expect(result.truncated).toBe(false);
        });

        it('should respect maxDepth', async () => {
            // Graph: root -> child1 -> grandchild1
            const router = createMockRouter(
                {
                    'root': mockCI('root', 'Root'),
                    'child1': mockCI('child1', 'Child1'),
                    'grandchild1': mockCI('grandchild1', 'Grandchild1')
                },
                {
                    'parent=root': [mockRelString('r1', 'root', 'child1')],
                    'parent=child1': [mockRelString('r2', 'child1', 'grandchild1')]
                }
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.traverseGraph({ ciSysId: 'root', direction: 'downstream', maxDepth: 1 });

            // Should only have root (depth 0) + child1 (depth 1)
            // grandchild1 would be at depth 2 which exceeds maxDepth=1
            // child1 is at depth 1 which equals maxDepth, so it's added but not expanded
            expect(result.nodes.length).toBe(2);
            expect(result.truncated).toBe(true);
            expect(result.truncationReason).toContain('depth');
        });

        it('should respect maxNodes', async () => {
            // Root has many children
            const cis: Record<string, any> = { 'root': mockCI('root', 'Root') };
            const rels = [];
            for (let i = 0; i < 10; i++) {
                cis[`child${i}`] = mockCI(`child${i}`, `Child${i}`);
                rels.push(mockRelString(`r${i}`, 'root', `child${i}`));
            }

            const router = createMockRouter(cis, { 'parent=root': rels });
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.traverseGraph({ ciSysId: 'root', direction: 'downstream', maxNodes: 3 });

            expect(result.nodes.length).toBeLessThanOrEqual(3);
            expect(result.truncated).toBe(true);
            expect(result.truncationReason).toContain('node limit');
        });

        it('should handle cycles via visited set', async () => {
            // Cycle: root -> child1, child1 -> root (back-edge)
            const router = createMockRouter(
                {
                    'root': mockCI('root', 'Root'),
                    'child1': mockCI('child1', 'Child1')
                },
                {
                    'parent=root': [mockRelString('r1', 'root', 'child1')],
                    'parent=child1': [mockRelString('r2', 'child1', 'root')]
                }
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.traverseGraph({ ciSysId: 'root', direction: 'downstream', maxDepth: 5 });

            // Root should appear only once in nodes
            const rootNodes = result.nodes.filter(n => n.sysId === 'root');
            expect(rootNodes).toHaveLength(1);
            expect(result.nodes).toHaveLength(2); // root + child1 only
        });

        it('should clamp maxDepth to 5', async () => {
            const router = createMockRouter(
                { 'root': mockCI('root', 'Root') },
                {}
            );
            mockRequestHandler.get.mockImplementation(router);

            // Request maxDepth=100 but should be clamped to 5
            const result = await cmdb.traverseGraph({ ciSysId: 'root', maxDepth: 100 });

            expect(result.truncated).toBe(false);
            expect(result.nodes).toHaveLength(1);
        });

        it('should track apiCallCount', async () => {
            const router = createMockRouter(
                {
                    'root': mockCI('root', 'Root'),
                    'child1': mockCI('child1', 'Child')
                },
                {
                    'parent=root': [mockRelString('r1', 'root', 'child1')]
                }
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.traverseGraph({ ciSysId: 'root', direction: 'downstream', maxDepth: 2 });

            expect(result.apiCallCount).toBeGreaterThan(0);
        });

        it('should use both directions when specified', async () => {
            const router = createMockRouter(
                { 'root': mockCI('root', 'Root') },
                {}
            );
            mockRequestHandler.get.mockImplementation(router);

            await cmdb.traverseGraph({ ciSysId: 'root', direction: 'both', maxDepth: 1 });

            // Should have queries for both parent= and child= on the root
            const queries = mockRequestHandler.get.mock.calls
                .map((call: any) => call[0]?.query?.sysparm_query || '')
                .filter((q: string) => q.startsWith('parent=') || q.startsWith('child='));

            const hasParentQuery = queries.some((q: string) => q.startsWith('parent=root'));
            const hasChildQuery = queries.some((q: string) => q.startsWith('child=root'));

            expect(hasParentQuery).toBe(true);
            expect(hasChildQuery).toBe(true);
        });
    });

    describe('Display value extraction', () => {
        it('should extract display_value from object fields', async () => {
            const router = createMockRouter(
                {
                    'root': mockCI('root', 'Root'),
                    'child1': mockCI('child1', 'Child')
                },
                {
                    'parent=root': [{
                        sys_id: 'rel1',
                        parent: { value: 'root' },
                        child: { value: 'child1' },
                        type: { value: 'type_id', display_value: 'Runs on' }
                    }]
                }
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.getRelationships({ ciSysId: 'root', direction: 'downstream' });

            expect(result.relationships[0].typeName).toBe('Runs on');
        });

        it('should fall back to value when display_value missing', async () => {
            const router = createMockRouter(
                {
                    'root': mockCI('root', 'Root'),
                    'child1': mockCI('child1', 'Child')
                },
                {
                    'parent=root': [{
                        sys_id: 'rel1',
                        parent: { value: 'root' },
                        child: { value: 'child1' },
                        type: { value: 'some_type_id' }
                    }]
                }
            );
            mockRequestHandler.get.mockImplementation(router);

            const result = await cmdb.getRelationships({ ciSysId: 'root', direction: 'downstream' });

            expect(result.relationships[0].typeName).toBe('some_type_id');
        });
    });
});
