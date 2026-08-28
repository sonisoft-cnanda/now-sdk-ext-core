import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ClusterTransactionManager } from "../../../../src/sn/transaction/ClusterTransactionManager";
import { ServiceNowInstance, ServiceNowSettingsInstance } from "../../../../src/sn/ServiceNowInstance";
import { InvalidParameterException } from "../../../../src/exception/InvalidParameterException";
import { READ_ONLY } from "../../../../src/policy/PolicyTypes";
import { isPolicyRefusal, refusalFor } from "../../../../src/policy/PolicyRefusal";
import { createGetCredentialsMock } from "../../__mocks__/servicenow-sdk-mocks";

const mockGetCredentials = createGetCredentialsMock();
jest.mock("@servicenow/sdk-cli/dist/auth/index.js", () => ({ getCredentials: mockGetCredentials }));

const EXECUTION_ID = "11111111111111111111111111111111";
const TRANSACTION_ID = "22222222222222222222222222222222";
const ACTION_ID = "33333333333333333333333333333333";
const SECRET = "never-return-this-session-token";
const columns = ["node_id", "user", "age", "url", "type", "foreground", "thread", "state", "query_count", "acl_time", "br_count", "br_time", "business_rule", "db_time", "event_count"];
const values = ["node-a", "test.user", "1 Minute", "/safe_test.do", "HTTP", "true", "worker-1", "Processing", "3", "0", "2", "4", "Rule", "5", "6"];
const listHtml = (rows = true) => `<table><tr>${columns.map((name) => `<th name="${name}" glide_type="string"></th>`).join("")}</tr>${rows ? `<tr sys_id="${TRANSACTION_ID}">${values.map((value) => `<td>${value}</td>`).join("")}</tr>` : ""}</table>`;
const progress = (state: string, extra: object = {}) => `<xml answer='${JSON.stringify({ state, percent_complete: "50", children: [], ...extra }).replace(/'/g, "&apos;")}'/>`;

describe("ClusterTransactionManager", () => {
    let manager: ClusterTransactionManager;
    let req: { get: jest.Mock; post: jest.Mock; getUserSession: jest.Mock };

    beforeEach(async () => {
        jest.clearAllMocks();
        const credential = await mockGetCredentials("test-instance");
        const instance = new ServiceNowInstance({ alias: "test-instance", credential } as ServiceNowSettingsInstance);
        manager = new ClusterTransactionManager(instance);
        req = { get: jest.fn(), post: jest.fn(), getUserSession: jest.fn() };
        (manager as any)._req = req;
    });

    it("polls the parent from running to success before reading all transaction fields", async () => {
        req.get.mockResolvedValueOnce({ data: `var executionID = '${EXECUTION_ID}';` });
        req.post
            .mockResolvedValueOnce({ data: progress("1", { children: [{ state: "2", percent_complete: "100" }] }) })
            .mockResolvedValueOnce({ data: progress("1") })
            .mockResolvedValueOnce({ data: progress("2", { children: [{ state: "0" }] }) });
        req.get.mockResolvedValueOnce({ data: listHtml() });

        const result = await manager.getTransactions({ pollIntervalMs: 0 });

        expect(req.post).toHaveBeenCalledTimes(3);
        expect(req.post.mock.calls.every(([request]) => request.requires === READ_ONLY)).toBe(true);
        expect(result).toEqual([{ sys_id: TRANSACTION_ID, ...Object.fromEntries(columns.map((name, i) => [name, values[i]])) }]);
    });

    it("skips polling for the platform's null execution id and returns an empty list", async () => {
        req.get.mockResolvedValueOnce({ data: `var executionID = 'null';` });
        req.get.mockResolvedValueOnce({ data: listHtml(false) });
        await expect(manager.getTransactions()).resolves.toEqual([]);
        expect(req.post).not.toHaveBeenCalled();
    });

    it("ignores list-2 selection, icon, and spacer cells", async () => {
        const html = `<table><tr>${columns.map((name) => `<th name="${name}" glide_type="string"></th>`).join("")}</tr><tr sys_id="${TRANSACTION_ID}"><td>select</td><td>icon</td>${values.map((value) => `<td>${value}</td>`).join("")}<td>spacer</td></tr></table>`;
        req.get.mockResolvedValueOnce({ data: `var executionID = 'null';` });
        req.get.mockResolvedValueOnce({ data: html });
        const result = await manager.getTransactions();
        expect(result[0].node_id).toBe("node-a");
        expect(result[0].event_count).toBe("6");
    });

    it("rejects terminal failure with platform detail", async () => {
        req.get.mockResolvedValueOnce({ data: `var executionID = '${EXECUTION_ID}';` });
        req.post.mockResolvedValueOnce({ data: progress("3", { detail_message: "one node failed" }) });
        await expect(manager.getTransactions()).rejects.toThrow("one node failed");
    });

    it("rejects an unparseable progress response without echoing its body", async () => {
        req.get.mockResolvedValueOnce({ data: `var executionID = '${EXECUTION_ID}';` });
        req.post.mockResolvedValueOnce({ data: `<private>${SECRET}</private>` });
        const error = await manager.getTransactions().catch((value) => value);
        expect(error.message).toMatch(/AJAXProgressStatusChecker/);
        expect(JSON.stringify(error)).not.toContain(SECRET);
    });

    it("rejects a missing execution id without echoing the page", async () => {
        req.get.mockResolvedValueOnce({ data: `<html>${SECRET}</html>` });
        const error = await manager.getTransactions().catch((value) => value);
        expect(error.message).toMatch(/loading_transactions/);
        expect(error.message).not.toContain(SECRET);
    });

    it("times out based on the configured bound", async () => {
        req.get.mockResolvedValueOnce({ data: `var executionID = '${EXECUTION_ID}';` });
        req.post.mockResolvedValue({ data: progress("1") });
        await expect(manager.getTransactions({ timeoutMs: 0, pollIntervalMs: 0 })).rejects.toThrow("timed out after 0 ms");
    });

    it("supports cancellation while waiting between polls", async () => {
        const controller = new AbortController();
        req.get.mockResolvedValueOnce({ data: `var executionID = '${EXECUTION_ID}';` });
        req.post.mockResolvedValueOnce({ data: progress("1") });

        const retrieval = manager.getTransactions({ pollIntervalMs: 1000, signal: controller.signal });
        await new Promise((resolve) => setImmediate(resolve));
        controller.abort();

        await expect(retrieval).rejects.toThrow("aborted");
        expect(req.post).toHaveBeenCalledTimes(1);
        expect(req.get).toHaveBeenCalledTimes(1);
    });

    it("rejects an unparseable terminal list", async () => {
        req.get.mockResolvedValueOnce({ data: `var executionID = 'null';` });
        req.get.mockResolvedValueOnce({ data: "<html>not a list</html>" });
        await expect(manager.getTransactions()).rejects.toThrow("transaction rows");
    });

    it("submits exactly one authorized identifier and does not retrieve", async () => {
        req.post.mockResolvedValueOnce({ data: `<xml><action_${ACTION_ID}><key can_execute="true" sys_id="${TRANSACTION_ID}"/></action_${ACTION_ID}></xml>` });
        req.getUserSession.mockResolvedValue({ userToken: SECRET });
        req.post.mockResolvedValueOnce({ data: listHtml() });

        await expect(manager.killTransaction(TRANSACTION_ID, { killActionSysId: ACTION_ID }))
            .resolves.toEqual({ accepted: true, sysId: TRANSACTION_ID });
        expect(req.get).not.toHaveBeenCalled();
        expect(req.post).toHaveBeenCalledTimes(2);
        expect(req.post.mock.calls[0][0].requires).toBe(READ_ONLY);
        expect(req.post.mock.calls[1][0].requires).toBeUndefined();
        expect(req.post.mock.calls[1][0].fields.sysparm_checked_items).toBe(TRANSACTION_ID);
        expect(req.post.mock.calls[1][0].fields.sysparm_checked_items).not.toContain(",");
    });

    it("rejects authorization refusal without issuing the kill POST", async () => {
        req.post.mockResolvedValueOnce({ data: `<xml><action_${ACTION_ID}><key can_execute="false" sys_id="${TRANSACTION_ID}"/></action_${ACTION_ID}></xml>` });
        await expect(manager.killTransaction(TRANSACTION_ID, { killActionSysId: ACTION_ID })).rejects.toThrow("not authorized");
        expect(req.post).toHaveBeenCalledTimes(1);
    });

    it("resolves and caches the Kill UI action", async () => {
        req.get.mockResolvedValueOnce({ data: { result: [{ sys_id: ACTION_ID, name: "Kill" }] }, bodyObject: { result: [{ sys_id: ACTION_ID, name: "Kill" }] } });
        req.post.mockResolvedValue({ data: `<xml><action_${ACTION_ID}><key can_execute="true" sys_id="${TRANSACTION_ID}"/></action_${ACTION_ID}></xml>` });
        req.getUserSession.mockResolvedValue({ userToken: SECRET });
        await manager.killTransaction(TRANSACTION_ID);
        await manager.killTransaction(TRANSACTION_ID);
        expect(req.get).toHaveBeenCalledTimes(1);
        expect(req.get.mock.calls[0][0].path).toBe("/api/now/table/sys_ui_action");
    });

    it("fails when the Kill UI action cannot be resolved uniquely", async () => {
        req.get.mockResolvedValueOnce({ data: { result: [] }, bodyObject: { result: [] } });
        await expect(manager.killTransaction(TRANSACTION_ID)).rejects.toThrow("killActionSysId");
        expect(req.post).not.toHaveBeenCalled();
    });

    it("preserves a branded central policy refusal from the mutating POST", async () => {
        req.post.mockResolvedValueOnce({ data: `<xml><action_${ACTION_ID}><key can_execute="true" sys_id="${TRANSACTION_ID}"/></action_${ACTION_ID}></xml>` });
        req.getUserSession.mockResolvedValue({ userToken: SECRET });
        req.post.mockRejectedValueOnce(refusalFor("write", "default"));
        const error = await manager.killTransaction(TRANSACTION_ID, { killActionSysId: ACTION_ID }).catch((value) => value);
        expect(isPolicyRefusal(error)).toBe(true);
    });

    it.each(["", " ", "not-a-sys-id", null])("rejects invalid transaction id %p before HTTP", async (sysId) => {
        await expect(manager.killTransaction(sysId as string)).rejects.toBeInstanceOf(InvalidParameterException);
        expect(req.get).not.toHaveBeenCalled();
        expect(req.post).not.toHaveBeenCalled();
    });

    it("rejects a platform error and strips session material", async () => {
        req.post.mockResolvedValueOnce({ data: `<xml><action_${ACTION_ID}><key can_execute="true" sys_id="${TRANSACTION_ID}"/></action_${ACTION_ID}></xml>` });
        req.getUserSession.mockResolvedValue({ userToken: SECRET });
        const platformError = new Error(`request failed; sysparm_ck=${SECRET}`);
        (platformError as any).session = { userToken: SECRET };
        req.post.mockRejectedValueOnce(platformError);
        const error = await manager.killTransaction(TRANSACTION_ID, { killActionSysId: ACTION_ID }).catch((value) => value);
        expect(error.message).not.toContain(SECRET);
        expect(JSON.stringify(error)).not.toContain(SECRET);
    });

    it("rejects a silently redirected login page", async () => {
        req.post.mockResolvedValueOnce({ data: `<xml><action_${ACTION_ID}><key can_execute="true" sys_id="${TRANSACTION_ID}"/></action_${ACTION_ID}></xml>` });
        req.getUserSession.mockResolvedValue({ userToken: SECRET });
        req.post.mockResolvedValueOnce({ data: "<form action=login.do></form>" });
        await expect(manager.killTransaction(TRANSACTION_ID, { killActionSysId: ACTION_ID })).rejects.toThrow("did not accept");
    });
});
