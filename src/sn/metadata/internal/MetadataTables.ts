import { MetadataScopeError } from '../MetadataScopeError';
import type { MetadataReader, MetadataRow } from './MetadataReader';

const ID = /^[a-f0-9]{32}$/i;
const NAME = /^[a-z0-9_]+$/i;
/**
 * Tables whose schema the platform's own metadata, capture and application model depend on. A column added to one of
 * them (or to a table extending one), or a choice list changed on one, changes every record the platform keeps there.
 */
export const SCHEMA_TABLES = new Set(['sys_metadata', 'sys_dictionary', 'sys_db_object', 'sys_documentation', 'sys_choice', 'sys_glide_object',
    'sys_update_set', 'sys_update_xml', 'sys_update_version', 'sys_metadata_delete', 'sys_scope', 'sys_app', 'sys_store_app',
    'sys_user_preference']);

/** The table and every table it extends, the table first. Refuses the platform's own schema tables. */
export async function ancestry(reader: MetadataReader, table: string): Promise<MetadataRow[]> {
    const fields = 'sys_id,name,super_class,sys_scope';
    let rows = await reader.rows('sys_db_object', `name=${table}`, fields);
    if (rows.length !== 1 || rows[0].name !== table) throw new MetadataScopeError('table_not_supported', { table });
    const chain: MetadataRow[] = [];
    while (rows.length === 1) {
        const row = rows[0];
        if (chain.some(seen => seen.sys_id === row.sys_id) || chain.length > 30) throw new MetadataScopeError('evidence_unavailable');
        if (SCHEMA_TABLES.has(row.name) || !NAME.test(row.name)) throw new MetadataScopeError('table_not_supported', { table: row.name });
        chain.push(row);
        if (!ID.test(row.super_class)) return chain;
        const parent = await reader.exact('sys_db_object', row.super_class, 'name,super_class,sys_scope');
        if (!parent) throw new MetadataScopeError('evidence_unavailable');
        rows = [parent];
    }
    throw new MetadataScopeError('evidence_unavailable');
}
