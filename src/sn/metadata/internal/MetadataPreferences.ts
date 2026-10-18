import type { MetadataRow } from './MetadataReader';
import { MetadataScopeError } from '../MetadataScopeError';

export function preferenceValue(rows: MetadataRow[], name: string): string | undefined {
    const values = [...new Set(rows.filter(row => row.name === name).map(row => row.value))];
    if (values.length > 1) throw new MetadataScopeError('evidence_unavailable');
    return values[0];
}
function multiset(rows: MetadataRow[]): string[] {
    return rows.map(row => JSON.stringify([row.name, row.value])).sort();
}
export function comparePreferences(before: MetadataRow[], after: MetadataRow[], expectedSet?: string | string[]) {
    const oldSet = preferenceValue(before, 'sys_update_set');
    const newSet = preferenceValue(after, 'sys_update_set');
    const switched = oldSet !== newSet;
    const unchanged = JSON.stringify(multiset(before)) === JSON.stringify(multiset(after));
    const destinations = Array.isArray(expectedSet) ? expectedSet : [expectedSet];
    const allowed = switched && !!newSet && destinations.includes(newSet) &&
        before.filter(row => row.name === 'sys_update_set').length === 1 &&
        after.filter(row => row.name === 'sys_update_set').length === 1;
    const remaining = (rows: MetadataRow[]) => allowed ? rows.filter(row => row.name !== 'sys_update_set') : rows;
    const valid = JSON.stringify(multiset(remaining(before))) === JSON.stringify(multiset(remaining(after)));
    const oldIds = new Set(before.map(row => JSON.stringify([row.sys_id, row.name, row.value])));
    const replaced = [...new Set(after.filter(row => !oldIds.has(JSON.stringify([row.sys_id, row.name, row.value])) &&
        before.some(old => old.name === row.name && old.value === row.value)).map(row => row.name))].sort();
    return { valid, unchanged, replaced, currentUpdateSet: { before: oldSet, after: newSet, switched } };
}
