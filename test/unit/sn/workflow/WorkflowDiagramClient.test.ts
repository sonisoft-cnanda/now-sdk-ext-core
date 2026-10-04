import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { WorkflowDiagramClient } from "../../../../src/sn/workflow/WorkflowDiagramClient";
import { parseDiagramResponse, serializeGraph } from "../../../../src/sn/workflow/WorkflowGraphML";
import { SessionManager } from "../../../../src/comm/http/SessionManager";
import { ServiceNowInstance, ServiceNowSettingsInstance } from "../../../../src/sn/ServiceNowInstance";
import { READ_ONLY } from "../../../../src/policy/PolicyTypes";
import { createGetCredentialsMock } from "../../__mocks__/servicenow-sdk-mocks";

const mockGetCredentials = createGetCredentialsMock();
jest.mock("@servicenow/sdk-cli/dist/auth/index.js", () => ({ getCredentials: mockGetCredentials }));

const VERSION = "f4eb88282ff3c750fde4cc2bcfa4e3a3";
const WORKFLOW = "09db00282ff3c750fde4cc2bcfa4e36d";
const BEGIN = "38eb88282ff3c750fde4cc2bcfa4e3a5";
const END = "34eb88282ff3c750fde4cc2bcfa4e3a7";
const TIMER = "8feb8c682ff3c750fde4cc2bcfa4e357";
const ALWAYS = "f8eb88282ff3c750fde4cc2bcfa4e3a6";
const TIMER_ALWAYS = "0dfb84a82ff3c750fde4cc2bcfa4e3f6";
const PROCESSOR = "com.glideapp.workflow.ui.WorkflowDiagramProcessor";

/** Shaped like the processor's answer to `publish` in the captured editor session. */
const GRAPH = `<?xml version="1.0" encoding="UTF-8"?><xml sysparm_max="10000" sysparm_processor="${PROCESSOR}" sysparm_type="publish"><graphml><graph id="${VERSION}"><data key="activity_3961a1da0a0a0b5c00ecd84822f70d85">Timer</data><data key="can_delete">true</data><data key="active">true</data><data key="can_checkout">true</data><data key="warning"/><data key="name">New Test</data><data key="can_force_checkout">false</data><data key="status_display">Published</data><data key="read_only">true</data><data key="table">incident</data><data key="can_publish">false</data><data key="workflow">${WORKFLOW}</data><data key="published">true</data><data key="full_sequences">${BEGIN},${TIMER},${END}</data><data key="sys_mod_count">14</data><node id="${BEGIN}"><data key="parent"/><data key="description">Begin</data><data key="is_parent">false</data><data key="deleteable">false</data><data key="name">Begin</data><data key="x">20</data><data key="width">80</data><data key="y">20</data><data key="activity_definition">c7a5e32c0a0a0b3a002377c24ed8ea76</data><data key="height"/></node><node id="${TIMER}"><data key="parent"/><data key="stage"/><data key="name">Timer</data><data key="x">190</data><data key="width"/><data key="description">Wait &amp; see</data><data key="y">60</data><data key="is_parent">false</data><data key="activity_definition">3961a1da0a0a0b5c00ecd84822f70d85</data><data key="height"/></node><port id="${TIMER_ALWAYS}" node="${TIMER}"><data key="name">Always</data><data key="error">false</data><data key="event">false</data><data key="order">0</data></port><edge id="cdfb8c642ff3c750fde4cc2bcfa4e349" source="${TIMER}" source_port="${TIMER_ALWAYS}" target="${END}"/><edge id="f8eb88282ff3c750fde4cc2bcfa4e3a9" source="${BEGIN}" source_port="${ALWAYS}" target="${TIMER}"/></graph></graphml></xml>`;

const EMPTY = (type: string) => `<?xml version="1.0" encoding="UTF-8"?><xml sysparm_max="10000" sysparm_processor="${PROCESSOR}" sysparm_type="${type}"/>`;

describe("WorkflowGraphML", () => {
    it("parses the processor's graph into nodes, exits and transitions", () => {
        const { graph, messages } = parseDiagramResponse(GRAPH);
        expect(messages).toEqual({});
        expect(graph).toMatchObject({
            id: VERSION, workflowSysId: WORKFLOW, name: "New Test", table: "incident", published: true, active: true,
            readOnly: true, canCheckout: true, canPublish: false, canForceCheckout: false, canDelete: true,
            statusDisplay: "Published", fullSequences: [BEGIN, TIMER, END],
            activityTypes: { "3961a1da0a0a0b5c00ecd84822f70d85": "Timer" },
        });
        expect(graph.properties.warning).toBe("");
        expect(graph.properties["activity_3961a1da0a0a0b5c00ecd84822f70d85"]).toBeUndefined();
        expect(graph.nodes).toEqual([
            { id: BEGIN, name: "Begin", typeName: "Begin", activityDefinition: "c7a5e32c0a0a0b3a002377c24ed8ea76", x: 20, y: 20, width: 80, height: undefined, stage: undefined, parent: undefined, isParent: false, deletable: false },
            { id: TIMER, name: "Wait & see", typeName: "Timer", activityDefinition: "3961a1da0a0a0b5c00ecd84822f70d85", x: 190, y: 60, width: undefined, height: undefined, stage: undefined, parent: undefined, isParent: false, deletable: true },
        ]);
        expect(graph.ports).toEqual([{ id: TIMER_ALWAYS, node: TIMER, name: "Always", order: 0, error: false, event: false }]);
        expect(graph.edges).toEqual([
            { id: "cdfb8c642ff3c750fde4cc2bcfa4e349", source: TIMER, sourcePort: TIMER_ALWAYS, target: END },
            { id: "f8eb88282ff3c750fde4cc2bcfa4e3a9", source: BEGIN, sourcePort: ALWAYS, target: TIMER },
        ]);
    });

    it("surfaces validation and copy messages instead of a graph", () => {
        const warning = `<?xml version="1.0" encoding="UTF-8"?><xml sysparm_processor="${PROCESSOR}" sysparm_type="publish"><validation_warning>Validation warning. Click the validation button in the toolbar to get details:

Validate Summary  - Workflow version contains Warnings - Total checks performed:16 (Info:15, Warn:1, Critical:0)

Publish this workflow with warnings?

</validation_warning></xml>`;
        const parsed = parseDiagramResponse(warning);
        expect(parsed.graph).toBeUndefined();
        expect(parsed.messages.validationWarning).toContain("Warn:1");
        expect(parseDiagramResponse(`<xml><validation_critical>Nope</validation_critical></xml>`).messages).toEqual({ validationCritical: "Nope" });
        expect(parseDiagramResponse(`<xml><duplicate_name>Taken</duplicate_name></xml>`).messages).toEqual({ duplicateName: "Taken" });
    });

    it("serializes only what changes, escaped", () => {
        expect(serializeGraph(VERSION, { nodes: [{ id: TIMER, x: 190.4, y: 60 }, { id: END }] }))
            .toBe(`<graphml><graph id="${VERSION}"><node id="${TIMER}"><data key="x">190</data><data key="y">60</data></node><node id="${END}"></node></graph></graphml>`);
        expect(serializeGraph(VERSION, { edges: [{ id: 'a"<&>', source: BEGIN, sourcePort: ALWAYS, target: TIMER }] }))
            .toBe(`<graphml><graph id="${VERSION}"><edge id="a&quot;&lt;&amp;&gt;" source="${BEGIN}" source_port="${ALWAYS}" target="${TIMER}"/></graph></graphml>`);
    });
});

describe("WorkflowDiagramClient", () => {
    let client: WorkflowDiagramClient;
    let req: { post: jest.Mock<any> };

    beforeEach(async () => {
        const credential = await mockGetCredentials("test-instance");
        const instance = new ServiceNowInstance({ alias: "test-instance", credential } as ServiceNowSettingsInstance);
        client = new WorkflowDiagramClient(instance);
        req = { post: jest.fn() };
        jest.spyOn(SessionManager.getInstance(), "getRequest").mockReturnValue(req as any);
    });

    afterEach(() => jest.restoreAllMocks());

    const sent = (i = 0) => req.post.mock.calls[i][0] as { path: string; fields: Record<string, string>; requires?: unknown };

    it("reads a diagram as a read-only request", async () => {
        req.post.mockResolvedValueOnce({ data: GRAPH });
        const graph = await client.get(VERSION);
        expect(graph.id).toBe(VERSION);
        expect(sent()).toMatchObject({ path: "/xmlhttp.do", requires: READ_ONLY });
        expect(sent().fields).toEqual({
            sysparm_processor: PROCESSOR, sysparm_scope: "global", sysparm_want_session_messages: "true", sysparm_type: "get", id: VERSION,
        });
    });

    it("checks out and publishes as writes", async () => {
        req.post.mockResolvedValueOnce({ data: GRAPH }).mockResolvedValueOnce({ data: GRAPH });
        await client.checkout(VERSION, "New Test");
        expect(sent().fields).toMatchObject({ sysparm_type: "checkout", sys_id: VERSION, name: "New Test" });
        expect(sent().requires).toBeUndefined();
        const result = await client.publish(VERSION, false);
        expect(sent(1).fields).toMatchObject({ sysparm_type: "publish_novalidate", sys_id: VERSION });
        expect(result.graph?.published).toBe(true);
    });

    it("sends the editor's payload for dropping an activity onto a line", async () => {
        req.post.mockResolvedValueOnce({ data: EMPTY("newedgecontrolnode") });
        await client.newEdgeControlNode(VERSION, { id: TIMER, x: 190, y: 60 },
            [{ id: "f8eb88282ff3c750fde4cc2bcfa4e3a9", source: BEGIN, sourcePort: ALWAYS, target: TIMER }],
            [{ id: "cdfb8c642ff3c750fde4cc2bcfa4e349", source: TIMER, sourcePort: TIMER_ALWAYS, target: END }]);
        const fields = sent().fields;
        expect(fields.sysparm_type).toBe("newedgecontrolnode");
        expect(fields.id).toBe(VERSION);
        expect(fields.xml).toContain(`<node id="${TIMER}"><data key="x">190</data>`);
        expect(fields.changed_edges).toContain(`target="${TIMER}"`);
        expect(fields.new_edges).toContain(`source="${TIMER}"`);
    });

    it("sends empty edge lists as empty strings when deleting a node", async () => {
        req.post.mockResolvedValueOnce({ data: EMPTY("deletenode") });
        await client.deleteNode(VERSION, TIMER, []);
        expect(sent().fields).toMatchObject({ sysparm_type: "deletenode", delete_edges: "", changed_edges: "", new_edges: "" });
    });

    it("fails when the answer is not from the processor (e.g. a login page)", async () => {
        req.post.mockResolvedValueOnce({ data: "<html>login.do</html>" });
        await expect(client.get(VERSION)).rejects.toThrow(/did not answer 'get'/);
    });

    it("throws the processor's duplicate-name message", async () => {
        req.post.mockResolvedValueOnce({ data: `<?xml version="1.0"?><xml sysparm_processor="${PROCESSOR}"><duplicate_name>A workflow with that name exists</duplicate_name></xml>` });
        await expect(client.checkout(VERSION, "x")).rejects.toThrow("A workflow with that name exists");
    });
});
