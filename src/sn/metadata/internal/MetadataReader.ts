import type { ServiceNowRequest } from '../../../comm/http/ServiceNowRequest';
import { READ_ONLY } from '../../../policy/PolicyTypes';
import { MetadataScopeError } from '../MetadataScopeError';

export type MetadataRow = Record<string, string>;
/** Read-only, bounded pagination on the same authenticated request as the forms. */
export class MetadataReader {
    public constructor(private _request: ServiceNowRequest) {}
    /**
     * Every row of the query, or evidence_unavailable. Each of `fields` must be present as a string, except those named
     * in `optional`: dot-walked values the session may not read, which the instance sometimes omits (seen for the hidden
     * roles nobody and maint) instead of returning ''. They read as ''.
     */
    public async rows(table: string, query: string, fields: string, optional: readonly string[] = []): Promise<MetadataRow[]> {
        // Only a dot-walked field the query asks for may be optional: a direct field stays required.
        if (optional.some(field => !field.includes('.') || !fields.split(',').includes(field))) throw new MetadataScopeError('evidence_unavailable');
        const result: MetadataRow[] = [];
        const ids = new Set<string>();
        let expectedCount: number | undefined;
        for (let page = 0; page < 100; page++) {
            const response = await this._request.get<{ result?: unknown }>({ path: `/api/now/table/${table}`,
                headers: { Accept: 'application/json' }, body: null, requires: READ_ONLY, sensitive: true,
                query: { sysparm_query: `${query}^ORDERBYsys_id`, sysparm_fields: fields,
                    sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true', sysparm_no_count: 'false',
                    sysparm_limit: '200', sysparm_offset: String(page * 200),
                    // Paging is by offset and X-Total-Count. Without this, a long query (an IN list of sys_ids)
                    // whose result needs a second page is refused: 400 "Pagination not supported".
                    sysparm_suppress_pagination_header: 'true' } });
            const rows = response.bodyObject?.result;
            if (response.status !== 200 || !Array.isArray(rows) || rows.length > 200) throw new MetadataScopeError('evidence_unavailable');
            const countHeader = (response.headers as Record<string, string>)?.['x-total-count'];
            const count = Number(countHeader);
            if (countHeader === undefined || !Number.isSafeInteger(count) || count < 0 || count > 20000 ||
                (expectedCount !== undefined && expectedCount !== count)) throw new MetadataScopeError('evidence_unavailable');
            expectedCount = count;
            for (const value of rows as unknown[]) {
                if (!value || typeof value !== 'object') throw new MetadataScopeError('evidence_unavailable');
                const row: Record<string, unknown> = { ...value };
                for (const field of optional) if (row[field] === undefined) row[field] = '';
                if (typeof row.sys_id !== 'string' || !row.sys_id || ids.has(row.sys_id) ||
                    fields.split(',').some(field => typeof row[field] !== 'string')) throw new MetadataScopeError('evidence_unavailable');
                ids.add(row.sys_id); result.push(row as MetadataRow);
            }
            if (result.length > expectedCount) throw new MetadataScopeError('evidence_unavailable');
            if (rows.length < 200) {
                if (result.length !== expectedCount) throw new MetadataScopeError('evidence_unavailable');
                return result;
            }
        }
        throw new MetadataScopeError('evidence_unavailable');
    }
    public async exact(table: string, sysId: string, fields: string): Promise<MetadataRow | undefined> {
        const rows = await this.rows(table, `sys_id=${sysId}`, `sys_id,${fields}`);
        if (rows.some(row => row.sys_id !== sysId) || rows.length > 1) throw new MetadataScopeError('evidence_unavailable');
        return rows[0];
    }
}
