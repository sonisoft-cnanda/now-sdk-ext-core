import { WorkflowExport, WorkflowExportActivity, WorkflowExportActivityType } from "./WorkflowModels";

/**
 * The structure of a legacy workflow, rebuilt from a {@link WorkflowExport}.
 *
 * A workflow is a graph of activities wired exit by exit, laid out freely on a canvas.
 * This finds its loops (edges back to an activity still being explored from Begin),
 * where the paths leaving each activity come back together (immediate post-dominators;
 * parallel branches rejoin at the Join they all reach), and from that a block tree —
 * sequences, decisions, parallel lanes, loops and gotos — that every view and the
 * Flow Designer conversion walk.
 */

/** Marker for "the paths never come back together". */
export const WORKFLOW_EXIT = "__exit__";

/** One exit of an activity as the structure sees it. */
export interface StructureExit {
    sysId: string;
    name: string;
    condition: string;

    /** Targets reached without looping back */
    forward: string[];

    /** Targets that loop back to an activity being explored */
    loop: string[];
}

/** The tree the views and the conversion are built from. */
export type OutlineItem =
    | OutlineStep
    | { kind: "end"; activity: string }
    | { kind: "goto"; target: string }
    | { kind: "rejoinsBelow" }
    | { kind: "rejoin"; withoutJoin: boolean };

/** A step and, when it branches, where each exit leads. */
export interface OutlineStep {
    kind: "step";
    activity: string;

    /** Position in reading order, 1-based */
    number: number;

    /** Exits that loop back to an earlier step */
    loops: Array<{ exit: string; target: string }>;

    /** Exits with no transition: the workflow stops there */
    deadExits: Array<{ name: string; condition: string }>;

    /** Whether the activity has more than one exit (a decision) */
    decision: boolean;

    /** Branches printed under the step (decision exits, parallel lanes) */
    branches: OutlineBranch[];

    /** Exits that lead straight on to where the paths rejoin */
    directExits: string[];

    /**
     * The exit the reading continues with at the same level ("guard clause" layout, or
     * the only way on). Undefined when the paths rejoin or never continue.
     */
    mainExit?: { name: string; condition: string };
}

/** A branch under a step: one exit (decision) or one line of a parallel split. */
export interface OutlineBranch {
    /** Exit name; undefined for a parallel split of a non-decision activity */
    exit?: string;
    condition: string;

    /** Several targets on one exit run in parallel: one lane per target */
    lanes: OutlineItem[][];
}

/** The rebuilt structure of a whole workflow version. */
export interface WorkflowOutline {
    /** Sequence from Begin */
    main: OutlineItem[];

    /** Sequences from activities nothing leads to */
    unreachable: OutlineItem[][];

    /** Step number per activity sys_id */
    numbers: Map<string, number>;
}

export class WorkflowStructure {
    public readonly data: WorkflowExport;
    public readonly activities = new Map<string, WorkflowExportActivity>();
    public readonly begin: string | undefined;

    /** Edges (from, exit sys_id, to) that loop back */
    public readonly backEdges = new Set<string>();

    /** Activities reachable from Begin */
    public readonly reachable: Set<string>;

    private readonly _out = new Map<string, Map<string, string[]>>();
    private readonly _incoming = new Map<string, Array<{ from: string; exit: string }>>();
    private readonly _ipdom = new Map<string, string>();

    public constructor(data: WorkflowExport) {
        this.data = data;
        for (const a of data.activities ?? []) {
            const exits = (a.exits ?? []).map(e => ({ ...e, name: e.name ?? '', condition: e.condition ?? '' }));
            this.activities.set(a.sysId, {
                ...a, name: a.name ?? '', type: a.type ?? '', variables: a.variables ?? [],
                exits: exits.sort((x, y) => ((x.order ?? 0) - (y.order ?? 0)) || x.name.localeCompare(y.name)),
            });
            this._out.set(a.sysId, new Map());
            this._incoming.set(a.sysId, []);
        }
        for (const t of data.transitions ?? []) {
            if (!this.activities.has(t.from) || !this.activities.has(t.to)) continue;
            const exits = this._out.get(t.from);
            const exit = t.exit || "?";
            exits.set(exit, [...(exits.get(exit) ?? []), t.to]);
            this._incoming.get(t.to).push({ from: t.from, exit });
        }
        for (const exits of this._out.values()) {
            for (const [exit, targets] of exits) exits.set(exit, [...targets].sort((a, b) => this.compare(a, b)));
        }
        this.begin = this.findBegin();
        this.findBackEdges();
        this.reachable = this.reach(this.begin);
        this.computePostDominators();
    }

    // -------------------------------------------------------------- basics

    public activity(sysId: string): WorkflowExportActivity {
        return this.activities.get(sysId);
    }

    public typeOf(sysId: string): WorkflowExportActivityType | undefined {
        return this.data.activityTypes?.[this.activities.get(sysId)?.typeSysId];
    }

    public incoming(sysId: string): Array<{ from: string; exit: string }> {
        return this._incoming.get(sysId) ?? [];
    }

    /** Canvas reading order: top to bottom, then left to right. */
    public compare(a: string, b: string): number {
        const x = this.activities.get(a);
        const y = this.activities.get(b);
        return ((x.y ?? 0) - (y.y ?? 0)) || ((x.x ?? 0) - (y.x ?? 0)) || x.name.localeCompare(y.name);
    }

    public isEnd(sysId: string): boolean {
        return /(^|,)\s*end\s*=\s*true/i.test(this.typeOf(sysId)?.attributes ?? "")
            || (this.activities.get(sysId)?.type === "End" && !this.activities.get(sysId).exits.length);
    }

    public isJoin(sysId: string): boolean {
        return /(^|,)\s*generate\s*=\s*join/i.test(this.typeOf(sysId)?.attributes ?? "") || this.activities.get(sysId)?.type === "Join";
    }

    public isDesigner(sysId: string): boolean {
        return this.typeOf(sysId)?.sysClassName === "wf_element_activity";
    }

    /** Whether the activity parks the workflow: its type waits, unless it is a task told not to. */
    public waits(sysId: string): boolean {
        if (!this.typeOf(sysId)?.waits) return false;
        const flag = this.activities.get(sysId).variables.find(v => v.element === "wait_for_completion");
        return !(flag && (flag.value === "0" || flag.value === "false"));
    }

    public exitName(from: string, exitSysId: string): string {
        return this.activities.get(from)?.exits.find(e => e.sysId === exitSysId)?.name ?? "?";
    }

    /** Exits in order, each with its forward and looping targets. */
    public exits(sysId: string): StructureExit[] {
        const a = this.activities.get(sysId);
        const out = this._out.get(sysId);
        const known = a.exits.map(e => ({ sysId: e.sysId, name: e.name, condition: e.condition ?? "" }));
        if (out.has("?")) known.push({ sysId: "?", name: "?", condition: "" });
        return known.map(e => {
            const targets = out.get(e.sysId) ?? [];
            return {
                ...e,
                forward: targets.filter(t => !this.backEdges.has(edgeKey(sysId, e.sysId, t))),
                loop: targets.filter(t => this.backEdges.has(edgeKey(sysId, e.sysId, t))),
            };
        });
    }

    public forward(sysId: string): string[] {
        return this.exits(sysId).flatMap(e => e.forward);
    }

    /** Activities reachable from root, following every transition. */
    public reach(root: string | undefined): Set<string> {
        const seen = new Set<string>();
        const todo = root ? [root] : [];
        while (todo.length) {
            const n = todo.pop();
            if (seen.has(n)) continue;
            seen.add(n);
            for (const targets of this._out.get(n).values()) todo.push(...targets);
        }
        return seen;
    }

    /** Activities reachable from root without looping back. */
    public forwardReach(root: string): Set<string> {
        const seen = new Set<string>();
        const todo = [root];
        while (todo.length) {
            const n = todo.pop();
            if (seen.has(n)) continue;
            seen.add(n);
            todo.push(...this.forward(n));
        }
        return seen;
    }

    /** Activities reachable from root, not going past a Join. */
    public reachUntilJoin(root: string): Set<string> {
        const seen = new Set<string>();
        const todo = [root];
        while (todo.length) {
            const n = todo.pop();
            if (seen.has(n)) continue;
            seen.add(n);
            if (!this.isJoin(n)) for (const targets of this._out.get(n).values()) todo.push(...targets);
        }
        return seen;
    }

    /**
     * Where the paths leaving an activity come back together ({@link WORKFLOW_EXIT} if they
     * never do). Parallel lines rejoin at the Join they all reach, unless they meet before
     * it (then that meeting point is the merge, and the Join closes a later block).
     */
    public mergeOf(sysId: string): string {
        let merge = this._ipdom.get(sysId) ?? WORKFLOW_EXIT;
        const exits = this.exits(sysId);
        const parallel = exits.some(e => e.forward.length > 1);
        if (parallel && (merge === WORKFLOW_EXIT || !this.isJoin(merge))) {
            const reaches = exits.flatMap(e => e.forward).map(t => this.reach(t));
            // A Join after the merge point closes a later block, not this one: the lines
            // meet first and run what is between once per line.
            const later = merge === WORKFLOW_EXIT ? new Set<string>() : this.reach(merge);
            const joins = [...this.activities.keys()].filter(j => this.isJoin(j) && !later.has(j) && reaches.every(r => r.has(j)));
            if (joins.length) {
                const depth = this.distances(sysId);
                merge = joins.sort((a, b) => (depth.get(a) ?? 1e6) - (depth.get(b) ?? 1e6))[0];
            }
        }
        return merge;
    }

    private distances(root: string): Map<string, number> {
        const depth = new Map<string, number>([[root, 0]]);
        let frontier = [root];
        while (frontier.length) {
            const next: string[] = [];
            for (const n of frontier) {
                for (const targets of this._out.get(n).values()) {
                    for (const t of targets) {
                        if (!depth.has(t)) {
                            depth.set(t, depth.get(n) + 1);
                            next.push(t);
                        }
                    }
                }
            }
            frontier = next;
        }
        return depth;
    }

    private findBegin(): string | undefined {
        const start = this.data.version?.start;
        if (start && this.activities.has(start)) return start;
        for (const id of this.activities.keys()) {
            if (/(^|,)\s*begin\s*=\s*true/i.test(this.typeOf(id)?.attributes ?? "")) return id;
        }
        return [...this.activities.keys()].sort((a, b) => this.compare(a, b))[0];
    }

    private rawEdges(sysId: string): Array<[string, string]> {
        const order = [...this.activities.get(sysId).exits.map(e => e.sysId), "?"];
        const out = this._out.get(sysId);
        return order.flatMap(exit => (out.get(exit) ?? []).map((to): [string, string] => [exit, to]));
    }

    private findBackEdges(): void {
        const roots = this.begin ? [this.begin] : [];
        const rest = [...this.activities.keys()].filter(a => a !== this.begin).sort((a, b) => this.compare(a, b));
        // Activities nothing leads to first, then any left over: a cycle nothing enters.
        roots.push(...rest.filter(a => !this._incoming.get(a).length), ...rest.filter(a => this._incoming.get(a).length));
        const state = new Map<string, "open" | "done">();
        for (const root of roots) {
            if (state.has(root)) continue;
            const stack: Array<{ node: string; edges: Array<[string, string]>; i: number }> = [{ node: root, edges: this.rawEdges(root), i: 0 }];
            state.set(root, "open");
            while (stack.length) {
                const top = stack[stack.length - 1];
                if (top.i >= top.edges.length) {
                    state.set(top.node, "done");
                    stack.pop();
                    continue;
                }
                const [exit, to] = top.edges[top.i++];
                if (state.get(to) === "open") this.backEdges.add(edgeKey(top.node, exit, to));
                else if (!state.has(to)) {
                    state.set(to, "open");
                    stack.push({ node: to, edges: this.rawEdges(to), i: 0 });
                }
            }
        }
    }

    private computePostDominators(): void {
        const ids = [...this.activities.keys()];
        const all = new Set([...ids, WORKFLOW_EXIT]);
        const succ = new Map(ids.map(n => [n, this.forward(n).length ? this.forward(n) : [WORKFLOW_EXIT]]));
        const pdom = new Map<string, Set<string>>(ids.map(n => [n, new Set(all)]));
        pdom.set(WORKFLOW_EXIT, new Set([WORKFLOW_EXIT]));
        let changed = true;
        while (changed) {
            changed = false;
            for (const n of ids) {
                const sets = succ.get(n).map(s => pdom.get(s));
                const common = sets.length ? new Set([...sets[0]].filter(x => sets.every(s => s.has(x)))) : new Set<string>();
                common.add(n);
                if (common.size !== pdom.get(n).size || [...common].some(x => !pdom.get(n).has(x))) {
                    pdom.set(n, common);
                    changed = true;
                }
            }
        }
        for (const n of ids) {
            const strict = [...pdom.get(n)].filter(x => x !== n);
            const immediate = strict.find(c => strict.every(o => pdom.get(c)?.has(o) ?? o === WORKFLOW_EXIT));
            if (immediate) this._ipdom.set(n, immediate);
        }
    }
}

function edgeKey(from: string, exit: string, to: string): string {
    return `${from}|${exit}|${to}`;
}

/**
 * Rebuild the workflow as a block tree: numbered steps in reading order, decisions laid out
 * as guard clauses where their paths never rejoin, parallel lanes closed at their Join,
 * loops, and gotos to steps shown elsewhere.
 */
export function buildOutline(s: WorkflowStructure): WorkflowOutline {
    const numbers = new Map<string, number>();

    // `ahead`: steps a path further down this level will show; a branch reaching one
    // continues there instead of claiming it.
    const sequence = (start: string, stops: Set<string>, ahead: ReadonlySet<string> = new Set()): OutlineItem[] => {
        const items: OutlineItem[] = [];
        let n: string | undefined = start;
        let first = true;
        while (n && n !== WORKFLOW_EXIT) {
            if (stops.has(n)) {
                if (first) items.push({ kind: "rejoinsBelow" });
                return items;
            }
            if (s.isEnd(n)) {
                items.push({ kind: "end", activity: n });
                return items;
            }
            if (numbers.has(n) || ahead.has(n)) {
                items.push({ kind: "goto", target: n });
                return items;
            }
            numbers.set(n, numbers.size + 1);
            first = false;
            const exits = s.exits(n);
            const step: OutlineStep = {
                kind: "step", activity: n, number: numbers.get(n),
                loops: exits.flatMap(e => e.loop.map(t => ({ exit: e.name, target: t }))),
                deadExits: exits.filter(e => !e.forward.length && !e.loop.length).map(e => ({ name: e.name, condition: e.condition })),
                decision: s.activity(n).exits.length > 1,
                branches: [], directExits: [],
            };
            items.push(step);
            const live = exits.filter(e => e.forward.length);
            if (!live.length) return items;
            if (live.length === 1 && live[0].forward.length === 1) {
                // one way on: a sequence, even from a decision whose other exits lead nowhere
                if (step.decision) step.mainExit = { name: live[0].name, condition: live[0].condition };
                n = live[0].forward[0];
                continue;
            }

            let merge = s.mergeOf(n);
            if (merge !== WORKFLOW_EXIT && s.isEnd(merge) && !stops.has(merge)) merge = WORKFLOW_EXIT;
            const inner = new Set(stops);
            if (merge !== WORKFLOW_EXIT) inner.add(merge);
            const direct = live.filter(e => e.forward.length === 1 && inner.has(e.forward[0]));
            const branching = live.filter(e => !direct.includes(e));
            let main: StructureExit | undefined;
            if (merge === WORKFLOW_EXIT && step.decision && branching.length > 1) {
                const single = branching.filter(e => e.forward.length === 1);
                if (single.length) main = single.reduce((best, e) => (s.forwardReach(e.forward[0]).size > s.forwardReach(best.forward[0]).size ? e : best));
            }
            // Side branches of a guard layout leave the steps the main path reaches to it.
            const branchAhead = main ? new Set([...ahead, ...s.forwardReach(main.forward[0])]) : ahead;
            for (const e of branching) {
                if (e === main) continue;
                step.branches.push({
                    exit: step.decision ? e.name : undefined,
                    condition: e.condition,
                    lanes: e.forward.map(t => sequence(t, inner, branchAhead)),
                });
            }
            step.directExits = direct.map(e => e.name);
            if (main) {
                step.mainExit = { name: main.name, condition: main.condition };
                n = main.forward[0];
                continue;
            }
            if (merge === WORKFLOW_EXIT || stops.has(merge)) return items;
            if (numbers.has(merge)) {
                items.push({ kind: "goto", target: merge });
                return items;
            }
            const parallelSplit = branching.some(e => e.forward.length > 1);
            if (parallelSplit && !s.isJoin(merge) && !s.isEnd(merge)) items.push({ kind: "rejoin", withoutJoin: true });
            else if (branching.length && !direct.length) items.push({ kind: "rejoin", withoutJoin: false });
            n = merge;
        }
        return items;
    };

    const main = s.begin ? sequence(s.begin, new Set()) : [];
    const orphans = [...s.activities.keys()].filter(a => !s.reachable.has(a)).sort((a, b) => s.compare(a, b));
    const roots = orphans.filter(a => !s.incoming(a).some(i => orphans.includes(i.from)));
    const unreachable: OutlineItem[][] = [];
    // Activities nothing leads to first, then whatever is left (a cycle nothing enters).
    for (const root of [...roots, ...orphans]) {
        if (!numbers.has(root)) unreachable.push(sequence(root, new Set()));
    }
    return { main, unreachable, numbers };
}
