import type { FormWriteOptions } from '../../comm/http/FormRecordModels';

/** Global must be requested explicitly. Named scopes resolve to one active application. */
export type MetadataScopeRef = { sysId: string } | { scope: string } | 'global';
/**
 * Opt-in for writing files of an installed Store application. The platform marks every file it
 * captures as customized (replace_on_upgrade=false), so later upgrades of that application skip it.
 */
export interface StoreCustomizationOptions {
    acknowledgeUpgradeSkip: true;
}
export interface MetadataWriteOptions extends FormWriteOptions {
    scope: MetadataScopeRef;
    updateSet?: string;
    allowMixedScopeCapture?: boolean;
    /** Required for an installed Store application, together with an explicit updateSet. */
    storeCustomization?: StoreCustomizationOptions;
}
export interface MetadataDeleteOptions extends Omit<MetadataWriteOptions, 'fields' | 'variables' | 'initialQuery'> {
    confirm: { table: string; sysId: string };
}
/** Upgrade evidence for a write to an installed Store application's file. */
export interface CustomizationReport {
    storeApplication: true;
    /** sys_update_xml.replace_on_upgrade of the capture; false means upgrades skip this file. */
    replaceOnUpgrade?: boolean;
    /** A sys_update_version taken from the Store application (the shipped baseline) exists. */
    baselineVersion?: boolean;
}
export interface CaptureReport {
    updateSetSysId: string;
    updateSetName: string;
    updateSetScope: string;
    predictedUpdateSetSysId?: string;
    recordScope: string;
    action: string;
    /** sys_update_xml.name of the capture: <table>_<sys_id>, or the platform's coalescing name. */
    updateName?: string;
    preferencesUnchanged: boolean;
    preferenceRowsReplaced: string[];
    currentUpdateSet: { before?: string; after?: string; switched: boolean };
    customization?: CustomizationReport;
}
export interface MetadataWriteResult {
    table: string;
    sysId: string;
    action: 'insert' | 'update' | 'delete';
    scope: { sysId: string; scope: string };
    capture: CaptureReport;
    messages: string[];
}
