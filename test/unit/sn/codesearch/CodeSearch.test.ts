/**
 * Unit tests for CodeSearch
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { CodeSearch } from '../../../../src/sn/codesearch/CodeSearch';
import { CodeSearchRecordTypeResult } from '../../../../src/sn/codesearch/CodeSearchModels';
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
 * Creates a mock raw search response matching actual ServiceNow API shape.
 * result is an array of record type groups.
 */
function createMockSearchResponse(groups: CodeSearchRecordTypeResult[] = []) {
    return {
        data: { result: groups },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: groups }
    } as IHttpResponse<any>;
}

/**
 * Creates a mock tables response — result is a flat array of tables.
 */
function createMockTablesResponse(tables: object[] = []) {
    return {
        data: { result: tables },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: tables }
    } as IHttpResponse<any>;
}

/**
 * Creates a mock search groups response (Table API)
 */
function createMockGroupsResponse(groups: object[] = []) {
    return {
        data: { result: groups },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: groups }
    } as IHttpResponse<any>;
}

/**
 * Creates a non-200 error response
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

/**
 * Creates a mock Table API POST response (single record).
 */
function createMockTableRecordResponse(record: object, status: number = 201) {
    return {
        data: { result: record },
        status,
        statusText: status === 201 ? 'Created' : 'OK',
        headers: {},
        config: {},
        bodyObject: { result: record }
    } as IHttpResponse<any>;
}

/**
 * Helper to create a realistic raw search result group
 */
function createMockRecordTypeResult(overrides: Partial<CodeSearchRecordTypeResult> = {}): CodeSearchRecordTypeResult {
    return {
        recordType: 'sys_script_include',
        tableLabel: 'Script Includes',
        hits: [
            {
                name: 'TestScript',
                className: 'sys_script_include',
                tableLabel: 'Script Includes',
                matches: [
                    {
                        field: 'script',
                        fieldLabel: 'Script',
                        lineMatches: [
                            { line: 10, context: 'var gr = new GlideRecord("incident");', escaped: 'var gr = new GlideRecord("incident");' },
                            { line: 25, context: 'var gr2 = new GlideRecord("task");', escaped: 'var gr2 = new GlideRecord("task");' }
                        ]
                    }
                ]
            }
        ],
        ...overrides
    };
}

describe('CodeSearch - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let codeSearch: CodeSearch;
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
            codeSearch = new CodeSearch(instance);
        }
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(codeSearch).toBeInstanceOf(CodeSearch);
            expect((codeSearch as any)._instance).toBe(instance);
        });

        it('should initialize logger', () => {
            expect((codeSearch as any)._logger).toBeDefined();
        });

        it('should initialize ServiceNowRequest', () => {
            expect((codeSearch as any)._req).toBeDefined();
        });

        it('should initialize TableAPIRequest', () => {
            expect((codeSearch as any)._tableAPI).toBeDefined();
        });
    });

    describe('Constants', () => {
        it('should have SEARCH_API_PATH', () => {
            expect((CodeSearch as any).SEARCH_API_PATH).toBe('/api/sn_codesearch/code_search/search');
        });

        it('should have TABLES_API_PATH', () => {
            expect((CodeSearch as any).TABLES_API_PATH).toBe('/api/sn_codesearch/code_search/tables');
        });

        it('should have SEARCH_GROUP_TABLE', () => {
            expect((CodeSearch as any).SEARCH_GROUP_TABLE).toBe('sn_codesearch_search_group');
        });

        it('should have SEARCH_TABLE_TABLE', () => {
            expect((CodeSearch as any).SEARCH_TABLE_TABLE).toBe('sn_codesearch_table');
        });
    });

    describe('Method existence', () => {
        it('should have search method', () => {
            expect(typeof codeSearch.search).toBe('function');
        });

        it('should have searchRaw method', () => {
            expect(typeof codeSearch.searchRaw).toBe('function');
        });

        it('should have searchInApp method', () => {
            expect(typeof codeSearch.searchInApp).toBe('function');
        });

        it('should have searchInTable method', () => {
            expect(typeof codeSearch.searchInTable).toBe('function');
        });

        it('should have getTablesForSearchGroup method', () => {
            expect(typeof codeSearch.getTablesForSearchGroup).toBe('function');
        });

        it('should have getSearchGroups method', () => {
            expect(typeof codeSearch.getSearchGroups).toBe('function');
        });

        it('should have static flattenResults method', () => {
            expect(typeof CodeSearch.flattenResults).toBe('function');
        });

        it('should have static formatResultsAsText method', () => {
            expect(typeof CodeSearch.formatResultsAsText).toBe('function');
        });

        it('should have addTableToSearchGroup method', () => {
            expect(typeof codeSearch.addTableToSearchGroup).toBe('function');
        });

        it('should have getTableRecordsForSearchGroup method', () => {
            expect(typeof codeSearch.getTableRecordsForSearchGroup).toBe('function');
        });
    });

    describe('searchRaw() - validation', () => {
        it('should throw when term is empty string', async () => {
            await expect(codeSearch.searchRaw({ term: '' })).rejects.toThrow('Search term is required');
        });

        it('should throw when term is whitespace only', async () => {
            await expect(codeSearch.searchRaw({ term: '   ' })).rejects.toThrow('Search term is required');
        });

        it('should throw when table is provided without search_group', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            await expect(codeSearch.searchRaw({ term: 'test', table: 'sys_script_include' }))
                .rejects.toThrow('search_group is required when searching a specific table');
        });

        it('should NOT throw when table is provided with search_group', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await expect(codeSearch.searchRaw({
                term: 'test',
                table: 'sys_script_include',
                search_group: 'myGroup'
            })).resolves.not.toThrow();
        });
    });

    describe('searchRaw() - API calls', () => {
        it('should return raw record type groups on success', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mockGroup = createMockRecordTypeResult();
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([mockGroup]));

            const results = await codeSearch.searchRaw({ term: 'GlideRecord' });

            expect(results).toHaveLength(1);
            expect(results[0].recordType).toBe('sys_script_include');
            expect(results[0].hits).toHaveLength(1);
            expect(results[0].hits[0].matches[0].lineMatches).toHaveLength(2);
        });

        it('should throw on non-200 response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(500));

            await expect(codeSearch.searchRaw({ term: 'test' }))
                .rejects.toThrow('Code search failed. Status: 500');
        });

        it('should construct correct URL path', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await codeSearch.searchRaw({ term: 'test' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/sn_codesearch/code_search/search');
        });

        it('should include term in query parameters', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await codeSearch.searchRaw({ term: 'GlideRecord' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.term).toBe('GlideRecord');
        });

        it('should include search_group when provided', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await codeSearch.searchRaw({ term: 'test', search_group: 'myGroup' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.search_group).toBe('myGroup');
        });

        it('should include table when provided', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await codeSearch.searchRaw({ term: 'test', table: 'sys_script_include', search_group: 'myGroup' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.table).toBe('sys_script_include');
        });

        it('should include current_app and search_all_scopes when provided', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await codeSearch.searchRaw({
                term: 'test',
                current_app: 'x_myapp',
                search_all_scopes: false
            });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.current_app).toBe('x_myapp');
            expect(callArgs.query.search_all_scopes).toBe('false');
        });

        it('should include limit when provided', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await codeSearch.searchRaw({ term: 'test', limit: 50 });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.limit).toBe('50');
        });

        it('should include extended_matching when provided', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await codeSearch.searchRaw({ term: 'test', extended_matching: true });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.extended_matching).toBe('true');
        });

        it('should not include undefined optional parameters', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await codeSearch.searchRaw({ term: 'test' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query).toEqual({ term: 'test' });
        });
    });

    describe('search() - flattened results', () => {
        it('should return flattened results from raw response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mockGroup = createMockRecordTypeResult();
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([mockGroup]));

            const results = await codeSearch.search({ term: 'GlideRecord' });

            expect(results).toHaveLength(1);
            expect(results[0].table).toBe('sys_script_include');
            expect(results[0].name).toBe('TestScript');
            expect(results[0].field).toBe('script');
            expect(results[0].fieldLabel).toBe('Script');
            expect(results[0].matchCount).toBe(2);
            expect(results[0].firstMatchLine).toBe(10);
            expect(results[0].firstMatchContext).toContain('GlideRecord');
        });

        it('should flatten multiple groups and hits', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const group1 = createMockRecordTypeResult();
            const group2 = createMockRecordTypeResult({
                recordType: 'sys_script',
                tableLabel: 'Business Rules',
                hits: [
                    {
                        name: 'MyBR',
                        className: 'sys_script',
                        tableLabel: 'Business Rules',
                        matches: [
                            { field: 'script', fieldLabel: 'Script', lineMatches: [{ line: 5, context: 'test' }] }
                        ]
                    }
                ]
            });
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([group1, group2]));

            const results = await codeSearch.search({ term: 'test' });

            expect(results).toHaveLength(2);
            expect(results[0].table).toBe('sys_script_include');
            expect(results[1].table).toBe('sys_script');
        });

        it('should skip groups with no hits', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const emptyGroup: CodeSearchRecordTypeResult = {
                recordType: 'sys_empty',
                tableLabel: 'Empty Table',
                hits: []
            };
            const fullGroup = createMockRecordTypeResult();
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([emptyGroup, fullGroup]));

            const results = await codeSearch.search({ term: 'test' });

            expect(results).toHaveLength(1);
            expect(results[0].table).toBe('sys_script_include');
        });
    });

    describe('searchInApp()', () => {
        it('should delegate to search with correct current_app and search_all_scopes', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([createMockRecordTypeResult()]));

            const results = await codeSearch.searchInApp('GlideRecord', 'x_myapp');

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.term).toBe('GlideRecord');
            expect(callArgs.query.current_app).toBe('x_myapp');
            expect(callArgs.query.search_all_scopes).toBe('false');
            expect(results).toHaveLength(1);
        });

        it('should pass through additional options', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await codeSearch.searchInApp('test', 'x_myapp', { search_group: 'myGroup', limit: 25 });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.search_group).toBe('myGroup');
            expect(callArgs.query.limit).toBe('25');
        });
    });

    describe('searchInTable()', () => {
        it('should delegate to search with correct table and search_group', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([createMockRecordTypeResult()]));

            const results = await codeSearch.searchInTable('GlideRecord', 'sys_script_include', 'myGroup');

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.term).toBe('GlideRecord');
            expect(callArgs.query.table).toBe('sys_script_include');
            expect(callArgs.query.search_group).toBe('myGroup');
            expect(results).toHaveLength(1);
        });

        it('should pass through additional options', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockSearchResponse([]));

            await codeSearch.searchInTable('test', 'sys_script', 'myGroup', { limit: 10 });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.limit).toBe('10');
        });
    });

    describe('getTablesForSearchGroup()', () => {
        it('should throw when searchGroup is empty', async () => {
            await expect(codeSearch.getTablesForSearchGroup('')).rejects.toThrow('Search group name is required');
        });

        it('should throw when searchGroup is whitespace only', async () => {
            await expect(codeSearch.getTablesForSearchGroup('   ')).rejects.toThrow('Search group name is required');
        });

        it('should return tables on successful 200 response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mockTables = [
                { name: 'sys_script_include', label: 'Script Include' },
                { name: 'sys_script', label: 'Business Rule' }
            ];
            mockRequestHandler.get.mockResolvedValue(createMockTablesResponse(mockTables));

            const tables = await codeSearch.getTablesForSearchGroup('myGroup');

            expect(tables).toHaveLength(2);
            expect(tables[0].name).toBe('sys_script_include');
            expect(tables[1].name).toBe('sys_script');
        });

        it('should throw on non-200 response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(404));

            await expect(codeSearch.getTablesForSearchGroup('nonexistent'))
                .rejects.toThrow("Failed to list tables for search group 'nonexistent'. Status: 404");
        });

        it('should construct correct URL with search_group param', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockTablesResponse([]));

            await codeSearch.getTablesForSearchGroup('myGroup');

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/sn_codesearch/code_search/tables');
            expect(callArgs.query.search_group).toBe('myGroup');
        });
    });

    describe('getSearchGroups()', () => {
        it('should return groups on successful 200 response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mockGroups = [
                { sys_id: 'abc', name: 'Default Search Group' },
                { sys_id: 'def', name: 'Custom Group' }
            ];
            mockRequestHandler.get.mockResolvedValue(createMockGroupsResponse(mockGroups));

            const groups = await codeSearch.getSearchGroups();

            expect(groups).toHaveLength(2);
            expect(groups[0].name).toBe('Default Search Group');
            expect(groups[1].sys_id).toBe('def');
        });

        it('should throw on non-200 response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(500));

            await expect(codeSearch.getSearchGroups())
                .rejects.toThrow('Failed to query code search groups. Status: 500');
        });

        it('should apply default limit of 100', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockGroupsResponse([]));

            await codeSearch.getSearchGroups();

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_limit).toBe(100);
        });

        it('should apply custom limit when provided', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockGroupsResponse([]));

            await codeSearch.getSearchGroups({ limit: 25 });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_limit).toBe(25);
        });

        it('should include encodedQuery when provided', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockGroupsResponse([]));

            await codeSearch.getSearchGroups({ encodedQuery: 'active=true' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toBe('active=true');
        });

        it('should work with no options', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockGroupsResponse([]));

            const groups = await codeSearch.getSearchGroups();

            expect(groups).toEqual([]);
        });
    });

    describe('flattenResults()', () => {
        it('should flatten a single group with a single hit', () => {
            const rawResults = [createMockRecordTypeResult()];
            const flattened = CodeSearch.flattenResults(rawResults);

            expect(flattened).toHaveLength(1);
            expect(flattened[0].table).toBe('sys_script_include');
            expect(flattened[0].name).toBe('TestScript');
            expect(flattened[0].field).toBe('script');
            expect(flattened[0].matchCount).toBe(2);
        });

        it('should flatten multiple groups', () => {
            const rawResults = [
                createMockRecordTypeResult(),
                createMockRecordTypeResult({
                    recordType: 'sys_script',
                    hits: [{
                        name: 'BR1', className: 'sys_script', tableLabel: 'Business Rules',
                        matches: [{ field: 'script', fieldLabel: 'Script', lineMatches: [{ line: 1, context: 'x' }] }]
                    }]
                })
            ];

            const flattened = CodeSearch.flattenResults(rawResults);
            expect(flattened).toHaveLength(2);
        });

        it('should skip groups with empty hits', () => {
            const rawResults: CodeSearchRecordTypeResult[] = [
                { recordType: 'empty', tableLabel: 'Empty', hits: [] },
                createMockRecordTypeResult()
            ];

            const flattened = CodeSearch.flattenResults(rawResults);
            expect(flattened).toHaveLength(1);
        });

        it('should skip hits with empty matches', () => {
            const rawResults: CodeSearchRecordTypeResult[] = [{
                recordType: 'sys_script_include',
                tableLabel: 'Script Includes',
                hits: [
                    { name: 'NoMatches', className: 'sys_script_include', tableLabel: 'Script Includes', matches: [] },
                    {
                        name: 'HasMatch', className: 'sys_script_include', tableLabel: 'Script Includes',
                        matches: [{ field: 'script', fieldLabel: 'Script', lineMatches: [{ line: 1, context: 'x' }] }]
                    }
                ]
            }];

            const flattened = CodeSearch.flattenResults(rawResults);
            expect(flattened).toHaveLength(1);
            expect(flattened[0].name).toBe('HasMatch');
        });

        it('should handle empty input', () => {
            expect(CodeSearch.flattenResults([])).toEqual([]);
        });

        it('should set firstMatchContext and firstMatchLine from first line match', () => {
            const rawResults = [createMockRecordTypeResult()];
            const flattened = CodeSearch.flattenResults(rawResults);

            expect(flattened[0].firstMatchLine).toBe(10);
            expect(flattened[0].firstMatchContext).toContain('GlideRecord');
        });

        it('should handle matches with empty lineMatches', () => {
            const rawResults: CodeSearchRecordTypeResult[] = [{
                recordType: 'sys_script',
                tableLabel: 'BR',
                hits: [{
                    name: 'Test', className: 'sys_script', tableLabel: 'BR',
                    matches: [{ field: 'script', fieldLabel: 'Script', lineMatches: [] }]
                }]
            }];

            const flattened = CodeSearch.flattenResults(rawResults);
            expect(flattened).toHaveLength(1);
            expect(flattened[0].matchCount).toBe(0);
            expect(flattened[0].firstMatchContext).toBe('');
            expect(flattened[0].firstMatchLine).toBe(0);
        });
    });

    describe('formatResultsAsText()', () => {
        it('should return "No results found." for empty array', () => {
            expect(CodeSearch.formatResultsAsText([])).toBe('No results found.');
        });

        it('should format results with match details', () => {
            const results = CodeSearch.flattenResults([createMockRecordTypeResult()]);
            const text = CodeSearch.formatResultsAsText(results);

            expect(text).toContain('Found 1 matches');
            expect(text).toContain('Script Includes');
            expect(text).toContain('TestScript');
            expect(text).toContain('GlideRecord');
            expect(text).toContain('L10:');
        });

        it('should truncate to 3 line matches and show overflow count', () => {
            const manyMatches: CodeSearchRecordTypeResult[] = [{
                recordType: 'sys_script',
                tableLabel: 'BR',
                hits: [{
                    name: 'Big', className: 'sys_script', tableLabel: 'BR',
                    matches: [{
                        field: 'script', fieldLabel: 'Script',
                        lineMatches: [
                            { line: 1, context: 'line1' },
                            { line: 2, context: 'line2' },
                            { line: 3, context: 'line3' },
                            { line: 4, context: 'line4' },
                            { line: 5, context: 'line5' }
                        ]
                    }]
                }]
            }];

            const results = CodeSearch.flattenResults(manyMatches);
            const text = CodeSearch.formatResultsAsText(results);

            expect(text).toContain('line1');
            expect(text).toContain('line2');
            expect(text).toContain('line3');
            expect(text).not.toContain('line4');
            expect(text).toContain('2 more matches');
        });
    });

    describe('addTableToSearchGroup() - validation', () => {
        it('should throw when table is empty string', async () => {
            await expect(codeSearch.addTableToSearchGroup({
                table: '', search_fields: 'script', search_group: 'abc123'
            })).rejects.toThrow('Table name is required');
        });

        it('should throw when table is whitespace only', async () => {
            await expect(codeSearch.addTableToSearchGroup({
                table: '   ', search_fields: 'script', search_group: 'abc123'
            })).rejects.toThrow('Table name is required');
        });

        it('should throw when search_fields is empty', async () => {
            await expect(codeSearch.addTableToSearchGroup({
                table: 'sys_script', search_fields: '', search_group: 'abc123'
            })).rejects.toThrow('Search fields are required');
        });

        it('should throw when search_fields is whitespace only', async () => {
            await expect(codeSearch.addTableToSearchGroup({
                table: 'sys_script', search_fields: '   ', search_group: 'abc123'
            })).rejects.toThrow('Search fields are required');
        });

        it('should throw when search_group is empty', async () => {
            await expect(codeSearch.addTableToSearchGroup({
                table: 'sys_script', search_fields: 'script', search_group: ''
            })).rejects.toThrow('Search group sys_id is required');
        });

        it('should throw when search_group is whitespace only', async () => {
            await expect(codeSearch.addTableToSearchGroup({
                table: 'sys_script', search_fields: 'script', search_group: '   '
            })).rejects.toThrow('Search group sys_id is required');
        });
    });

    describe('addTableToSearchGroup() - API calls', () => {
        it('should return the created record on 201 response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mockRecord = {
                sys_id: 'new123',
                table: 'sys_script',
                search_fields: 'script',
                search_group: 'group123'
            };
            mockRequestHandler.post.mockResolvedValue(createMockTableRecordResponse(mockRecord));

            const result = await codeSearch.addTableToSearchGroup({
                table: 'sys_script',
                search_fields: 'script',
                search_group: 'group123'
            });

            expect(result.sys_id).toBe('new123');
            expect(result.table).toBe('sys_script');
            expect(result.search_fields).toBe('script');
            expect(result.search_group).toBe('group123');
        });

        it('should return the created record on 200 response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mockRecord = {
                sys_id: 'new456',
                table: 'sys_script_include',
                search_fields: 'script,name',
                search_group: 'group789'
            };
            mockRequestHandler.post.mockResolvedValue(createMockTableRecordResponse(mockRecord, 200));

            const result = await codeSearch.addTableToSearchGroup({
                table: 'sys_script_include',
                search_fields: 'script,name',
                search_group: 'group789'
            });

            expect(result.sys_id).toBe('new456');
        });

        it('should throw on non-200/201 response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(createErrorResponse(403));

            await expect(codeSearch.addTableToSearchGroup({
                table: 'sys_script',
                search_fields: 'script',
                search_group: 'group123'
            })).rejects.toThrow("Failed to add table 'sys_script' to search group 'group123'. Status: 403");
        });

        it('should throw with status unknown when response is null', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(null);

            await expect(codeSearch.addTableToSearchGroup({
                table: 'sys_script',
                search_fields: 'script',
                search_group: 'group123'
            })).rejects.toThrow("Failed to add table 'sys_script' to search group 'group123'. Status: unknown");
        });

        it('should call TableAPI post with correct table name', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mockRecord = { sys_id: 'x', table: 'sys_script', search_fields: 'script', search_group: 'g1' };
            mockRequestHandler.post.mockResolvedValue(createMockTableRecordResponse(mockRecord));

            await codeSearch.addTableToSearchGroup({
                table: 'sys_script',
                search_fields: 'script',
                search_group: 'g1'
            });

            const callArgs = mockRequestHandler.post.mock.calls[0][0] as any;
            expect(callArgs.path).toContain('sn_codesearch_table');
        });

        it('should include correct body fields in POST request', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mockRecord = { sys_id: 'x', table: 'sys_ui_script', search_fields: 'script,name', search_group: 'grp1' };
            mockRequestHandler.post.mockResolvedValue(createMockTableRecordResponse(mockRecord));

            await codeSearch.addTableToSearchGroup({
                table: 'sys_ui_script',
                search_fields: 'script,name',
                search_group: 'grp1'
            });

            const callArgs = mockRequestHandler.post.mock.calls[0][0] as any;
            expect(callArgs.json.table).toBe('sys_ui_script');
            expect(callArgs.json.search_fields).toBe('script,name');
            expect(callArgs.json.search_group).toBe('grp1');
        });
    });

    describe('getTableRecordsForSearchGroup() - validation', () => {
        it('should throw when searchGroupSysId is empty', async () => {
            await expect(codeSearch.getTableRecordsForSearchGroup(''))
                .rejects.toThrow('Search group sys_id is required');
        });

        it('should throw when searchGroupSysId is whitespace only', async () => {
            await expect(codeSearch.getTableRecordsForSearchGroup('   '))
                .rejects.toThrow('Search group sys_id is required');
        });
    });

    describe('getTableRecordsForSearchGroup() - API calls', () => {
        it('should return table records on successful response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mockRecords = [
                { sys_id: 'rec1', table: 'sys_script', search_fields: 'script', search_group: 'grp1' },
                { sys_id: 'rec2', table: 'sys_script_include', search_fields: 'script,name', search_group: 'grp1' }
            ];
            mockRequestHandler.get.mockResolvedValue(createMockGroupsResponse(mockRecords));

            const records = await codeSearch.getTableRecordsForSearchGroup('grp1');

            expect(records).toHaveLength(2);
            expect(records[0].sys_id).toBe('rec1');
            expect(records[1].table).toBe('sys_script_include');
        });

        it('should throw on non-200 response', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(500));

            await expect(codeSearch.getTableRecordsForSearchGroup('grp1'))
                .rejects.toThrow("Failed to query table records for search group 'grp1'. Status: 500");
        });

        it('should throw with status unknown when response is null', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(null);

            await expect(codeSearch.getTableRecordsForSearchGroup('grp1'))
                .rejects.toThrow("Failed to query table records for search group 'grp1'. Status: unknown");
        });

        it('should include search_group filter in query', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockGroupsResponse([]));

            await codeSearch.getTableRecordsForSearchGroup('abc123');

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toBe('search_group=abc123');
        });

        it('should apply default limit of 100', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockGroupsResponse([]));

            await codeSearch.getTableRecordsForSearchGroup('abc123');

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_limit).toBe(100);
        });

        it('should apply custom limit when provided', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue(createMockGroupsResponse([]));

            await codeSearch.getTableRecordsForSearchGroup('abc123', { limit: 10 });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_limit).toBe(10);
        });
    });
});
