import { Parser } from "htmlparser2";
import { FormControl, FormSnapshot, FormVariableControl } from "./FormRecordModels";

/**
 * Parses classic UI form pages (`/<table>.do`) into a {@link FormSnapshot}.
 *
 * Kept separate from the writer so it can be exercised against fixture HTML. Only the
 * controls a browser would submit for the record are kept: `<table>.*` inputs,
 * textareas and selects, plus the hidden tokens a submit must echo back. Display-only
 * mirrors (`sys_display.*`, `sys_select.*`, `sys_original.*`) are ignored — posting a
 * `sys_select` value is how the UI ends up storing a reference it only displayed.
 */

const TOKENS = new Set([
    "sys_uniqueValue", "sysparm_encoded_record", "sys_modCount", "onLoad_sys_updated_on", "sys_row",
]);

interface PendingSelect {
    name: string;
    options: Array<{ value: string; label: string; selected: boolean }>;
}

/**
 * Parse a form page.
 *
 * @param html The form page
 * @param table The table the form belongs to
 * @throws Error when the page is not a form for `table` (e.g. a login page or an error page)
 */
export function parseFormHtml(html: string, table: string): FormSnapshot {
    const prefix = `${table}.`;
    const tokens: Record<string, string> = {};
    const actions: Record<string, string> = {};
    const controls = new Map<string, FormControl>();
    const types = new Map<string, string>();
    const mandatory = new Set<string>();
    let target: string | undefined;

    let textarea: { name: string; text: string } | null = null;
    let select: PendingSelect | null = null;
    let option: { value: string | undefined; label: string; selected: boolean } | null = null;

    const keep = (name: string | undefined): boolean =>
        !!name && name.startsWith(prefix) && !name.endsWith(".ui_policy_sensitive");

    const parser = new Parser({
        onopentag(tag, attrs) {
            switch (tag) {
                case "input": {
                    const name = attrs.name;
                    if (name === "sys_target") target = attrs.value;
                    if (TOKENS.has(name)) tokens[name] = attrs.value ?? "";
                    if (!keep(name)) return;
                    const type = (attrs.type || "text").toLowerCase();
                    if (type === "button" || type === "submit" || type === "image") return;
                    if ((type === "checkbox" || type === "radio") && attrs.checked === undefined) return;
                    controls.set(name, { name, value: attrs.value ?? "" });
                    return;
                }
                case "textarea":
                    if (keep(attrs.name)) textarea = { name: attrs.name, text: "" };
                    return;
                case "select":
                    if (keep(attrs.name)) select = { name: attrs.name, options: [] };
                    return;
                case "option":
                    if (select) option = { value: attrs.value, label: "", selected: attrs.selected !== undefined };
                    return;
                case "button":
                    if (attrs["data-action-name"] && attrs.gsft_id) actions[attrs["data-action-name"]] = attrs.gsft_id;
                    return;
                case "div":
                    if (attrs["data-type"] === "label" && attrs.id?.startsWith("label.") && attrs.type) {
                        types.set(attrs.id.slice("label.".length), attrs.type);
                    }
                    return;
                case "span":
                    if (attrs.id?.startsWith("status.") && attrs.mandatory === "true") {
                        mandatory.add(attrs.id.slice("status.".length));
                    }
                    return;
            }
        },
        ontext(text) {
            if (textarea) textarea.text += text;
            if (option) option.label += text;
        },
        onclosetag(tag) {
            if (tag === "textarea" && textarea) {
                controls.set(textarea.name, { name: textarea.name, value: textarea.text });
                textarea = null;
            } else if (tag === "option" && select && option) {
                select.options.push({ value: option.value ?? option.label, label: option.label.trim(), selected: option.selected });
                option = null;
            } else if (tag === "select" && select) {
                const chosen = select.options.find(o => o.selected) ?? select.options[0];
                controls.set(select.name, {
                    name: select.name,
                    value: chosen ? chosen.value : "",
                    choices: select.options.map(o => ({ value: o.value, label: o.label })),
                });
                select = null;
            }
        },
    }, { decodeEntities: true, lowerCaseAttributeNames: true, lowerCaseTags: true });
    parser.write(html);
    parser.end();

    if (target !== table || tokens.sys_uniqueValue === undefined) {
        throw new Error(`The response was not a ${table} form (it may be a login or error page)`);
    }

    const fields: Record<string, FormControl> = {};
    const variables: Record<string, FormVariableControl> = {};
    for (const control of controls.values()) {
        const type = types.get(control.name);
        if (type) control.type = type;
        if (mandatory.has(control.name)) control.mandatory = true;
        const variable = splitVariableName(control.name, table);
        if (variable) variables[variable.element] = { ...control, ...variable };
        else fields[control.name] = control;
    }

    const sysId = tokens.sys_uniqueValue;
    return {
        table,
        sysId,
        isNewRecord: tokens.sys_row === "-1",
        encodedRecord: tokens.sysparm_encoded_record ?? "",
        modCount: tokens.sys_modCount ?? "",
        updatedOn: tokens.onLoad_sys_updated_on ?? "",
        actions,
        fields,
        variables,
    };
}

/**
 * Split `<table>.<varField>.var__m_<model>.<element>` into its parts.
 * Returns undefined for ordinary (possibly dot-walked) field names.
 */
export function splitVariableName(
    name: string,
    table: string,
): { field: string; model: string; element: string } | undefined {
    const parts = name.slice(table.length + 1).split(".");
    if (parts.length !== 3 || !parts[1].startsWith("var__m_")) return undefined;
    return { field: parts[0], model: parts[1], element: parts[2] };
}

/**
 * Messages shown on a classic UI page, split by severity.
 */
export function parseFormMessages(html: string): { errors: string[]; info: string[] } {
    const errors: string[] = [];
    const info: string[] = [];
    // Message containers do not nest, so the most recent one decides the severity.
    let current: "error" | "info" | null = null;
    let text: string | null = null;
    const parser = new Parser({
        onopentag(tag, attrs) {
            const cls = attrs.class ?? "";
            if (tag === "div" && /\boutputmsg\b/.test(cls)) {
                current = /outputmsg_error|notification-error/.test(cls) ? "error" : "info";
            }
            if (current && tag === "span" && /\boutputmsg_text\b/.test(cls)) text = "";
        },
        ontext(t) {
            if (text !== null) text += t;
        },
        onclosetag(tag) {
            if (tag === "span" && text !== null) {
                const message = text.replace(/\s+/g, " ").trim();
                if (message) (current === "error" ? errors : info).push(message);
                text = null;
            }
        },
    }, { decodeEntities: true, lowerCaseAttributeNames: true });
    parser.write(html);
    parser.end();
    return { errors, info };
}

/**
 * Read the action and sys_id that `modal_dialog_form_response.do` reports after a
 * successful form submit. Returns undefined when the page is anything else — which is
 * how a rejected submit (re-rendered form, error page) shows up.
 */
export function parseFormResponse(html: string): { action: string; sysId: string } | undefined {
    let inResponse = false;
    const values: Record<string, string> = {};
    const parser = new Parser({
        onopentag(tag, attrs) {
            if (tag === "span" && /\bmodal_dialog_form_response\b/.test(attrs.class ?? "")) inResponse = true;
            else if (inResponse && tag === "input" && attrs.name) values[attrs.name] = attrs.value ?? "";
        },
        onclosetag(tag) {
            if (tag === "span") inResponse = false;
        },
    }, { decodeEntities: true, lowerCaseAttributeNames: true });
    parser.write(html);
    parser.end();
    if (!values.action || !values.sysid) return undefined;
    return { action: values.action, sysId: values.sysid };
}
