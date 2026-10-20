/** The user's working set: apps.current_app and sys_update_set. `global` or a sys_scope sys_id. */
export interface WorkingSet {
    application: string;
    updateSet: string;
}
export interface UpdateSetSummary {
    sysId: string;
    name: string;
    state: string;
    /** sys_update_set.application: `global`, or the application's sys_scope sys_id. */
    application: string;
    isDefault: boolean;
}
export interface CreateScopedUpdateSetOptions {
    /**
     * `global`, the sys_scope sys_id of any application (including an installed Store application),
     * or a scope name that resolves to exactly one active application.
     */
    application: string;
    /** At most 80 characters. A second In progress set with the same name in the application is refused. */
    name: string;
    description?: string;
}
export interface UseUpdateSetOptions {
    /** Permit an application's Default set. Only for restoring a previous context: never develop in a Default. */
    allowDefault?: boolean;
}
export interface UseUpdateSetResult {
    /** Pass to restoreWorkingSet when the work is done. */
    previous: WorkingSet;
    current: WorkingSet;
    updateSet: UpdateSetSummary;
}
export interface RestoreWorkingSetResult {
    restored: WorkingSet;
    /** The previous set had closed; the application's Default was made current instead. */
    fallback?: 'application_default';
}
export interface MoveCaptureOptions {
    /** sys_update_xml sys_id. */
    capture: string;
    sourceSet: string;
    targetSet: string;
    /** Appended to the capture's comments. Letters, digits and simple punctuation only. */
    reason: string;
}
export interface MoveCaptureResult {
    capture: string;
    name: string;
    application: string;
    from: UpdateSetSummary;
    to: UpdateSetSummary;
}
export interface CompleteUpdateSetOptions {
    /** The number of captures the caller expects in the set. Completion is refused on any other count. */
    expectedCaptures: number;
}

export type WorkingSetErrorCode = 'invalid_input' | 'evidence_unavailable' | 'update_set_not_found' | 'update_set_exists' |
    'application_not_found' | 'create_not_applied' | 'application_not_applied' | 'update_set_closed' | 'default_update_set' |
    'working_set_not_applied' | 'no_single_default' | 'capture_not_in_source' | 'scope_mismatch' | 'duplicate_capture' |
    'newer_capture_exists' | 'move_not_applied' | 'capture_count_mismatch' | 'mixed_scope_capture' | 'update_set_in_use' |
    'complete_not_applied' | 'script_result_unavailable';

/** Identifiers and counts that explain a refusal; never names, descriptions or payloads. */
export interface WorkingSetErrorDetail {
    updateSet?: string;
    application?: string;
    capture?: string;
    captures?: string[];
    state?: string;
    expected?: number;
    actual?: number;
    status?: number;
    /** The working set before a change that did not read back: pass it to restoreWorkingSet. */
    previous?: WorkingSet;
}

/** An update-set lifecycle step was refused, or its outcome did not read back as required. */
export class WorkingSetError extends Error {
    public constructor(public readonly code: WorkingSetErrorCode, public readonly detail?: WorkingSetErrorDetail) {
        super(`Update set operation failed: ${code}`);
        this.name = 'WorkingSetError';
    }
}
