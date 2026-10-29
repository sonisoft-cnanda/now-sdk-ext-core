/**
 * The gate at the HTTP layer.
 *
 * Placed at `getRequestConfig`, alongside the cross-instance binding guard, because
 * that is the one point every request passes through — both SessionManager-managed
 * handlers and the ~21 managers that build their own ServiceNowRequest. Tested here
 * rather than through a manager so the assertion is about the chokepoint itself.
 *
 * Follows the shape of InstanceBindingGuard.test.ts, which pins the sibling guard.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { Logger } from "../../../src/util/Logger";
import { RequestHandler } from "../../../src/comm/http/RequestHandler";
import { ServiceNowInstance } from "../../../src/sn/ServiceNowInstance";
import { MockAuthenticationHandler } from "../__mocks__/servicenow-sdk-mocks";
import {
    allowAllLayer,
    denyLayer,
    grantLayer,
    installPolicy,
    resetPolicyForTests,
} from "../../../src/policy/Policy";
import { isPolicyRefusal } from "../../../src/policy/PolicyRefusal";
import { READ_ONLY } from "../../../src/policy/PolicyTypes";

function anInstance(alias: string): ServiceNowInstance {
    return new ServiceNowInstance({ alias, host: `${alias}.service-now.com` });
}

let handler: RequestHandler;

beforeEach(() => {
    handler = new RequestHandler(new MockAuthenticationHandler() as never);
    const instance = anInstance("dev");
    handler.bindInstance(instance);
    handler.setSession({ instanceUrl: "https://dev.service-now.com" }, instance);
});

afterEach(() => resetPolicyForTests());

const request = (over: Record<string, unknown> = {}): never =>
    ({ method: "GET", path: "/api/now/table/incident", query: {}, headers: {}, ...over }) as never;

describe("with no policy installed", () => {
    it("permits a write, so embedding the library is unchanged", async () => {
        await expect(
            (handler as never as { getRequestConfig(r: never): Promise<unknown> }).getRequestConfig(
                request({ method: "POST" }),
            ),
        ).resolves.toBeDefined();
    });
});

describe("with a deny-by-default policy installed", () => {
    beforeEach(() => installPolicy([]));

    const config = (r: never) =>
        (handler as never as { getRequestConfig(x: never): Promise<unknown> }).getRequestConfig(r);

    it("still permits reads", async () => {
        await expect(config(request({ method: "GET" }))).resolves.toBeDefined();
    });

    it("refuses a POST", async () => {
        await expect(config(request({ method: "POST" }))).rejects.toThrow(/write/i);
    });

    it("throws a branded refusal, not a generic error", async () => {
        // executeScriptAuto distinguishes refusals from failures by this predicate; if
        // it stops being branded, a refused script silently runs via sys_trigger.
        const error = await config(request({ method: "PUT" })).catch((e: unknown) => e);
        expect(isPolicyRefusal(error)).toBe(true);
    });

    it("refuses a mutating GET that the verb would have waved through", async () => {
        await expect(
            config(request({ method: "GET", path: "/api/sn_appclient/appmanager/app/install" })),
        ).rejects.toThrow(/write/i);
    });

    it("refuses sysparm_delete_all even riding in form fields", async () => {
        await expect(
            config(request({ method: "POST", path: "/xmlhttp.do", fields: { sysparm_delete_all: "true" } })),
        ).rejects.toThrow(/write/i);
    });

    it("permits a POST that declared itself a read — this is what keeps `nex log` alive", async () => {
        await expect(
            config(request({ method: "POST", path: "/xmlhttp.do", requires: READ_ONLY })),
        ).resolves.toBeDefined();
    });

    it("reports the deciding layer on the refusal", async () => {
        const error = await config(request({ method: "POST" })).catch((e: unknown) => e);
        expect(isPolicyRefusal(error) && error.decision.decidingLayer).toBe("default");
    });
});

describe("with a grant installed", () => {
    it("permits the granted verb", async () => {
        installPolicy([grantLayer("test-grant", ["write"])]);
        await expect(
            (handler as never as { getRequestConfig(r: never): Promise<unknown> }).getRequestConfig(
                request({ method: "POST" }),
            ),
        ).resolves.toBeDefined();
    });

    it("still refuses execute when only write was granted", async () => {
        installPolicy([grantLayer("test-grant", ["write"])]);
        await expect(
            (handler as never as { getRequestConfig(r: never): Promise<unknown> }).getRequestConfig(
                request({ method: "POST", path: "/sys.scripts.do" }),
            ),
        ).rejects.toThrow(/execute/i);
    });

    it("a deny layer above the grant wins — the production guarantee, at the wire", async () => {
        installPolicy([denyLayer("env-deny", ["write"]), grantLayer("cli-flag", ["write"])]);
        const error = await (handler as never as { getRequestConfig(r: never): Promise<unknown> })
            .getRequestConfig(request({ method: "POST" }))
            .catch((e: unknown) => e);
        expect(isPolicyRefusal(error) && error.decision.decidingLayer).toBe("env-deny");
    });
});

describe("--deny-execute on flow designer runs", () => {
    // What nex installs for `--deny-execute`: a deny layer above its permissive default.
    beforeEach(() => installPolicy([denyLayer("deny-execute", ["execute"]), allowAllLayer()]));

    const config = (r: never) =>
        (handler as never as { getRequestConfig(x: never): Promise<unknown> }).getRequestConfig(r);
    const PF = "/api/now/processflow";
    const CTX = "2774cd1398401310e30e42f7cfb620a1";

    it("refuses a flow test run", async () => {
        await expect(config(request({ method: "POST", path: `${PF}/flow/bfd1455b53001310b6d61901a0490e0c/test` })))
            .rejects.toThrow(/execute/i);
    });

    it("refuses starting a debug run and stepping one", async () => {
        await expect(config(request({ method: "POST", path: `${PF}/debug/start/flow-object` }))).rejects.toThrow(/execute/i);
        await expect(config(request({ method: "POST", path: `${PF}/debug/command/${CTX}/RESUME` }))).rejects.toThrow(/execute/i);
    });

    it("still lets a debug run be cancelled and its breakpoints cleared", async () => {
        await expect(config(request({ method: "POST", path: `${PF}/operations/flow/context/${CTX}/cancel` }))).resolves.toBeDefined();
        await expect(config(request({ method: "POST", path: `${PF}/debug/breakpoints/${CTX}` }))).resolves.toBeDefined();
    });
});

describe("scheduled jobs at the wire (NSE-28)", () => {
    const config = (r: never) =>
        (handler as never as { getRequestConfig(x: never): Promise<unknown> }).getRequestConfig(r);
    const TRIGGER = "/api/now/table/sys_trigger";
    const SYS_ID = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

    it("lets --read-only read sys_trigger, as InstanceHealth does for stuck jobs", async () => {
        installPolicy([denyLayer("read-only", ["write", "execute"]), allowAllLayer()]);
        await expect(config(request({ method: "GET", path: TRIGGER, query: { sysparm_query: "state=0" } })))
            .resolves.toBeDefined();
        await expect(config(request({ method: "POST", path: TRIGGER }))).rejects.toThrow(/write/i);
    });

    it("refuses scheduling a script under --deny-execute, but not deleting a job", async () => {
        installPolicy([denyLayer("deny-execute", ["execute"]), allowAllLayer()]);
        await expect(config(request({ method: "POST", path: TRIGGER }))).rejects.toThrow(/execute/i);
        await expect(config(request({ method: "PATCH", path: `/api/now/table/sysauto_script/${SYS_ID}` })))
            .rejects.toThrow(/execute/i);
        await expect(config(request({ method: "DELETE", path: `${TRIGGER}/${SYS_ID}` }))).resolves.toBeDefined();
        // discovery_schedule extends sysauto_script and inherits its script field.
        await expect(config(request({ method: "POST", path: "/api/now/table/discovery_schedule" })))
            .rejects.toThrow(/execute/i);
        await expect(config(request({ method: "POST", path: "/api/now/table/scheduled_data_import" }))).resolves.toBeDefined();
    });
});

describe("logging a refused request", () => {
    beforeEach(() => installPolicy([denyLayer("deny-execute", ["execute"]), allowAllLayer()]));

    it("does not log the payload of a request that was refused before it was sent", async () => {
        const logged = jest.spyOn(Logger.prototype, "error");
        const error = await handler.post(request({
            method: "POST",
            path: "/api/now/processflow/flow/bfd1455b53001310b6d61901a0490e0c/test",
            json: { flow: { name: "secret-flow-definition" }, outputMap: { current: "secret-input" } },
        })).catch((e: unknown) => e);
        expect(isPolicyRefusal(error)).toBe(true);
        expect(JSON.stringify(logged.mock.calls)).not.toContain("secret");
        logged.mockRestore();
    });
});
