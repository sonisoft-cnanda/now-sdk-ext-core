const IDENTIFIER = /^[a-z0-9_]{1,80}$/i;
// A field may be dot-walked (caller_id.email); each part is an identifier.
const FIELD = /^[a-z0-9_]{1,80}(\.[a-z0-9_]{1,80}){0,5}$/i;
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
    /** Records that use a choice value. */
    records?: number;
}
function safeDetail(detail?: MetadataErrorDetail): MetadataErrorDetail | undefined {
    if (!detail) return undefined;
    const safe: MetadataErrorDetail = {};
    if (detail.field && FIELD.test(detail.field)) safe.field = detail.field;
    if (detail.table && IDENTIFIER.test(detail.table)) safe.table = detail.table;
    if (detail.updateSetState !== undefined) safe.updateSetState = STATES.has(detail.updateSetState) ? detail.updateSetState : 'unknown';
    if (detail.updateSetApplication && (detail.updateSetApplication === 'global' || /^[a-f0-9]{32}$/i.test(detail.updateSetApplication))) {
        safe.updateSetApplication = detail.updateSetApplication;
    }
    const path = detail.redirectPath?.split(/[?#]/)[0];
    if (path && /^\/[a-z0-9_./-]{1,120}$/i.test(path)) safe.redirectPath = path;
    if (detail.records !== undefined && Number.isSafeInteger(detail.records) && detail.records >= 0) safe.records = detail.records;
    return Object.keys(safe).length ? safe : undefined;
}

/** A refusal before the form POST. Messages contain codes, never caller values. */
export class MetadataScopeError extends Error {
    public readonly detail?: MetadataErrorDetail;
    public constructor(public readonly code: 'scope_required' | 'scope_unknown' | 'scope_ambiguous' |
        'scope_mismatch' | 'scope_not_applied' | 'store_scope' | 'table_not_supported' |
        'field_not_supported' | 'delete_not_supported' | 'not_permitted' | 'csrf_token_unavailable' |
        'invalid_input' | 'evidence_unavailable' | 'update_set_required' | 'protected_record' | 'form_redirected' |
        'update_set_not_current' | 'section_not_supported' | 'domain_not_supported' | 'column_exists' |
        'column_not_found' | 'choice_list_inherited' | 'choice_not_found' | 'choice_ambiguous' | 'choice_in_use' | 'choice_unchanged' |
        'confirmation_required' | 'column_not_deletable' | 'column_has_data' | 'column_has_dependents' | 'column_referenced',
        detail?: MetadataErrorDetail) {
        super(`Metadata write refused: ${code}`);
        this.name = 'MetadataScopeError';
        this.detail = safeDetail(detail);
    }
}
