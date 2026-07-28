/**
 * Unit tests for SchemaDiscovery
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { SchemaDiscovery } from '../../../../src/sn/schema/SchemaDiscovery';
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
 * Creates a mock response wrapping an array result.
 */
function createMockArrayResponse(data: unknown[], status: number = 200) {
    return {
        data: { result: data },
        status,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: data }
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

describe('SchemaDiscovery - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let discovery: SchemaDiscovery;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;

    beforeEach(async () => {
        jest.clearAllMocks();
        SessionManager.resetInstance();

        mockAuthHandler = new MockAuthenticationHandler();
        mockRequestHandler = new MockRequestHandler();

        jest.spyOn(AuthenticationHandlerFactory, 'createAuthHandler').mockReturnValue(mockAuthHandler as any);
        jest.spyOn(RequestHandlerFactory, 'createRequestHandler').mockReturnValue(mockRequestHandler as any);

        const alias = 'test-instance';
        const credential = await mockGetCredentials(alias);
        if (credential) {
            const snSettings: ServiceNowSettingsInstance = { alias, credential };
            instance = new ServiceNowInstance(snSettings);
            discovery = new SchemaDiscovery(instance);
        }
    });

    // ================================================================
    // Constructor
    // ================================================================
    describe('constructor', () => {
        it('should create a SchemaDiscovery instance', () => {
            expect(discovery).toBeDefined();
            expect(discovery).toBeInstanceOf(SchemaDiscovery);
        });
    });

    // ================================================================
    // discoverTableSchema
    // ================================================================
    describe('discoverTableSchema', () => {
        it('should discover a table schema with basic fields', async () => {
            const tableRecord = { sys_id: 'tbl123', name: 'incident', label: 'Incident', super_class: 'task' };
            const dictRecords = [
                {
                    sys_id: 'dict1',
                    name: 'incident',
                    element: 'short_description',
                    column_label: 'Short description',
                    internal_type: 'string',
                    max_length: '160',
                    mandatory: 'true',
                    read_only: 'false',
                    reference: '',
                    default_value: ''
                },
                {
                    sys_id: 'dict2',
                    name: 'incident',
                    element: 'caller_id',
                    column_label: 'Caller',
                    internal_type: 'reference',
                    max_length: '32',
                    mandatory: 'false',
                    read_only: 'false',
                    reference: 'sys_user',
                    default_value: ''
                }
            ];

            // GET sys_db_object
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([tableRecord]));
            // GET sys_dictionary
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(dictRecords));

            const result = await discovery.discoverTableSchema('incident');

            expect(result.table).toBe('incident');
            expect(result.label).toBe('Incident');
            expect(result.superClass).toBe('task');
            expect(result.fields).toHaveLength(2);

            const shortDesc = result.fields.find(f => f.name === 'short_description');
            expect(shortDesc).toBeDefined();
            expect(shortDesc!.label).toBe('Short description');
            expect(shortDesc!.internalType).toBe('string');
            expect(shortDesc!.maxLength).toBe(160);
            expect(shortDesc!.mandatory).toBe(true);
            expect(shortDesc!.readOnly).toBe(false);

            const caller = result.fields.find(f => f.name === 'caller_id');
            expect(caller).toBeDefined();
            expect(caller!.internalType).toBe('reference');
            expect(caller!.referenceTable).toBe('sys_user');
        });

        it('should handle internal_type as object', async () => {
            const tableRecord = { sys_id: 'tbl123', name: 'incident', label: 'Incident' };
            const dictRecords = [
                {
                    sys_id: 'dict1',
                    name: 'incident',
                    element: 'state',
                    column_label: 'State',
                    internal_type: { link: 'http://...', value: 'integer' },
                    max_length: '40',
                    mandatory: 'false',
                    read_only: 'false'
                }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([tableRecord]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(dictRecords));

            const result = await discovery.discoverTableSchema('incident');

            const stateField = result.fields.find(f => f.name === 'state');
            expect(stateField).toBeDefined();
            expect(stateField!.internalType).toBe('integer');
        });

        it('should handle super_class as object', async () => {
            const tableRecord = {
                sys_id: 'tbl123',
                name: 'incident',
                label: 'Incident',
                super_class: { link: 'http://...', value: 'task_id', display_value: 'task' }
            };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([tableRecord]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const result = await discovery.discoverTableSchema('incident');

            expect(result.superClass).toBe('task');
        });

        it('should include choice tables when requested', async () => {
            const tableRecord = { sys_id: 'tbl123', name: 'incident', label: 'Incident' };
            const dictRecords = [
                {
                    sys_id: 'dict1',
                    name: 'incident',
                    element: 'state',
                    column_label: 'State',
                    internal_type: 'integer',
                    max_length: '40',
                    mandatory: 'false',
                    read_only: 'false'
                }
            ];
            const choiceRecords = [
                { sys_id: 'ch1', name: 'incident', element: 'state', label: 'New', value: '1' },
                { sys_id: 'ch2', name: 'incident', element: 'state', label: 'Active', value: '2' },
                { sys_id: 'ch3', name: 'incident', element: 'priority', label: 'High', value: '1' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([tableRecord]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(dictRecords));
            // GET sys_choice
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(choiceRecords));

            const result = await discovery.discoverTableSchema('incident', { includeChoiceTables: true });

            expect(result.choiceTables).toBeDefined();
            expect(result.choiceTables!.length).toBe(2);

            const stateChoices = result.choiceTables!.find(ct => ct.field === 'state');
            expect(stateChoices).toBeDefined();
            expect(stateChoices!.choices).toHaveLength(2);
            expect(stateChoices!.choices[0]).toEqual({ label: 'New', value: '1' });
        });

        it('should include relationships when requested', async () => {
            const tableRecord = { sys_id: 'tbl123', name: 'incident', label: 'Incident' };
            const dictRecords = [
                {
                    sys_id: 'dict1',
                    name: 'incident',
                    element: 'caller_id',
                    column_label: 'Caller',
                    internal_type: 'reference',
                    max_length: '32',
                    mandatory: 'false',
                    read_only: 'false',
                    reference: 'sys_user'
                },
                {
                    sys_id: 'dict2',
                    name: 'incident',
                    element: 'assignment_group',
                    column_label: 'Assignment group',
                    internal_type: 'reference',
                    max_length: '32',
                    mandatory: 'false',
                    read_only: 'false',
                    reference: 'sys_user_group'
                }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([tableRecord]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(dictRecords));

            const result = await discovery.discoverTableSchema('incident', { includeRelationships: true });

            expect(result.relationships).toBeDefined();
            expect(result.relationships!).toHaveLength(2);
            expect(result.relationships![0]).toEqual({ name: 'caller_id', type: 'reference', relatedTable: 'sys_user' });
            expect(result.relationships![1]).toEqual({ name: 'assignment_group', type: 'reference', relatedTable: 'sys_user_group' });
        });

        it('should include UI policies when requested', async () => {
            const tableRecord = { sys_id: 'tbl123', name: 'incident', label: 'Incident' };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([tableRecord]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));
            // UI policies
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([
                { sys_id: 'pol1', short_description: 'Hide field', active: 'true' }
            ]));

            const result = await discovery.discoverTableSchema('incident', { includeUIPolicies: true });

            expect(result.uiPolicies).toBeDefined();
            expect(result.uiPolicies!).toHaveLength(1);
            expect(result.uiPolicies![0]).toEqual({ sys_id: 'pol1', short_description: 'Hide field', active: true });
        });

        it('should include business rules when requested', async () => {
            const tableRecord = { sys_id: 'tbl123', name: 'incident', label: 'Incident' };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([tableRecord]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));
            // Business rules
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([
                { sys_id: 'rule1', name: 'Set Priority', when: 'before', active: 'true' }
            ]));

            const result = await discovery.discoverTableSchema('incident', { includeBusinessRules: true });

            expect(result.businessRules).toBeDefined();
            expect(result.businessRules!).toHaveLength(1);
            expect(result.businessRules![0]).toEqual({ sys_id: 'rule1', name: 'Set Priority', when: 'before', active: true });
        });

        it('should throw when tableName is empty', async () => {
            await expect(discovery.discoverTableSchema(''))
                .rejects.toThrow('Table name is required');
        });

        it('should throw when table is not found', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            await expect(discovery.discoverTableSchema('nonexistent_table'))
                .rejects.toThrow("Table 'nonexistent_table' not found in sys_db_object");
        });
    });

    // ================================================================
    // explainField
    // ================================================================
    describe('explainField', () => {
        it('should explain a field with choices', async () => {
            const dictRecord = {
                sys_id: 'dict1',
                name: 'incident',
                element: 'state',
                column_label: 'State',
                internal_type: 'integer',
                max_length: '40',
                mandatory: 'true',
                read_only: 'false',
                comments: 'Current state of the incident',
                help: 'Select the current state',
                reference: ''
            };
            const choiceRecords = [
                { sys_id: 'ch1', name: 'incident', element: 'state', label: 'New', value: '1' },
                { sys_id: 'ch2', name: 'incident', element: 'state', label: 'Active', value: '2' },
                { sys_id: 'ch3', name: 'incident', element: 'state', label: 'Resolved', value: '6' }
            ];

            // GET sys_dictionary
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([dictRecord]));
            // GET sys_choice
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(choiceRecords));

            const result = await discovery.explainField('incident', 'state');

            expect(result.field).toBe('state');
            expect(result.table).toBe('incident');
            expect(result.label).toBe('State');
            expect(result.type).toBe('integer');
            expect(result.maxLength).toBe(40);
            expect(result.mandatory).toBe(true);
            expect(result.readOnly).toBe(false);
            expect(result.comments).toBe('Current state of the incident');
            expect(result.help).toBe('Select the current state');
            expect(result.choices).toBeDefined();
            expect(result.choices!).toHaveLength(3);
            expect(result.choices![0]).toEqual({ label: 'New', value: '1' });
        });

        it('should explain a reference field without choices', async () => {
            const dictRecord = {
                sys_id: 'dict1',
                name: 'incident',
                element: 'caller_id',
                column_label: 'Caller',
                internal_type: 'reference',
                max_length: '32',
                mandatory: 'false',
                read_only: 'false',
                reference: 'sys_user'
            };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([dictRecord]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const result = await discovery.explainField('incident', 'caller_id');

            expect(result.field).toBe('caller_id');
            expect(result.referenceTable).toBe('sys_user');
            expect(result.choices).toBeUndefined();
        });

        it('should handle internal_type as object', async () => {
            const dictRecord = {
                sys_id: 'dict1',
                name: 'incident',
                element: 'state',
                column_label: 'State',
                internal_type: { link: 'http://...', value: 'integer' },
                max_length: '40',
                mandatory: 'false',
                read_only: 'false'
            };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([dictRecord]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const result = await discovery.explainField('incident', 'state');

            expect(result.type).toBe('integer');
        });

        it('should throw when tableName is empty', async () => {
            await expect(discovery.explainField('', 'state'))
                .rejects.toThrow('Table name is required');
        });

        it('should throw when fieldName is empty', async () => {
            await expect(discovery.explainField('incident', ''))
                .rejects.toThrow('Field name is required');
        });

        it('should throw when field is not found', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            await expect(discovery.explainField('incident', 'nonexistent_field'))
                .rejects.toThrow("Field 'nonexistent_field' not found on table 'incident'");
        });
    });

    // ================================================================
    // validateCatalogConfiguration
    // ================================================================
    describe('validateCatalogConfiguration', () => {
        it('should return valid result for a clean catalog item', async () => {
            const variables = [
                { sys_id: 'var1', name: 'requested_for', question_text: 'Requested for', type: 'reference', mandatory: 'false', active: 'true', cat_item: 'cat123' },
                { sys_id: 'var2', name: 'description', question_text: 'Description', type: 'text', mandatory: 'false', active: 'true', cat_item: 'cat123' }
            ];
            const policies = [
                { sys_id: 'pol1', short_description: 'Hide description', catalog_item: 'cat123', active: 'true' }
            ];

            // GET item_option_new
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(variables));
            // GET catalog_ui_policy
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(policies));

            const result = await discovery.validateCatalogConfiguration('cat123');

            expect(result.valid).toBe(true);
            expect(result.errors).toBe(0);
            expect(result.warnings).toBe(0);
            expect(result.issues).toHaveLength(0);
        });

        it('should detect duplicate variable names', async () => {
            const variables = [
                { sys_id: 'var1', name: 'dup_name', question_text: 'First', type: 'string', mandatory: 'false', active: 'true', cat_item: 'cat123' },
                { sys_id: 'var2', name: 'dup_name', question_text: 'Second', type: 'string', mandatory: 'false', active: 'true', cat_item: 'cat123' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(variables));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const result = await discovery.validateCatalogConfiguration('cat123');

            expect(result.valid).toBe(false);
            expect(result.errors).toBe(1);
            const dupIssue = result.issues.find(i => i.issue.includes('Duplicate'));
            expect(dupIssue).toBeDefined();
            expect(dupIssue!.severity).toBe('error');
        });

        it('should detect variables with no name', async () => {
            const variables = [
                { sys_id: 'var1', name: '', question_text: 'Unnamed', type: 'string', mandatory: 'false', active: 'true', cat_item: 'cat123' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(variables));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const result = await discovery.validateCatalogConfiguration('cat123');

            expect(result.valid).toBe(false);
            expect(result.errors).toBe(1);
            const noNameIssue = result.issues.find(i => i.issue.includes('no name'));
            expect(noNameIssue).toBeDefined();
            expect(noNameIssue!.severity).toBe('error');
        });

        it('should detect variables with no question text', async () => {
            const variables = [
                { sys_id: 'var1', name: 'my_var', question_text: '', type: 'string', mandatory: 'false', active: 'true', cat_item: 'cat123' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(variables));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const result = await discovery.validateCatalogConfiguration('cat123');

            expect(result.valid).toBe(true); // warnings only
            expect(result.warnings).toBe(1);
            const noTextIssue = result.issues.find(i => i.issue.includes('no question text'));
            expect(noTextIssue).toBeDefined();
            expect(noTextIssue!.severity).toBe('warning');
        });

        it('should detect inactive mandatory variables', async () => {
            const variables = [
                { sys_id: 'var1', name: 'req_field', question_text: 'Required', type: 'string', mandatory: 'true', active: 'false', cat_item: 'cat123' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(variables));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const result = await discovery.validateCatalogConfiguration('cat123');

            expect(result.warnings).toBeGreaterThanOrEqual(1);
            const inactiveIssue = result.issues.find(i => i.issue.includes('inactive'));
            expect(inactiveIssue).toBeDefined();
            expect(inactiveIssue!.severity).toBe('warning');
        });

        it('should detect UI policies with no short description', async () => {
            const variables = [
                { sys_id: 'var1', name: 'my_var', question_text: 'My var', type: 'string', mandatory: 'false', active: 'true', cat_item: 'cat123' }
            ];
            const policies = [
                { sys_id: 'pol1', short_description: '', catalog_item: 'cat123', active: 'true' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(variables));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(policies));

            const result = await discovery.validateCatalogConfiguration('cat123');

            expect(result.warnings).toBe(1);
            const polIssue = result.issues.find(i => i.component === 'ui_policy');
            expect(polIssue).toBeDefined();
            expect(polIssue!.issue).toContain('no short description');
        });

        it('should detect multiple issues in a single validation', async () => {
            const variables = [
                { sys_id: 'var1', name: '', question_text: '', type: 'string', mandatory: 'false', active: 'true', cat_item: 'cat123' },
                { sys_id: 'var2', name: 'dup', question_text: 'Good', type: 'string', mandatory: 'false', active: 'true', cat_item: 'cat123' },
                { sys_id: 'var3', name: 'dup', question_text: 'Also good', type: 'string', mandatory: 'true', active: 'false', cat_item: 'cat123' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(variables));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const result = await discovery.validateCatalogConfiguration('cat123');

            // Errors: no name on var1, duplicate name on var3
            // Warnings: no question text on var1, inactive mandatory on var3
            expect(result.valid).toBe(false);
            expect(result.errors).toBeGreaterThanOrEqual(2);
            expect(result.warnings).toBeGreaterThanOrEqual(2);
        });

        it('should throw when catalogItemSysId is empty', async () => {
            await expect(discovery.validateCatalogConfiguration(''))
                .rejects.toThrow('Catalog item sys_id is required');
        });

        it('should handle empty variable and policy lists', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const result = await discovery.validateCatalogConfiguration('cat123');

            expect(result.valid).toBe(true);
            expect(result.errors).toBe(0);
            expect(result.warnings).toBe(0);
            expect(result.issues).toHaveLength(0);
        });
    });
});
