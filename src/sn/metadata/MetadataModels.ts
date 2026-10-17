import type { FormWriteOptions } from '../../comm/http/FormRecordModels';

/** Global must be requested explicitly. Named scopes resolve to one active application. */
export type MetadataScopeRef = { sysId: string } | { scope: string } | 'global';
export interface MetadataWriteOptions extends FormWriteOptions {
    scope: MetadataScopeRef;
    updateSet?: string;
    allowMixedScopeCapture?: boolean;
}
export interface MetadataDeleteOptions extends Omit<MetadataWriteOptions, 'fields' | 'variables' | 'initialQuery'> {
    confirm: { table: string; sysId: string };
}
export interface CaptureReport {
    updateSetSysId: string;
    updateSetName: string;
    updateSetScope: string;
    predictedUpdateSetSysId?: string;
    recordScope: string;
    action: string;
    preferencesUnchanged: boolean;
    preferenceRowsReplaced: string[];
    currentUpdateSet: { before?: string; after?: string; switched: boolean };
}
export interface MetadataWriteResult {
    table: string;
    sysId: string;
    action: 'insert' | 'update' | 'delete';
    scope: { sysId: string; scope: string };
    capture: CaptureReport;
    messages: string[];
}
