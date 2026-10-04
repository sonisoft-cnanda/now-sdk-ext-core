/**
 * Models for variable (glide_var) definitions — the `var_dictionary` rows that describe
 * the variables a record such as a workflow activity carries.
 */

/**
 * One choice offered by a choice variable.
 */
export interface VariableChoice {
    /** Stored value. The platform's NULL_OVERRIDE ("none") choice is reported as an empty string, which is what it stores. */
    value: string;

    /** Display label */
    label: string;
}

/**
 * Definition of one variable in a variable model.
 */
export interface VariableDefinition {
    /** sys_id of the var_dictionary row (what `sys_variable_value.variable` references) */
    sysId: string;

    /** Variable model table name, e.g. `var__m_<activity definition sys_id>` */
    model: string;

    /** Element name — the key used when reading or writing the variable */
    element: string;

    /** Label shown on the form */
    label: string;

    /** Internal type, e.g. `string`, `script`, `boolean`, `glide_duration`, `reference`, `glide_list`, `conditions` */
    internalType: string;

    /** Default value, verbatim (may be a `javascript:` expression evaluated by the form) */
    defaultValue: string;

    /** Referenced table, for reference and glide_list variables */
    reference?: string;

    /** Whether the variable is mandatory */
    mandatory: boolean;

    /** Display order */
    order: number;

    /** Help text */
    hint?: string;

    /** Choices, for choice variables */
    choices?: VariableChoice[];
}

/**
 * Options for listing variable definitions.
 */
export interface ListVariableDefinitionsOptions {
    /** Choice label language. Defaults to `en`. */
    language?: string;

    /** Include inactive variables. Defaults to false. */
    includeInactive?: boolean;
}
