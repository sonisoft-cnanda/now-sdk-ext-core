/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { XMLParser } from "fast-xml-parser";
import { WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode, WorkflowGraphPort } from "./WorkflowModels";

/**
 * GraphML as spoken by the Workflow Editor's diagram processor
 * (`com.glideapp.workflow.ui.WorkflowDiagramProcessor`).
 *
 * - `<graph id>` is the wf_workflow_version sys_id; its `<data>` children are version
 *   properties and permissions (`can_checkout`, `published`, …) plus one
 *   `activity_<definition sys_id>` entry per activity type in the palette.
 * - `<node>` is a wf_activity. Careful: its `name` is the activity TYPE ("Timer") and
 *   its `description` is the activity's own name.
 * - `<port>` is a wf_condition (an exit) on a node.
 * - `<edge>` is a wf_transition; `source_port` is the condition it leaves from.
 */

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "#text",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (name) => ["graph", "node", "port", "edge", "data"].includes(name),
});

type Element = Record<string, any>;

/**
 * Errors the diagram processor reports in its response instead of a graph.
 */
export interface DiagramProcessorMessages {
    validationCritical?: string;
    validationWarning?: string;
    duplicateName?: string;
    differentDomain?: string;
}

/**
 * Parse a diagram processor response (`<xml …><graphml>…</graphml></xml>`).
 *
 * @returns The graph when the response carries one, and any reported messages
 */
export function parseDiagramResponse(xml: string): { graph?: WorkflowGraph; messages: DiagramProcessorMessages; root: Element } {
    const doc = parser.parse(xml) as Element;
    const root: Element = doc?.xml ?? {};
    const messages: DiagramProcessorMessages = {};
    const text = (key: string): string | undefined => {
        const value = root[key];
        if (value === undefined) return undefined;
        const raw = typeof value === "object" ? (value["#text"] ?? "") : String(value);
        return String(raw).trim();
    };
    if (text("validation_critical") !== undefined) messages.validationCritical = text("validation_critical");
    if (text("validation_warning") !== undefined) messages.validationWarning = text("validation_warning");
    if (text("duplicate_name") !== undefined) messages.duplicateName = text("duplicate_name");
    if (text("different_domain") !== undefined) messages.differentDomain = text("different_domain");

    const graphEl: Element | undefined = root.graphml?.graph?.[0];
    return { graph: graphEl ? toGraph(graphEl) : undefined, messages, root };
}

function dataMap(el: Element): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of (el.data ?? []) as Element[]) {
        if (d?.key === undefined) continue;
        out[String(d.key)] = d["#text"] === undefined ? "" : String(d["#text"]);
    }
    return out;
}

function num(value: string | undefined): number | undefined {
    if (value === undefined || value === "") return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function toGraph(el: Element): WorkflowGraph {
    const all = dataMap(el);
    const properties: Record<string, string> = {};
    const activityTypes: Record<string, string> = {};
    for (const [key, value] of Object.entries(all)) {
        if (/^activity_[0-9a-f]{32}$/i.test(key)) activityTypes[key.slice("activity_".length)] = value;
        else properties[key] = value;
    }

    const nodes: WorkflowGraphNode[] = ((el.node ?? []) as Element[]).map(n => {
        const d = dataMap(n);
        const node: WorkflowGraphNode = {
            id: String(n.id),
            name: d.description ?? "",
            typeName: d.name ?? "",
            activityDefinition: d.activity_definition ?? "",
            x: num(d.x),
            y: num(d.y),
            width: num(d.width),
            height: num(d.height),
            stage: d.stage || undefined,
            parent: d.parent || undefined,
            isParent: d.is_parent === "true",
            deletable: d.deleteable !== "false",
        };
        return node;
    });

    const ports: WorkflowGraphPort[] = ((el.port ?? []) as Element[]).map(p => {
        const d = dataMap(p);
        return {
            id: String(p.id),
            node: String(p.node),
            name: d.name ?? "",
            order: num(d.order) ?? 0,
            error: d.error === "true",
            event: d.event === "true",
        };
    });

    const edges: WorkflowGraphEdge[] = ((el.edge ?? []) as Element[]).map(e => ({
        id: String(e.id),
        source: String(e.source),
        sourcePort: String(e.source_port ?? ""),
        target: String(e.target),
    }));

    const bool = (key: string): boolean => properties[key] === "true";
    return {
        id: String(el.id ?? ""),
        workflowSysId: properties.workflow ?? "",
        name: properties.name ?? "",
        table: properties.table ?? "",
        published: bool("published"),
        active: bool("active"),
        readOnly: bool("read_only"),
        canCheckout: bool("can_checkout"),
        canForceCheckout: bool("can_force_checkout"),
        canPublish: bool("can_publish"),
        canDelete: bool("can_delete"),
        statusDisplay: properties.status_display ?? "",
        fullSequences: properties.full_sequences ? properties.full_sequences.split(",").filter(Boolean) : [],
        properties,
        activityTypes,
        nodes,
        ports,
        edges,
    };
}

/**
 * A node position to send to the processor.
 */
export interface GraphNodeInput {
    id: string;
    x?: number;
    y?: number;
}

/**
 * Serialize minimal GraphML for a processor write: the graph id plus the elements being
 * changed. The processor needs nothing else — the editor's copy of every graph property
 * and palette entry is ignored.
 */
export function serializeGraph(
    versionSysId: string,
    content: { nodes?: GraphNodeInput[]; edges?: WorkflowGraphEdge[] },
): string {
    const parts: string[] = [];
    for (const node of content.nodes ?? []) {
        const data: string[] = [];
        if (node.x !== undefined) data.push(`<data key="x">${Math.round(node.x)}</data>`);
        if (node.y !== undefined) data.push(`<data key="y">${Math.round(node.y)}</data>`);
        parts.push(`<node id="${attr(node.id)}">${data.join("")}</node>`);
    }
    for (const edge of content.edges ?? []) {
        parts.push(`<edge id="${attr(edge.id)}" source="${attr(edge.source)}" source_port="${attr(edge.sourcePort)}" target="${attr(edge.target)}"/>`);
    }
    return `<graphml><graph id="${attr(versionSysId)}">${parts.join("")}</graph></graphml>`;
}

function attr(value: string): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
