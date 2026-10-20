import { isPolicyRefusal } from '../../../policy/PolicyRefusal';
import type { CustomizationReport, MetadataScopeRef } from '../MetadataModels';
import { MetadataScopeError } from '../MetadataScopeError';
import type { MetadataReader } from './MetadataReader';

const ID = /^[a-f0-9]{32}$/i;
const NAME = /^[a-z0-9_]+$/i;

export interface ResolvedScope {
    sysId: string;
    scope: string;
    /** An installed Store application: writes need the caller's explicit opt-in. */
    store: boolean;
}

/** Resolve an explicit scope to exactly one application. There is no default scope. */
export async function resolveScope(reader: MetadataReader, ref: MetadataScopeRef): Promise<ResolvedScope> {
    if (!ref) throw new MetadataScopeError('scope_required');
    const id = ref === 'global' ? 'global' : typeof ref === 'object' && 'sysId' in ref ? ref.sysId : undefined;
    const name = typeof ref === 'object' && 'scope' in ref ? ref.scope : undefined;
    if (id ? id !== 'global' && !ID.test(id) : !name || !NAME.test(name) || name === 'global') {
        throw new MetadataScopeError('invalid_input');
    }
    const rows = await reader.rows('sys_scope', id ? `sys_id=${id}` : `scope=${name}^active=true`, 'sys_id,scope,active,sys_class_name');
    if (rows.some(row => id ? row.sys_id !== id : row.scope !== name)) throw new MetadataScopeError('evidence_unavailable');
    if (!rows.length) throw new MetadataScopeError('scope_unknown');
    if (rows.length !== 1) throw new MetadataScopeError('scope_ambiguous');
    const app = rows[0];
    if ((!id && app.active !== 'true') || !app.scope || (app.sys_id !== 'global' && !ID.test(app.sys_id))) throw new MetadataScopeError('evidence_unavailable');
    const store = app.sys_class_name === 'sys_store_app' || !!await reader.exact('sys_store_app', app.sys_id, 'scope');
    return { sysId: app.sys_id, scope: app.scope, store };
}

/** Upgrade evidence for a Store file. Best effort: a missing read never turns a verified write into a failure. */
export async function customizationEvidence(reader: MetadataReader, captureId: string | undefined, name: string | undefined): Promise<CustomizationReport> {
    const report: CustomizationReport = { storeApplication: true };
    const read = async <T>(collect: () => Promise<T>): Promise<T | undefined> => {
        try { return await collect(); } catch (error) {
            if (isPolicyRefusal(error)) throw error;
            return undefined;
        }
    };
    const capture = captureId ? await read(() => reader.exact('sys_update_xml', captureId, 'replace_on_upgrade')) : undefined;
    if (capture && ['true', 'false', '1', '0'].includes(capture.replace_on_upgrade)) report.replaceOnUpgrade = ['true', '1'].includes(capture.replace_on_upgrade);
    const versions = name ? await read(() => reader.rows('sys_update_version', `name=${name}^source_table=sys_store_app`, 'sys_id,name')) : undefined;
    if (versions) report.baselineVersion = versions.some(row => row.name === name);
    return report;
}
