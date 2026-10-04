import { beforeEach, afterEach, describe, expect, it, jest } from "@jest/globals";
import { FormRecordWriter, encodeDuration, encodeFormValue } from "../../../../src/comm/http/FormRecordWriter";
import { parseFormHtml, parseFormMessages, parseFormResponse } from "../../../../src/comm/http/FormHtmlParser";
import { SessionManager } from "../../../../src/comm/http/SessionManager";
import { ServiceNowInstance, ServiceNowSettingsInstance } from "../../../../src/sn/ServiceNowInstance";
import { InvalidParameterException } from "../../../../src/exception/InvalidParameterException";
import { FormSubmitError } from "../../../../src/exception/FormSubmitError";
import { READ_ONLY } from "../../../../src/policy/PolicyTypes";
import { createGetCredentialsMock } from "../../__mocks__/servicenow-sdk-mocks";

const mockGetCredentials = createGetCredentialsMock();
jest.mock("@servicenow/sdk-cli/dist/auth/index.js", () => ({ getCredentials: mockGetCredentials }));

const NEW_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VERSION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TIMER = "3961a1da0a0a0b5c00ecd84822f70d85";
const INSERT_ACTION = "42da42d00a0a0b340066377beb6dd099";
const UPDATE_ACTION = "573761fdff623100f03bffffffffff16";
const TOKEN = "session-token-never-in-errors";
const V = `wf_activity.vars.var__m_${TIMER}`;

/** A trimmed wf_activity form modeled on what the instance renders for a new Timer activity. */
function timerForm(opts: { sysId?: string; row?: string; modCount?: string } = {}): string {
    const sysId = opts.sysId ?? NEW_ID;
    return `<html><body><form>
<input type="HIDDEN" id="sys_target" name="sys_target" value="wf_activity"></input>
<input type="HIDDEN" id="sys_uniqueValue" name="sys_uniqueValue" value="${sysId}"></input>
<input type="HIDDEN" name="sys_row" value="${opts.row ?? "-1"}"></input>
<input type="HIDDEN" name="sys_modCount" value="${opts.modCount ?? ""}"></input>
<input type="HIDDEN" name="onLoad_sys_updated_on" value=""></input>
<input type="HIDDEN" id="sysparm_encoded_record" name="sysparm_encoded_record" value="ENCODED-STATE"></input>
<input type="HIDDEN" name="sysparm_ck" value="form-token"></input>
<button type="submit" value="sysverb_insert" id="sysverb_insert" data-action-name="sysverb_insert" gsft_id="${INSERT_ACTION}">Submit</button>
<button type="submit" data-action-name="sysverb_update" gsft_id="${UPDATE_ACTION}">Update</button>
<input type="hidden" name="wf_activity.workflow_version.table" value="incident"/>
<div class="foreign" data-type="label" type="string" id="label.wf_activity.name"></div>
<span id="status.wf_activity.name" mandatory="true"></span>
<input name="wf_activity.name" value=""/>
<input type="hidden" name="sys_original.${V}.timer_type" value=""/>
<div class="foreign" data-type="label" choice="1" type="choice" id="label.${V}.timer_type"></div>
<select aria-required="false" NAME="${V}.timer_type" ID="${V}.timer_type">
  <option value="" selected="SELECTED">A user specified duration</option>
  <option value="relative_duration">A relative duration</option>
  <option value="script">Script</option>
</select>
<div class="foreign" data-type="label" type="glide_duration" id="label.${V}.duration"></div>
<input type="hidden" name="ni.${V}.durationdur_day" value=""/>
<input name="${V}.duration" value=""/>
<input type="hidden" name="${V}.relative_duration.ui_policy_sensitive" value="true"/>
<input type="hidden" name="${V}.relative_duration" value=""/>
<input type="hidden" name="sys_select.${V}.relative_duration" value="9c41248d1b314d50e7bb628a234bcb10"/>
<textarea name="${V}.script">// Set 'answer' to the number of seconds this timer should wait&#13;
answer = 0;</textarea>
<input type="checkbox" name="wf_activity.unticked" value="true"/>
</form></body></html>`;
}

const RESPONSE_PAGE = (action: string, sysId: string) =>
    `<html><body><span class="modal_dialog_form_response" style="display:none"><form><input name="action" value="${action}"></input><input name="sysid" value="${sysId}"></input><input name="value" value="x"></input></form></span></body></html>`;

const ERROR_PAGE = `<html><body><div class="outputmsg_div"><div class="outputmsg outputmsg_error notification notification-error"><span class="outputmsg_text">Invalid insert</span></div><div class="outputmsg outputmsg_info notification notification-info"><span class="outputmsg_text">Some info</span></div></div>${timerForm()}</body></html>`;

describe("FormHtmlParser", () => {
    it("reads tokens, actions, fields and variables like a browser would submit them", () => {
        const snapshot = parseFormHtml(timerForm(), "wf_activity");

        expect(snapshot.sysId).toBe(NEW_ID);
        expect(snapshot.isNewRecord).toBe(true);
        expect(snapshot.encodedRecord).toBe("ENCODED-STATE");
        expect(snapshot.actions).toEqual({ sysverb_insert: INSERT_ACTION, sysverb_update: UPDATE_ACTION });
        expect(snapshot.fields["wf_activity.name"]).toEqual({ name: "wf_activity.name", value: "", type: "string", mandatory: true });
        expect(Object.keys(snapshot.variables).sort()).toEqual(["vars.duration", "vars.relative_duration", "vars.script", "vars.timer_type"]);
        expect(snapshot.variables["vars.timer_type"]).toMatchObject({
            field: "vars", model: `var__m_${TIMER}`, element: "timer_type", value: "", type: "choice",
            choices: [{ value: "", label: "A user specified duration" }, { value: "relative_duration", label: "A relative duration" }, { value: "script", label: "Script" }],
        });
        expect(snapshot.variables["vars.script"].value).toBe("// Set 'answer' to the number of seconds this timer should wait\r\nanswer = 0;");
        expect(snapshot.variables["vars.duration"].type).toBe("glide_duration");
        // UI mirrors and unticked checkboxes are not posted by a browser either.
        expect(snapshot.variables["vars.relative_duration"].value).toBe("");
        expect(snapshot.fields["wf_activity.unticked"]).toBeUndefined();
        expect(Object.keys(snapshot.fields).some(n => n.includes("ui_policy_sensitive"))).toBe(false);
    });

    it("rejects a page that is not the table's form", () => {
        expect(() => parseFormHtml("<html><form action='login.do'><input name='user_name'/></form></html>", "wf_activity"))
            .toThrow(/not a wf_activity form/);
        expect(() => parseFormHtml(timerForm(), "sys_atf_step")).toThrow(/not a sys_atf_step form/);
    });

    it("splits messages by severity", () => {
        expect(parseFormMessages(ERROR_PAGE)).toEqual({ errors: ["Invalid insert"], info: ["Some info"] });
    });

    it("reads the submit outcome from the dialog response page", () => {
        expect(parseFormResponse(RESPONSE_PAGE("sysverb_insert", NEW_ID))).toEqual({ action: "sysverb_insert", sysId: NEW_ID });
        expect(parseFormResponse(timerForm())).toBeUndefined();
    });
});

describe("encodeFormValue", () => {
    it("encodes caller values the way the form posts them", () => {
        expect(encodeFormValue(true)).toBe("true");
        expect(encodeFormValue(false)).toBe("false");
        expect(encodeFormValue(null)).toBe("");
        expect(encodeFormValue(["a", "b"])).toBe("a,b");
        expect(encodeFormValue(42)).toBe("42");
        expect(encodeFormValue("text")).toBe("text");
    });

    it("posts durations as D HH:MM:SS", () => {
        expect(encodeDuration(3723)).toBe("0 01:02:03");
        expect(encodeDuration({ days: 2, hours: 1, minutes: 2, seconds: 3 })).toBe("2 01:02:03");
        expect(encodeDuration("1970-01-03 01:02:03")).toBe("2 01:02:03");
        expect(encodeDuration("90")).toBe("0 00:01:30");
        expect(encodeDuration("1 00:00:00")).toBe("1 00:00:00");
        expect(encodeDuration("")).toBe("");
        expect(() => encodeDuration(-1)).toThrow(InvalidParameterException);
        expect(encodeFormValue(60, { name: "d", value: "", type: "glide_duration" })).toBe("0 00:01:00");
    });

    it("rejects objects for anything but durations", () => {
        expect(() => encodeFormValue({ days: 1 }, { name: "x", value: "", type: "string" })).toThrow(InvalidParameterException);
    });

    it("accepts a choice by value or label and rejects anything else", () => {
        const control = { name: "c", value: "", choices: [{ value: "", label: "-- None --" }, { value: "script", label: "Script" }] };
        expect(encodeFormValue("script", control)).toBe("script");
        expect(encodeFormValue("SCRIPT", control)).toBe("script");
        expect(encodeFormValue("", control)).toBe("");
        expect(() => encodeFormValue("nope", control)).toThrow(/Allowed: '' \(-- None --\), script/);
    });
});

describe("FormRecordWriter", () => {
    let writer: FormRecordWriter;
    let req: { get: jest.Mock<any>; post: jest.Mock<any>; getUserSession: jest.Mock<any> };

    beforeEach(async () => {
        jest.clearAllMocks();
        const credential = await mockGetCredentials("test-instance");
        const instance = new ServiceNowInstance({ alias: "test-instance", credential } as ServiceNowSettingsInstance);
        writer = new FormRecordWriter(instance);
        req = { get: jest.fn(), post: jest.fn(), getUserSession: jest.fn() };
        req.getUserSession.mockResolvedValue({ userToken: TOKEN });
        jest.spyOn(SessionManager.getInstance(), "getRequest").mockReturnValue(req as any);
    });

    afterEach(() => jest.restoreAllMocks());

    it("inserts by loading the form, submitting only the given values, and confirming the record", async () => {
        req.get
            .mockResolvedValueOnce({ data: timerForm() })
            .mockResolvedValueOnce({ status: 200, bodyObject: { result: [{ sys_id: NEW_ID }] } });
        req.post.mockResolvedValueOnce({ data: RESPONSE_PAGE("sysverb_insert", NEW_ID) });

        const result = await writer.insert("wf_activity", {
            view: "diagrammer",
            initialQuery: `workflow_version=${VERSION}^activity_definition=${TIMER}`,
            fields: { name: "Wait", x: 10 },
            variables: { timer_type: "Script", script: "answer = 10;", duration: 90 },
        });

        expect(result).toEqual({ sysId: NEW_ID, action: "sysverb_insert", messages: [] });
        const load = req.get.mock.calls[0][0];
        expect(load).toMatchObject({ path: "/wf_activity.do", requires: READ_ONLY, responseFormat: "text" });
        expect(load.query).toEqual({ sys_id: "-1", sysparm_view: "diagrammer", sysparm_query: `workflow_version=${VERSION}^activity_definition=${TIMER}` });

        const submit = req.post.mock.calls[0][0];
        expect(submit.path).toBe("/wf_activity.do");
        expect(submit.fields).toEqual({
            sys_target: "wf_activity",
            sys_uniqueName: "sys_id",
            sys_uniqueValue: NEW_ID,
            sys_row: "-1",
            sys_modCount: "",
            onLoad_sys_updated_on: "",
            sys_action: INSERT_ACTION,
            sysparm_ck: TOKEN,
            sysparm_encoded_record: "ENCODED-STATE",
            sysparm_goto_url: "modal_dialog_form_response.do?sysparm_returned_action=$action&sysparm_returned_sysid=$sys_id",
            isFormPage: "true",
            sysparm_view: "diagrammer",
            "wf_activity.name": "Wait",
            "wf_activity.x": "10",
            [`${V}.timer_type`]: "script",
            [`${V}.script`]: "answer = 10;",
            [`${V}.duration`]: "0 00:01:30",
        });
        expect(req.get.mock.calls[1][0].query).toMatchObject({ sysparm_query: `sys_id=${NEW_ID}` });
    });

    it("updates using the record's form and the update action", async () => {
        req.get.mockResolvedValueOnce({ data: timerForm({ sysId: NEW_ID, row: "0", modCount: "3" }) });
        req.post.mockResolvedValueOnce({ data: RESPONSE_PAGE("sysverb_update", NEW_ID) });

        await writer.update("wf_activity", NEW_ID, { variables: { script: "answer = 11;" } });

        expect(req.get.mock.calls[0][0].query).toEqual({ sys_id: NEW_ID });
        const fields = req.post.mock.calls[0][0].fields;
        expect(fields).toMatchObject({ sys_action: UPDATE_ACTION, sys_row: "0", sys_modCount: "3", [`${V}.script`]: "answer = 11;" });
        expect(fields[`${V}.timer_type`]).toBeUndefined();
    });

    it("refuses to update a record whose form comes back as a new record", async () => {
        req.get.mockResolvedValueOnce({ data: timerForm({ sysId: "cccccccccccccccccccccccccccccccc" }) });
        await expect(writer.update("wf_activity", NEW_ID, { fields: { name: "x" } })).rejects.toThrow(/was not found/);
        expect(req.post).not.toHaveBeenCalled();
    });

    it("rejects unknown variables before submitting, listing the valid ones", async () => {
        req.get.mockResolvedValueOnce({ data: timerForm() });
        await expect(writer.insert("wf_activity", { variables: { timr_type: "script" } }))
            .rejects.toThrow("Unknown variable 'timr_type' on the wf_activity form. Available: duration, relative_duration, script, timer_type");
        expect(req.post).not.toHaveBeenCalled();
    });

    it("reports the instance's error messages when the submit is not accepted", async () => {
        req.get.mockResolvedValueOnce({ data: timerForm() });
        req.post.mockResolvedValueOnce({ data: ERROR_PAGE });
        const error = await writer.insert("wf_activity", { fields: { name: "x" } }).catch(e => e);
        expect(error).toBeInstanceOf(FormSubmitError);
        expect(error.messages).toEqual(["Invalid insert"]);
        expect(error.message).not.toContain(TOKEN);
    });

    it("fails an insert the instance claimed but did not make", async () => {
        req.get
            .mockResolvedValueOnce({ data: timerForm() })
            .mockResolvedValueOnce({ status: 200, bodyObject: { result: [] } });
        req.post.mockResolvedValueOnce({ data: RESPONSE_PAGE("sysverb_insert", NEW_ID) });
        await expect(writer.insert("wf_activity", { fields: { name: "x" } })).rejects.toThrow(/does not exist/);
    });

    it("asks again while the existence check is queued, and never calls a failed check a missing record", async () => {
        req.get
            .mockResolvedValueOnce({ data: timerForm() })
            .mockResolvedValueOnce({ status: 202 })
            .mockResolvedValueOnce({ status: 200, bodyObject: { result: [{ sys_id: NEW_ID }] } });
        req.post.mockResolvedValueOnce({ data: RESPONSE_PAGE("sysverb_insert", NEW_ID) });
        await expect(writer.insert("wf_activity", { fields: { name: "x" } })).resolves.toMatchObject({ sysId: NEW_ID });

        req.get
            .mockResolvedValueOnce({ data: timerForm() })
            .mockResolvedValueOnce({ status: 500 });
        req.post.mockResolvedValueOnce({ data: RESPONSE_PAGE("sysverb_insert", NEW_ID) });
        const error = await writer.insert("wf_activity", { fields: { name: "x" } }).catch(e => e);
        expect(error).toBeInstanceOf(FormSubmitError);
        expect(error.message).toContain(`reported inserting record ${NEW_ID}, but checking that it exists failed (status 500)`);
        expect(error.message).not.toContain("does not exist");
    });

    it("keeps the same element on two variable columns apart", async () => {
        const form = `<html><body><form>
<input type="HIDDEN" name="sys_target" value="sys_atf_step"></input>
<input type="HIDDEN" name="sys_uniqueValue" value="${NEW_ID}"></input>
<input type="HIDDEN" name="sys_row" value="-1"></input>
<input type="HIDDEN" name="sysparm_encoded_record" value="E"></input>
<button type="submit" data-action-name="sysverb_insert" gsft_id="${INSERT_ACTION}">Submit</button>
<textarea name="sys_atf_step.inputs.var__m_atf_input_variable_aa.script">in</textarea>
<textarea name="sys_atf_step.outputs.var__m_atf_output_variable_bb.script">out</textarea>
</form></body></html>`;
        const snapshot = parseFormHtml(form, "sys_atf_step");
        expect(Object.keys(snapshot.variables).sort()).toEqual(["inputs.script", "outputs.script"]);

        req.get
            .mockResolvedValueOnce({ data: form })
            .mockResolvedValueOnce({ status: 200, bodyObject: { result: [{ sys_id: NEW_ID }] } });
        req.post.mockResolvedValueOnce({ data: RESPONSE_PAGE("sysverb_insert", NEW_ID) });
        await writer.insert("sys_atf_step", { variableField: "inputs", variables: { script: "gs.info(1);" } });
        expect(req.post.mock.calls[0][0].fields).toMatchObject({ "sys_atf_step.inputs.var__m_atf_input_variable_aa.script": "gs.info(1);" });
        expect(req.post.mock.calls[0][0].fields["sys_atf_step.outputs.var__m_atf_output_variable_bb.script"]).toBeUndefined();
    });

    it("validates table, sys_id and field names", async () => {
        await expect(writer.loadForm("bad table")).rejects.toThrow(InvalidParameterException);
        await expect(writer.loadForm("wf_activity", "123")).rejects.toThrow(InvalidParameterException);
        await expect(writer.update("wf_activity", "nope", {})).rejects.toThrow(InvalidParameterException);
        req.get.mockResolvedValueOnce({ data: timerForm() });
        await expect(writer.insert("wf_activity", { fields: { "workflow_version.table": "x" } })).rejects.toThrow(/Invalid field name/);
    });
});
