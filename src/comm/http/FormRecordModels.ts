/**
 * Models for {@link FormRecordWriter}: writing a record through the classic UI form
 * (`/<table>.do`) the way a browser does.
 */

/**
 * A duration accepted for a `glide_duration` form field. Numbers are seconds.
 */
export interface FormDurationInput {
    days?: number;
    hours?: number;
    minutes?: number;
    seconds?: number;
}

/**
 * A value for a form field or a variable.
 *
 * - `boolean` is posted as `true`/`false`
 * - an array is posted comma-separated (glide_list)
 * - a `number` or {@link FormDurationInput} on a `glide_duration` field is posted as `D HH:MM:SS`
 * - `null` posts an empty value
 * - anything else is posted as its string form, exactly as given
 */
export type FormValueInput = string | number | boolean | null | string[] | FormDurationInput;

/**
 * One control on a loaded form.
 */
export interface FormControl {
    /** The posted parameter name, e.g. `wf_activity.name` or `wf_activity.vars.var__m_<id>.script` */
    name: string;

    /** The value the form would post if left untouched */
    value: string;

    /** Field type from the form label (e.g. `choice`, `boolean`, `glide_duration`, `reference`), when the form declares one */
    type?: string;

    /** Whether the form marks the field mandatory */
    mandatory?: boolean;

    /** Options offered by a choice field, in form order */
    choices?: Array<{ value: string; label: string }>;
}

/**
 * A variable (glide_var) element exposed by a loaded form.
 */
export interface FormVariableControl extends FormControl {
    /** The glide_var column on the record, e.g. `vars` or `inputs` */
    field: string;

    /** The variable model table name, e.g. `var__m_3961a1da0a0a0b5c00ecd84822f70d85` */
    model: string;

    /** The variable element name, e.g. `timer_type` */
    element: string;
}

/**
 * A parsed classic form: the tokens a submit must echo back plus every control.
 */
export interface FormSnapshot {
    /** Table the form belongs to */
    table: string;

    /** sys_id the form will insert as (pre-assigned for new records) or the record being edited */
    sysId: string;

    /** True when the form was loaded for a new record (`sys_id=-1`) */
    isNewRecord: boolean;

    /**
     * Opaque, signed form-load state. Carries values that are not form inputs, such as
     * fields set through `sysparm_query` at load time. Required for the submit to apply
     * variables.
     */
    encodedRecord: string;

    /** `sys_modCount` of the record when the form was loaded */
    modCount: string;

    /** `onLoad_sys_updated_on` of the record when the form was loaded */
    updatedOn: string;

    /** Form-action UI action sys_ids keyed by action name (e.g. `sysverb_insert`, `sysverb_update`) */
    actions: Record<string, string>;

    /** Ordinary field controls, keyed by posted name */
    fields: Record<string, FormControl>;

    /** Variable controls, keyed by element name */
    variables: Record<string, FormVariableControl>;
}

/**
 * Options for loading a form.
 */
export interface FormLoadOptions {
    /** Form view (`sysparm_view`). Defaults to the table's default view. */
    view?: string;

    /**
     * Encoded query applied to a new record at load time (`sysparm_query`), e.g.
     * `workflow_version=<id>^activity_definition=<id>`. Fields set this way travel in the
     * encoded record, so they apply even when they are not on the form.
     */
    initialQuery?: string;
}

/**
 * Options for inserting or updating a record through its form.
 */
export interface FormWriteOptions extends FormLoadOptions {
    /** Field values keyed by column name (e.g. `{ name: 'Wait 1 day' }`). Dot-walked names are not supported. */
    fields?: Record<string, FormValueInput>;

    /** Variable values keyed by element name. Unknown elements are rejected. */
    variables?: Record<string, FormValueInput>;

    /**
     * Which glide_var column the variables belong to, when the form exposes more than
     * one (e.g. ATF step `inputs` vs `outputs`). Defaults to the only one present.
     */
    variableField?: string;
}

/**
 * Result of a form write.
 */
export interface FormWriteResult {
    /** sys_id of the inserted or updated record */
    sysId: string;

    /** The form action that ran */
    action: 'sysverb_insert' | 'sysverb_update';

    /** Info messages the instance returned with the response */
    messages: string[];
}
