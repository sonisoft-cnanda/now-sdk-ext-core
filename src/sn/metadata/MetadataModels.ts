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
/** A table's list columns for one view (not a related list, not a user's personalized list). */
export interface ListLayout {
    table: string;
    /** View name; '' is the Default view. */
    view: string;
    /** False when the table has no list of its own for the view (it shows its parent's); a save creates one. */
    exists: boolean;
    /** sys_id of the list, when it exists. A save replaces it, so it changes on every save. */
    sysId?: string;
    /** sys_scope of the list, when it exists. */
    scope?: string;
    /** sys_update_name of the list, when it exists. */
    updateName?: string;
    /** Column names in order; dot-walked columns as `field.field`. */
    columns: string[];
}
export interface ListLayoutWriteOptions {
    /** The complete new column list, in order. Each column must be offered by the List Layout page. */
    columns: string[];
    /** View name; '' or omitted is the Default view. */
    view?: string;
    /** Must be the list's own application; for a table with no list yet, the application the new list will belong to. */
    scope: MetadataScopeRef;
    /** In progress set of that application, already the user's set for it (WorkingSetManager.useUpdateSet). */
    updateSet: string;
    /** Required when the list belongs to an installed Store application. */
    storeCustomization?: StoreCustomizationOptions;
}
export interface ListLayoutWriteResult {
    table: string;
    view: string;
    scope: { sysId: string; scope: string };
    /** sys_id of the list after the save (a new record on every save). */
    sysId: string;
    /** sys_id of the list the save replaced; absent when the list was created. */
    previousSysId?: string;
    /** True when the table had no list of its own and the save created one. */
    created: boolean;
    /** The columns read back after the save. */
    columns: string[];
    /** The columns before the save, to restore them; empty when the list was created. */
    previousColumns: string[];
    capture: CaptureReport;
}
export interface ColumnWriteOptions {
    /**
     * The column name, lower case. The platform's prefix is added when it is missing: `u_` in Global, `<scope>_` when the
     * application adds the column to another application's table, none on the application's own table.
     */
    column: string;
    /** The column label (the Field Label record, in the session's language). */
    label: string;
    /** The column type: a sys_glide_object name such as string, integer, boolean, glide_date_time or reference. */
    type: string;
    /** Maximum length, for string types. The platform's default for the type applies when omitted. */
    maxLength?: number;
    /** The referenced table: required for type reference, optional for glide_list, refused otherwise. */
    reference?: string;
    /** The application the column belongs to. */
    scope: MetadataScopeRef;
    /** In progress set of that application, already the user's set for it (WorkingSetManager.useUpdateSet). */
    updateSet: string;
    /** Required when the application is an installed Store application. */
    storeCustomization?: StoreCustomizationOptions;
}
export interface ColumnWriteResult {
    table: string;
    /** The column's name as the platform saved it, prefix included. */
    column: string;
    /** sys_id of the sys_dictionary record. */
    sysId: string;
    label: string;
    type: string;
    scope: { sysId: string; scope: string };
    /** Form sections the platform appended the field to (the Default view's main section); empty when it placed it nowhere. */
    formSections: string[];
    /** Update names of every capture the save made, each verified in the set: Dictionary, Field Label(s), Form Layout(s). */
    captures: string[];
    /** The Dictionary capture. */
    capture: CaptureReport;
    messages: string[];
}
/** One sys_choice row of a column's choice list. */
export interface Choice {
    sysId: string;
    value: string;
    label: string;
    /** Order in the list; undefined when the row has none. */
    sequence?: number;
    inactive: boolean;
    hint: string;
    /** Set when the list depends on another field's value. */
    dependentValue: string;
    language: string;
}
/** The column a choice list belongs to, as its dictionary row says. */
export interface ChoiceColumn {
    /** The table that defines the column: the table itself, or a table it extends. */
    table: string;
    type: string;
    /**
     * sys_dictionary.choice: '1' dropdown with -- None --, '3' dropdown without, '2' suggestion, '0' or '' none. With none,
     * the form shows the column as a plain field and does not offer the choices.
     */
    choice: string;
    scope: string;
}
/** A choice list's application file (sys_choice_set): it carries the list's application and its capture name. */
export interface ChoiceSetRef {
    sysId: string;
    scope: string;
    /** sys_update_name: `sys_choice_<table>_<element>`, the one capture that holds every choice of the list. */
    updateName: string;
}
export interface ChoiceListOptions {
    /** sys_choice.language; 'en' when omitted. */
    language?: string;
}
export interface ChoiceList {
    table: string;
    element: string;
    language: string;
    column: ChoiceColumn;
    /** Absent when the table has no list of its own for the column. */
    choiceSet?: ChoiceSetRef;
    /** In list order: sequence, then value. */
    choices: Choice[];
}
export interface ChoiceWriteOptions extends ChoiceListOptions {
    /** The stored value; it identifies the choice within the list and language. */
    value: string;
    /** Required to add a choice; changes the label of an existing one. */
    label?: string;
    sequence?: number;
    inactive?: boolean;
    hint?: string;
    /** The choice list's application (its sys_choice_set's application, or the column's for a new list). */
    scope: MetadataScopeRef;
    /** In progress set of that application. The capture follows it; it need not be the user's current set. */
    updateSet: string;
    /** Required when the application is an installed Store application. */
    storeCustomization?: StoreCustomizationOptions;
}
export interface ChoiceRemoveOptions extends ChoiceListOptions {
    value: string;
    scope: MetadataScopeRef;
    updateSet: string;
    storeCustomization?: StoreCustomizationOptions;
    /**
     * Remove the choice even though records still hold its value. They keep the value, which the form then shows as
     * it is stored, without a label. Inactivating the choice instead keeps the label and hides it from new selections.
     */
    confirmInUse?: boolean;
}
export interface ChoiceWriteResult {
    table: string;
    element: string;
    language: string;
    value: string;
    action: 'insert' | 'update' | 'delete';
    /** sys_id of the sys_choice row. */
    sysId: string;
    /** The row as read back after the save; absent after a delete. */
    choice?: Choice;
    /** The row before the save; absent for an insert. */
    previous?: Choice;
    /** The list in this language after the save. */
    choices: Choice[];
    column: ChoiceColumn;
    /** The list's application file after the save. Removing the last choice keeps it (seen); absent only if the platform removed it. */
    choiceSet?: ChoiceSetRef & { created: boolean };
    /** Records that hold the value (counted for a delete). */
    inUse?: number;
    scope: { sysId: string; scope: string };
    /** The Choice list capture, `sys_choice_<table>_<element>`. */
    capture: CaptureReport;
    messages: string[];
}
export interface ColumnRemoveOptions {
    /** Must name the table and the column exactly as given: a removal deletes the column's data wherever its capture is committed. */
    confirm: { table: string; column: string };
    /** Required when rows hold a value in the column (`ColumnRemoveResult.records`): the platform drops it with the column. */
    acknowledgeDataLoss?: boolean;
    /**
     * Required when the platform will also delete the onChange client scripts and UI policy actions that name the column
     * (its Field Deletion Cleanup rule). They must belong to the column's application; another application's are refused.
     */
    acknowledgeDependentDeletes?: boolean;
    /** The column's application. */
    scope: MetadataScopeRef;
    /** In progress set of that application. The DELETE captures follow it; it need not be the user's current set. */
    updateSet: string;
    /** Required when the application is an installed Store application. */
    storeCustomization?: StoreCustomizationOptions;
}
/** What the removal left behind: the platform keeps these, pointing at a column that no longer exists. */
export interface ColumnRemovalLeftovers {
    /** sys_choice rows of the column on the table, and the list's sys_choice_set. */
    choices: number;
    choiceSet?: string;
    /** Form elements (sys_ui_element) naming the column, with their sections. */
    formElements: Array<{ sysId: string; section: string }>;
    /** List elements (sys_ui_list_element) naming the column, with their lists. */
    listElements: Array<{ sysId: string; list: string }>;
}
export interface ColumnRemoveResult {
    table: string;
    column: string;
    /** sys_id of the deleted sys_dictionary record. */
    sysId: string;
    scope: { sysId: string; scope: string };
    /** Rows that held a value in the column when it was removed (the table and the tables extending it). */
    records: number;
    /**
     * True when the column's only capture was the given set's own: it was created in this set and the DELETE replaced it there.
     * Shipping that set still carries a DELETE; move the DELETE captures to a set that never ships instead.
     */
    createdInThisSet: boolean;
    /** Records the platform deleted with the column, by kind. */
    deleted: { labels: string[]; clientScripts: string[]; uiPolicyActions: string[] };
    /** Update names of every DELETE capture verified in the set. */
    captures: string[];
    leftovers: ColumnRemovalLeftovers;
    /** The Dictionary capture. */
    capture: CaptureReport;
    messages: string[];
}
