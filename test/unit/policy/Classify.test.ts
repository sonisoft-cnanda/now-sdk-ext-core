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

    it("requires write for sys_trigger — a scheduled job outlives the request", () => {
        const r = req({ method: "POST", path: "/api/now/table/sys_trigger" });
        expect(classify(r).verbs).toEqual(["write"]);
        expect(floorFor(r).reasons.join()).toMatch(/sys_trigger/);
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
