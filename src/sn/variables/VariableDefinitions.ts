import { TableAPIRequest } from "../../comm/http/TableAPIRequest";
import { IHttpResponse } from "../../comm/http/IHttpResponse";
import { InvalidParameterException } from "../../exception/InvalidParameterException";
import { ServiceNowInstance } from "../ServiceNowInstance";
import { ListVariableDefinitionsOptions, VariableChoice, VariableDefinition } from "./VariableModels";

type Row = Record<string, unknown>;

const MODEL = /^var__m_[a-z0-9_]+$/i;
const DEFINITION_FIELDS = [
    "sys_id", "name", "element", "column_label", "internal_type", "default_value", "reference",
    "mandatory", "order", "hint", "choice", "active",
].join(",");

/**
 * Reads variable definitions (`var_dictionary`) for a variable model, e.g. the variables
 * a workflow activity type exposes (`var__m_<activity definition sys_id>`).
 *
 * Layout-only elements (names starting with `.`, such as `.begin_split`) are skipped:
 * they never hold a value. Results are cached per model and language for the lifetime
 * of the instance object.
 */
export class VariableDefinitions {
    private _tableAPI: TableAPIRequest;
    private _cache = new Map<string, Promise<VariableDefinition[]>>();

    public constructor(instance: ServiceNowInstance) {
        this._tableAPI = new TableAPIRequest(instance);
    }

    /**
     * List the variables in a model, in display order.
     *
     * @param model Variable model table name, e.g. `var__m_3961a1da0a0a0b5c00ecd84822f70d85`
     */
    public async list(model: string, options: ListVariableDefinitionsOptions = {}): Promise<VariableDefinition[]> {
        if (!MODEL.test(model ?? "")) {
            throw new InvalidParameterException(`Invalid variable model name '${model}'`);
        }
        const language = options.language ?? "en";
        const key = `${model}|${language}|${options.includeInactive ? 1 : 0}`;
        if (!this._cache.has(key)) {
            const pending = this.load(model, language, !!options.includeInactive);
            this._cache.set(key, pending);
            pending.catch(() => this._cache.delete(key));
        }
        return this._cache.get(key);
    }

    private async load(model: string, language: string, includeInactive: boolean): Promise<VariableDefinition[]> {
        const active = includeInactive ? "" : "^active=true";
        const rows = await this.read("var_dictionary", `name=${model}${active}^ORDERBYorder`, DEFINITION_FIELDS);
        const definitions = rows
            .filter(row => !str(row.element).startsWith("."))
            .map(row => toDefinition(row, model));

        if (definitions.some(d => d.choices)) {
            const choices = await this.read(
                "sys_choice", `name=${model}^language=${language}^inactive=false^ORDERBYsequence`, "element,value,label,sequence");
            for (const definition of definitions) {
                if (!definition.choices) continue;
                definition.choices = choices
                    .filter(c => str(c.element) === definition.element)
                    .map((c): VariableChoice => ({ value: str(c.value) === "NULL_OVERRIDE" ? "" : str(c.value), label: str(c.label) }));
                // Reference variables can carry a choice flag with no choice rows.
                if (!definition.choices.length) delete definition.choices;
            }
        }
        return definitions;
    }

    private async read(table: string, query: string, fields: string): Promise<Row[]> {
        const response: IHttpResponse<{ result: Row[] }> = await this._tableAPI.get<{ result: Row[] }>(table, {
            sysparm_query: query, sysparm_fields: fields, sysparm_limit: "1000", sysparm_exclude_reference_link: "true",
        });
        if (response?.status !== 200 || !Array.isArray(response.bodyObject?.result)) {
            throw new Error(`Failed to read ${table}. Status: ${response?.status ?? "unknown"}`);
        }
        return response.bodyObject.result;
    }
}

function toDefinition(row: Row, model: string): VariableDefinition {
    const definition: VariableDefinition = {
        sysId: str(row.sys_id),
        model,
        element: str(row.element),
        label: str(row.column_label),
        internalType: str(row.internal_type),
        defaultValue: str(row.default_value),
        mandatory: str(row.mandatory) === "true",
        order: Number(str(row.order)) || 0,
    };
    if (str(row.reference)) definition.reference = str(row.reference);
    if (str(row.hint)) definition.hint = str(row.hint);
    if (str(row.choice) !== "" && str(row.choice) !== "0") definition.choices = [];
    return definition;
}

function str(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value && typeof value === "object" && "value" in value) return str((value as Row).value);
    return "";
}
