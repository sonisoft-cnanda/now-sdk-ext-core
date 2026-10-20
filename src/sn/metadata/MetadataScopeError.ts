const IDENTIFIER = /^[a-z0-9_]{1,80}$/i;
const STATES = new Set(['in progress', 'complete', 'ignore']);

/**
 * Schema identifiers that explain a refusal. Each value is checked: only table and field names,
 * sys_ids, update-set states and a redirect path without its query reach the error.
 */
export interface MetadataErrorDetail {
    field?: string;
    table?: string;
    updateSetState?: string;
    updateSetApplication?: string;
    redirectPath?: string;
}
function safeDetail(detail?: MetadataErrorDetail): MetadataErrorDetail | undefined {
    if (!detail) return undefined;
    const safe: MetadataErrorDetail = {};
    if (detail.field && IDENTIFIER.test(detail.field)) safe.field = detail.field;
    if (detail.table && IDENTIFIER.test(detail.table)) safe.table = detail.table;
    if (detail.updateSetState !== undefined) safe.updateSetState = STATES.has(detail.updateSetState) ? detail.updateSetState : 'unknown';
    if (detail.updateSetApplication && (detail.updateSetApplication === 'global' || /^[a-f0-9]{32}$/i.test(detail.updateSetApplication))) {
        safe.updateSetApplication = detail.updateSetApplication;
    }
    const path = detail.redirectPath?.split(/[?#]/)[0];
    if (path && /^\/[a-z0-9_./-]{1,120}$/i.test(path)) safe.redirectPath = path;
    return Object.keys(safe).length ? safe : undefined;
}

/** A refusal before the form POST. Messages contain codes, never caller values. */
export class MetadataScopeError extends Error {
    public readonly detail?: MetadataErrorDetail;
    public constructor(public readonly code: 'scope_required' | 'scope_unknown' | 'scope_ambiguous' |
        'scope_mismatch' | 'scope_not_applied' | 'store_scope' | 'table_not_supported' |
        'field_not_supported' | 'delete_not_supported' | 'not_permitted' | 'csrf_token_unavailable' |
        'invalid_input' | 'evidence_unavailable' | 'update_set_required' | 'protected_record' | 'form_redirected',
        detail?: MetadataErrorDetail) {
        super(`Metadata write refused: ${code}`);
        this.name = 'MetadataScopeError';
        this.detail = safeDetail(detail);
    }
}
