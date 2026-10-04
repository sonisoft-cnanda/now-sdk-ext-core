import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { VariableDefinitions } from "../../../../src/sn/variables/VariableDefinitions";
import { SessionManager } from "../../../../src/comm/http/SessionManager";
import { ServiceNowInstance, ServiceNowSettingsInstance } from "../../../../src/sn/ServiceNowInstance";
import { InvalidParameterException } from "../../../../src/exception/InvalidParameterException";
import { createGetCredentialsMock } from "../../__mocks__/servicenow-sdk-mocks";

const mockGetCredentials = createGetCredentialsMock();
jest.mock("@servicenow/sdk-cli/dist/auth/index.js", () => ({ getCredentials: mockGetCredentials }));

const MODEL = "var__m_3961a1da0a0a0b5c00ecd84822f70d85";

describe("VariableDefinitions", () => {
    let definitions: VariableDefinitions;
    let req: { executeRequest: jest.Mock<any> };

    beforeEach(async () => {
        const credential = await mockGetCredentials("test-instance");
        const instance = new ServiceNowInstance({ alias: "test-instance", credential } as ServiceNowSettingsInstance);
        definitions = new VariableDefinitions(instance);
        req = { executeRequest: jest.fn() };
        jest.spyOn(SessionManager.getInstance(), "getRequest").mockReturnValue(req as any);
    });

    afterEach(() => jest.restoreAllMocks());

    const ok = (result: unknown[]) => ({ status: 200, bodyObject: { result } });

    it("lists variables in order with choices, skipping layout elements", async () => {
        req.executeRequest
            .mockResolvedValueOnce(ok([
                { sys_id: "1", element: ".begin_split", column_label: "", internal_type: "formatter", order: "1" },
                { sys_id: "2", element: "timer_type", column_label: "Timer based on", internal_type: "string", default_value: "", choice: "1", order: "310", mandatory: "false" },
                { sys_id: "3", element: "relative_duration", column_label: "Relative duration", internal_type: "reference", reference: "cmn_relative_duration", choice: "3", order: "1310" },
                { sys_id: "4", element: "script", column_label: "Script", internal_type: "script", default_value: "answer = 0;", choice: "0", order: "3000", hint: "seconds" },
            ]))
            .mockResolvedValueOnce(ok([
                { element: "timer_type", value: "NULL_OVERRIDE", label: "A user specified duration" },
                { element: "timer_type", value: "script", label: "Script" },
            ]));

        const result = await definitions.list(MODEL);

        expect(result).toEqual([
            { sysId: "2", model: MODEL, element: "timer_type", label: "Timer based on", internalType: "string", defaultValue: "", mandatory: false, order: 310,
                choices: [{ value: "", label: "A user specified duration" }, { value: "script", label: "Script" }] },
            { sysId: "3", model: MODEL, element: "relative_duration", label: "Relative duration", internalType: "reference", defaultValue: "", mandatory: false, order: 1310, reference: "cmn_relative_duration" },
            { sysId: "4", model: MODEL, element: "script", label: "Script", internalType: "script", defaultValue: "answer = 0;", mandatory: false, order: 3000, hint: "seconds" },
        ]);
        expect(req.executeRequest.mock.calls[0][0].query).toMatchObject({ sysparm_query: `name=${MODEL}^active=true^ORDERBYorder` });
        expect(req.executeRequest.mock.calls[1][0].query).toMatchObject({ sysparm_query: `name=${MODEL}^language=en^inactive=false^ORDERBYsequence` });

        await definitions.list(MODEL);
        expect(req.executeRequest).toHaveBeenCalledTimes(2);
    });

    it("rejects names that are not variable models", async () => {
        await expect(definitions.list("sys_user")).rejects.toThrow(InvalidParameterException);
        await expect(definitions.list("var__m_x^ORname=y")).rejects.toThrow(InvalidParameterException);
    });

    it("rejects a language that is not a language code", async () => {
        await expect(definitions.list(MODEL, { language: "en^element=script" })).rejects.toThrow(InvalidParameterException);
        expect(req.executeRequest).not.toHaveBeenCalled();
    });

    it("asks again while a read is queued (202)", async () => {
        req.executeRequest.mockResolvedValueOnce({ status: 202, bodyObject: null }).mockResolvedValueOnce(ok([]));
        await expect(definitions.list(MODEL)).resolves.toEqual([]);
        expect(req.executeRequest).toHaveBeenCalledTimes(2);
    });

    it("does not cache failures", async () => {
        req.executeRequest.mockResolvedValueOnce({ status: 500, bodyObject: null }).mockResolvedValueOnce(ok([]));
        await expect(definitions.list(MODEL)).rejects.toThrow(/Failed to read var_dictionary/);
        await expect(definitions.list(MODEL)).resolves.toEqual([]);
    });
});
