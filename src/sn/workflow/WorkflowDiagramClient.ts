import { SessionManager } from "../../comm/http/SessionManager";
import { ServiceNowRequest } from "../../comm/http/ServiceNowRequest";
import { READ_ONLY } from "../../policy/PolicyTypes";
import { redactMessage, stripSecretsFromError } from "../../util/redact";
import { ServiceNowInstance } from "../ServiceNowInstance";
import { DiagramProcessorMessages, GraphNodeInput, parseDiagramResponse, serializeGraph } from "./WorkflowGraphML";
import { WorkflowGraph, WorkflowGraphEdge } from "./WorkflowModels";

const PROCESSOR = "com.glideapp.workflow.ui.WorkflowDiagramProcessor";

/**
 * Client for the Workflow Editor's diagram processor — the endpoint the legacy Workflow
 * Editor canvas uses for every structural change (`POST /xmlhttp.do` with
 * `sysparm_processor=com.glideapp.workflow.ui.WorkflowDiagramProcessor`).
 *
 * Going through it, rather than writing wf_* records directly, is what gets the
 * platform's own behaviour: checkout's deep copy of a version, publish's validation,
 * path computation and version swap, and node deletes that clean up exits and variables.
 *
 * Low level: no argument resolution or permission checks. Use WorkflowManager.
 */
export class WorkflowDiagramClient {
    private _instance: ServiceNowInstance;

    public constructor(instance: ServiceNowInstance) {
        this._instance = instance;
    }

    /** Read a version's diagram, including what the current user may do with it. */
    public async get(versionSysId: string): Promise<WorkflowGraph> {
        return this.requireGraph(await this.call("get", { id: versionSysId }, true), "get");
    }

    /** Read one activity's node and its exits. */
    public async getNode(activitySysId: string): Promise<WorkflowGraph> {
        return this.requireGraph(await this.call("getnode", { id: activitySysId }, true), "getnode");
    }

    /**
     * Check out a published version: creates a new draft version (a deep copy of
     * activities, exits, transitions, variables and stages) checked out to the caller.
     *
     * @returns The draft's diagram (`id` is the new version's sys_id)
     */
    public async checkout(versionSysId: string, name: string): Promise<WorkflowGraph> {
        return this.requireGraph(await this.call("checkout", { sys_id: versionSysId, name }), "checkout");
    }

    /** Take over a checkout held by another user. */
    public async forceCheckout(versionSysId: string): Promise<WorkflowGraph> {
        return this.requireGraph(await this.call("forcecheckout", { sys_id: versionSysId }), "forcecheckout");
    }

    /**
     * Publish a draft. With `validate`, validation findings are returned instead of
     * publishing when there are any Warn or Critical results.
     */
    public async publish(versionSysId: string, validate: boolean): Promise<{ graph?: WorkflowGraph; messages: DiagramProcessorMessages }> {
        const parsed = await this.call(validate ? "publish" : "publish_novalidate", { sys_id: versionSysId });
        return { graph: parsed.graph, messages: parsed.messages };
    }

    /**
     * Delete a version. Deleting a draft discards the checkout; deleting a workflow's
     * last version deletes the workflow.
     */
    public async delete(versionSysId: string): Promise<void> {
        await this.call("delete", { sys_id: versionSysId });
    }

    /** Set the workflow active or inactive. */
    public async setActive(versionSysId: string, active: boolean): Promise<void> {
        await this.call(active ? "activate" : "inactivate", { sys_id: versionSysId });
    }

    /** Reposition activities. */
    public async moveNodes(versionSysId: string, nodes: GraphNodeInput[]): Promise<void> {
        await this.call("movenodes", { id: versionSysId, xml: serializeGraph(versionSysId, { nodes }) });
    }

    /** Add a transition. The edge id becomes the wf_transition sys_id. */
    public async newEdge(versionSysId: string, edge: WorkflowGraphEdge): Promise<void> {
        await this.call("newedge", { id: versionSysId, xml: serializeGraph(versionSysId, { edges: [edge] }) });
    }

    /** Re-point an existing transition. */
    public async changeEdge(versionSysId: string, edge: WorkflowGraphEdge): Promise<void> {
        await this.call("changeedge", { id: versionSysId, xml: serializeGraph(versionSysId, { edges: [edge] }) });
    }

    /** Remove a transition. */
    public async deleteEdge(versionSysId: string, edge: WorkflowGraphEdge): Promise<void> {
        await this.call("deleteedge", { id: versionSysId, xml: serializeGraph(versionSysId, { edges: [edge] }) });
    }

    /**
     * What the editor sends when an activity is dropped onto a line: position the node,
     * re-point the existing transitions, and add the new ones.
     */
    public async newEdgeControlNode(
        versionSysId: string,
        node: GraphNodeInput,
        changedEdges: WorkflowGraphEdge[],
        newEdges: WorkflowGraphEdge[],
    ): Promise<void> {
        await this.call("newedgecontrolnode", {
            id: versionSysId,
            xml: serializeGraph(versionSysId, { nodes: [node] }),
            changed_edges: this.edges(versionSysId, changedEdges),
            new_edges: this.edges(versionSysId, newEdges),
        });
    }

    /**
     * Delete an activity together with its exits and variables, removing, re-pointing
     * and adding transitions as given.
     */
    public async deleteNode(
        versionSysId: string,
        activitySysId: string,
        deleteEdges: WorkflowGraphEdge[],
        changedEdges: WorkflowGraphEdge[] = [],
        newEdges: WorkflowGraphEdge[] = [],
    ): Promise<void> {
        await this.call("deletenode", {
            id: versionSysId,
            xml: serializeGraph(versionSysId, { nodes: [{ id: activitySysId }] }),
            delete_edges: this.edges(versionSysId, deleteEdges),
            changed_edges: this.edges(versionSysId, changedEdges),
            new_edges: this.edges(versionSysId, newEdges),
        });
    }

    /** Recompute stage assignments after activities change (the editor calls this after every activity save). */
    public async updateStages(versionSysId: string): Promise<void> {
        await this.call("updatestages", { id: versionSysId });
    }

    private edges(versionSysId: string, edges: WorkflowGraphEdge[]): string {
        return edges.length ? serializeGraph(versionSysId, { edges }) : "";
    }

    private requireGraph(parsed: { graph?: WorkflowGraph; messages: DiagramProcessorMessages }, type: string): WorkflowGraph {
        if (!parsed.graph) throw new Error(`The workflow diagram processor returned no diagram for '${type}'`);
        return parsed.graph;
    }

    private async call(
        type: string,
        params: Record<string, string>,
        readOnly = false,
    ): Promise<{ graph?: WorkflowGraph; messages: DiagramProcessorMessages }> {
        try {
            const response = await this.request().post<string>({
                method: "POST", path: "/xmlhttp.do", headers: null, query: null, body: null,
                responseFormat: "text",
                ...(readOnly ? { requires: READ_ONLY } : {}),
                fields: {
                    sysparm_processor: PROCESSOR,
                    sysparm_scope: "global",
                    sysparm_want_session_messages: "true",
                    sysparm_type: type,
                    ...params,
                },
            });
            const body = typeof response.data === "string" ? response.data : "";
            if (!/<xml[\s>]/.test(body) || !body.includes(PROCESSOR)) {
                throw new Error(`The workflow diagram processor did not answer '${type}' (the session may have expired)`);
            }
            const parsed = parseDiagramResponse(body);
            if (parsed.messages.duplicateName) throw new Error(parsed.messages.duplicateName);
            if (parsed.messages.differentDomain) throw new Error(parsed.messages.differentDomain);
            return { graph: parsed.graph, messages: parsed.messages };
        } catch (error) {
            if (error instanceof Error) error.message = redactMessage(error.message);
            throw stripSecretsFromError(error);
        }
    }

    private request(): ServiceNowRequest {
        // Shares the Table API's session, so reads and processor writes see the same user state.
        return SessionManager.getInstance().getRequest(this._instance);
    }
}
