/** A refusal before the form POST. Messages contain codes, never caller values. */
export class MetadataScopeError extends Error {
    public constructor(public readonly code: 'scope_required' | 'scope_unknown' | 'scope_ambiguous' |
        'scope_mismatch' | 'scope_not_applied' | 'store_scope' | 'table_not_supported' |
        'field_not_supported' | 'delete_not_supported' | 'not_permitted' | 'csrf_token_unavailable' |
        'invalid_input' | 'evidence_unavailable') {
        super(`Metadata write refused: ${code}`);
        this.name = 'MetadataScopeError';
    }
}
