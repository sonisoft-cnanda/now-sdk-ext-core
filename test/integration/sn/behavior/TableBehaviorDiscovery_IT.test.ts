import { beforeAll, describe, expect, it } from '@jest/globals';
import { getCredentials } from '@servicenow/sdk-cli/dist/auth/index.js';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { TableBehaviorDiscovery } from '../../../../src/sn/behavior/TableBehaviorDiscovery';

const alias = process.env.NEX_BEHAVIOR_TEST_ALIAS;
const live = alias ? describe : describe.skip;

live('table behavior (read-only instance validation)', () => {
    let discovery: TableBehaviorDiscovery;
    beforeAll(async () => {
        const credential = await getCredentials(alias);
        if (!credential) throw new Error('NEX_BEHAVIOR_TEST_ALIAS must identify usable credentials.');
        discovery = new TableBehaviorDiscovery(new ServiceNowInstance({ alias, credential }));
    });

    it('discovers all eight categories on change_request with explicit completeness', async () => {
        const result = await discovery.discoverTableBehavior('change_request', { limit: 2 });
        expect(result.categories).toHaveLength(8);
        expect(result.ancestors).toContain('task');
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536);
        const warnings = result.categories.flatMap(section => [...section.warnings, ...section.items.flatMap(item => item.warnings)]);
        expect(warnings.filter(warning => ['request_failed', 'malformed_response'].includes(warning.code))).toEqual([]);
        const rule = result.categories.find(section => section.category === 'business_rules')?.items[0];
        expect(rule).toBeDefined();
        const detail = await discovery.getBehaviorDetails([rule!.reference], { details: ['scripts'] });
        expect(detail.items[0].reference).toEqual(rule!.reference);
        expect(detail.items[0].scripts).toBeDefined();
    }, 120000);

    it('supports a non-task table without requiring change-model configuration', async () => {
        const result = await discovery.discoverTableBehavior('sys_user', { categories: ['state_models', 'data_policies'], limit: 2 });
        expect(result.table).toBe('sys_user');
        expect(result.categories.every(section => section.status !== 'failed')).toBe(true);
    }, 120000);
});
