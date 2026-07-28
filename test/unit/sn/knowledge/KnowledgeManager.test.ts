/**
 * Unit tests for KnowledgeManager
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { KnowledgeManager } from '../../../../src/sn/knowledge/KnowledgeManager';
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

function createMockResponse(data: any, status: number = 200) {
    return {
        data: { result: data },
        status,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: data }
    } as IHttpResponse<any>;
}

function createMockListResponse(data: any[], status: number = 200) {
    return {
        data: { result: data },
        status,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: data }
    } as IHttpResponse<any>;
}

function createMockStatsResponse(count: number, status: number = 200) {
    return {
        data: { result: { stats: { count: String(count) } } },
        status,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: { stats: { count: String(count) } } }
    } as IHttpResponse<any>;
}

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

describe('KnowledgeManager - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let knowledgeMgr: KnowledgeManager;
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
            knowledgeMgr = new KnowledgeManager(instance);
        }
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(knowledgeMgr).toBeInstanceOf(KnowledgeManager);
            expect((knowledgeMgr as any)._instance).toBe(instance);
        });

        it('should initialize logger', () => {
            expect((knowledgeMgr as any)._logger).toBeDefined();
        });

        it('should initialize TableAPIRequest', () => {
            expect((knowledgeMgr as any)._tableAPI).toBeDefined();
        });

        it('should initialize AggregateQuery', () => {
            expect((knowledgeMgr as any)._aggregateQuery).toBeDefined();
        });
    });

    describe('listKnowledgeBases', () => {
        it('should return knowledge bases with default options', async () => {
            const mockKBs = [
                { sys_id: 'kb1', title: 'IT Knowledge Base', active: 'true' },
                { sys_id: 'kb2', title: 'HR Knowledge Base', active: 'true' }
            ];
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockKBs));

            const result = await knowledgeMgr.listKnowledgeBases();

            expect(result).toHaveLength(2);
            expect(result[0].sys_id).toBe('kb1');
            expect(mockRequestHandler.get).toHaveBeenCalledTimes(1);
        });

        it('should pass active filter in query', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listKnowledgeBases({ active: true });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('active=true');
        });

        it('should pass custom query', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listKnowledgeBases({ query: 'titleLIKEIT' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('titleLIKEIT');
        });

        it('should pass limit and offset', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listKnowledgeBases({ limit: 10, offset: 5 });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_limit).toBe(10);
            expect(callArgs.query.sysparm_offset).toBe(5);
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));

            await expect(knowledgeMgr.listKnowledgeBases())
                .rejects.toThrow('Failed to list knowledge bases');
        });
    });

    describe('getKnowledgeBase', () => {
        it('should return KB detail with article and category counts', async () => {
            const mockKB = { sys_id: 'kb1', title: 'IT KB', active: 'true' };
            // First call: table API for KB record
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockKB]));
            // Second & third calls: stats API for article and category counts
            mockRequestHandler.get.mockResolvedValueOnce(createMockStatsResponse(42));
            mockRequestHandler.get.mockResolvedValueOnce(createMockStatsResponse(5));

            const result = await knowledgeMgr.getKnowledgeBase('kb1');

            expect(result.knowledgeBase.sys_id).toBe('kb1');
            expect(result.articleCount).toBe(42);
            expect(result.categoryCount).toBe(5);
        });

        it('should throw error if sysId is empty', async () => {
            await expect(knowledgeMgr.getKnowledgeBase(''))
                .rejects.toThrow('Knowledge base sys_id is required');
        });

        it('should throw error when KB not found', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await expect(knowledgeMgr.getKnowledgeBase('nonexistent'))
                .rejects.toThrow("Knowledge base 'nonexistent' not found");
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));

            await expect(knowledgeMgr.getKnowledgeBase('kb1'))
                .rejects.toThrow("Knowledge base 'kb1' not found");
        });
    });

    describe('listCategories', () => {
        it('should return categories with default options', async () => {
            const mockCategories = [
                { sys_id: 'cat1', label: 'General', value: 'kb1', active: 'true' },
                { sys_id: 'cat2', label: 'FAQs', value: 'kb1', active: 'true' }
            ];
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockCategories));

            const result = await knowledgeMgr.listCategories();

            expect(result).toHaveLength(2);
            expect(result[0].label).toBe('General');
        });

        it('should filter by knowledge base using value= field', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listCategories({ knowledgeBaseSysId: 'kb1' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('value=kb1');
        });

        it('should filter by parent category using parent_id= field', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listCategories({ parentCategory: 'cat-parent' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('parent_id=cat-parent');
        });

        it('should filter by active status', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listCategories({ active: true });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('active=true');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));

            await expect(knowledgeMgr.listCategories())
                .rejects.toThrow('Failed to list categories');
        });
    });

    describe('createCategory', () => {
        it('should create a category with label and KB reference', async () => {
            const mockCategory = { sys_id: 'cat-new', label: 'New Category', value: 'kb1', active: 'true' };
            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(mockCategory, 201));

            const result = await knowledgeMgr.createCategory({
                label: 'New Category',
                knowledgeBaseSysId: 'kb1'
            });

            expect(result.sys_id).toBe('cat-new');
            expect(result.label).toBe('New Category');
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(1);
        });

        it('should include parent category when provided', async () => {
            const mockCategory = { sys_id: 'cat-new', label: 'Sub Category', value: 'kb1', parent_id: 'cat-parent' };
            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(mockCategory, 201));

            await knowledgeMgr.createCategory({
                label: 'Sub Category',
                knowledgeBaseSysId: 'kb1',
                parentCategory: 'cat-parent'
            });

            const callArgs = mockRequestHandler.post.mock.calls[0][0] as any;
            expect(callArgs.json.parent_id).toBe('cat-parent');
        });

        it('should throw error if label is empty', async () => {
            await expect(knowledgeMgr.createCategory({
                label: '',
                knowledgeBaseSysId: 'kb1'
            })).rejects.toThrow('Category label is required');
        });

        it('should throw error if knowledgeBaseSysId is empty', async () => {
            await expect(knowledgeMgr.createCategory({
                label: 'Test',
                knowledgeBaseSysId: ''
            })).rejects.toThrow('Knowledge base sys_id is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(knowledgeMgr.createCategory({
                label: 'Test',
                knowledgeBaseSysId: 'kb1'
            })).rejects.toThrow("Failed to create category 'Test'");
        });
    });

    describe('listArticles', () => {
        it('should return article summaries', async () => {
            const mockArticles = [
                { sys_id: 'art1', number: 'KB0010001', short_description: 'How to reset password', workflow_state: 'published' },
                { sys_id: 'art2', number: 'KB0010002', short_description: 'VPN setup guide', workflow_state: 'draft' }
            ];
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockArticles));

            const result = await knowledgeMgr.listArticles();

            expect(result).toHaveLength(2);
            expect(result[0].short_description).toBe('How to reset password');
        });

        it('should include sysparm_fields to exclude body', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listArticles();

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_fields).toBeDefined();
            expect(callArgs.query.sysparm_fields).not.toContain('text');
            expect(callArgs.query.sysparm_fields).not.toContain('wiki');
        });

        it('should filter by knowledge base', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listArticles({ knowledgeBaseSysId: 'kb1' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('kb_knowledge_base=kb1');
        });

        it('should filter by category', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listArticles({ categorySysId: 'cat1' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('kb_category=cat1');
        });

        it('should filter by workflow state', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listArticles({ workflowState: 'published' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('workflow_state=published');
        });

        it('should apply text search with LIKE operator', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await knowledgeMgr.listArticles({ textSearch: 'password' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('short_descriptionLIKEpassword');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));

            await expect(knowledgeMgr.listArticles())
                .rejects.toThrow('Failed to list articles');
        });
    });

    describe('getArticle', () => {
        it('should return full article record', async () => {
            const mockArticle = {
                sys_id: 'art1',
                number: 'KB0010001',
                short_description: 'How to reset password',
                text: '<p>Step 1: Go to settings...</p>',
                kb_knowledge_base: 'kb1',
                workflow_state: 'published'
            };
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockArticle]));

            const result = await knowledgeMgr.getArticle('art1');

            expect(result.sys_id).toBe('art1');
            expect(result.text).toBe('<p>Step 1: Go to settings...</p>');
        });

        it('should throw error if sysId is empty', async () => {
            await expect(knowledgeMgr.getArticle(''))
                .rejects.toThrow('Article sys_id is required');
        });

        it('should throw error when article not found', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await expect(knowledgeMgr.getArticle('nonexistent'))
                .rejects.toThrow("Article 'nonexistent' not found");
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));

            await expect(knowledgeMgr.getArticle('art1'))
                .rejects.toThrow("Failed to get article 'art1'");
        });
    });

    describe('createArticle', () => {
        it('should create an article with all fields', async () => {
            const mockArticle = {
                sys_id: 'art-new',
                number: 'KB0010003',
                short_description: 'New Article',
                kb_knowledge_base: 'kb1',
                workflow_state: 'draft'
            };
            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(mockArticle, 201));

            const result = await knowledgeMgr.createArticle({
                shortDescription: 'New Article',
                knowledgeBaseSysId: 'kb1',
                text: '<p>Content here</p>',
                categorySysId: 'cat1',
                articleType: 'text'
            });

            expect(result.sys_id).toBe('art-new');
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(1);
        });

        it('should default workflow_state to draft', async () => {
            const mockArticle = { sys_id: 'art-new', short_description: 'Test', kb_knowledge_base: 'kb1', workflow_state: 'draft' };
            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(mockArticle, 201));

            await knowledgeMgr.createArticle({
                shortDescription: 'Test',
                knowledgeBaseSysId: 'kb1'
            });

            const callArgs = mockRequestHandler.post.mock.calls[0][0] as any;
            expect(callArgs.json.workflow_state).toBe('draft');
        });

        it('should include additional fields', async () => {
            const mockArticle = { sys_id: 'art-new', short_description: 'Test', kb_knowledge_base: 'kb1' };
            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(mockArticle, 201));

            await knowledgeMgr.createArticle({
                shortDescription: 'Test',
                knowledgeBaseSysId: 'kb1',
                additionalFields: { meta_description: 'A test article' }
            });

            const callArgs = mockRequestHandler.post.mock.calls[0][0] as any;
            expect(callArgs.json.meta_description).toBe('A test article');
        });

        it('should throw error if shortDescription is empty', async () => {
            await expect(knowledgeMgr.createArticle({
                shortDescription: '',
                knowledgeBaseSysId: 'kb1'
            })).rejects.toThrow('Article short description is required');
        });

        it('should throw error if knowledgeBaseSysId is empty', async () => {
            await expect(knowledgeMgr.createArticle({
                shortDescription: 'Test',
                knowledgeBaseSysId: ''
            })).rejects.toThrow('Knowledge base sys_id is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(knowledgeMgr.createArticle({
                shortDescription: 'Test',
                knowledgeBaseSysId: 'kb1'
            })).rejects.toThrow('Failed to create article');
        });
    });

    describe('updateArticle', () => {
        it('should update article fields via PUT', async () => {
            const mockArticle = { sys_id: 'art1', short_description: 'Updated Title', kb_knowledge_base: 'kb1' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockArticle));

            const result = await knowledgeMgr.updateArticle('art1', {
                shortDescription: 'Updated Title'
            });

            expect(result.short_description).toBe('Updated Title');
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
        });

        it('should only include provided fields in body', async () => {
            const mockArticle = { sys_id: 'art1', short_description: 'Test', kb_knowledge_base: 'kb1' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockArticle));

            await knowledgeMgr.updateArticle('art1', {
                shortDescription: 'Test',
                text: '<p>New content</p>'
            });

            const callArgs = mockRequestHandler.put.mock.calls[0][0] as any;
            expect(callArgs.json.short_description).toBe('Test');
            expect(callArgs.json.text).toBe('<p>New content</p>');
            expect(callArgs.json.wiki).toBeUndefined();
        });

        it('should throw error if sysId is empty', async () => {
            await expect(knowledgeMgr.updateArticle('', { shortDescription: 'Test' }))
                .rejects.toThrow('Article sys_id is required');
        });

        it('should throw error if no fields provided', async () => {
            await expect(knowledgeMgr.updateArticle('art1', {}))
                .rejects.toThrow('At least one field must be provided for update');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.put.mockResolvedValueOnce(createErrorResponse(500));

            await expect(knowledgeMgr.updateArticle('art1', { shortDescription: 'Test' }))
                .rejects.toThrow("Failed to update article 'art1'");
        });
    });

    describe('publishArticle', () => {
        it('should set workflow_state to published', async () => {
            const mockArticle = { sys_id: 'art1', short_description: 'Test', workflow_state: 'published' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockArticle));

            const result = await knowledgeMgr.publishArticle('art1');

            expect(result.workflow_state).toBe('published');
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);

            const callArgs = mockRequestHandler.put.mock.calls[0][0] as any;
            expect(callArgs.json.workflow_state).toBe('published');
        });

        it('should throw error if sysId is empty', async () => {
            await expect(knowledgeMgr.publishArticle(''))
                .rejects.toThrow('Article sys_id is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.put.mockResolvedValueOnce(createErrorResponse(500));

            await expect(knowledgeMgr.publishArticle('art1'))
                .rejects.toThrow("Failed to update article 'art1'");
        });
    });
});
