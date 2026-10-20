import type { MetadataRow } from './MetadataReader';

const PART = /^[a-z0-9_]+$/i;

/**
 * Tables whose captures coalesce under a platform name rather than `<table>_<sys_id>`, with the
 * record fields that name is built from. Seen on Australia: every later change of the same label
 * or choice list replaces the one capture with that name.
 */
const COALESCING: Record<string, { fields: string[]; name: (row: MetadataRow) => string }> = {
    sys_documentation: { fields: ['name', 'element', 'language'],
        name: row => `sys_documentation_${row.name}_${row.element}_${row.language}` },
    sys_choice_set: { fields: ['name', 'element'], name: row => `sys_choice_${row.name}_${row.element}` },
};

/** Record fields to read so that {@link updateName} can name the capture; empty for `<table>_<sys_id>`. */
export function updateNameFields(table: string): string[] {
    return COALESCING[table]?.fields ?? [];
}

/**
 * The sys_update_xml name a change of this record is captured under, or undefined when the record
 * does not supply a usable name (the caller must then fail rather than guess).
 */
export function updateName(table: string, sysId: string, row?: MetadataRow): string | undefined {
    const rule = COALESCING[table];
    if (!rule) return `${table}_${sysId}`;
    if (!row || rule.fields.some(field => !PART.test(row[field] ?? ''))) return undefined;
    return rule.name(row);
}
