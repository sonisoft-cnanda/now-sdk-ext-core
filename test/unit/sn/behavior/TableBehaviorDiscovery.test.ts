import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TableAPIRequest } from '../../../../src/comm/http/TableAPIRequest';
import { IHttpResponse } from '../../../../src/comm/http/IHttpResponse';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { TableBehaviorDiscovery } from '../../../../src/sn/behavior/TableBehaviorDiscovery';
import { FlowManager } from '../../../../src/sn/flow/FlowManager';
import { refusalFor } from '../../../../src/policy/PolicyRefusal';

type Row = Record<string, unknown>;
const id = (value: number): string => value.toString(16).padStart(32, '0');
const tables: Record<string, string[]> = {
    task: [], incident: [], change_request: [], sys_user: [],
    sys_script: ['collection', 'active', 'name', 'when', 'order', 'condition', 'filter_condition', 'script', 'action_update'],
    sys_script_client: ['table', 'name', 'active', 'applies_extended', 'type', 'field', 'script'],
    sys_ui_action: ['table', 'name', 'active', 'condition', 'sys_overrides', 'action_name', 'script'],
    sys_ui_policy: ['table', 'active', 'inherit', 'conditions', 'reverse_if_false', 'script_true', 'script_false'],
    sys_ui_policy_action: ['ui_policy', 'field', 'mandatory', 'disabled', 'visible'],
    sys_data_policy2: ['model_table', 'active', 'inherit', 'conditions', 'apply_import_set'],
    sys_data_policy_rule: ['sys_data_policy', 'field', 'mandatory', 'disabled'],
    wf_workflow_version: ['table', 'name', 'active', 'published', 'workflow', 'condition'],
    wf_activity: ['workflow_version', 'activity_definition', 'script'],
    wf_transition: ['from', 'to', 'condition'], sys_variable_value: ['document_key', 'variable', 'value'],
    sys_flow_record_trigger: ['table', 'active', 'run_on_extended', 'condition', 'insert', 'update', 'trigger_strategy'],
    sys_hub_flow: ['name', 'active', 'remote_trigger_id', 'type', 'status'],
    sys_state_model: ['table', 'active', 'condition'], sys_state_transition: ['state_model', 'state', 'enter_condition', 'exit_condition'],
    sttrm_model: ['table_name', 'active', 'state_field'], sttrm_state: ['sttrm_model', 'state_value', 'state_label'],
    sttrm_state_transition: ['from_state', 'to_state', 'automatic'], sttrm_transition_condition: ['sttrm_state_transition', 'condition', 'condition_script', 'condition_type'],
    sttrm_transition_condition_field: ['transition_condition', 'name'],
    sys_hub_trigger_instance_v2: ['flow', 'trigger_type', 'trigger_inputs', 'published_version'],
    sys_ui_action_role: ['sys_ui_action', 'sys_user_role'],
    sys_ui_action_view: ['sys_ui_action', 'sys_ui_view', 'visibility'],
    wf_condition: ['activity', 'condition'],
    sys_script_include: ['name', 'api_name', 'script', 'active']
};
let rows: Record<string, Row[]>;
let calls: { table: string; query: string; fields: string[] }[];
let failures: Record<string, number | Error>;
let discovery: TableBehaviorDiscovery;

function matches(row: Row, query: string): boolean {
    return query.split('^NQ').some(part => part.split('^').every(term => {
        if (!term || term.startsWith('ORDERBY')) return true;
        const match = /^(\w+)(ISNOTEMPTY|IN|LIKE|=)(.*)$/.exec(term);
        if (!match) throw new Error(`Unsupported fixture query: ${term}`);
        const value = String(row[match[1]] ?? '');
        if (match[2] === 'ISNOTEMPTY') return Boolean(value);
        if (match[2] === 'IN') return match[3].split(',').includes(value);
        if (match[2] === 'LIKE') return value.includes(match[3]);
        return value === match[3];
    }));
}

beforeEach(() => {
    jest.restoreAllMocks(); calls = []; failures = {};
    const names = Object.keys(tables);
    rows = Object.fromEntries(names.map(name => [name, []]));
    rows.sys_db_object = names.map((name, index) => ({ name, sys_id: id(1000 + index), super_class: ['incident', 'change_request'].includes(name) ? id(1000) : '' }));
    rows.sys_dictionary = names.flatMap(name => ['sys_id', ...tables[name]].map(element => ({ name, element })));
    jest.spyOn(TableAPIRequest.prototype, 'get').mockImplementation(async <T>(table: string, params: object): Promise<IHttpResponse<T>> => {
        const query = params as { sysparm_query: string; sysparm_fields: string; sysparm_offset?: number; sysparm_limit: number };
        calls.push({ table, query: query.sysparm_query, fields: query.sysparm_fields.split(',') });
        const failure = failures[table];
        if (failure instanceof Error) throw failure;
        const matched = (rows[table] ?? []).filter(row => matches(row, query.sysparm_query));
        const page = matched.slice(query.sysparm_offset ?? 0, (query.sysparm_offset ?? 0) + query.sysparm_limit);
        const selected = page.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => query.sysparm_fields.split(',').includes(field))));
        return { status: failure ?? 200, bodyObject: { result: selected } } as IHttpResponse<T>;
    });
    discovery = new TableBehaviorDiscovery(new ServiceNowInstance({ alias: 'behavior-unit', host: 'https://behavior-unit.example' }));
});

describe('TableBehaviorDiscovery', () => {
    it('includes parent business rules and conditions without fetching scripts', async () => {
        rows.sys_script = [
            { sys_id: id(1), collection: 'task', name: 'Parent', active: 'true', condition: 'current.active', when: 'before', script: 'secret body' },
            { sys_id: id(2), collection: 'incident', name: 'Inactive', active: 'false' },
            { sys_id: id(3), collection: 'change_request', name: 'Unrelated', active: 'true' }
        ];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['business_rules'] });
        expect(result.ancestors).toEqual(['task']);
        expect(result.categories[0].items).toHaveLength(1);
        expect(result.categories[0].items[0]).toMatchObject({ inherited: true, active: true, configuration: { condition: 'current.active' }, scriptFields: ['script'] });
        expect(JSON.stringify(result)).not.toContain('secret body');
        expect(calls.find(call => call.table === 'sys_script')?.fields).not.toContain('script');
        expect(calls.some(call => call.table === 'sys_ui_policy')).toBe(false);
    });

    it('honors client inheritance flags and applies active filters to both query branches', async () => {
        rows.sys_script_client = [
            { sys_id: id(1), table: 'incident', active: 'true', applies_extended: 'false' },
            { sys_id: id(2), table: 'task', active: 'true', applies_extended: 'true' },
            { sys_id: id(3), table: 'task', active: 'true', applies_extended: 'false' },
            { sys_id: id(4), table: 'task', active: 'false', applies_extended: 'true' }
        ];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['client_scripts'] });
        expect(result.categories[0].items.map(item => item.reference.sysId)).toEqual([id(1), id(2)]);
    });

    it('can request inactive scripts and exact-table filtering in one call', async () => {
        rows.sys_script = [{ sys_id: id(1), collection: 'incident', active: 'false', script: 'current.setAbortAction(true);' }];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['business_rules'], includeInactive: true, includeInherited: false, details: ['scripts'] });
        expect(result.categories[0].items[0].scripts).toEqual({ script: 'current.setAbortAction(true);' });
        expect(calls.find(call => call.table === 'sys_script')?.query).toContain('collection=incident');
    });

    it('preserves UI policy field actions including leave-alone values', async () => {
        rows.sys_ui_policy = [{ sys_id: id(1), table: 'incident', active: 'true', conditions: 'state=3', reverse_if_false: 'true' }];
        rows.sys_ui_policy_action = [{ sys_id: id(2), ui_policy: id(1), field: 'close_notes', mandatory: 'true', disabled: 'ignore', visible: 'leave_alone' }];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['ui_policies'] });
        expect(result.categories[0].items[0].related?.[0].configuration).toMatchObject({ mandatory: 'true', disabled: 'ignore', visible: 'leave_alone' });
    });

    it('queries data policies through model_table and attaches server requirements', async () => {
        rows.sys_data_policy2 = [{ sys_id: id(1), model_table: 'incident', active: 'true', conditions: 'state=3' }];
        rows.sys_data_policy_rule = [{ sys_id: id(2), sys_data_policy: id(1), field: 'close_code', mandatory: 'true', disabled: 'ignore' }];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['data_policies'] });
        expect(result.categories[0].items[0].related?.[0].configuration.mandatory).toBe('true');
        expect(calls.find(call => call.table === 'sys_data_policy2')?.query).toContain('model_table=incident');
    });

    it('paginates without losing records and binds cursors to filters', async () => {
        rows.sys_script = [1, 2, 3].map(n => ({ sys_id: id(n), collection: 'incident', active: 'true' }));
        const first = await discovery.discoverTableBehavior('incident', { categories: ['business_rules'], limit: 1 });
        const cursor = first.categories[0].nextCursor;
        const second = await discovery.discoverTableBehavior('incident', { categories: ['business_rules'], limit: 1, cursors: { business_rules: cursor } });
        expect(first.categories[0].items[0].reference.sysId).toBe(id(1));
        expect(second.categories[0].items[0].reference.sysId).toBe(id(2));
        await expect(discovery.discoverTableBehavior('task', { categories: ['business_rules'], cursors: { business_rules: cursor } })).rejects.toThrow('Invalid cursor');
    });

    it('does not treat forbidden categories as empty or discard successful categories', async () => {
        failures.sys_script = 403;
        const result = await discovery.discoverTableBehavior('incident', { categories: ['business_rules', 'ui_policies'] });
        expect(result.categories[0]).toMatchObject({ status: 'partial', warnings: [{ code: 'permission_denied' }] });
        expect(result.categories[1]).toMatchObject({ status: 'complete', items: [] });
    });

    it('never sends a table filter whose anchor field is missing', async () => {
        rows.sys_dictionary = rows.sys_dictionary.filter(row => !(row.name === 'sys_script' && row.element === 'collection'));
        const result = await discovery.discoverTableBehavior('incident', { categories: ['business_rules'] });
        expect(result.categories[0].warnings[0].code).toBe('unsupported');
        expect(calls.some(call => call.table === 'sys_script')).toBe(false);
    });

    it.each([401, new Error('Stale session'), refusalFor('write', 'test')])('propagates authentication and policy failures: %s', async failure => {
        failures.sys_script = failure;
        await expect(discovery.discoverTableBehavior('incident', { categories: ['business_rules'] })).rejects.toThrow();
    });

    it('retrieves known references without target-table discovery, deduplicating the batch', async () => {
        rows.sys_script = [{ sys_id: id(1), collection: 'incident', script: 'body' }];
        const ref = { kind: 'business_rules' as const, sourceTable: 'sys_script', sysId: id(1) };
        const result = await discovery.getBehaviorDetails([ref, ref], { details: ['scripts'] });
        expect(result.items).toHaveLength(1);
        expect(result.items[0].scripts?.script).toBe('body');
        expect(calls.filter(call => call.table === 'sys_db_object').some(call => call.query.includes('incident'))).toBe(false);
    });

    it('rejects unsafe references and query injection before any reads', async () => {
        await expect(discovery.getBehaviorDetails([{ kind: 'flows', sourceTable: 'sys_user', sysId: id(1) }])).rejects.toThrow('Unsupported');
        await expect(discovery.discoverTableBehavior('incident^ORactive=true')).rejects.toThrow('Invalid table');
        expect(calls).toHaveLength(0);
    });

    it('omits an oversized script whole, with a direct retrieval path', async () => {
        rows.sys_script = [{ sys_id: id(1), collection: 'incident', script: 'x'.repeat(20000) }];
        const result = await discovery.getBehaviorDetails([{ kind: 'business_rules', sourceTable: 'sys_script', sysId: id(1) }], { details: ['scripts'], maxBytes: 4096 });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
        expect(result.items[0].scripts).toBeUndefined();
        expect(result.items[0].omittedDetails).toEqual(['scripts']);
        expect(result.items[0].warnings.find(w => w.code === 'truncated')?.reference?.sysId).toBe(id(1));
    });

    it('rejects an undersized budget when failure metadata alone cannot fit', async () => {
        const references = Array.from({ length: 50 }, (_, index) => ({ kind: 'business_rules' as const, sourceTable: 'sys_script', sysId: id(index + 1) }));
        await expect(discovery.getBehaviorDetails(references, { maxBytes: 4096 })).rejects.toThrow('select fewer categories/references');
    });

    it('infers a GlideAjax target without querying for the platform constructor', async () => {
        rows.sys_script = [{ sys_id: id(1), script: 'new GlideAjax("Helper");' }];
        const result = await discovery.getBehaviorDetails([{ kind: 'business_rules', sourceTable: 'sys_script', sysId: id(1) }], { details: ['dependencies'] });
        expect(result.items[0].dependencies?.filter(dep => dep.name).map(dep => dep.name)).toEqual(['Helper']);
    });

    it('links runtime triggers to flows but reads design definitions only on request', async () => {
        rows.sys_flow_record_trigger = [{ sys_id: id(1), table: 'incident', active: 'true', condition: 'state=3' }];
        rows.sys_hub_flow = [{ sys_id: id(2), remote_trigger_id: id(1), type: 'flow', name: 'Resolve', active: 'true' }];
        const definition = jest.spyOn(FlowManager.prototype, 'getFlowDesignDefinition').mockResolvedValue({ success: true, sysId: id(2), definition: { name: 'Resolve', status: 'draft' } });
        const summary = await discovery.discoverTableBehavior('incident', { categories: ['flows'] });
        expect(summary.categories[0].items[0].name).toBe('Resolve');
        expect(definition).not.toHaveBeenCalled();
        const detailed = await discovery.discoverTableBehavior('incident', { categories: ['flows'], details: ['definitions'] });
        expect(detailed.categories[0].items[0].definitionSource).toBe('design_time');
        expect(detailed.categories[0].items[0].configuration.triggerSource).toBe('runtime');
    });

    it('supports generic state gates without querying change-specific tables', async () => {
        rows.sttrm_model = [{ sys_id: id(1), table_name: 'incident', active: 'true', state_field: 'state' }, { sys_id: id(9), table_name: 'change_request', active: 'true' }];
        rows.sttrm_state = [{ sys_id: id(2), sttrm_model: id(1), state_value: '1' }];
        rows.sttrm_state_transition = [{ sys_id: id(3), from_state: id(2), to_state: id(4) }];
        rows.sttrm_transition_condition = [{ sys_id: id(5), sttrm_state_transition: id(3), condition: 'approval=approved' }];
        rows.sttrm_transition_condition_field = [{ sys_id: id(6), transition_condition: id(5), name: 'close_notes' }];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['state_models'] });
        expect(result.categories[0].items).toHaveLength(1);
        expect(result.categories[0].items[0].related?.some(row => row.configuration.name === 'close_notes')).toBe(true);
        expect(calls.some(call => call.table.startsWith('chg_'))).toBe(false);
        expect(calls.find(call => call.table === 'sttrm_state')?.query).not.toContain(id(9));
    });

    it('retrieves published workflow activities, transitions and variables only on request', async () => {
        rows.wf_workflow_version = [{ sys_id: id(1), table: 'incident', active: 'true', published: 'true' }, { sys_id: id(2), table: 'incident', active: 'true', published: 'false' }];
        rows.wf_activity = [{ sys_id: id(3), workflow_version: id(1) }];
        rows.wf_transition = [{ sys_id: id(4), from: id(3), to: id(5) }];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['workflows'], details: ['definitions'] });
        expect(result.categories[0].items).toHaveLength(1);
        expect(result.categories[0].items[0].related?.map(row => row.sourceTable)).toEqual(['wf_activity', 'wf_transition']);
    });

    it('expands a literal Script Include dependency once and labels unresolved syntax', async () => {
        rows.sys_script = [{ sys_id: id(1), script: 'new Helper(); new Helper();' }];
        rows.sys_script_include = [{ sys_id: id(2), name: 'Helper', script: 'new Helper();' }];
        const result = await discovery.getBehaviorDetails([{ kind: 'business_rules', sourceTable: 'sys_script', sysId: id(1) }], { details: ['scripts', 'dependencies'], dependencyDepth: 1 });
        expect(result.dependencies).toHaveLength(1);
        expect(result.dependencies[0].scripts?.script).toBe('new Helper();');
        expect(result.items[0].dependencies?.some(dep => dep.resolution === 'unresolved')).toBe(true);
    });
    it('finds unpublished designer triggers with decoded inputs and stable references', async () => {
        rows.sys_hub_trigger_instance_v2 = [{ sys_id: id(11), flow: id(12), trigger_type: 'record_update', trigger_inputs: gzipSync(JSON.stringify([{ name: 'table', value: 'incident' }, { name: 'trigger_strategy', value: 'once' }])).toString('base64') }];
        rows.sys_hub_flow = [{ sys_id: id(12), name: 'Draft', active: 'false', type: 'flow', status: 'draft' }];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['flows'], includeInactive: true });
        expect(result.categories[0].items[0]).toMatchObject({ name: 'Draft', configuration: { triggerSource: 'design_time', triggerInputs: { table: 'incident', trigger_strategy: 'once' } } });
        expect(JSON.stringify(result)).not.toContain('trigger_inputs');
    });

    it('reports corrupt trigger inputs without guessing a target table', async () => {
        rows.sys_hub_trigger_instance_v2 = [{ sys_id: id(11), flow: id(12), trigger_type: 'record_update', trigger_inputs: 'invalid gzip' }];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['flows'], includeInactive: true });
        expect(result.categories[0].items).toEqual([]);
        expect(result.categories[0].warnings.some(w => w.code === 'malformed_response')).toBe(true);
    });

    it('resolves canonical dependencies while preserving the referenced snapshot', async () => {
        rows.sys_hub_flow = [{ sys_id: id(1), type: 'flow' }];
        jest.spyOn(FlowManager.prototype, 'getFlowDesignDefinition').mockResolvedValue({ success: true, sysId: id(1), definition: { actionInstances: [{ actionType: { id: id(2), parent_action: id(3) } }], subFlowInstances: [{ subFlow: { id: id(4), parentFlow: id(5), actionInstances: [{ actionType: { id: id(6) } }] } }] } });
        const result = await discovery.getBehaviorDetails([{ kind: 'flows', sourceTable: 'sys_hub_flow', sysId: id(1) }], { details: ['dependencies'] });
        expect(result.items[0].dependencies?.filter(d => d.reference).map(d => [d.reference?.sysId, d.snapshotSysId])).toEqual([[id(3), id(2)], [id(5), id(4)]]);
        expect(result.items[0].definition).toBeUndefined();
    });

    it('uses Australia dictionary fields for trigger timing and data-policy enforcement', async () => {
        const fixture = JSON.parse(readFileSync(new URL('./fixtures/australia-metadata.json', import.meta.url), 'utf8')) as { records: Row[] };
        const runtime = fixture.records.filter(row => ['sys_flow_record_trigger', 'sys_flow_trigger'].includes(String(row.name)) && row.element).map(row => ({ ...row, name: 'sys_flow_record_trigger' }));
        rows.sys_dictionary = [...rows.sys_dictionary.filter(row => !['sys_flow_record_trigger', 'sys_data_policy2'].includes(String(row.name))), ...runtime, ...fixture.records.filter(row => row.name === 'sys_data_policy2')];
        rows.sys_flow_record_trigger = [{ sys_id: id(1), table: 'incident', active: 'true', on_insert: 'true', on_update: 'false', run_on_extended: 'true' }];
        rows.sys_data_policy2 = [{ sys_id: id(2), model_table: 'incident', active: 'true', enforce_ui: 'true' }];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['flows', 'data_policies'] });
        expect(result.categories[0].items[0].configuration).toMatchObject({ on_insert: 'true', on_update: 'false' });
        expect(result.categories[1].items[0].configuration.enforce_ui).toBe('true');
    });

    it('marks field ACL omissions instead of treating hidden conditions as empty', async () => {
        rows.sys_script = [{ sys_id: id(1), collection: 'incident', active: 'true' }];
        const result = await discovery.discoverTableBehavior('incident', { categories: ['business_rules'] });
        expect(result.categories[0].items[0].warnings.some(w => w.code === 'missing_fields' && w.message.includes('condition'))).toBe(true);
    });

});
