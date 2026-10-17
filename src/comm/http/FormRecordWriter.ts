import type { FormTransportLoadOptions, FormTransportSubmitOptions, FormTransportSnapshot, FormTransportResult } from "./internal/FormTransportModels";
import { isPolicyRefusal } from "../../policy/PolicyRefusal";
import { InvalidParameterException } from "../../exception/InvalidParameterException";
import { FormSubmitError } from "../../exception/FormSubmitError";
import { READ_ONLY } from "../../policy/PolicyTypes";
import { ServiceNowInstance } from "../../sn/ServiceNowInstance";
import { Logger } from "../../util/Logger";
import { redactMessage, stripSecretsFromError } from "../../util/redact";
import { parseFormHtml, parseFormMessages, parseFormResponse } from "./FormHtmlParser";
import {
    FormControl,
    FormDurationInput,
    FormLoadOptions,
    FormSnapshot,
    FormValueInput,
    FormVariableControl,
    FormWriteOptions,
    FormWriteResult,
} from "./FormRecordModels";
import { ServiceNowRequest } from "./ServiceNowRequest";
import { SessionManager } from "./SessionManager";

const NAME = /^[a-z0-9_]+$/i;
const SYS_ID = /^[0-9a-f]{32}$/i;

/** Where a successful submit lands. Small, and it echoes back the action and sys_id. */
const GOTO_URL = "modal_dialog_form_response.do?sysparm_returned_action=$action&sysparm_returned_sysid=$sys_id";

/**
 * Writes a record through its classic UI form (`/<table>.do`), exactly as a browser does:
 * load the form, then submit it with the form's tokens.
 *
 * This is a low-level tool for writing directly to an instance when the record is NOT
 * authored in a now-sdk application. Its reason to exist is variable-backed records
 * (any table with a glide_var column, e.g. `wf_activity.vars`): the form submit is the
 * path that writes their `sys_variable_value` rows, where REST writes to that table run
 * into ACLs. Records that belong in a now-sdk app (ATF tests, flows, …) should be
 * authored there instead.
 *
 * Why two requests: a new record's form carries values that are not form inputs —
 * anything set through `sysparm_query` at load time, such as the record's variable
 * model — inside the signed `sysparm_encoded_record`. A submit without it inserts the
 * record but silently drops every variable.
 *
 * Only the values you pass are posted. The instance fills in everything else the same
 * way the form would: variable defaults on insert, current values on update.
 */
class FormTransport {
    private _logger: Logger = new Logger("FormRecordWriter");
    private _instance: ServiceNowInstance;

    public constructor(instance: ServiceNowInstance) {
        this._instance = instance;
    }

    /**
     * Load a record's form.
     *
     * @param table Table name
     * @param sysId Record sys_id, or `-1` for a new record
     * @param options View and, for new records, the initial query
     * @throws Error when the page is not the expected form, or the record does not exist
     */
    public async loadForm(table: string, sysId: string = "-1", options: FormTransportLoadOptions = {}): Promise<FormTransportSnapshot> {
        this.requireTable(table);
        if (sysId !== "-1" && !SYS_ID.test(sysId)) {
            throw new InvalidParameterException("sysId must be -1 or a 32-character sys_id");
        }

        const query: Record<string, string> = { ...options.query, sys_id: sysId };
        if (options.view) query.sysparm_view = options.view;
        if (options.initialQuery) query.sysparm_query = options.initialQuery;

        try {
            const response = await this.request().get<string>({
                method: "GET", path: `/${table}.do`, headers: null, body: null, query,
                requires: READ_ONLY, responseFormat: "text", sensitive: options.sensitive,
                ...(options.sensitive ? { redirect: "manual" as const } : {}),
            });
            const snapshot = parseFormHtml(this.text(response.data), table, options);
            if (sysId !== "-1" && (snapshot.isNewRecord || snapshot.sysId !== sysId)) {
                throw new Error(`Record ${table}/${sysId} was not found or is not readable`);
            }
            return snapshot;
        } catch (error) {
            if (options.sensitive && !isPolicyRefusal(error) && !(error instanceof FormSubmitError)) {
                const code = error instanceof Error && ["csrf_token_unavailable", "csrf_rejected"].includes(error.message) ? error.message : "Form request failed";
                throw new Error(code);
            }
            throw this.sanitizeError(error);
        }
    }

    /**
     * Submit a form you already loaded. Use this to inspect the form's variables (names,
     * types, choices) before deciding what to write.
     */
    public async submit(
        snapshot: FormTransportSnapshot,
        action: string,
        options: FormTransportSubmitOptions = {},
    ): Promise<FormTransportResult> {
        const table = snapshot.table;
        let posted: Record<string, string>;
        try { posted = this.buildFields(snapshot, options); } catch (error) {
            if (options.sensitive) throw new InvalidParameterException("Invalid form field or variable value");
            throw error;
        }

        try {
            const session = (await this.request().getUserSession()) as { userToken?: string } | undefined;
            if (options.tokenSource === "page" ? !snapshot.pageToken : !session?.userToken) {
                throw new Error("An authenticated ServiceNow session token is required to submit a form");
            }
            const fields: Record<string, string> = {
                ...(options.postAllRenderedInputs ? snapshot.renderedInputs : {}),
                sys_target: table,
                sys_uniqueName: "sys_id",
                sys_uniqueValue: snapshot.sysId,
                sys_row: snapshot.isNewRecord ? "-1" : "0",
                sys_modCount: snapshot.modCount,
                onLoad_sys_updated_on: snapshot.updatedOn,
                sys_action: options.actionValue ?? snapshot.actions[action] ?? action,
                sysparm_ck: options.tokenSource === "page" ? snapshot.pageToken : session.userToken,
                sysparm_encoded_record: snapshot.encodedRecord,
                sysparm_goto_url: GOTO_URL,
                isFormPage: "true",
                ...(options.view ? { sysparm_view: options.view } : {}),
                ...posted,
                ...options.extraFields,
            };

            this._logger.info(`Submitting ${action} for ${table}/${snapshot.sysId}`);
            const response = await this.request().post<string>({
                method: "POST", path: `/${table}.do`, headers: null, query: null, body: null,
                fields, responseFormat: "text", redirect: options.redirect, sensitive: options.sensitive,
            });
            if (options.landing === "guarded") {
                return await this.guardedLanding(snapshot, action, response.status,
                    response.headers as Record<string, string>, this.text(response.data), fields);
            }
            const html = this.text(response.data);
            const accepted = parseFormResponse(html);
            const messages = parseFormMessages(html);
            if (!accepted || accepted.action !== action) {
                throw new FormSubmitError(table, `The ${table} form submit was not accepted`, messages.errors);
            }
            return { sysId: accepted.sysId, action, messages: messages.info };
        } catch (error) {
            if (options.sensitive && !isPolicyRefusal(error) && !(error instanceof FormSubmitError)) {
                const code = error instanceof Error && ["csrf_token_unavailable", "csrf_rejected"].includes(error.message) ? error.message : "Form request failed";
                throw new Error(code);
            }
            throw this.sanitizeError(error);
        }
    }

    /**
     * Turn caller values into posted form parameters, validating variables against the
     * form so a misspelt element fails loudly instead of being silently ignored.
     */
    public validate(snapshot: FormSnapshot, options: FormWriteOptions): void {
        try { this.buildFields(snapshot, options); }
        catch { throw new InvalidParameterException("Invalid form field or variable value"); }
    }

    private buildFields(snapshot: FormSnapshot, options: FormWriteOptions): Record<string, string> {
        const table = snapshot.table;
        const out: Record<string, string> = {};

        for (const [field, value] of Object.entries(options.fields ?? {})) {
            if (!NAME.test(field)) throw new InvalidParameterException(`Invalid field name '${field}'`);
            const name = `${table}.${field}`;
            out[name] = encodeFormValue(value, snapshot.fields[name]);
        }

        const values = Object.entries(options.variables ?? {});
        if (values.length) {
            const available = this.variablesFor(snapshot, options.variableField);
            for (const [element, value] of values) {
                const control = available[element];
                if (!control) {
                    const known = Object.keys(available).sort().join(", ") || "(none)";
                    throw new InvalidParameterException(`Unknown variable '${element}' on the ${table} form. Available: ${known}`);
                }
                out[control.name] = encodeFormValue(value, control);
            }
        }
        return out;
    }

    private variablesFor(snapshot: FormSnapshot, field?: string): Record<string, FormVariableControl> {
        const all = Object.values(snapshot.variables);
        const columns = [...new Set(all.map(v => v.field))];
        if (!columns.length) {
            throw new InvalidParameterException(`The ${snapshot.table} form has no variables`);
        }
        const column = field ?? (columns.length === 1 ? columns[0] : undefined);
        if (!column || !columns.includes(column)) {
            throw new InvalidParameterException(
                `Specify variableField for the ${snapshot.table} form; it has variables on: ${columns.join(", ")}`);
        }
        return Object.fromEntries(all.filter(v => v.field === column).map(v => [v.element, v]));
    }

    public async requireExists(table: string, sysId: string): Promise<void> {
        const read = () => this.request().get<{ result?: Array<{ sys_id: string }> }>({
            method: "GET", path: `/api/now/table/${table}`, headers: { Accept: "application/json" }, body: null,
            query: { sysparm_query: `sys_id=${sysId}`, sysparm_fields: "sys_id", sysparm_limit: "1" },
        });
        let response = await read();
        // 202: the instance queued the request behind others in this session; ask again.
        for (let attempt = 1; response?.status === 202 && attempt <= 3; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            response = await read();
        }
        if (response?.status !== 200) {
            // The insert was reported; only the check failed. Say so, so nobody inserts again.
            throw new FormSubmitError(table, `The ${table} form reported inserting record ${sysId}, `
                + `but checking that it exists failed (status ${response?.status ?? "unknown"})`);
        }
        if (!response.bodyObject?.result?.length) {
            throw new FormSubmitError(table, `The ${table} form reported an insert, but record ${sysId} does not exist`);
        }
    }

    private async guardedLanding(snapshot: FormSnapshot, action: string, status: number,
        headers: Record<string, string>, html: string, fields: Record<string, string>): Promise<FormTransportResult> {
        const session = await this.request().getUserSession() as { instanceUrl?: URL | string; userToken?: string;
            cookie?: { getCookiesSync(url: string): Array<{ value: string }> } };
        const withheld = new Set([...Object.values(fields), session.userToken ?? "",
            ...(session.cookie?.getCookiesSync(String(session.instanceUrl)) ?? []).map(cookie => cookie.value)]);
        for (const value of [...withheld]) for (const line of value.split(/[\r\n]+/)) if (line) withheld.add(line);
        const clean = (text: string): string => {
            text = text.replace(/\s+/g, " ").trim();
            for (const value of [...withheld].filter(Boolean).sort((a, b) => b.length - a.length)) {
                text = text.split(value.replace(/\s+/g, " ").trim()).join("[redacted]");
                text = text.split(encodeURIComponent(value)).join("[redacted]");
            }
            text = redactMessage(text).replace(/https?:\/\/\S+/g, "[url]").replace(/[A-Za-z0-9_+/=.-]{24,}/g, "[redacted]");
            return /(?:Class\.create|\.prototype|function\s*\(|[{};]|<script)/i.test(text)
                ? "[message withheld: script content]" : text.slice(0, 200);
        };
        const messages = parseFormMessages(html);
        const location = headers.location ?? headers.Location;
        if (status >= 300 && status < 400 && location) {
            const origin = new URL(String(session.instanceUrl));
            const url = new URL(location, origin);
            if (url.pathname === "/security_interceptor.do") throw new Error("csrf_rejected");
            const allowed = new Set(["sys_id", "sysparm_transaction_scope", "sysparm_isdevstudio", "sysparm_nameofstack", "sysparm_view", "sysparm_referring_url"]);
            if (url.origin !== origin.origin || url.username || url.password || url.hash ||
                url.pathname !== `/${snapshot.table}.do` || !url.searchParams.has("sys_id") ||
                [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1) ||
                (url.searchParams.has("sysparm_transaction_scope") && url.searchParams.get("sysparm_transaction_scope") !== fields.sysparm_transaction_scope) || [...url.searchParams.keys()].some(key => !allowed.has(key)) ||
                (url.searchParams.has("sys_id") && ![snapshot.sysId, "-1"].includes(url.searchParams.get("sys_id")))) {
                throw new FormSubmitError(snapshot.table, "Unexpected form redirect");
            }
            const landing = await this.request().get<string>({ path: url.pathname,
                query: Object.fromEntries(url.searchParams), headers: null, body: null,
                requires: READ_ONLY, responseFormat: "text", sensitive: true, redirect: "manual" });
            if (landing.status >= 300) throw new FormSubmitError(snapshot.table, "Unexpected landing redirect");
            const parsed = parseFormMessages(this.text(landing.data));
            messages.errors.push(...parsed.errors); messages.info.push(...parsed.info);
        }
        return { sysId: snapshot.sysId, action, messages: messages.info.map(clean), errors: messages.errors.map(clean) };
    }

    private request(): ServiceNowRequest {
        // One session for the form load, the submit and the follow-up read: the submit's
        // token must belong to the session that loaded the form.
        return SessionManager.getInstance().getRequest(this._instance);
    }

    private requireTable(table: string): void {
        if (!table || !NAME.test(table)) throw new InvalidParameterException("A valid table name is required");
    }

    private text(data: unknown): string {
        return typeof data === "string" ? data : "";
    }

    private sanitizeError<T>(error: T): T {
        if (error instanceof Error) error.message = redactMessage(error.message);
        return stripSecretsFromError(error);
    }
}

/** Shared internal transport. Excluded from the package barrel. */
export function createFormTransport(instance: ServiceNowInstance): FormTransport {
    return new FormTransport(instance);
}

/** Write ordinary records through classic forms with the established defaults. */
export class FormRecordWriter {
    private _transport: FormTransport;
    public constructor(instance: ServiceNowInstance) { this._transport = createFormTransport(instance); }
    public loadForm(table: string, sysId = "-1", options: FormLoadOptions = {}): Promise<FormSnapshot> {
        return this._transport.loadForm(table, sysId, options);
    }
    /**
     * Insert a record through its form.
     *
     * @param table Table name
     * @param options Field values, variable values, view and initial query
     * @returns The new record's sys_id and any info messages
     * @throws InvalidParameterException for unknown variables or invalid choice values
     * @throws FormSubmitError when the instance does not accept the submit
     */
    public async insert(table: string, options: FormWriteOptions = {}): Promise<FormWriteResult> {
        const snapshot = await this.loadForm(table, "-1", options);
        const result = await this.submit(snapshot, "sysverb_insert", options);
        await this._transport.requireExists(table, result.sysId);
        return result;
    }

    /**
     * Update a record through its form. Fields and variables you do not pass keep their
     * current values.
     *
     * @param table Table name
     * @param sysId Record sys_id
     * @param options Field values, variable values and view
     * @throws InvalidParameterException for unknown variables or invalid choice values
     * @throws FormSubmitError when the instance does not accept the submit
     */
    public async update(table: string, sysId: string, options: FormWriteOptions = {}): Promise<FormWriteResult> {
        if (!SYS_ID.test(sysId ?? "")) throw new InvalidParameterException("sysId must be a 32-character sys_id");
        const snapshot = await this.loadForm(table, sysId, { view: options.view });
        return await this.submit(snapshot, "sysverb_update", options);
    }

    public async submit(snapshot: FormSnapshot, action: "sysverb_insert" | "sysverb_update",
        options: FormWriteOptions = {}): Promise<FormWriteResult> {
        return await this._transport.submit(snapshot, action, options) as FormWriteResult;
    }
}

/**
 * Encode a caller value the way the form posts it.
 *
 * @param value The caller's value
 * @param control The form control it is going to, when known (drives duration and choice handling)
 */
export function encodeFormValue(value: FormValueInput, control?: FormControl): string {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.join(",");
    if (typeof value === "boolean") return value ? "true" : "false";

    if (control?.type === "glide_duration") return encodeDuration(value);
    if (typeof value === "object") {
        throw new InvalidParameterException(`An object value is only valid for a duration field (${control?.name ?? "unknown field"})`);
    }

    const text = String(value);
    if (control?.choices?.length) return resolveChoice(text, control);
    return text;
}

/**
 * Durations post in the form's display format, `D HH:MM:SS`. The stored format
 * (`1970-01-03 01:02:03`) and plain seconds are not understood by the form, so both are
 * converted here.
 */
export function encodeDuration(value: number | string | FormDurationInput): string {
    let total: number;
    if (typeof value === "number") {
        total = value;
    } else if (typeof value === "object") {
        total = ((value.days ?? 0) * 86400) + ((value.hours ?? 0) * 3600) + ((value.minutes ?? 0) * 60) + (value.seconds ?? 0);
    } else {
        const text = value.trim();
        if (text === "") return "";
        const stored = /^1970-01-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
        if (stored) {
            total = ((Number(stored[1]) - 1) * 86400) + (Number(stored[2]) * 3600) + (Number(stored[3]) * 60) + Number(stored[4]);
        } else if (/^\d+$/.test(text)) {
            total = Number(text);
        } else {
            return text;
        }
    }
    if (!Number.isFinite(total) || total < 0) throw new InvalidParameterException(`Invalid duration: ${JSON.stringify(value)}`);
    total = Math.floor(total);
    const days = Math.floor(total / 86400);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${days} ${pad(Math.floor((total % 86400) / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function resolveChoice(text: string, control: FormControl): string {
    const choices = control.choices;
    if (choices.some(c => c.value === text)) return text;
    const byLabel = choices.find(c => c.label.toLowerCase() === text.toLowerCase());
    if (byLabel) return byLabel.value;
    const allowed = choices.map(c => (c.value === "" ? `'' (${c.label})` : c.value)).join(", ");
    throw new InvalidParameterException(`'${text}' is not a choice for ${control.name}. Allowed: ${allowed}`);
}
