import { WorkflowExport } from "./WorkflowModels";
import { buildOutline, OutlineItem, WORKFLOW_EXIT, WorkflowStructure } from "./WorkflowStructure";
import { flowHintFor } from "./WorkflowFlowHints";

/**
 * Views of a legacy workflow export that an agent (or a person) can reason on:
 * a nested, flow-like outline, a flat node list, a structural analysis and a Mermaid graph.
 */

export interface WorkflowViewOptions {
    /** Include settings left at their default */
    allValues?: boolean;

    /** Print scripts in full instead of the first 25 lines */
    fullScripts?: boolean;

    /** Annotate steps with a likely Flow Designer construct */
    flowHints?: boolean;
}

const SCRIPT_TYPES = new Set(["script", "script_plain", "script_server", "email_script"]);
const SCRIPT_PREVIEW_LINES = 25;
const SCRATCH_WRITE = /workflow\.scratchpad\.(\w+)\s*(?:=(?!=)|\+=|-=)/g;
const SCRATCH_ANY = /workflow\.scratchpad\.(\w+)/g;
const CATALOG_VAR = /current\.variables\.(\w+)/g;
const TEMPLATE_FIELD = /(?:^|\^)(?:NQ)?([a-z_][\w.]*)(?:=|!=|LIKE|IN|ISEMPTY|ISNOTEMPTY)/gi;

// ------------------------------------------------------------------ helpers

function oneLine(text: string, limit = 160): string {
    const flat = String(text).replace(/\s+/g, " ").trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** Lines in a script, not counting a final line break. */
export function lineCount(text: string): number {
    return String(text ?? "").replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** Whether an exit's condition is just `activity.result == '<exit>'` (or always true). */
export function trivialCondition(name: string, condition: string): boolean {
    const c = (condition ?? "").replace(/\s+/g, "").toLowerCase();
    const n = name.toLowerCase();
    return c === "" || c === "true" || c === `activity.result=='${n}'` || c === `activity.result=="${n}"`;
}

/** Name catalog variables referenced by sys_id (`variables.<sys_id>`) using the export's references. */
export function nameCatalogVariables(data: WorkflowExport, value: string): string {
    return value.replace(/variables\.([0-9a-f]{32})/gi, (match: string, id: string) =>
        data.references?.[id] ? `variables.${data.references[id].display}` : match);
}

function settings(s: WorkflowStructure, sysId: string, opts: WorkflowViewOptions, indent: string): string[] {
    const a = s.activity(sysId);
    const lines: string[] = [];
    if (a.subflow) lines.push(`${indent}- runs workflow "${a.subflow.name}" (${a.subflow.workflowSysId})`);
    const values = new Map(a.variables.map(v => [v.element, v.value]));
    for (const v of a.variables) {
        if (v.isDefault && !opts.allValues) continue;
        // The form stores a relative duration even when the due date/timer does not use one.
        if (v.element === "relative_duration" && !opts.allValues && (values.get("timer_type") ?? "") !== "relative_duration") continue;
        const value = v.value ?? "";
        if (SCRIPT_TYPES.has(v.type) || value.includes("\n")) {
            const body = value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "").split("\n");
            const shown = opts.fullScripts ? body : body.slice(0, SCRIPT_PREVIEW_LINES);
            lines.push(`${indent}- ${v.element} (${v.label}):`);
            lines.push(...shown.map(line => `${indent}    | ${line}`));
            if (shown.length < body.length) lines.push(`${indent}    | … ${body.length - shown.length} more lines (full scripts)`);
            continue;
        }
        let display = v.display && v.display !== value ? `  (${v.display})` : "";
        const named = nameCatalogVariables(s.data, value);
        if (named !== value && !display) display = "  (catalog variables named)";
        lines.push(`${indent}- ${v.element} = ${oneLine(named, 240)}${display}`);
    }
    for (const [key, value] of Object.entries(a.input ?? {})) {
        lines.push(`${indent}- input.${key} = ${oneLine(typeof value === "string" ? value : JSON.stringify(value), 240)}`);
    }
    return lines;
}

function label(s: WorkflowStructure, sysId: string, opts: WorkflowViewOptions, number?: number): string {
    const a = s.activity(sysId);
    let text = `${number ? `${number}. ` : ""}${a.name || "(unnamed)"}`;
    if (a.type && a.type !== a.name) text += ` [${a.type}]`;
    if (s.waits(sysId)) text += " [WAIT]";
    if (s.isDesigner(sysId)) text += " [DESIGNER]";
    const stage = s.data.stages?.find(st => st.sysId === a.stage);
    if (stage) text += `  (stage: ${stage.name})`;
    if (opts.flowHints) {
        const hint = flowHintFor(s, sysId);
        if (hint) text += `  ≈ ${hint}`;
    }
    return text;
}

function header(s: WorkflowStructure): string[] {
    const w = s.data.workflow ?? ({} as Partial<WorkflowExport["workflow"]>);
    const v = s.data.version ?? ({} as Partial<WorkflowExport["version"]>);
    let state = "retired";
    if (v.published) state = "published";
    else if (v.checkedOut) state = "draft";
    const lines = [`# ${w.name}  (wf_workflow ${w.sysId}, version ${v.sysId} ${state}${v.active ? "" : ", inactive"}, `
        + `table ${w.table || "global"}, scope ${w.scope || "global"})`];
    if (w.description) lines.push(oneLine(w.description, 400));
    if (s.data.inputs?.length) {
        lines.push(`inputs: ${s.data.inputs.map(i => `${i.name}:${i.type}${i.mandatory ? "*" : ""}`).join(", ")}`);
    }
    const trigger: string[] = [];
    if (v.condition) trigger.push(`condition = ${v.condition}`);
    if (v.conditionType) trigger.push(`condition type = ${v.conditionType}`);
    for (const item of s.data.usedBy?.catalogItems ?? []) trigger.push(`catalog item "${item.name}"${item.active ? "" : " (inactive)"}`);
    for (const parent of s.data.usedBy?.parentWorkflows ?? []) trigger.push(`subflow of "${parent.name}"`);
    if (v.runMultiple) trigger.push("run multiple = true");
    lines.push(`TRIGGER ${trigger.length ? trigger.join("; ") : "(none: started by script or as a subflow)"}`);
    if (s.data.stages?.length) lines.push(`stages: ${[...s.data.stages].sort((a, b) => a.order - b.order).map(st => st.name).join(" → ")}`);
    return lines;
}

// ------------------------------------------------------------------ outline

/**
 * The workflow as a nested, flow-like outline: numbered steps, decisions ("on Approved:"),
 * guard clauses, parallel branches and where they rejoin, loops ("back to step N"),
 * [WAIT] on steps that park the workflow, and each step's non-default settings.
 */
export function renderWorkflowOutline(data: WorkflowExport, opts: WorkflowViewOptions = {}): string {
    const s = new WorkflowStructure(data);
    const outline = buildOutline(s);
    const out = header(s);
    const ref = (target: string): string => `${outline.numbers.get(target) ?? "?"} (${s.activity(target).name})`;

    const render = (items: OutlineItem[], depth: number): void => {
        const pad = "  ".repeat(depth);
        for (const item of items) {
            switch (item.kind) {
                case "end": {
                    const name = s.activity(item.activity).name;
                    out.push(`${pad}${!name || name === "End" ? "■ End" : `■ End (${name})`}`);
                    break;
                }
                case "goto":
                    out.push(`${pad}→ continue at step ${ref(item.target)}`);
                    break;
                case "rejoinsBelow":
                    out.push(`${pad}→ rejoins below`);
                    break;
                case "rejoin":
                    out.push(item.withoutJoin
                        ? `${pad}↳ paths rejoin WITHOUT a Join — what follows runs once per branch:`
                        : `${pad}↳ paths rejoin:`);
                    break;
                case "step": {
                    out.push(`${pad}${label(s, item.activity, opts, item.number)}`);
                    out.push(...settings(s, item.activity, opts, `${pad}     `));
                    for (const loop of item.loops) out.push(`${pad}  ↻ on ${loop.exit}: back to step ${ref(loop.target)}`);
                    for (const dead of item.deadExits) out.push(`${pad}  on ${dead.name}: (no transition — the workflow stops here)`);
                    for (const branch of item.branches) {
                        let inner = depth + 1;
                        if (branch.exit !== undefined) {
                            const shown = trivialCondition(branch.exit, branch.condition) ? "" : `  [${oneLine(branch.condition, 120)}]`;
                            out.push(`${pad}  on ${branch.exit}:${shown}`);
                            inner = depth + 2;
                        }
                        if (branch.lanes.length > 1) {
                            out.push(`${"  ".repeat(inner)}in parallel:`);
                            branch.lanes.forEach((lane, k) => {
                                out.push(`${"  ".repeat(inner + 1)}branch ${k + 1}:`);
                                render(lane, inner + 2);
                            });
                        } else {
                            render(branch.lanes[0], inner);
                        }
                    }
                    if (item.directExits.length) out.push(`${pad}  on ${item.directExits.join(" / ")} ↓`);
                    if (item.mainExit) {
                        const shown = trivialCondition(item.mainExit.name, item.mainExit.condition) ? "" : `  [${oneLine(item.mainExit.condition, 120)}]`;
                        out.push(`${pad}  on ${item.mainExit.name}${shown} ↓`);
                    }
                    break;
                }
            }
        }
    };

    render(outline.main, 0);
    if (outline.unreachable.length) out.push("", "UNREACHABLE — nothing transitions here from Begin:");
    outline.unreachable.forEach((sequence, i) => {
        if (i) out.push("");
        render(sequence, 1);
    });
    return out.map(line => line.trimEnd()).join("\n");
}

// ------------------------------------------------------------------ nodes

/** Every activity flat: settings, where it is entered from, and each exit with its targets. */
export function renderWorkflowNodes(data: WorkflowExport, opts: WorkflowViewOptions = {}): string {
    const s = new WorkflowStructure(data);
    const out = header(s);
    const order = [...s.activities.keys()].sort((a, b) =>
        (Number(!s.reachable.has(a)) - Number(!s.reachable.has(b))) || s.compare(a, b));
    for (const id of order) {
        out.push("");
        out.push(`${label(s, id, opts)}   ${id}${s.reachable.has(id) ? "" : "   UNREACHABLE"}`);
        out.push(...settings(s, id, opts, "     "));
        const sources = s.incoming(id).map(i => `${s.activity(i.from).name} (${s.exitName(i.from, i.exit)})`);
        if (sources.length) out.push(`     from: ${sources.join("; ")}`);
        for (const e of s.exits(id)) {
            const targets = [...e.forward.map(t => s.activity(t).name), ...e.loop.map(t => `${s.activity(t).name} ↻`)];
            const shown = trivialCondition(e.name, e.condition) ? "" : ` [${oneLine(e.condition, 120)}]`;
            out.push(`     ${e.name}${shown} → ${targets.length ? targets.join(", ") : "(no transition)"}`);
        }
    }
    return out.map(line => line.trimEnd()).join("\n");
}

// ------------------------------------------------------------------ analysis

/** Structure, risks and data flow of a workflow version. */
export interface WorkflowAnalysis {
    activityCount: number;
    transitionCount: number;
    activitiesByType: Record<string, number>;

    /** Begin-to-end paths, loops ignored (capped at 1e9) */
    pathCount: number;

    waits: string[];
    decisions: Array<{ activity: string; exits: Array<{ name: string; targets: string[]; loops: string[] }>; rejoinsAt?: string }>;
    parallelSplits: Array<{ activity: string; exit: string; targets: string[]; rejoinsAt?: string; rejoinIsJoin: boolean }>;

    /** Steps after a parallel split, reached by several branches without a Join: they run once per branch */
    mergesWithoutJoin: Array<{ activity: string; splitAt: string }>;

    loops: Array<{ from: string; exit: string; to: string; cappedBy?: string }>;
    deadExits: Array<{ activity: string; exit: string }>;
    unreachable: string[];
    ends: string[];

    /** workflow.scratchpad keys: who sets and who reads them */
    scratchpad: Array<{ key: string; setBy: string[]; usedBy: string[] }>;

    /** Catalog variables read, by name, with the steps reading them */
    catalogVariables: Array<{ name: string; readBy: string[] }>;

    /** Non-default scripts */
    scripts: Array<{ activity: string; element: string; lines: number }>;

    /** Fields set by template values (Set Values, task templates) */
    templateFields: Array<{ activity: string; element: string; fields: string[] }>;

    subflows: Array<{ activity: string; workflow: string; workflowSysId: string }>;
    designerActivities: string[];
}

/** Analyze a workflow version. Activity references are sys_ids. */
export function analyzeWorkflow(data: WorkflowExport): WorkflowAnalysis {
    const s = new WorkflowStructure(data);
    const ids = [...s.activities.keys()].sort((a, b) => s.compare(a, b));
    const byType: Record<string, number> = {};
    for (const id of ids) byType[s.activity(id).type] = (byType[s.activity(id).type] ?? 0) + 1;

    const counts = new Map<string, number>();
    const paths = (n: string): number => {
        if (counts.has(n)) return counts.get(n);
        counts.set(n, 0);
        const next = s.forward(n);
        const total = next.length ? Math.min(next.reduce((sum, t) => sum + paths(t), 0), 1e9) : 1;
        counts.set(n, total);
        return total;
    };

    const reachable = ids.filter(id => s.reachable.has(id));
    const merge = (id: string): string | undefined => {
        const m = s.mergeOf(id);
        return m === WORKFLOW_EXIT ? undefined : m;
    };
    const splits = reachable.flatMap(id => s.exits(id).filter(e => e.forward.length > 1).map(e => ({ id, exit: e })));

    const risky = new Map<string, { activity: string; splitAt: string }>();
    for (const { id, exit } of splits) {
        const reaches = exit.forward.map(t => s.reachUntilJoin(t));
        for (const m of s.activities.keys()) {
            if (exit.forward.includes(m) || s.isJoin(m) || s.isEnd(m)) continue;
            const arriving = s.incoming(m).filter(i => !s.backEdges.has(`${i.from}|${i.exit}|${m}`));
            if (reaches.filter(r => r.has(m)).length > 1 && arriving.length > 1) risky.set(`${m}|${id}`, { activity: m, splitAt: id });
        }
    }

    const writes = new Map<string, Set<string>>();
    const reads = new Map<string, Set<string>>();
    const catalog = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, key: string, id: string): void => {
        map.set(key, (map.get(key) ?? new Set<string>()).add(id));
    };
    for (const id of ids) {
        const a = s.activity(id);
        const texts = [...a.variables.filter(v => !v.isDefault).map(v => v.value ?? ""), JSON.stringify(a.input ?? {})];
        for (const text of texts) {
            for (const m of text.matchAll(SCRATCH_WRITE)) add(writes, m[1], id);
            for (const m of text.matchAll(SCRATCH_ANY)) add(reads, m[1], id);
            for (const m of text.matchAll(CATALOG_VAR)) add(catalog, m[1], id);
            for (const m of text.matchAll(/variables\.([0-9a-f]{32})/gi)) add(catalog, data.references?.[m[1]]?.display ?? m[1], id);
        }
    }

    return {
        activityCount: ids.length,
        transitionCount: data.transitions?.length ?? 0,
        activitiesByType: byType,
        pathCount: s.begin ? paths(s.begin) : 0,
        waits: reachable.filter(id => s.waits(id)),
        decisions: reachable.filter(id => s.activity(id).exits.length > 1).map(id => ({
            activity: id,
            exits: s.exits(id).map(e => ({ name: e.name, targets: e.forward, loops: e.loop })),
            rejoinsAt: merge(id),
        })),
        parallelSplits: splits.map(({ id, exit }) => ({
            activity: id, exit: exit.name, targets: exit.forward, rejoinsAt: merge(id), rejoinIsJoin: !!merge(id) && s.isJoin(merge(id)),
        })),
        mergesWithoutJoin: [...risky.values()].sort((a, b) => s.compare(a.activity, b.activity) || s.compare(a.splitAt, b.splitAt)),
        loops: [...s.backEdges].map(key => key.split("|"))
            .sort((a, b) => s.compare(a[0], b[0]) || s.exitName(a[0], a[1]).localeCompare(s.exitName(b[0], b[1])))
            .map(([from, exit, to]) => {
                const guard = ids.find(x => s.activity(x).type === "Turnstile" && s.reach(to).has(x) && s.reach(x).has(from));
                return { from, exit: s.exitName(from, exit), to, ...(guard ? { cappedBy: guard } : {}) };
            }),
        deadExits: reachable.filter(id => !s.isEnd(id))
            .flatMap(id => s.exits(id).filter(e => !e.forward.length && !e.loop.length).map(e => ({ activity: id, exit: e.name }))),
        unreachable: ids.filter(id => !s.reachable.has(id)),
        ends: ids.filter(id => s.isEnd(id)),
        scratchpad: [...reads.keys()].sort().map(key => {
            const setBy = [...(writes.get(key) ?? [])];
            return { key, setBy, usedBy: [...reads.get(key)].filter(id => !setBy.includes(id)) };
        }),
        catalogVariables: [...catalog.keys()].sort().map(name => ({ name, readBy: [...catalog.get(name)] })),
        scripts: ids.flatMap(id => s.activity(id).variables
            .filter(v => SCRIPT_TYPES.has(v.type) && !v.isDefault)
            .map(v => ({ activity: id, element: v.element, lines: lineCount(v.value) }))),
        templateFields: ids.flatMap(id => s.activity(id).variables
            .filter(v => v.type === "template_value" && v.value)
            .map(v => ({ activity: id, element: v.element, fields: [...new Set([...v.value.matchAll(TEMPLATE_FIELD)].map(m => m[1]))].filter(f => f !== "EQ").sort() }))),
        subflows: ids.filter(id => s.activity(id).subflow).map(id => ({
            activity: id, workflow: s.activity(id).subflow.name, workflowSysId: s.activity(id).subflow.workflowSysId,
        })),
        designerActivities: ids.filter(id => s.isDesigner(id)),
    };
}

/** The analysis as text. */
export function renderWorkflowAnalysis(data: WorkflowExport): string {
    const s = new WorkflowStructure(data);
    const a = analyzeWorkflow(data);
    const name = (id: string): string => s.activity(id)?.name ?? id;
    const typed = (id: string): string => `${name(id)} [${s.activity(id).type}]`;
    const out = header(s);
    out.push("");
    out.push(`ACTIVITIES ${a.activityCount}: ${Object.entries(a.activitiesByType).sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0])).map(([t, c]) => `${t} ×${c}`).join(", ")}`);
    out.push(`TRANSITIONS ${a.transitionCount}`);
    if (s.begin) out.push(`PATHS Begin → end (ignoring loops): ${a.pathCount}`);
    out.push(`WAITS (the workflow parks here): ${a.waits.length ? a.waits.map(typed).join(", ") : "none"}`);
    if (a.decisions.length) {
        out.push("DECISIONS:");
        for (const d of a.decisions) {
            const parts = d.exits.map(e => {
                const dest = [...e.targets.map(name), ...e.loops.map(t => `${name(t)} ↻`)];
                return `${e.name} → ${dest.length ? dest.join(", ") : "(none)"}`;
            });
            out.push(`  ${typed(d.activity)}: ${parts.join("; ")}${d.rejoinsAt ? `   — paths rejoin at ${name(d.rejoinsAt)}` : ""}`);
        }
    }
    if (a.parallelSplits.length) {
        out.push("PARALLEL SPLITS (one exit, several lines — all run):");
        for (const p of a.parallelSplits) {
            const rejoin = p.rejoinsAt ? `   — rejoin at ${typed(p.rejoinsAt)}` : "   — never rejoin (first End wins)";
            out.push(`  ${name(p.activity)} (${p.exit}) → ${p.targets.map(name).join(", ")}${rejoin}`);
        }
    }
    if (a.mergesWithoutJoin.length) {
        out.push("MERGES WITHOUT A JOIN after a parallel split (these run once per arriving branch):");
        out.push(...a.mergesWithoutJoin.map(m => `  ${typed(m.activity)} — branches from ${name(m.splitAt)}`));
    }
    if (a.loops.length) {
        out.push("LOOPS:");
        out.push(...a.loops.map(l => `  ${name(l.from)} (${l.exit}) ↻ back to ${name(l.to)}${l.cappedBy ? `   — capped by Turnstile ${name(l.cappedBy)}` : ""}`));
    }
    if (a.deadExits.length) {
        out.push("EXITS WITH NO TRANSITION (the workflow can stop there; a validation warning):");
        out.push(...a.deadExits.map(d => `  ${name(d.activity)}: ${d.exit}`));
    }
    if (a.unreachable.length) out.push(`UNREACHABLE (no path from Begin — never runs): ${a.unreachable.map(name).join(", ")}`);
    if (a.ends.length > 1) out.push(`ENDS: ${a.ends.length} — the first one reached cancels every other running branch`);
    if (a.scratchpad.length) {
        out.push("SCRATCHPAD (workflow.scratchpad — becomes flow variables):");
        out.push(...a.scratchpad.map(k => `  ${k.key}: set by ${k.setBy.map(name).sort().join(", ") || "(nobody here)"}; `
            + `used by ${k.usedBy.map(name).sort().join(", ") || "(nobody else)"}`));
    }
    if (a.catalogVariables.length) {
        out.push(`CATALOG VARIABLES read: ${a.catalogVariables.map(c => `${c.name} (${c.readBy.map(name).sort().join(", ")})`).join("; ")}`);
    }
    if (a.scripts.length) {
        out.push("SCRIPTS TO PORT (non-default):");
        out.push(...a.scripts.map(x => `  ${typed(x.activity)} ${x.element}: ${x.lines} lines`));
    }
    if (a.templateFields.length) {
        out.push("FIELDS SET BY TEMPLATES:");
        out.push(...a.templateFields.map(t => `  ${typed(t.activity)} ${t.element}: ${t.fields.join(", ")}`));
    }
    if (a.subflows.length) out.push(`SUBFLOWS CALLED: ${a.subflows.map(x => `${name(x.activity)} → "${x.workflow}"`).join(", ")}`);
    if (a.designerActivities.length) out.push(`ACTIVITY DESIGNER / SPOKE ACTIVITIES: ${a.designerActivities.map(typed).join(", ")}`);
    return out.map(line => line.trimEnd()).join("\n");
}

// ------------------------------------------------------------------ mermaid

/** A Mermaid flowchart of the workflow. */
export function renderWorkflowMermaid(data: WorkflowExport): string {
    const s = new WorkflowStructure(data);
    const order = [...s.activities.keys()].sort((a, b) => s.compare(a, b));
    const ids = new Map(order.map((id, i) => [id, `n${i + 1}`]));
    const esc = (text: string): string => String(text).replace(/"/g, "'");
    const out = ["flowchart TD"];
    for (const id of order) {
        const a = s.activity(id);
        let text = esc(a.name);
        if (a.type && a.type !== a.name) text += `<br/>[${esc(a.type)}]`;
        if (s.waits(id)) text = `⏸ ${text}`;
        if (s.isEnd(id) || id === s.begin) out.push(`  ${ids.get(id)}(["${text}"])`);
        else if (a.exits.length > 1) out.push(`  ${ids.get(id)}{"${text}"}`);
        else out.push(`  ${ids.get(id)}["${text}"]`);
    }
    for (const id of order) {
        s.exits(id).forEach((e, k) => {
            const edge = s.activity(id).exits.length <= 1 && e.name === "Always" ? "" : `|${esc(e.name)}|`;
            for (const t of e.forward) out.push(`  ${ids.get(id)} -->${edge} ${ids.get(t)}`);
            for (const t of e.loop) out.push(`  ${ids.get(id)} -.->|${esc(e.name)} ↻| ${ids.get(t)}`);
            if (!e.forward.length && !e.loop.length && !s.isEnd(id)) out.push(`  ${ids.get(id)} -.->|${esc(e.name)}| ${ids.get(id)}x${k}(("no transition"))`);
        });
    }
    return out.join("\n");
}
