/**
 * Requirement classification.
 *
 * The cases that matter are the ones where the HTTP verb lies. Gating on the verb was
 * considered and rejected because it fails in BOTH directions — mutations that travel
 * as GET, and reads that travel as POST — and each of those is represented here.
 */

import { describe, it, expect } from "@jest/globals";
import { classify, floorFor } from "../../../src/policy/internal/Classify";
import { HTTPRequest } from "../../../src/comm/http/HTTPRequest";
import { READ_ONLY } from "../../../src/policy/PolicyTypes";

const req = (over: Partial<HTTPRequest>): HTTPRequest => ({
    path: "/api/now/table/incident",
    headers: null,
    body: null,
    query: null,
    ...over,
});

describe("tier 3 — verb default", () => {
    it("treats GET as needing nothing", () => {
        expect(classify(req({ method: "GET" })).verbs).toEqual([]);
    });

    it.each(["POST", "PUT", "DELETE", "post"])("treats %s as a write", (method) => {
        expect(classify(req({ method })).verbs).toEqual(["write"]);
    });

    it("defaults to GET when no method is given", () => {
        expect(classify(req({})).verbs).toEqual([]);
    });
});

describe("tier 1 — floor, for mutations the verb hides", () => {
    it("catches store app install, which is issued as a GET", () => {
        const r = req({ method: "GET", path: "/api/sn_appclient/appmanager/app/install" });
        expect(classify(r).verbs).toEqual(["write"]);
    });

    it("catches store app update, also a GET", () => {
        const r = req({ method: "GET", path: "/api/sn_appclient/appmanager/app/update" });
        expect(classify(r).verbs).toEqual(["write"]);
    });

    it.each([
        "/api/sn_appclient/appmanager/app/repair",
        "/api/sn_appclient/v1/appmanager/app/repair",
        "/api/sn_appclient/v1/appmanager/app/install",
        "/api/sn_appclient/v1/appmanager/app/update",
        "/api/sn_appclient/v1/appmanager/plugin/activate",
        "/api/sn_appclient/appmanager/plugin/repair",
        "/api/sn_appclient/v1/appmanager/plugin/rollback",
        "/api/sn_appclient/v1/appmanager/loadDemoData",
        "/api/sn_appclient/v1/appmanager/sync_apps",
        "/api/sn_appclient/v1/appmanager/app/repair?app_id=abc&version=1.0.0",
        "/api/sn_appclient/appmanager/app/install;x=1?app_id=abc",
        "/api/sn_appclient/appmanager/app/install/",
        "/api/sn_appclient/appmanager/app/install#x",
        "/api/sn_appclient//appmanager/app//repair",
        "/API/SN_APPCLIENT/V1/APPMANAGER/APP/REPAIR",
        // Resolved by new URL() before sending, or decoded by the server.
        "/api/sn_appclient/./appmanager/app/repair",
        "/api/sn_appclient/v1/../appmanager/app/install?app_id=abc",
        "/api\\sn_appclient\\appmanager\\app\\repair",
        "/api/sn_appclient/appmanager/app/%72epair",
        "/api/sn_appclient/appmanager;v=1/app/repair",
        "/api;x/sn_appclient/appmanager/app/install?app_id=abc",
    ])("catches the App Client's mutating GET %s, versioned or not", (path) => {
        expect(classify(req({ method: "GET", path })).verbs).toEqual(["write"]);
    });

    it.each([
        "/api/sn_appclient/v1/appmanager/app/abc123",
        "/api/sn_appclient/v1/appmanager/progress/abc123",
        "/api/sn_appclient/v1/appmanager/installations",
        "/api/sn_appclient/v1/appmanager/plugin/com.snc.x",
        "/api/sn_appclient/v1/appmanager/app/installations",
        "/api/sn_appclient/v1/appmanager/app/repair_info",
    ])("leaves the App Client's reads, such as %s, as reads", (path) => {
        expect(classify(req({ method: "GET", path })).verbs).toEqual([]);
    });

    it("checks every floor rule against the path as it will be sent, not only as written", () => {
        expect(classify(req({ method: "POST", path: "/x/../sys.scripts.do" })).verbs).toContain("execute");
        expect(classify(req({ method: "DELETE", path: "/api/now/./table/sys_trigger/abc" })).verbs).toEqual(["write"]);
        expect(floorFor(req({ method: "DELETE", path: "/api/now/./table/sys_trigger/abc" })).reasons.join()).toMatch(/sys_trigger/);
        // A malformed escape cannot be decoded; the raw and URL-resolved spellings still apply.
        expect(classify(req({ method: "GET", path: "/api/sn_appclient/./appmanager/app/repair%" })).verbs).toEqual(["write"]);
    });

    it("catches sysparm_delete_all wherever it rides", () => {
        // Application.uninstall sends this in `fields`, not the query string.
        const inFields = req({ method: "POST", path: "/xmlhttp.do", fields: { sysparm_delete_all: "true" } });
        expect(floorFor(inFields).reasons).toContain("sysparm_delete_all");

        const inQuery = req({ method: "GET", path: "/anything", query: { sysparm_delete_all: "true" } });
        expect(classify(inQuery).verbs).toEqual(["write"]);
    });

    it("catches sysparm_delete_when_done on an otherwise read-shaped export", () => {
        const r = req({ method: "GET", path: "/export_base_update_set.do", query: { sysparm_delete_when_done: "true" } });
        expect(classify(r).verbs).toEqual(["write"]);
    });

    it("does not fire on sysparm_delete_when_done=false", () => {
        const r = req({ method: "GET", path: "/export_base_update_set.do", query: { sysparm_delete_when_done: "false" } });
        expect(classify(r).verbs).toEqual([]);
    });

    it("requires execute for background scripts", () => {
        expect(classify(req({ method: "POST", path: "/sys.scripts.do" })).verbs).toContain("execute");
    });

    it("requires write and execute for a sys_trigger insert — a scheduled script outlives the request", () => {
        const r = req({ method: "POST", path: "/api/now/table/sys_trigger" });
        expect(classify(r).verbs.sort()).toEqual(["execute", "write"]);
        expect(floorFor(r).reasons.join()).toMatch(/sys_trigger/);
    });
});

describe("tier 1 — scheduled jobs (NSE-28)", () => {
    const SYS_ID = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
    const T = "/api/now/table";
    const TRIGGER_WHY = "sys_trigger scheduled job — persisting a job outlives the request that made it";
    const DEFINITION_WHY = "scheduled job definition — persisting a job outlives the request that made it";
    const SCRIPT_WHY = "script-bearing schedule — inserting or changing one schedules server-side script";

    // Reading scheduled jobs changes nothing; InstanceHealth reads sys_trigger for stuck jobs.
    it.each([
        `${T}/sys_trigger`,
        `${T}/sys_trigger/${SYS_ID}`,
        `${T}/sys_trigger?sysparm_query=state=0&sysparm_limit=100`,
        `${T}/sysauto`,
        `${T}/sysauto/${SYS_ID}`,
        `${T}/sysauto_script`,
        `${T}/sysauto_script/${SYS_ID}`,
        `${T}/discovery_schedule`,
        `${T}/discovery_schedule/${SYS_ID}`,
        "/api/now/v2/table/sys_trigger",
    ])("needs nothing for GET %s", (path) => {
        const r = req({ method: "GET", path });
        expect(classify(r).verbs).toEqual([]);
        expect(floorFor(r).reasons).toEqual([]);
    });

    // Script-bearing schedules: inserting or changing one schedules code, so execute too.
    it.each([
        ["POST", `${T}/sys_trigger`, [TRIGGER_WHY, SCRIPT_WHY]],
        ["PUT", `${T}/sys_trigger/${SYS_ID}`, [TRIGGER_WHY, SCRIPT_WHY]],
        ["PATCH", `${T}/sys_trigger/${SYS_ID}`, [TRIGGER_WHY, SCRIPT_WHY]],
        ["POST", `${T}/sysauto_script`, [DEFINITION_WHY, SCRIPT_WHY]],
        ["PUT", `${T}/sysauto_script/${SYS_ID}`, [DEFINITION_WHY, SCRIPT_WHY]],
        ["PATCH", `${T}/sysauto_script/${SYS_ID}`, [DEFINITION_WHY, SCRIPT_WHY]],
        ["POST", `${T}/sysauto`, [DEFINITION_WHY, SCRIPT_WHY]],
        ["PATCH", `${T}/sysauto/${SYS_ID}`, [DEFINITION_WHY, SCRIPT_WHY]],
    ])("floors %s %s at write and execute", (method, path, reasons) => {
        const r = req({ method, path });
        expect(classify(r).verbs.sort()).toEqual(["execute", "write"]);
        expect(floorFor(r).verbs.sort()).toEqual(["execute", "write"]);
        expect(floorFor(r).reasons).toEqual(reasons);
    });

    // Deleting a job runs nothing, and cleanup must stay possible under --deny-execute.
    it.each([
        [`${T}/sys_trigger/${SYS_ID}`, TRIGGER_WHY],
        [`${T}/sysauto_script/${SYS_ID}`, DEFINITION_WHY],
        [`${T}/sysauto/${SYS_ID}`, DEFINITION_WHY],
    ])("floors DELETE %s at write alone", (path, why) => {
        const r = req({ method: "DELETE", path });
        expect(floorFor(r).verbs).toEqual(["write"]);
        expect(floorFor(r).reasons).toEqual([why]);
    });

    // Other scheduled-job definitions: a write, not an execute.
    it.each([
        ["POST", `${T}/discovery_schedule`],
        ["PUT", `${T}/discovery_schedule/${SYS_ID}`],
        ["PATCH", `${T}/scheduled_data_import/${SYS_ID}`],
        ["DELETE", `${T}/sys_atf_schedule/${SYS_ID}`],
        ["POST", `${T}/sysauto_template`],
        ["PATCH", `${T}/sysauto_report/${SYS_ID}`],
        ["DELETE", `${T}/sysauto_pa/${SYS_ID}`],
        ["POST", `${T}/sn_cmdb_ws_reconcile_duplicate_template_schedule`],
    ])("floors %s %s at write", (method, path) => {
        const r = req({ method, path });
        expect(floorFor(r).verbs).toEqual(["write"]);
        expect(floorFor(r).reasons).toEqual([DEFINITION_WHY]);
    });

    it("a declaration cannot talk a scheduled-job insert down to a read", () => {
        const trigger = req({ method: "POST", path: `${T}/sys_trigger`, requires: READ_ONLY });
        expect(classify(trigger).verbs.sort()).toEqual(["execute", "write"]);
        const definition = req({ method: "POST", path: `${T}/discovery_schedule`, requires: READ_ONLY });
        expect(classify(definition).verbs).toEqual(["write"]);
    });

    it.each([
        "/api/now/./table/sys_trigger",
        "/api/now/table/./sys_trigger",
        "/api/now/x/../table/sys_trigger",
        "/api/now/table/sys_trigger;x=1",
        "/api/now/table;x=1/sys_trigger",
        "/api/now/table/sys_trigger;x=1/" + "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
        "/api/now/table/sys_%74rigger",
        "/api/now//table//sys_trigger",
        "/API/NOW/TABLE/SYS_TRIGGER",
        "/api/now/v1/table/sys_trigger",
        "/api/now/v2/table/sysauto_script",
        "/api/now/./table/sysauto_script;x=1",
    ])("floors the respelled POST %s", (path) => {
        expect(classify(req({ method: "POST", path, requires: READ_ONLY })).verbs.sort()).toEqual(["execute", "write"]);
    });

    it.each([
        "/api/now/table/./discovery_schedule",
        "/api/now/table/discovery_schedule;x=1",
        "/api/now/table/sysauto_template;x=1",
    ])("floors the respelled definition POST %s", (path) => {
        expect(classify(req({ method: "POST", path, requires: READ_ONLY })).verbs).toEqual(["write"]);
    });

    // Made-up tables that only share a prefix with a scheduled-job table.
    it.each([
        `${T}/sys_trigger_x`,
        `${T}/sys_trigger_x/${SYS_ID}`,
        `${T}/sysautomatic`,
        `${T}/sysautomatic/${SYS_ID}`,
        `${T}/discovery_schedule_x`,
        `${T}/x_sys_trigger`,
    ])("does not catch %s", (path) => {
        expect(floorFor(req({ method: "POST", path })).reasons).toEqual([]);
        expect(classify(req({ method: "POST", path, requires: READ_ONLY })).verbs).toEqual([]);
    });
});

describe("tier 1 — flow designer test and debug runs", () => {
    const PF = "/api/now/processflow";
    const ID = "bfd1455b53001310b6d61901a0490e0c";
    const CTX = "2774cd1398401310e30e42f7cfb620a1";

    // These run the flow for real, so they need execute as well as the default write.
    it.each([
        ["flow test", `${PF}/flow/${ID}/test`, "flow designer test run"],
        ["action test", `${PF}/action/action_types/${ID}/test`, "flow designer test run"],
        ["debug start", `${PF}/debug/start/flow-object`, "flow designer debug run"],
        ["step over", `${PF}/debug/command/${CTX}/STEP_OVER`, "flow designer debug run"],
        ["resume", `${PF}/debug/command/${CTX}/RESUME`, "flow designer debug run"],
        ["skip all", `${PF}/debug/command/${CTX}/SKIP_ALL`, "flow designer debug run"],
    ])("requires execute and write for a %s POST", (_name, path, why) => {
        const r = req({ method: "POST", path });
        expect(classify(r).verbs.sort()).toEqual(["execute", "write"]);
        expect(floorFor(r).reasons).toEqual([why]);
    });

    // The debugger reads its breakpoints over the same paths; a floor must not refuse a GET.
    it.each([
        `${PF}/debug/allowed-breakpoints/${CTX}`,
        `${PF}/debug/breakpoints/${CTX}`,
        `${PF}/operations/flow/context/${CTX}`,
        `${PF}/flow/${ID}`,
        `${PF}/debug/command/${CTX}/STEP_OVER`,
    ])("needs nothing for GET %s", (path) => {
        expect(classify(req({ method: "GET", path })).verbs).toEqual([]);
    });

    // Changing breakpoints and cancelling run nothing new. Cancel has to stay possible
    // under --deny-execute, so these are only the default write.
    it.each([
        ["set breakpoints", `${PF}/debug/breakpoints/${CTX}`],
        ["cancel", `${PF}/operations/flow/context/${CTX}/cancel`],
        ["copy", `${PF}/flow/${ID}/copy`],
    ])("leaves a %s POST at write", (_name, path) => {
        const r = req({ method: "POST", path });
        expect(classify(r).verbs).toEqual(["write"]);
        expect(floorFor(r).reasons).toEqual([]);
    });

    it("matches the method in any case", () => {
        expect(classify(req({ method: "post", path: `${PF}/flow/${ID}/test` })).verbs).toContain("execute");
    });

    it("does not fire on a path that only contains a test segment further up", () => {
        const r = req({ method: "POST", path: `${PF}/flow/${ID}/test/extra` });
        expect(classify(r).verbs).toEqual(["write"]);
    });
});

describe("tier 2 — declared", () => {
    it("lets a reading POST say so, which is what keeps `nex log` working", () => {
        // SyslogReader tails via a POST to the AJAX processor. Without this the default
        // classes it a write and every log tail is refused.
        const r = req({ method: "POST", path: "/xmlhttp.do", requires: READ_ONLY });
        expect(classify(r).verbs).toEqual([]);
    });

    it("lets a caller declare execute where the default would say write", () => {
        const r = req({
            method: "POST",
            path: "/xmlhttp.do",
            requires: { verbs: ["execute", "write"], target: "instance" },
        });
        expect(classify(r).verbs).toEqual(expect.arrayContaining(["execute", "write"]));
    });

    it("carries the declared target through", () => {
        const r = req({ method: "PUT", requires: { verbs: ["write"], target: "local" } });
        expect(classify(r).target).toBe("local");
    });

    it.each(["AJAXProgressStatusChecker", "AJAXActionSecurity"])(
        "keeps %s processor POSTs read-only",
        (processor) => {
            const r = req({
                method: "POST",
                path: "/xmlhttp.do",
                fields: { sysparm_processor: processor },
                requires: READ_ONLY,
            });
            expect(classify(r).verbs).toEqual([]);
        },
    );

    it("classifies the transaction kill POST as an instance write", () => {
        const result = classify(req({
            method: "POST",
            path: "/v_cluster_transaction_list.do",
            fields: { sysparm_checked_items: "22222222222222222222222222222222" },
        }));
        expect(result.verbs).toEqual(["write"]);
        expect(result.target).toBe("instance");
    });
});

describe("the floor cannot be lowered", () => {
    it("a declaration cannot talk a mutating GET down to a read", () => {
        const r = req({
            method: "GET",
            path: "/api/sn_appclient/appmanager/app/install",
            requires: READ_ONLY,
        });
        expect(classify(r).verbs).toEqual(["write"]);
    });

    it("a declaration cannot move a floor match off the instance", () => {
        // Otherwise `target: "local"` would be a way to opt out of the gate entirely.
        const r = req({
            method: "POST",
            path: "/sys.scripts.do",
            requires: { verbs: [], target: "local" },
        });
        const result = classify(r);
        expect(result.target).toBe("instance");
        expect(result.verbs).toContain("execute");
    });

    it("unions floor with declared rather than replacing either", () => {
        const r = req({
            method: "POST",
            path: "/sys.scripts.do",
            requires: { verbs: ["write"], target: "instance" },
        });
        expect(classify(r).verbs).toEqual(expect.arrayContaining(["execute", "write"]));
    });
});

describe("reasons", () => {
    it("reports why the floor fired, for the audit log", () => {
        const r = req({ method: "POST", path: "/sys.scripts.do" });
        expect(floorFor(r).reasons).toContain("background script execution");
    });

    it("is empty when no floor rule matched", () => {
        expect(floorFor(req({ method: "GET" })).reasons).toEqual([]);
    });
});
