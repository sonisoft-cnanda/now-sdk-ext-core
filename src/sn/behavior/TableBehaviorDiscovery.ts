import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { TableAPIRequest } from '../../comm/http/TableAPIRequest';
import { isPolicyRefusal } from '../../policy/PolicyRefusal';
import { stripSecretsFromError } from '../../util/redact';
import { ServiceNowInstance } from '../ServiceNowInstance';
import { FlowManager } from '../flow/FlowManager';
import {
    BEHAVIOR_CATEGORIES, BehaviorCategory, BehaviorCategoryResult, BehaviorConfiguration,
    BehaviorDependency, BehaviorDetail, BehaviorDetailOptions, BehaviorDetailsResult,
    BehaviorItem, BehaviorKind, BehaviorReference, BehaviorRelatedRecord, BehaviorWarning,
    TableBehaviorOptions, TableBehaviorResult
} from './BehaviorModels';

type Row = Record<string, unknown>;
type Source = { table: string; target: string; inherit?: string; exact?: boolean; fields: string[]; scripts?: string[] };
type Cursor = { source: number; offset: number; signature: string };
const split = (value: string): string[] => value.split(',');
const COMMON = split('sys_id,sys_class_name,name,short_description,description,active,sys_scope,sys_updated_on,order,sys_overrides');
const SOURCES: Record<BehaviorCategory, Source[]> = {
    business_rules: [{ table: 'sys_script', target: 'collection', fields: split('collection,when,action_insert,action_update,action_delete,action_query,filter_condition,condition,advanced,abort_action,add_message,message,change_fields,template,role_conditions'), scripts: ['script'] }],
    ui_actions: [{ table: 'sys_ui_action', target: 'table', fields: split('table,action_name,condition,client,roles,form_button,form_link,form_context_menu,list_button,list_link,list_context_menu,list_banner_button,list_choice,show_insert,show_update,sys_overrides,ui_type,form_button_v2,form_menu_button_v2,format_for_configurable_workspace'), scripts: ['script', 'onclick', 'client_script_v2'] }],
    client_scripts: [{ table: 'sys_script_client', target: 'table', inherit: 'applies_extended', fields: split('table,type,field,ui_type,view,global,applies_extended,isolate_script,condition'), scripts: ['script'] }],
    ui_policies: [{ table: 'sys_ui_policy', target: 'table', inherit: 'inherit', fields: split('table,conditions,on_load,reverse_if_false,inherit,global,view,run_scripts,ui_type'), scripts: ['script_true', 'script_false'] }],
    data_policies: [{ table: 'sys_data_policy2', target: 'model_table', inherit: 'inherit', fields: split('model_table,conditions,reverse_if_false,inherit,apply_import_set,apply_soap,enforce_ui') }],
    workflows: [{ table: 'wf_workflow_version', target: 'table', exact: true, fields: split('table,workflow,published,condition,condition_type,run_multiple,expected_time,start,checked_out,valid_from,valid_to,after_business_rules') }],
    flows: [{ table: 'sys_flow_record_trigger', target: 'table', inherit: 'run_on_extended', fields: split('table,condition,conditions,on_insert,on_update,on_delete,published_version,trigger_definition,trigger_type,type,run_on_extended,trigger_strategy,run_flow_in,run_when_setting,run_when_user_setting,run_when_user_list') }, { table: 'sys_hub_trigger_instance_v2', target: '', fields: split('flow,trigger_type,trigger_inputs,published_version,comment') }],
    state_models: [
        { table: 'sys_state_model', target: 'table', exact: true, fields: split('table,condition,conditions,state_field,global_exit_condition') },
        { table: 'sttrm_model', target: 'table_name', exact: true, fields: split('table_name,state_field,condition,conditions,read_roles,write_roles,advanced_security') }
    ]
};
const EXTRA: Record<string, Source> = {
    subflow: { table: 'sys_hub_flow', target: '', fields: split('type,internal_name,status'), scripts: [] },
    action: { table: 'sys_hub_action_type_definition', target: '', fields: split('internal_name,status'), scripts: [] },
    script_include: { table: 'sys_script_include', target: '', fields: split('api_name,client_callable,access'), scripts: ['script'] },
    decision_table: { table: 'sys_decision', target: '', fields: split('label,condition'), scripts: [] }
};
const FLOW_SOURCE: Source = { table: 'sys_hub_flow', target: '', fields: split('type,internal_name,status,remote_trigger_id'), scripts: [] };
const DETAIL_NAMES: BehaviorDetail[] = ['scripts', 'definitions', 'dependencies'];
const TABLE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SYS_ID = /^[a-f0-9]{32}$/i;
const string = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'value' in value) return string(value.value);
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
};
const record = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const bool = (value: unknown): boolean | undefined => ['true', '1'].includes(string(value)) ? true : ['false', '0'].includes(string(value)) ? false : undefined;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const key = (ref: BehaviorReference): string => `${ref.kind}:${ref.sourceTable}:${ref.sysId}`;

class ReadFailure extends Error {
    constructor(readonly warning: BehaviorWarning) { super(warning.message); }
}

/** Read-only discovery of table configuration and batched artifact details. */
export class TableBehaviorDiscovery {
    public constructor(private readonly _instance: ServiceNowInstance) {}

    /** Discover active, applicable configuration; request optional detail without an extra call. */
    public async discoverTableBehavior(table: string, options: TableBehaviorOptions = {}): Promise<TableBehaviorResult> {
        return new Reader(this._instance, options).discover(table, options);
    }

    /** Retrieve up to 50 known artifacts without scanning a table's behavior inventory. */
    public async getBehaviorDetails(references: BehaviorReference[], options: BehaviorDetailOptions = {}): Promise<BehaviorDetailsResult> {
        return new Reader(this._instance, options).details(references);
    }
}

class Reader {
    private readonly _api: TableAPIRequest;
    private _flowManager?: FlowManager;
    private readonly _instance: ServiceNowInstance;
    private readonly _schemas = new Map<string, Promise<Set<string>>>();
    private readonly _reads = new Map<string, Promise<Row[]>>();
    private readonly _details: BehaviorDetail[];
    private readonly _maxBytes: number;
    private readonly _dependencyDepth: number;
    private readonly _options: BehaviorDetailOptions;
    private readonly _dependencyAttempts = new Set<string>();
    private readonly _expanded = new Map<string, BehaviorItem>();

    constructor(instance: ServiceNowInstance, options: BehaviorDetailOptions) {
        this._api = new TableAPIRequest(instance);
        this._instance = instance;
        this._details = [...new Set(options.details ?? [])];
        if (this._details.some(value => !DETAIL_NAMES.includes(value))) throw new Error('Unknown behavior detail. Use scripts, definitions, dependencies.');
        this._maxBytes = options.maxBytes ?? 65536;
        if (!Number.isInteger(this._maxBytes) || this._maxBytes < 4096 || this._maxBytes > 1048576) throw new Error('maxBytes must be an integer from 4096 to 1048576.');
        this._dependencyDepth = options.dependencyDepth ?? 0;
        if (![0, 1].includes(this._dependencyDepth)) throw new Error('dependencyDepth must be 0 or 1.');
        if (this._dependencyDepth && !this._details.includes('dependencies')) throw new Error('dependencyDepth requires dependencies in details.');
        this._options = options;
    }

    private get _flow(): FlowManager {
        this._flowManager ??= new FlowManager(this._instance);
        return this._flowManager;
    }

    async discover(table: string, options: TableBehaviorOptions): Promise<TableBehaviorResult> {
        if (table.length > 160 || !TABLE_NAME.test(table)) throw new Error('Invalid table name.');
        const categories = [...new Set(options.categories ?? BEHAVIOR_CATEGORIES)];
        if (!categories.length || categories.some(value => !BEHAVIOR_CATEGORIES.includes(value))) throw new Error('Select at least one valid behavior category.');
        const limit = options.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 to 200.');
        if (options.name && (options.name.length > 128 || /[\^\r\n]/.test(options.name))) throw new Error('name must be at most 128 characters and cannot contain encoded-query operators.');
        if (options.sysIds && (options.sysIds.length > 50 || options.sysIds.some(id => !SYS_ID.test(id)))) throw new Error('sysIds must contain at most 50 valid sys_ids.');
        const hierarchy = await this._hierarchy(table);
        const metadataTables = categories.flatMap(category => SOURCES[category]).filter(source => source.table !== 'sys_hub_trigger_instance_v2' || options.includeInactive).map(source => source.table);
        for (let index = 0; index < metadataTables.length; index += 4) await Promise.allSettled(metadataTables.slice(index, index + 4).map(source => this._fields(source)));
        const result: TableBehaviorResult = { table, ancestors: hierarchy.slice(1), requestedDetails: this._details, categories: [], dependencies: [], warnings: [], visibility: 'accessible_configuration' };
        for (const category of categories) {
            const signature = createHash('sha256').update(JSON.stringify({ table, category, inherited: options.includeInherited !== false, inactive: options.includeInactive === true, name: options.name, ids: options.sysIds, details: this._details })).digest('hex');
            const cursor = this._cursor(options.cursors?.[category], signature);
            const section: BehaviorCategoryResult = { category, status: 'complete', items: [], warnings: [] };
            result.categories.push(section);
            const sources = SOURCES[category];
            let available = false;
            for (let sourceIndex = cursor.source; sourceIndex < sources.length; sourceIndex++) {
                const source = sources[sourceIndex];
                const offset = sourceIndex === cursor.source ? cursor.offset : 0;
                try {
                    if (source.table === 'sys_hub_trigger_instance_v2') {
                        if (!options.includeInactive) continue;
                        const page = await this._designerPage(table, hierarchy, options, offset, limit - section.items.length);
                        available = true;
                        for (const item of page.items) {
                            await this._enrich(item);
                            section.items.push(item);
                            if (bytes(result) > this._maxBytes - 2048) this._omitPayload(item);
                            if (bytes(result) > this._maxBytes - 2048) {
                                section.items.pop();
                                section.nextCursor = this._encode({ source: sourceIndex, offset: page.offsets[page.items.indexOf(item)], signature });
                                break;
                            }
                        }
                        if (!section.nextCursor && page.more) section.nextCursor = this._encode({ source: sourceIndex, offset: page.nextOffset, signature });
                        break;
                    }
                    const fields = await this._fields(source.table);
                    this._require(source.table, fields, [source.target]);
                    available = true;
                    let query = `${source.target}=${table}`;
                    if (options.includeInherited !== false && !source.exact) {
                        const parents = hierarchy.slice(1);
                        if (category === 'ui_actions') parents.push('global');
                        if (parents.length) {
                            if (source.inherit) {
                                this._require(source.table, fields, [source.inherit]);
                                query += `^NQ${source.target}IN${parents.join(',')}^${source.inherit}=true`;
                            } else query = `${source.target}IN${[table, ...parents].join(',')}`;
                        }
                    }
                    let filters = '';
                    if (!options.includeInactive) {
                        if (fields.has('active')) filters += '^active=true';
                        else section.warnings.push({ code: 'missing_fields', message: `Active status unavailable on ${source.table}; candidates may be inactive.`, sourceTable: source.table });
                        if (category === 'workflows') {
                            this._require(source.table, fields, ['published']);
                            filters += '^published=true';
                        }
                    }
                    const nameField = fields.has('name') ? 'name' : fields.has('short_description') ? 'short_description' : undefined;
                    if (options.name) {
                        if (category === 'flows') {
                            const flowFields = await this._fields('sys_hub_flow');
                            this._require('sys_hub_flow', flowFields, ['name', 'remote_trigger_id']);
                            const matching = await this._read('sys_hub_flow', `nameLIKE${options.name}^type=flow`, ['remote_trigger_id'], 2001);
                            if (matching.length > 2000) throw this._unsupported(source.table, 'Too many matching flows. Narrow the name filter.');
                            const ids = matching.map(row => string(row.remote_trigger_id)).filter(id => SYS_ID.test(id));
                            if (!ids.length) continue;
                            filters += `^sys_idIN${ids.join(',')}`;
                        } else {
                            if (!nameField) throw this._unsupported(source.table, 'Name filtering is unavailable for this source.');
                            filters += `^${nameField}LIKE${options.name}`;
                        }
                    }
                    if (options.sysIds?.length) filters += `^sys_idIN${options.sysIds.join(',')}`;
                    query = query.split('^NQ').map(part => part + filters).join('^NQ');
                    const take = limit - section.items.length;
                    const rows = await this._read(source.table, query + '^ORDERBYsys_id', this._columns(source, fields), take + 1, offset);
                    const selected = rows.slice(0, take);
                    const items = selected.map(row => this._item(category, source, row, fields, table));
                    await this._attachRelated(category, items);
                    if (category === 'flows') await this._attachFlows(items, options.includeInactive === true);
                    for (let index = 0; index < items.length; index++) {
                        const item = items[index];
                        await this._enrich(item);
                        section.items.push(item);
                        if (bytes(result) > this._maxBytes - 2048) {
                            this._omitPayload(item);
                            if (bytes(result) > this._maxBytes - 2048) {
                                section.items.pop();
                                section.nextCursor = this._encode({ source: sourceIndex, offset: offset + index, signature });
                                if (!section.items.length) section.warnings.push({ code: 'truncated', message: 'Record exceeds response budget. Increase maxBytes or retrieve its reference directly.', reference: item.reference });
                                break;
                            }
                        }
                    }
                    if (section.nextCursor) break;
                    if (rows.length > take) { section.nextCursor = this._encode({ source: sourceIndex, offset: offset + selected.length, signature }); break; }
                    if (section.items.length >= limit && sourceIndex + 1 < sources.length) { section.nextCursor = this._encode({ source: sourceIndex + 1, offset: 0, signature }); break; }
                } catch (error) { section.warnings.push(this._warning(error, source.table)); }
            }
            section.status = !available ? 'unavailable' : section.warnings.length || section.nextCursor || section.items.some(item => item.warnings.length) ? 'partial' : 'complete';
        }
        result.dependencies = [...this._expanded.values()];
        this._fitDependencies(result);
        return result;
    }

    async details(references: BehaviorReference[]): Promise<BehaviorDetailsResult> {
        if (!Array.isArray(references) || !references.length || references.length > 50) throw new Error('Provide 1 to 50 behavior references.');
        references.forEach(ref => this._source(ref));
        const unique = [...new Map(references.map(ref => [key(ref), ref])).values()];
        const result: BehaviorDetailsResult = { items: [], dependencies: [], warnings: [], remainingReferences: [], requestedDetails: this._details, visibility: 'accessible_configuration' };
        for (let index = 0; index < unique.length; index++) {
            const ref = unique[index];
            try {
                const item = await this._detail(ref);
                result.items.push(item);
                if (bytes(result) > this._maxBytes - 2048) {
                    this._omitPayload(item);
                    if (bytes(result) > this._maxBytes - 2048) {
                        result.items.pop();
                        result.remainingReferences = unique.slice(index);
                        result.warnings.push({ code: 'truncated', message: 'Response budget reached. Retrieve remainingReferences with a larger maxBytes or a smaller batch.' });
                        break;
                    }
                }
            } catch (error) { result.warnings.push({ ...this._warning(error, ref.sourceTable), reference: ref }); }
        }
        result.dependencies = [...this._expanded.values()];
        this._fitDependencies(result);
        return result;
    }

    private async _detail(ref: BehaviorReference, expand = true): Promise<BehaviorItem> {
        const source = this._source(ref);
        const fields = await this._fields(source.table);
        const rows = await this._read(source.table, `sys_id=${ref.sysId}`, this._columns(source, fields), 1);
        if (!rows.length) throw new ReadFailure({ code: 'not_found', message: 'Record not found or not visible to the authenticated user.', reference: ref });
        if (source.table === 'sys_hub_flow' && string(rows[0].type) !== (ref.kind === 'subflow' ? 'subflow' : 'flow')) throw new ReadFailure({ code: 'malformed_response', message: 'Flow artifact type does not match the requested kind.', reference: ref });
        const item = this._item(ref.kind, source, rows[0], fields);
        if (BEHAVIOR_CATEGORIES.includes(ref.kind as BehaviorCategory)) await this._attachRelated(ref.kind as BehaviorCategory, [item]);
        if (ref.kind === 'flows' && ['sys_flow_record_trigger', 'sys_hub_trigger_instance_v2'].includes(source.table)) await this._attachFlows([item], true);
        await this._enrich(item, expand);
        return item;
    }

    private _source(ref: BehaviorReference): Source {
        if (!ref || !SYS_ID.test(ref.sysId)) throw new Error('Each reference requires a 32-character hexadecimal sysId.');
        const candidates = SOURCES[ref.kind as BehaviorCategory] ?? (Object.prototype.hasOwnProperty.call(EXTRA, ref.kind) ? [EXTRA[ref.kind]] : []);
        const source = [...candidates, ...(ref.kind === 'flows' ? [FLOW_SOURCE] : [])].find(value => value.table === ref.sourceTable);
        if (!source) throw new Error(`Unsupported behavior reference kind/sourceTable: ${String(ref.kind)}/${String(ref.sourceTable)}`);
        return source;
    }

    private _columns(source: Source, fields: Set<string>): string[] {
        return [...new Set([...COMMON, ...source.fields, ...(this._details.includes('scripts') || this._details.includes('dependencies') ? source.scripts ?? [] : [])])].filter(field => fields.has(field));
    }

    private _item(kind: BehaviorKind, source: Source, row: Row, fields: Set<string>, requestedTable?: string): BehaviorItem {
        const id = string(row.sys_id);
        if (!SYS_ID.test(id)) throw new ReadFailure({ code: 'malformed_response', message: 'Metadata record lacks a valid sys_id.', sourceTable: source.table });
        const scriptFields = (source.scripts ?? []).filter(field => fields.has(field));
        const configuration: BehaviorConfiguration = {};
        const scripts: Record<string, string> = {};
        for (const [field, value] of Object.entries(row)) {
            if (scriptFields.includes(field)) scripts[field] = string(value);
            else configuration[field] = value;
        }
        let table = source.target ? string(row[source.target]) : undefined;
        if (source.table === 'sys_hub_trigger_instance_v2') {
            const inputs = this._triggerInputs(row.trigger_inputs);
            delete configuration.trigger_inputs;
            configuration.triggerInputs = inputs;
            configuration.triggerSource = 'design_time';
            table = string(inputs.table);
        }
        const item: BehaviorItem = {
            reference: { kind, sysId: id, sourceTable: source.table }, name: string(row.name) || string(row.short_description) || id,
            table, inherited: requestedTable && table ? table !== requestedTable : undefined, active: bool(row.active),
            scope: string(row.sys_scope) || undefined, configuration, scriptFields, warnings: []
        };
        const unreadable = this._columns(source, fields).filter(field => !scriptFields.includes(field) && !(field in row));
        if (unreadable.length) item.warnings.push({ code: 'missing_fields', message: `Requested fields not returned: ${unreadable.join(', ')}. These may be ACL-restricted.`, sourceTable: source.table });
        if (this._details.includes('scripts')) {
            item.scripts = scripts;
            for (const field of scriptFields) if (!(field in row)) item.warnings.push({ code: 'missing_fields', message: `Script field ${field} was not returned; it may be ACL-restricted.`, sourceTable: source.table });
        }
        if (this._details.includes('dependencies')) item.dependencies = this._scriptDependencies(Object.values(scripts));
        return item;
    }

    private async _hierarchy(table: string): Promise<string[]> {
        const names: string[] = [];
        const visited = new Set<string>();
        let query = `name=${table}`;
        for (let depth = 0; depth < 32; depth++) {
            const rows = await this._read('sys_db_object', query, ['sys_id', 'name', 'super_class'], 1);
            if (!rows.length) throw new ReadFailure({ code: 'not_found', message: `Table hierarchy not found or inaccessible for ${table}.` });
            const row = rows[0];
            const name = string(row.name);
            if (!TABLE_NAME.test(name) || visited.has(name)) throw new ReadFailure({ code: 'malformed_response', message: `Invalid or cyclic table hierarchy for ${table}.` });
            visited.add(name); names.push(name);
            const parent = string(row.super_class);
            if (!parent) return names;
            if (!SYS_ID.test(parent)) throw new ReadFailure({ code: 'malformed_response', message: `Invalid parent reference for ${name}.` });
            query = `sys_id=${parent}`;
        }
        throw new ReadFailure({ code: 'malformed_response', message: 'Table hierarchy exceeds 32 levels.' });
    }

    private _fields(table: string): Promise<Set<string>> {
        let pending = this._schemas.get(table);
        if (pending === undefined) {
            pending = this._loadFields(table);
            this._schemas.set(table, pending);
        }
        return pending;
    }

    private async _loadFields(table: string): Promise<Set<string>> {
        const hierarchy = await this._hierarchy(table);
        const rows = await this._read('sys_dictionary', `nameIN${hierarchy.join(',')}^elementISNOTEMPTY`, ['element'], 2001);
        if (rows.length > 2000) throw this._unsupported(table, 'Metadata field inventory exceeds supported bound.');
        const fields = new Set(rows.map(row => string(row.element)).filter(Boolean));
        fields.add('sys_id');
        return fields;
    }

    private _require(table: string, fields: Set<string>, required: string[]): void {
        const missing = required.filter(field => !fields.has(field));
        if (missing.length) throw this._unsupported(table, `Required fields unavailable: ${missing.join(', ')}. No unfiltered query was issued.`);
    }

    private _unsupported(table: string, message: string): ReadFailure {
        return new ReadFailure({ code: 'unsupported', message, sourceTable: table });
    }

    private _read(table: string, query: string, fields: string[], limit: number, offset = 0): Promise<Row[]> {
        const cacheKey = JSON.stringify([table, query, fields, limit, offset]);
        let pending = this._reads.get(cacheKey);
        if (pending === undefined) {
            pending = this._fetch(table, query, fields, limit, offset);
            this._reads.set(cacheKey, pending);
        }
        return pending;
    }

    private async _fetch(table: string, query: string, fields: string[], limit: number, offset: number): Promise<Row[]> {
        const response = await this._api.get<{ result: unknown }>(table, {
            sysparm_query: query, sysparm_fields: fields.join(','), sysparm_limit: limit, sysparm_offset: offset,
            sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true', sysparm_no_count: 'true'
        });
        if (response?.status === 401) throw new Error('Authentication failed (401) while reading table behavior.');
        if (response?.status !== 200) throw new ReadFailure({ code: response?.status === 403 ? 'permission_denied' : response?.status === 404 ? 'not_found' : 'request_failed', message: `Reading ${table} failed (HTTP ${response?.status ?? 'unknown'}).`, sourceTable: table });
        const rows = response.bodyObject?.result;
        if (!Array.isArray(rows) || rows.some(row => !record(row))) throw new ReadFailure({ code: 'malformed_response', message: `Invalid table response from ${table}.`, sourceTable: table });
        return rows as Row[];
    }

    private _warning(error: unknown, sourceTable?: string): BehaviorWarning {
        if (isPolicyRefusal(error)) throw error;
        const clean = stripSecretsFromError(error);
        if (clean instanceof Error && /401|authentication|unauthorized|session|csrf|token|stale|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|No response|Body not XML/i.test(clean.message)) throw clean;
        if (clean instanceof ReadFailure) return clean.warning;
        return { code: 'request_failed', message: `Read failed${sourceTable ? ` for ${sourceTable}` : ''}. Check connection and metadata access.`, sourceTable };
    }

    private _cursor(value: string | undefined, signature: string): Cursor {
        if (!value) return { source: 0, offset: 0, signature };
        try {
            const parsed = record(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown);
            if (value.length > 512 || !parsed || parsed.signature !== signature || !Number.isInteger(parsed.source) || !Number.isInteger(parsed.offset) || Number(parsed.source) < 0 || Number(parsed.source) > 1 || Number(parsed.offset) < 0 || Number(parsed.offset) > 1000000) throw new Error();
            return { source: Number(parsed.source), offset: Number(parsed.offset), signature };
        } catch { throw new Error('Invalid cursor or filters changed. Restart discovery with the desired filters.'); }
    }

    private _encode(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }

    private _omitPayload(item: BehaviorItem): void {
        item.omittedDetails = [...this._details];
        delete item.scripts; delete item.definition; delete item.dependencies;
        for (const row of item.related ?? []) delete row.scripts;
        item.warnings.push({ code: 'truncated', message: 'Detail exceeds response budget. Retrieve this reference alone with higher maxBytes; no script text was cut.', reference: item.reference });
    }

    private _fitDependencies(result: TableBehaviorResult | BehaviorDetailsResult): void {
        while (result.dependencies.length && bytes(result) > this._maxBytes) {
            const item = result.dependencies.pop();
            if (item && !result.warnings.some(warning => warning.code === 'truncated')) result.warnings.push({ code: 'truncated', message: 'Expanded dependencies exceed response budget. Retrieve dependency references directly.' });
        }
        if (bytes(result) > this._maxBytes) throw new Error('Response metadata exceeds maxBytes. Increase maxBytes or select fewer categories/references.');
    }

    private async _children(table: string, foreignKey: string, ids: string[], wanted: string[], scriptFields: string[] = []): Promise<BehaviorRelatedRecord[]> {
        if (!ids.length) return [];
        if (ids.some(id => !SYS_ID.test(id))) throw new ReadFailure({ code: 'malformed_response', message: `Invalid related-record reference for ${table}; no query issued.`, sourceTable: table });
        const fields = await this._fields(table);
        this._require(table, fields, [foreignKey]);
        const scripts = this._details.includes('scripts') || this._details.includes('dependencies') ? scriptFields : [];
        const columns = [...new Set([...COMMON, foreignKey, ...wanted, ...scripts])].filter(field => fields.has(field));
        const rows = await this._read(table, `${foreignKey}IN${ids.join(',')}^ORDERBYsys_id`, columns, 2001);
        if (rows.length > 2000) throw new ReadFailure({ code: 'truncated', message: `Related ${table} records exceed 2000. Retrieve fewer parent references.`, sourceTable: table });
        return rows.map(row => {
            const configuration: Row = {};
            const bodies: Record<string, string> = {};
            for (const [field, value] of Object.entries(row)) {
                if (scriptFields.includes(field)) bodies[field] = string(value);
                else configuration[field] = value;
            }
            return { sourceTable: table, sysId: string(row.sys_id), configuration, ...(scripts.length ? { scripts: bodies } : {}) };
        });
    }

    private async _attachRelated(category: BehaviorCategory, items: BehaviorItem[]): Promise<void> {
        if (!items.length) return;
        const ids = items.map(item => item.reference.sysId);
        const attach = (rows: BehaviorRelatedRecord[], foreignKey: string): void => {
            for (const item of items) item.related = [...(item.related ?? []), ...rows.filter(row => string(row.configuration[foreignKey]) === item.reference.sysId)];
        };
        try {
            if (category === 'ui_policies') attach(await this._children('sys_ui_policy_action', 'ui_policy', ids, split('field,mandatory,disabled,visible,cleared,value_action,value,field_message_type,field_message')), 'ui_policy');
            if (category === 'data_policies') attach(await this._children('sys_data_policy_rule', 'sys_data_policy', ids, split('field,mandatory,disabled')), 'sys_data_policy');
            if (category === 'workflows' && this._details.includes('definitions')) {
                const activities = await this._children('wf_activity', 'workflow_version', ids, split('activity_definition,notes,x,y,vars'), ['script']);
                attach(activities, 'workflow_version');
                const transitions = await this._children('wf_transition', 'from', activities.map(row => row.sysId), split('to,condition'));
                for (const item of items) {
                    const activityIds = new Set((item.related ?? []).map(row => row.sysId));
                    item.related = [...(item.related ?? []), ...transitions.filter(row => activityIds.has(string(row.configuration.from)))];
                }
                const conditions = await this._children('wf_condition', 'activity', activities.map(row => row.sysId), split('condition,condition_type,event,event_name,is_positive,else_flag,condition_default'));
                for (const item of items) {
                    const activityIds = new Set((item.related ?? []).filter(row => row.sourceTable === 'wf_activity').map(row => row.sysId));
                    item.related = [...(item.related ?? []), ...conditions.filter(row => activityIds.has(string(row.configuration.activity)))];
                }
                const variables = await this._children('sys_variable_value', 'document_key', activities.map(row => row.sysId), split('variable,value'));
                for (const item of items) {
                    const activityIds = new Set((item.related ?? []).filter(row => row.sourceTable === 'wf_activity').map(row => row.sysId));
                    item.related = [...(item.related ?? []), ...variables.filter(row => activityIds.has(string(row.configuration.document_key)))];
                }
            }
            if (category === 'state_models') {
                const legacy = items.filter(item => item.reference.sourceTable === 'sys_state_model');
                if (legacy.length) attach(await this._children('sys_state_transition', 'state_model', legacy.map(item => item.reference.sysId), split('state,state_label,terminal_state,enter_condition,exit_condition,condition,conditions')), 'state_model');
                const modern = items.filter(item => item.reference.sourceTable === 'sttrm_model');
                if (!modern.length) return;
                const states = await this._children('sttrm_state', 'sttrm_model', modern.map(item => item.reference.sysId), split('state_value,state_label,state_sequence,initial_state'));
                attach(states, 'sttrm_model');
                const transitions = await this._children('sttrm_state_transition', 'from_state', states.map(row => row.sysId), split('to_state,automatic'));
                const gates = await this._children('sttrm_transition_condition', 'sttrm_state_transition', transitions.map(row => row.sysId), split('condition,condition_type'), ['condition_script']);
                const requirements = await this._children('sttrm_transition_condition_field', 'transition_condition', gates.map(row => row.sysId), ['name']);
                for (const item of modern) {
                    const stateIds = new Set((item.related ?? []).map(row => row.sysId));
                    const modelTransitions = transitions.filter(row => stateIds.has(string(row.configuration.from_state)));
                    const transitionIds = new Set(modelTransitions.map(row => row.sysId));
                    const modelGates = gates.filter(row => transitionIds.has(string(row.configuration.sttrm_state_transition)));
                    const gateIds = new Set(modelGates.map(row => row.sysId));
                    item.related = [...(item.related ?? []), ...modelTransitions, ...modelGates, ...requirements.filter(row => gateIds.has(string(row.configuration.transition_condition)))];
                }
            }
            if (category === 'ui_actions') {
                attach(await this._children('sys_ui_action_role', 'sys_ui_action', ids, ['sys_user_role']), 'sys_ui_action');
                attach(await this._children('sys_ui_action_view', 'sys_ui_action', ids, ['sys_ui_view', 'visibility']), 'sys_ui_action');
                for (const item of items) {
                    const overrides = items.filter(other => string(other.configuration.sys_overrides) === item.reference.sysId);
                    if (overrides.length) item.configuration.overriddenBy = overrides.map(other => other.reference);
                }
            }
        } catch (error) {
            const warning = this._warning(error);
            for (const item of items) item.warnings.push(warning);
        }
    }

    private _triggerInputs(value: unknown): Row {
        try {
            const raw = string(value);
            const decoded: unknown = JSON.parse(raw.startsWith('[') ? raw : gunzipSync(Buffer.from(raw, 'base64'), { maxOutputLength: 1048576 }).toString('utf8'));
            if (!Array.isArray(decoded)) throw new Error();
            const inputs: Row = {};
            for (const entry of decoded) {
                const row = record(entry);
                if (row && typeof row.name === 'string') Object.defineProperty(inputs, row.name, { value: row.value, enumerable: true, configurable: true });
            }
            if (!TABLE_NAME.test(string(inputs.table))) throw new Error();
            return inputs;
        } catch { throw new ReadFailure({ code: 'malformed_response', message: 'Record trigger inputs are missing, inaccessible, corrupt, or exceed 1 MiB.', sourceTable: 'sys_hub_trigger_instance_v2' }); }
    }

    private async _designerPage(table: string, hierarchy: string[], options: TableBehaviorOptions, offset: number, limit: number): Promise<{ items: BehaviorItem[]; offsets: number[]; nextOffset: number; more: boolean }> {
        const source = SOURCES.flows[1];
        const fields = await this._fields(source.table);
        this._require(source.table, fields, ['trigger_type', 'trigger_inputs', 'flow']);
        let query = 'trigger_typeINrecord_create,record_update,record_create_or_update';
        if (options.name) {
            this._require('sys_hub_flow', await this._fields('sys_hub_flow'), ['name']);
            query += `^flow.nameLIKE${options.name}`;
        }
        if (options.sysIds?.length) query += `^sys_idIN${options.sysIds.join(',')}`;
        const rows = await this._read(source.table, query + '^ORDERBYsys_id', this._columns(source, fields), 201, offset);
        const items: BehaviorItem[] = [];
        const offsets: number[] = [];
        let scanned = 0;
        for (const row of rows.slice(0, 200)) {
            const item = this._item('flows', source, row, fields, table);
            const inputs = record(item.configuration.triggerInputs) ?? {};
            const applicable = item.table === table || (options.includeInherited !== false && hierarchy.slice(1).includes(item.table ?? '') && bool(inputs.run_on_extended) === true);
            if (applicable) {
                if (items.length === limit) {
                    await this._attachFlows(items, true);
                    return { items, offsets, nextOffset: offset + scanned, more: true };
                }
                items.push(item); offsets.push(offset + scanned);
            }
            scanned++;
        }
        await this._attachFlows(items, true);
        return { items, offsets, nextOffset: offset + scanned, more: rows.length > 200 };
    }

    private async _attachFlows(items: BehaviorItem[], includeInactive: boolean): Promise<void> {
        if (!items.length) return;
        try {
            const design = items[0].reference.sourceTable === 'sys_hub_trigger_instance_v2';
            const fields = await this._fields('sys_hub_flow');
            this._require('sys_hub_flow', fields, ['remote_trigger_id', 'type', 'active']);
            if (design && items.some(item => !SYS_ID.test(string(item.configuration.flow)))) throw this._unsupported('sys_hub_trigger_instance_v2', 'Missing flow reference; no unfiltered query was issued.');
            const flows = await this._read('sys_hub_flow', `${design ? 'sys_id' : 'remote_trigger_id'}IN${items.map(item => design ? string(item.configuration.flow) : item.reference.sysId).filter(id => SYS_ID.test(id)).join(',')}^type=flow${includeInactive ? '' : '^active=true'}`, this._columns(FLOW_SOURCE, fields), 2001);
            if (flows.length > 2000) throw new ReadFailure({ code: 'truncated', message: 'Flow links exceed 2000. Retrieve fewer trigger references.', sourceTable: 'sys_hub_flow' });
            for (const item of items) {
                const matches = flows.filter(row => design ? string(row.sys_id) === string(item.configuration.flow) : string(row.remote_trigger_id) === item.reference.sysId);
                item.related = [...(item.related ?? []), ...matches.map(row => ({ sourceTable: 'sys_hub_flow', sysId: string(row.sys_id), configuration: row }))];
                if (matches.length) item.name = matches.map(row => string(row.name)).filter(Boolean).join(', ') || item.name;
                else item.warnings.push({ code: 'unresolved', message: 'No visible matching flow. Trigger may be orphaned, inactive, or its flow may be inaccessible.' });
                item.configuration.triggerSource = design ? 'design_time' : 'runtime';
            }
            if (!design && flows.length) {
                const triggerFields = await this._fields('sys_hub_trigger_instance_v2');
                this._require('sys_hub_trigger_instance_v2', triggerFields, ['flow', 'trigger_inputs', 'trigger_type']);
                const triggers = await this._read('sys_hub_trigger_instance_v2', `flowIN${flows.map(row => string(row.sys_id)).join(',')}^trigger_typeINrecord_create,record_update,record_create_or_update`, ['sys_id', 'flow', 'trigger_type', 'trigger_inputs', 'published_version'], 2001);
                if (triggers.length > 2000) throw this._unsupported('sys_hub_trigger_instance_v2', 'More than 2000 design triggers; narrow the request.');
                for (const item of items) {
                    const flowIds = new Set((item.related ?? []).filter(row => row.sourceTable === 'sys_hub_flow').map(row => row.sysId));
                    for (const trigger of triggers.filter(row => flowIds.has(string(row.flow)))) {
                        item.related?.push({ sourceTable: 'sys_hub_trigger_instance_v2', sysId: string(trigger.sys_id), configuration: { flow: trigger.flow, trigger_type: trigger.trigger_type, published_version: trigger.published_version, triggerSource: 'design_time', triggerInputs: this._triggerInputs(trigger.trigger_inputs) } });
                    }
                }
            }
        } catch (error) {
            const warning = this._warning(error, 'sys_hub_flow');
            for (const item of items) item.warnings.push(warning);
        }
    }

    private async _enrich(item: BehaviorItem, expand = true): Promise<void> {
        if (this._details.includes('definitions') || this._details.includes('dependencies')) {
            try {
                const refs: BehaviorReference[] = ['sys_flow_record_trigger', 'sys_hub_trigger_instance_v2'].includes(item.reference.sourceTable)
                    ? (item.related ?? []).filter(row => row.sourceTable === 'sys_hub_flow').map(row => ({ kind: 'flows', sourceTable: row.sourceTable, sysId: row.sysId }))
                    : [item.reference];
                const definitions: Row = {};
                for (const ref of refs) {
                    let definition: Row | undefined;
                    if (ref.kind === 'flows' || ref.kind === 'subflow') {
                        const result = ref.kind === 'subflow'
                            ? await this._flow.getSubflowDefinition(ref.sysId, { scope: this._options.scope })
                            : await this._flow.getFlowDesignDefinition(ref.sysId, { scope: this._options.scope });
                        if (!result.success) throw new ReadFailure({ code: result.failureReason === 'permission_denied' ? 'permission_denied' : 'request_failed', message: result.errorMessage || 'Flow definition unavailable.', reference: ref });
                        definition = result.definition;
                    } else if (ref.kind === 'action') {
                        const result = await this._flow.getActionDefinition(ref.sysId, { scope: this._options.scope });
                        if (!result.success) throw new ReadFailure({ code: result.failureReason === 'permission_denied' ? 'permission_denied' : 'request_failed', message: result.errorMessage || 'Action definition unavailable.', reference: ref });
                        definition = { metadata: result.metadata, steps: result.steps };
                    } else if (ref.kind === 'decision_table') {
                        const inputs = await this._children('sys_decision_input', 'model', [ref.sysId], split('name,column,label,type,mandatory,reference,element,question_text'));
                        const questions = await this._children('sys_decision_question', 'decision_table', [ref.sysId], split('condition,answer,order'));
                        definition = { inputs, questions };
                    }
                    if (definition) {
                        definitions[ref.sysId] = definition;
                        if (this._details.includes('dependencies')) item.dependencies = [...(item.dependencies ?? []), ...this._definitionDependencies(definition)];
                    }
                }
                if (Object.keys(definitions).length && this._details.includes('definitions')) {
                    item.definition = definitions;
                    item.definitionSource = 'design_time';
                }
            } catch (error) { item.warnings.push(this._warning(error, item.reference.sourceTable)); }
        }
        if (this._details.includes('dependencies')) {
            const relatedScripts = (item.related ?? []).flatMap(row => Object.values(row.scripts ?? {}));
            item.dependencies = [...(item.dependencies ?? []), ...this._scriptDependencies(relatedScripts)];
            item.dependencies = [...new Map(item.dependencies.map(dep => [dep.reference ? key(dep.reference) : dep.name ?? dep.evidence, dep])).values()];
            if (expand && this._dependencyDepth) await this._expand(item);
        }
        if (!this._details.includes('scripts')) for (const row of item.related ?? []) delete row.scripts;
    }

    private _scriptDependencies(scripts: string[]): BehaviorDependency[] {
        const dependencies: BehaviorDependency[] = [];
        for (const script of scripts) {
            for (const match of script.matchAll(/\bnew\s+((?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*)\s*\(/g)) {
                const name = match[1];
                if (!['GlideRecord', 'GlideAggregate', 'GlideDateTime', 'GlideDate', 'GlideAjax', 'Date', 'Array', 'Object', 'Error', 'RegExp'].includes(name)) dependencies.push({ name, evidence: match[0], resolution: 'inferred' });
            }
            for (const match of script.matchAll(/\bnew\s+GlideAjax\s*\(\s*['"]([\w.$]+)['"]/g)) dependencies.push({ name: match[1], evidence: match[0], resolution: 'inferred' });
        }
        if (scripts.some(Boolean)) dependencies.push({ evidence: 'Static literal references only; dynamic calls and indirect dependencies are not exhaustively resolved.', resolution: 'unresolved' });
        return dependencies;
    }

    private _definitionDependencies(definition: Row): BehaviorDependency[] {
        const dependencies: BehaviorDependency[] = [];
        const mapping: Record<string, BehaviorKind> = { subflow: 'subflow', subflowid: 'subflow', subflow_id: 'subflow', actiontypeid: 'action', action_type: 'action', actiontype: 'action', decisiontable: 'decision_table', decision_table: 'decision_table', decisiontableid: 'decision_table' };
        const visit = (value: unknown, path: string, depth: number): void => {
            if (depth > 40) return;
            if (Array.isArray(value)) { value.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1)); return; }
            const row = record(value);
            if (!row) return;
            for (const [field, child] of Object.entries(row)) {
                const kind = mapping[field.toLowerCase()];
                const nested = record(child);
                const snapshotId = string(nested?.id);
                const parent = kind === 'action' ? string(nested?.parent_action) : kind === 'subflow' ? string(nested?.parentFlow) : '';
                const id = parent || string(child) || snapshotId;
                if (kind && SYS_ID.test(id)) {
                    dependencies.push({ reference: { kind, sourceTable: EXTRA[kind].table, sysId: id }, evidence: `${path}.${field}`, resolution: 'explicit', ...(parent && parent !== snapshotId ? { snapshotSysId: snapshotId } : {}) });
                    continue;
                }
                visit(child, `${path}.${field}`, depth + 1);
            }
        };
        visit(definition, 'definition', 0);
        return dependencies;
    }

    private async _expand(item: BehaviorItem): Promise<void> {
        for (const dependency of item.dependencies ?? []) {
            const attempt = dependency.reference ? key(dependency.reference) : dependency.name;
            if (!attempt || this._dependencyAttempts.has(attempt)) continue;
            if (this._dependencyAttempts.size >= 50) { item.warnings.push({ code: 'truncated', message: 'Dependency expansion limited to 50 unique artifacts. Retrieve remaining references directly.' }); break; }
            this._dependencyAttempts.add(attempt);
            try {
                if (!dependency.reference && dependency.name && /^[\w.$]+$/.test(dependency.name)) {
                    const fields = await this._fields('sys_script_include');
                    const nameField = dependency.name.includes('.') ? 'api_name' : 'name';
                    this._require('sys_script_include', fields, [nameField]);
                    const matches = await this._read('sys_script_include', `${nameField}=${dependency.name}`, ['sys_id'], 2);
                    if (matches.length === 1) dependency.reference = { kind: 'script_include', sourceTable: 'sys_script_include', sysId: string(matches[0].sys_id) };
                    else { dependency.resolution = 'unresolved'; continue; }
                }
                const ref = dependency.reference;
                if (!ref || key(ref) === key(item.reference) || this._expanded.has(key(ref))) continue;
                const detail = await this._detail(ref, false);
                this._expanded.set(key(ref), detail);
            } catch (error) { item.warnings.push(this._warning(error, dependency.reference?.sourceTable)); }
        }
    }
}
