/**
 * Models for {@link UpdateSetExporter}: exporting an update set to the platform's XML unload.
 */

export interface UpdateSetExportOptions {
    /**
     * Export a set (or batch) that is not Complete. The platform's Export to XML is offered only for a
     * Complete set; an In progress export is a snapshot of unfinished work. For a batch it also includes
     * children that are not Complete, as `UpdateSetExport.onlyIncludeCompletedChildren = false` does.
     */
    includeIncomplete?: boolean;
}

/** One update set in the file. For a local export, `sysId` is the source set, not the temporary copy. */
export interface ExportedUpdateSet {
    sysId: string;
    name: string;
    state: string;
    /** sys_update_xml rows in the set, and in the file. */
    records: number;
}

export interface UpdateSetExportResult {
    /** The unload XML. It holds every record's full payload. */
    xml: string;
    /** `local`: a sys_update_set; `retrieved`: a sys_remote_update_set (Retrieved Update Sets). */
    source: 'local' | 'retrieved';
    /** `batch`: a batch base exported with its children. */
    kind: 'single' | 'batch';
    /** The set that was asked for. */
    updateSet: { sysId: string; name: string; state: string; application: string };
    /** Every set in the file, the requested one first. */
    sets: ExportedUpdateSet[];
    /** Batch children the platform leaves out (not Complete, without includeIncomplete), and their descendants. */
    excluded: Array<{ sysId: string; name: string; state: string }>;
    recordCount: number;
    /**
     * A local export makes a temporary Retrieved Update Set copy, which the download deletes. `removedBy` is
     * `platform` when the download removed it and `nex` when the exporter had to; both are read back.
     */
    cleanup?: { temporarySysId: string; removedBy: 'platform' | 'nex' };
    messages: string[];
}

export type UpdateSetExportErrorCode =
    | 'invalid_input'
    | 'update_set_not_found'
    | 'update_set_incomplete'
    | 'batch_member'
    | 'retrieved_state'
    | 'evidence_unavailable'
    | 'script_result_unavailable'
    | 'export_failed'
    | 'export_mismatch'
    | 'cleanup_unverified';

/** Identifiers and counts that explain a refusal; never names, descriptions or payloads. */
export interface UpdateSetExportErrorDetail {
    updateSet?: string;
    /** The batch base to export instead of a batch member. */
    base?: string;
    state?: string;
    status?: number;
    expected?: number;
    actual?: number;
    /** Temporary Retrieved Update Set copies left on the instance: delete them (sys_remote_update_set). */
    temporary?: string[];
}

export class UpdateSetExportError extends Error {
    public constructor(public readonly code: UpdateSetExportErrorCode, public readonly detail?: UpdateSetExportErrorDetail) {
        super(`Update set export failed: ${code}`);
        this.name = 'UpdateSetExportError';
    }
}
