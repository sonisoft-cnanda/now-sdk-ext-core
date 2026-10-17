import type { CaptureReport } from './MetadataModels';
/** A submit was attempted. Read the evidence before deciding how to clean up. Never replay automatically. */
export class MetadataVerificationError extends Error {
    public constructor(public readonly code: 'scope_not_applied' | 'not_captured' | 'captured_elsewhere' |
        'mixed_scope_capture' | 'session_changed' | 'delete_not_applied' | 'delete_not_captured' |
        'write_not_applied' | 'verification_unavailable' | 'csrf_rejected',
        public readonly table: string, public readonly sysId: string,
        public readonly capture?: Partial<CaptureReport>, public readonly messages: string[] = [], public readonly writeAttempted = true) {
        super(`Metadata submit verification failed: ${code}`);
        this.name = 'MetadataVerificationError';
    }
}
