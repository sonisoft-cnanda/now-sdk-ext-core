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
/**
 * One form section's layout. Elements use the Form Layout page's values: a field name,
 * `.begin_split` / `.split` / `.end_split`, or `.formatter.<sys_ui_formatter sys_id>`.
 */
export interface FormLayout {
    section: string;
    table: string;
    /** View name; '' is the Default view. */
    view: string;
    caption: string;
    /** sys_scope of the section. */
    scope: string;
    elements: string[];
}
export interface FormLayoutWriteOptions {
    /** The complete new layout, in order. Fields must be offered by the page; annotations and charts are not supported. */
    elements: string[];
    /** Must be the section's own application. */
    scope: MetadataScopeRef;
    /** In progress set of the section's application, already the user's set for it (WorkingSetManager.useUpdateSet). */
    updateSet: string;
    /** Required when the section belongs to an installed Store application. */
    storeCustomization?: StoreCustomizationOptions;
}
export interface FormLayoutWriteResult {
    section: string;
    table: string;
    view: string;
    scope: { sysId: string; scope: string };
    /** The layout read back after the save. */
    elements: string[];
    /** The layout before the save, to restore it. */
    previousElements: string[];
    capture: CaptureReport;
}
