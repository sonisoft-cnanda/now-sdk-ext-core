import { WorkflowExport, WorkflowExportActivity, WorkflowExportVariable } from "./WorkflowModels";
import {
    FlowConversionPlan,
    FlowPlanCondition,
    FlowPlanConfidence,
    FlowPlanDecision,
    FlowPlanNode,
    FlowPlanSource,
    FlowPlanTrigger,
    FlowPlanValue,
} from "./WorkflowConversionModels";
import { buildOutline, OutlineItem, OutlineStep, WorkflowStructure } from "./WorkflowStructure";
import { analyzeWorkflow, lineCount, nameCatalogVariables } from "./WorkflowViews";

/**
 * Plans the move of a legacy workflow to Flow Designer.
 *
 * The plan follows the workflow's rebuilt structure (see {@link buildOutline}): approvals
 * become Ask For Approval with branches on its state, If and Switch become if / else if /
 * else, Set Values an Update Record, tasks Create (Catalog) Task, timers and waits their flow
 * equivalents, parallel branches a parallel block, scripts that only set scratchpad values
 * Set Flow Variables. Whatever cannot be carried over mechanically — scripts, loops, gotos,
 * catalog-variable conditions, spoke activities, subflows — is planned as an explicit TODO
 * and an open decision carrying the legacy detail, and every setting the mapping did not use
 * is listed on its step, so nothing is dropped silently.
 *
 * Out-of-box activity types are recognised by name; any other type is planned as manual
 * work with its settings attached.
 */

type FlowVariableType = 'string' | 'boolean' | 'integer';

const STRUCTURAL = new Set(['Begin', 'End', 'Branch', 'Join']);

/** Due-date / timer settings shared by approvals, tasks and timers. */
const TIMER_ELEMENTS = new Set([
    'timer_type', 'duration', 'relative_duration', 'field', 'schedule_type', 'schedule_field', 'user_specified_schedule',
    'timezone_type', 'timezone_field', 'user_specified_timezone', 'modifier', 'percentage', 'time_before', 'time_after',
]);

const QUERY_TERM = /^([a-z_][\w.]*?)(=|!=|>=|<=|>|<|NOT LIKE|LIKE|STARTSWITH|ENDSWITH|NOT IN|IN|ISNOTEMPTY|ISEMPTY|ANYTHING|SAMEAS|NSAMEAS)(.*)$/i;
const SCRIPT_LITERAL = /^(true|false|'[^']*'|-?\d+(?:\.\d+)?)$/;

/**
 * Names generated code cannot use for a step's output: reserved words, and the bindings the
 * Fluent file itself uses.
 */
const RESERVED = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
    'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
    'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements',
    'interface', 'package', 'private', 'protected', 'public', 'await', 'arguments', 'eval', 'undefined',
    'params', 'wfa', 'action', 'trigger',
]);

/** Whether generated code cannot use this name as a binding. */
export function isReservedIdentifier(name: string): boolean {
    return RESERVED.has(name);
}

/** Text placed in a template literal as is: backslashes, backticks and `${` escaped. */
export function templateLiteralText(text: string): string {
    return String(text ?? '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

const FIELD_PATH = /^[a-z_]\w*(\.[a-z_]\w*)*$/i;

/** A code-safe lowercase identifier from free text. */
export function identifierFrom(text: string, max = 48): string {
    let id = String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('_').slice(0, max);
    while (id.endsWith('_')) id = id.slice(0, -1);
    return /^[a-z]/.test(id) ? id : `x_${id || 'step'}`;
}

interface Context {
    s: WorkflowStructure;
    numbers: Map<string, number>;
    recordPill: string;
    table: string;
    ids: Set<string>;
    decisions: FlowPlanDecision[];
    coverage: Map<string, FlowPlanConfidence>;

    /** Output variable per activity whose outputs later steps branch on */
    outputs: Map<string, string>;

    /** Scratchpad keys with the type their literal assignments imply */
    flowVariables: Map<string, FlowVariableType>;

    /** How many parallel blocks the walk is inside */
    parallelDepth: number;

    /** The flow's identifier, left out of step ids (activity names often repeat the workflow name) */
    prefix: string;
}

/** Reads an activity's variables and remembers which ones the mapping used. */
class Settings {
    private readonly _used = new Set<string>();

    public constructor(private readonly a: WorkflowExportActivity) {}

    public value(element: string): string {
        this._used.add(element);
        return this.a.variables.find(v => v.element === element)?.value ?? '';
    }

    public display(element: string): string {
        this._used.add(element);
        const v = this.a.variables.find(x => x.element === element);
        return v?.display || v?.value || '';
    }

    /** The value when it differs from the type's default, else ''. */
    public custom(element: string): string {
        this._used.add(element);
        const v = this.a.variables.find(x => x.element === element);
        return v && !v.isDefault ? v.value ?? '' : '';
    }

    public flag(element: string): boolean {
        return ['1', 'true'].includes(this.value(element));
    }

    public use(...elements: string[]): void {
        for (const e of elements) this._used.add(e);
    }

    /** Non-default timer / due-date settings, as `label: value`. */
    public timer(): string[] {
        const timerType = this.a.variables.find(x => x.element === 'timer_type')?.value ?? '';
        return this.a.variables
            .filter(v => TIMER_ELEMENTS.has(v.element) && !v.isDefault && v.value)
            // the form keeps a relative duration even when the timer type does not use one
            .filter(v => v.element !== 'relative_duration' || timerType === 'relative_duration')
            .map(v => {
                this._used.add(v.element);
                return `${v.label || v.element}: ${v.display || v.value}`;
            });
    }

    /** Non-default settings the mapping did not use. */
    public leftovers(): WorkflowExportVariable[] {
        return this.a.variables.filter(v => !v.isDefault && v.value && !this._used.has(v.element) && !TIMER_ELEMENTS.has(v.element));
    }
}

/**
 * Plan a Flow Designer flow (or subflow) for a legacy workflow export.
 */
export function planFlowConversion(data: WorkflowExport): FlowConversionPlan {
    const s = new WorkflowStructure(data);
    const outline = buildOutline(s);
    const analysis = analyzeWorkflow(data);
    const trigger = planTrigger(data);
    if (!data?.workflow || !Array.isArray(data.activities)) throw new Error('Not a workflow export: workflow or activities missing');
    const identifier = identifierFrom(data.workflow.name);
    const ctx: Context = {
        s, numbers: outline.numbers, recordPill: trigger.recordPill, table: data.workflow.table,
        ids: new Set(), decisions: [], coverage: new Map(), outputs: new Map(), flowVariables: new Map(), parallelDepth: 0, prefix: identifier,
    };

    const steps = walk(ctx, outline.main, false);
    const name = (id: string): string => s.activity(id)?.name ?? id;

    // one decision per shared step rather than one per path reaching it
    const gotos = new Map<string, number>();
    for (const d of ctx.decisions.filter(x => x.topic === 'goto')) gotos.set(d.activities[0], (gotos.get(d.activities[0]) ?? 0) + 1);
    ctx.decisions = ctx.decisions.filter(x => x.topic !== 'goto');
    for (const [target, count] of gotos) {
        ctx.decisions.push({
            topic: 'goto',
            detail: `Step ${ctx.numbers.get(target)} (${name(target)}) is shared: ${count} other path${count === 1 ? '' : 's'} continue${count === 1 ? 's' : ''} there. `
                + 'A flow cannot jump: repeat the steps in each branch, move them (and what follows) into a subflow called from each place, '
                + 'or restructure the branches so they meet after the decision.',
            activities: [target],
        });
    }

    for (const loop of analysis.loops) {
        ctx.decisions.push({
            topic: 'loop',
            detail: `${name(loop.from)} (${loop.exit}) loops back to ${name(loop.to)}${loop.cappedBy ? `, capped by ${name(loop.cappedBy)}` : ''}. `
                + 'Rebuild it as Do the following until (with a flow-variable counter if it must be capped).',
            activities: [loop.from, loop.to],
        });
    }
    for (const merge of analysis.mergesWithoutJoin) {
        ctx.decisions.push({
            topic: 'mergeWithoutJoin',
            detail: `${name(merge.activity)} is reached by several parallel branches from ${name(merge.splitAt)} without a Join, so the workflow runs it once per branch. `
                + 'Decide whether the flow runs it once (after the parallel block) or in each branch.',
            activities: [merge.activity, merge.splitAt],
        });
    }
    for (const dead of analysis.deadExits) {
        ctx.decisions.push({
            topic: 'deadExit',
            detail: `${name(dead.activity)}: exit "${dead.exit}" has no transition, so the workflow stops there. Decide what the flow does (often: end the flow).`,
            activities: [dead.activity],
        });
    }
    if (analysis.unreachable.length) {
        ctx.decisions.push({
            topic: 'unreachable',
            detail: `Never runs (nothing leads to it): ${analysis.unreachable.map(name).join(', ')}. Not carried over.`,
            activities: analysis.unreachable,
        });
    }
    if (analysis.catalogVariables.length) {
        const readers = (ids: string[]): string => (ids.length > 3 ? `${ids.length} steps` : ids.map(name).join(', '));
        ctx.decisions.push({
            topic: 'catalogVariable',
            detail: `Catalog variables read: ${analysis.catalogVariables.map(v => `${v.name} (${readers(v.readBy)})`).join(', ')}. `
                + 'They are not data pills of the requested item: read them with Get Catalog Variables (or one script step returning them as outputs) and use those.',
            activities: [...new Set(analysis.catalogVariables.flatMap(v => v.readBy))],
        });
    }
    if (data.stages?.length) {
        ctx.decisions.push({
            topic: 'stage',
            detail: `The workflow moves the "${data.version?.stageField || 'stage'}" field through stages (${data.stages.map(st => st.name).join(' → ')}). `
                + 'Either set that field with Update Record at the same points or declare flow stages.',
            activities: [...s.activities.keys()].filter(id => s.activity(id).stage),
        });
    }
    const loose = analysis.scratchpad.filter(k => !k.setBy.length || !k.usedBy.length);
    if (loose.length) {
        ctx.decisions.push({
            topic: 'script',
            detail: `Scratchpad values only written or only read in this workflow (set elsewhere, or unused): ${loose.map(k => k.key).join(', ')}.`,
            activities: [...new Set(loose.flatMap(k => [...k.setBy, ...k.usedBy]))],
        });
    }

    const flowVariables = analysis.scratchpad
        .filter(k => k.setBy.length && k.usedBy.length)
        .map(k => ({ name: k.key, type: ctx.flowVariables.get(k.key) ?? 'string', setBy: k.setBy, usedBy: k.usedBy }));

    const coverage = { direct: 0, partial: 0, manual: 0 };
    for (const level of ctx.coverage.values()) coverage[level]++;

    return {
        format: 'now-sdk-ext/flow-conversion-plan@1',
        source: { workflowSysId: data.workflow.sysId, versionSysId: data.version?.sysId ?? '', name: data.workflow.name, table: data.workflow.table },
        kind: trigger.kind === 'subflow' ? 'subflow' : 'flow',
        name: data.workflow.name,
        identifier,
        trigger,
        flowVariables,
        steps,
        openDecisions: ctx.decisions,
        coverage,
    };
}

function planTrigger(data: WorkflowExport): FlowPlanTrigger {
    const table = data.workflow.table ?? '';
    const catalogItems = (data.usedBy?.catalogItems ?? []).map(c => ({ sysId: c.sysId, name: c.name }));
    const inputs = (data.inputs ?? []).map(i => ({ name: i.name, label: i.label, type: i.type, mandatory: i.mandatory }));
    const parents = data.usedBy?.parentWorkflows ?? [];
    if (table === 'sc_req_item' && !parents.length) {
        return {
            kind: 'serviceCatalog', table, catalogItems, inputs, recordPill: 'params.trigger.request_item',
            notes: [catalogItems.length
                ? `Attach the flow to ${catalogItems.map(c => `"${c.name}"`).join(', ')} (the item's Flow field) and clear the item's Workflow when you cut over.`
                : 'No catalog item names this workflow (order guides or scripts may start it); attach the flow where it is used.'],
        };
    }
    if (parents.length || inputs.length || !data.version?.condition) {
        const hasRecord = !!table && table !== 'global';
        return {
            kind: 'subflow', table, catalogItems, inputs, recordPill: hasRecord ? 'params.inputs.record' : '',
            notes: [
                parents.length ? `Called as a subflow by ${parents.map(p => `"${p.name}"`).join(', ')}.`
                    : 'Nothing starts this workflow by condition: it is started by script or as a subflow.',
                hasRecord ? `The workflow ran on its caller's ${table} record (current); the subflow takes it as the "record" input.`
                    : 'The workflow runs on no table (global), so the subflow has no record input.',
            ],
        };
    }
    return {
        kind: 'record', table, recordEvent: 'created', condition: data.version?.condition, catalogItems, inputs,
        recordPill: 'params.trigger.current',
        notes: [`The workflow starts when a ${table} record matching its condition is inserted${data.version?.conditionType ? ` (condition type "${data.version.conditionType}")` : ''}. `
            + 'Check whether it must also start on update before choosing the record trigger.'],
    };
}

// ------------------------------------------------------------------ the body

function walk(ctx: Context, items: OutlineItem[], nested: boolean): FlowPlanNode[] {
    const nodes: FlowPlanNode[] = [];
    for (const item of items) {
        if (item.kind === 'end') {
            if (nested) nodes.push({ kind: 'endFlow', id: newId(ctx, 'end_flow'), source: source(ctx, item.activity) });
        } else if (item.kind === 'goto') {
            const target = ctx.s.activity(item.target);
            const number = ctx.numbers.get(item.target);
            nodes.push({
                kind: 'todo', id: newId(ctx, `continue_at_${target.name}`), source: source(ctx, item.target),
                reason: `Continue at step ${number} (${target.name}), shared with other paths.`, continueAt: item.target,
            });
            ctx.decisions.push({ topic: 'goto', detail: '', activities: [item.target] });
        } else if (item.kind === 'step') {
            nodes.push(...planStep(ctx, item));
        }
    }
    return nodes;
}

function planStep(ctx: Context, step: OutlineStep): FlowPlanNode[] {
    const { s } = ctx;
    const a = s.activity(step.activity);
    const nodes: FlowPlanNode[] = [];
    const branchesOnExit = step.branches.some(b => b.exit !== undefined);
    const mapped = mapActivity(ctx, a, step, branchesOnExit);
    if (mapped) nodes.push(mapped);

    for (const loop of step.loops) {
        nodes.push({
            kind: 'todo', id: newId(ctx, `loop_${a.name}`), source: source(ctx, a.sysId),
            reason: `On ${loop.exit}, the workflow loops back to step ${ctx.numbers.get(loop.target)} (${s.activity(loop.target).name}). `
                + 'Wrap the steps from there in Do the following until, exiting when this exit is not taken.',
        });
    }

    const lanes = step.branches.filter(b => b.exit === undefined).flatMap(b => b.lanes);
    if (lanes.length) nodes.push(parallel(ctx, a, `parallel_after_${a.name}`, lanes));
    if (branchesOnExit || a.type === 'If' || a.type === 'Switch') {
        const decision = planDecision(ctx, a, step);
        if (decision) nodes.push(decision);
    }
    return nodes;
}

/** Lines that run at the same time. Flows cannot nest parallel blocks, so a nested one is flagged. */
function parallel(ctx: Context, a: WorkflowExportActivity, idText: string, lanes: OutlineItem[][]): FlowPlanNode {
    const nested = ctx.parallelDepth > 0;
    ctx.parallelDepth++;
    const walked = lanes.map(l => walk(ctx, l, true));
    ctx.parallelDepth--;
    const notes: string[] = [];
    if (nested) {
        notes.push('Nested in another parallel block, which flows do not allow: run these lines one after the other, or move this block into a subflow.');
        decide(ctx, 'other', `${a.name}: starts parallel lines inside another parallel block. Flows cannot nest Do the following in parallel; `
            + 'run them in sequence or move the inner block into a subflow.', a.sysId);
    }
    return { kind: 'parallel', id: newId(ctx, idText), source: source(ctx, a.sysId), lanes: walked, notes };
}

function planDecision(ctx: Context, a: WorkflowExportActivity, step: OutlineStep): FlowPlanNode | undefined {
    const bodies = new Map<string, FlowPlanNode[]>();
    for (const b of step.branches.filter(x => x.exit !== undefined)) {
        bodies.set(b.exit, b.lanes.length > 1 ? [parallel(ctx, a, `parallel_${a.name}_${b.exit}`, b.lanes)] : walk(ctx, b.lanes[0] ?? [], true));
    }
    const continuing = [...(step.mainExit ? [step.mainExit.name] : []), ...step.directExits];
    const notes = continuing.length && bodies.size ? [`${continuing.join(' / ')}: carries on with the steps after this decision.`] : [];
    const src = source(ctx, a.sysId);

    if (a.type === 'If') {
        const yes = a.exits.find(e => /^yes$/i.test(e.name))?.name ?? a.exits[0]?.name;
        const no = a.exits.find(e => e.name !== yes)?.name;
        const test = ifCondition(ctx, a);
        const confidence: FlowPlanConfidence = test.condition.derived ? (test.partial ? 'partial' : 'direct') : 'manual';
        ctx.coverage.set(a.sysId, bodies.size ? confidence : 'direct');
        const yesBody = bodies.get(yes);
        const noBody = no ? bodies.get(no) : undefined;
        if (!yesBody && !noBody) return undefined;
        return {
            kind: 'if', id: newId(ctx, `if_${a.name}`), source: src,
            branches: [{ label: yesBody ? yes : `${yes}: carries on below`, condition: test.condition, body: yesBody ?? [] }],
            otherwise: noBody ? { label: no, body: noBody } : undefined,
            confidence, notes: [...notes, ...test.notes],
        };
    }

    // exits that only continue at the same shared step become one branch
    const branches: Array<{ label: string; condition: FlowPlanCondition; body: FlowPlanNode[] }> = [];
    const byTarget = new Map<string, (typeof branches)[number]>();
    for (const e of a.exits.filter(x => bodies.has(x.name))) {
        const body = bodies.get(e.name);
        const condition = exitCondition(ctx, a, e.name);
        const target = body.length === 1 && body[0].kind === 'todo' ? body[0].continueAt : undefined;
        const same = target ? byTarget.get(target) : undefined;
        if (same) {
            same.label = `${same.label} / ${e.name}`;
            same.condition = same.condition.derived && condition.derived
                ? { expression: `${same.condition.expression}^OR${condition.expression}`, source: `${same.condition.source} || ${condition.source}`, derived: true }
                : { expression: '', source: `${same.condition.source} or ${condition.source}`, derived: false };
            continue;
        }
        const branch = { label: e.name, condition, body };
        branches.push(branch);
        if (target) byTarget.set(target, branch);
    }
    // an else exit (taken when no other exit matches) is the flow's else
    let otherwise: { label: string; body: FlowPlanNode[] } | undefined;
    const elseExit = a.exits.find(e => e.elseFlag);
    const elseBranch = elseExit ? branches.find(b => b.label === elseExit.name) : undefined;
    if (elseBranch) {
        if (branches.length > 1) {
            branches.splice(branches.indexOf(elseBranch), 1);
            otherwise = { label: elseBranch.label, body: elseBranch.body };
        } else {
            const others = a.exits.filter(e => e !== elseExit).map(e => e.name);
            elseBranch.condition = { expression: '', source: `none of the other exits matched (${others.join(', ')})`, derived: false };
        }
    }
    const derived = branches.filter(b => b.condition.derived).length;
    const confidence: FlowPlanConfidence = derived === branches.length ? 'direct' : derived ? 'partial' : 'manual';
    if (a.type === 'Switch') ctx.coverage.set(a.sysId, branches.length ? confidence : 'direct');
    if (!branches.length) return undefined;
    return { kind: 'if', id: newId(ctx, `if_${a.name}`), source: src, branches, ...(otherwise ? { otherwise } : {}), confidence, notes };
}

/** The If activity's test: its condition (when set) AND its script (when advanced). */
function ifCondition(ctx: Context, a: WorkflowExportActivity): { condition: FlowPlanCondition; partial: boolean; notes: string[] } {
    const settings = new Settings(a);
    const query = settings.value('condition');
    const script = settings.flag('advanced') ? settings.value('script').trim() : '';
    const parts: FlowPlanCondition[] = [];
    const notes: string[] = [];
    let partial = false;
    if (query) parts.push(encodedQueryToCondition(query, ctx.recordPill, nameCatalogVariables(ctx.s.data, query)));
    if (script) {
        const test = scriptTest(script, ctx);
        if (test) {
            parts.push(test);
            partial = true;
            notes.push(`Condition read from the script; check it:\n${script}`);
        } else {
            parts.push({ expression: '', source: `script:\n${script}`, derived: false });
        }
    }
    if (!parts.length) return { condition: { expression: '', source: '(no condition: always Yes)', derived: false }, partial, notes };
    const derived = parts.every(p => p.derived);
    return {
        condition: { expression: derived ? parts.map(p => p.expression).join('^') : '', source: parts.map(p => p.source).join('\nAND '), derived },
        partial, notes,
    };
}

/** A flow condition for leaving an activity through one of its exits. */
function exitCondition(ctx: Context, a: WorkflowExportActivity, exitName: string): FlowPlanCondition {
    const legacy = a.exits.find(e => e.name === exitName)?.condition ?? '';
    const results = [...legacy.matchAll(/activity\.result\s*==\s*['"]([^'"]*)['"]/g)].map(m => m[1]);
    const settings = new Settings(a);
    const output = ctx.outputs.get(a.sysId);
    const either = (pill: string): string => results.map(r => `${pill}=${templateLiteralText(r)}`).join('^OR');

    if (output && results.length && /^Approval - /.test(a.type)) {
        return { expression: either(`\${wfa.dataPill(${output}.approval_state, "choice")}`), source: legacy, derived: true };
    }
    if (a.type === 'Switch' && results.length) {
        if (settings.value('type') === 'field' && FIELD_PATH.test(settings.value('field')) && ctx.recordPill) {
            return { expression: either(`\${wfa.dataPill(${ctx.recordPill}.${settings.value('field')}, "string")}`), source: legacy, derived: true };
        }
        return { expression: '', source: `catalog variable ${settings.display('item_variable')} = ${results.join(' or ')}`, derived: false };
    }
    if (['Catalog Task', 'Create Task'].includes(a.type) && results.length) {
        if (output) return { expression: either(`\${wfa.dataPill(${output}.Record.state, "choice")}`), source: legacy, derived: true };
        return { expression: '', source: `the task's state = ${results.join(' or ')}`, derived: false };
    }
    // a custom exit comparing a field of the record with a literal
    const compare = /^current\.([a-z_][\w.]*)\s*(===?|!==?)\s*(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?|true|false))$/i.exec(legacy.trim());
    if (compare && !compare[1].startsWith('variables.') && ctx.recordPill) {
        const literal = templateLiteralText(compare[3] ?? compare[4] ?? compare[5]);
        return { expression: `\${wfa.dataPill(${ctx.recordPill}.${compare[1]}, "string")}${compare[2].startsWith('!') ? '!=' : '='}${literal}`, source: legacy, derived: true };
    }
    if (ctx.s.isJoin(a.sysId) && results.length) {
        const complete = results.every(r => r === 'complete');
        return {
            expression: '', derived: false,
            source: complete ? 'every branch reached the Join' : `a branch ended without reaching the Join (${exitName})`,
        };
    }
    return { expression: '', source: legacy || exitName, derived: false };
}

/**
 * Convert an encoded query on the workflow's record into a flow condition. Terms on catalog
 * variables or with `javascript:` values cannot become data pills and leave it underived.
 */
export function encodedQueryToCondition(query: string, recordPill: string, display = query): FlowPlanCondition {
    if (!recordPill) return { expression: '', source: display.replace(/\^EQ$/, ''), derived: false };
    const terms = query.replace(/\^EQ$/, '').split(/(\^OR|\^NQ|\^)/).filter(Boolean);
    let derived = true;
    const parts: string[] = [];
    for (const term of terms) {
        if (term === '^' || term === '^OR' || term === '^NQ') {
            parts.push(term);
            continue;
        }
        const m = QUERY_TERM.exec(term);
        if (!m || m[1].startsWith('variables.') || /javascript:/i.test(term)) {
            derived = false;
            continue;
        }
        parts.push(`\${wfa.dataPill(${recordPill}.${m[1]}, "string")}${m[2]}${templateLiteralText(m[3])}`);
    }
    return { expression: derived ? parts.join('') : '', source: display.replace(/\^EQ$/, ''), derived };
}

/**
 * Recognise an If script that only compares one scratchpad value or field of current with a
 * literal (`answer = ifScript(); function ifScript() { if (<test>) return 'yes'; return 'no'; }`
 * and the like) and turn the test into a flow condition.
 */
function scriptTest(script: string, ctx: Context): FlowPlanCondition | undefined {
    const code = compact(script);
    const shapes = [
        /^answer=(\w+)\(\);?function\1\(\)\{if\((.+)\)\{?return(?:'yes'|true);?\}?(?:else\{?)?return(?:'no'|false);?\}?\}$/,
        /^if\((.+)\)\{?answer=(?:'yes'|true);?\}?else\{?answer=(?:'no'|false);?\}?$/,
        /^answer=\((.+)\)\?'yes':'no';?$/,
    ];
    let test: string | undefined;
    for (const shape of shapes) {
        const m = shape.exec(code);
        if (m) {
            test = m[m.length - 1];
            break;
        }
    }
    if (!test) return undefined;
    const m = /^(workflow\.scratchpad|current)\.([a-z_]\w*)(?:(===?|!==?)(.+))?$/i.exec(test);
    if (!m || (m[4] !== undefined && !SCRIPT_LITERAL.test(m[4]))) return undefined;
    const literal = templateLiteralText(m[4] === undefined ? 'true' : m[4].replace(/^'|'$/g, ''));
    const operator = m[3]?.startsWith('!') ? '!=' : '=';
    if (m[1] === 'current') {
        if (!ctx.recordPill) return undefined;
        return { expression: `\${wfa.dataPill(${ctx.recordPill}.${m[2]}, "string")}${operator}${literal}`, source: test, derived: true };
    }
    const type = typeOfLiteral(m[4] ?? 'true');
    if (!ctx.flowVariables.has(m[2])) ctx.flowVariables.set(m[2], type);
    return { expression: `\${wfa.dataPill(params.flowVariables.${m[2]}, "${type}")}${operator}${literal}`, source: test, derived: true };
}

/** Script without comments or whitespace outside string literals, quotes made single. */
function compact(script: string): string {
    let out = '';
    let quote: string | undefined;
    for (let i = 0; i < script.length; i++) {
        const c = script[i];
        if (quote) {
            if (c === '\\') {
                out += c + (script[++i] ?? '');
                continue;
            }
            if (c === quote) {
                out += "'";
                quote = undefined;
            } else out += c;
            continue;
        }
        if (c === '/' && script[i + 1] === '/') {
            while (i < script.length && script[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && script[i + 1] === '*') {
            const end = script.indexOf('*/', i + 2);
            i = end < 0 ? script.length : end + 1;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            out += "'";
            continue;
        }
        if (!/\s/.test(c)) out += c;
    }
    return out;
}

function typeOfLiteral(literal: string): FlowVariableType {
    if (/^(true|false)$/.test(literal)) return 'boolean';
    if (/^-?\d+$/.test(literal)) return 'integer';
    return 'string';
}

// ------------------------------------------------------------------ activities

function mapActivity(ctx: Context, a: WorkflowExportActivity, step: OutlineStep, branchesOnExit: boolean): FlowPlanNode | undefined {
    const { s } = ctx;
    if (STRUCTURAL.has(a.type) || a.type === 'If' || a.type === 'Switch') return undefined;
    const settings = new Settings(a);
    const src = source(ctx, a.sysId);
    const id = newId(ctx, a.name);
    const notes: string[] = [];
    const record: FlowPlanValue = ctx.recordPill ? { kind: 'pill', expr: ctx.recordPill, type: 'reference' } : { kind: 'literal', value: '' };
    // Inputs that take the record as text (a template literal) rather than a reference.
    const recordText: FlowPlanValue = ctx.recordPill ? { kind: 'text', parts: [{ expr: ctx.recordPill, type: 'reference' }] } : { kind: 'literal', value: '' };
    if (!ctx.recordPill) notes.push('The workflow has no record (global): set the record this step works on.');
    const stage = s.data.stages?.find(st => st.sysId === a.stage)?.name;
    if (stage) notes.push(`Workflow stage: ${stage}.`);
    for (const dead of step.deadExits) notes.push(`Exit "${dead.name}" leads nowhere in the workflow.`);

    const finish = <T extends FlowPlanNode>(node: T, confidence: FlowPlanConfidence): T => {
        ctx.coverage.set(a.sysId, confidence);
        const left = settings.leftovers();
        if (left.length && 'notes' in node) {
            node.notes.push(`Not carried over: ${left.map(v => `${v.label || v.element} = ${oneLine(v.display || v.value, 120)}`).join('; ')}`);
        }
        return node;
    };

    if (s.isDesigner(a.sysId)) {
        decide(ctx, 'spoke', `${a.name} [${a.type}] is an Activity Designer (spoke) activity: call the matching IntegrationHub action, or build a custom action.`, a.sysId);
        return finish(todo(ctx, a, `Activity Designer activity "${a.type}": call the matching IntegrationHub action (or a custom action).`,
            a.input ? `inputs: ${JSON.stringify(a.input, null, 2)}` : undefined), 'manual');
    }

    switch (a.type) {
        case 'Approval - User':
        case 'Approval - Group': {
            const output = id;
            if (branchesOnExit) ctx.outputs.set(a.sysId, output);
            let confidence: FlowPlanConfidence = 'direct';
            const users = approvers(settings.value('users'), ctx.recordPill);
            const groups = approvers(settings.value('groups'), ctx.recordPill);
            const waitFor = settings.value('wait_for') || 'any';
            const ruleType = waitFor === 'all' ? 'All' : 'Any';
            if (waitFor === 'first') notes.push('The workflow took the first response from anyone (approve or reject); the closest rule is Any.');
            if (waitFor === 'script') {
                confidence = 'partial';
                notes.push(`The workflow decided by script; rebuild it as rule sets (Count / Percent) or a script step:\n${settings.value('approval_script')}`);
            } else settings.use('approval_script');
            if (settings.value('reject_handling') === 'wait') {
                confidence = 'partial';
                notes.push('The workflow waited for the other responses after a rejection; check the rule set.');
            }
            const approverScript = settings.flag('advanced') ? settings.custom('approver_script') : '';
            settings.use('approver_script');
            if (approverScript) {
                confidence = 'partial';
                notes.push(`Approvers are also added by script; compute them in a step before this one and pass them in:\n${approverScript}`);
                decide(ctx, 'approval', `${a.name}: approvers come from a script; port it to a step that returns them.`, a.sysId);
            }
            if (settings.value('condition')) {
                confidence = 'partial';
                notes.push(`Approvals were only requested when: ${nameCatalogVariables(s.data, settings.value('condition'))}. Wrap the step in an If.`);
            }
            const unresolved = [...users, ...groups].some(v => v.kind === 'literal' && v.value === '');
            if (unresolved) {
                confidence = 'partial';
                notes.push(`Some approvers are expressions this plan cannot turn into data pills: ${[settings.value('users'), settings.value('groups')].filter(Boolean).join(' ')}`);
            }
            if (!users.length && !groups.length && !approverScript) notes.push('No approvers are configured: the workflow skips this step (exit Skipped).');
            const timer = settings.timer();
            if (timer.length) notes.push(`The workflow set a due date (${timer.join(', ')}); set due_date with wfa.approvalDueDate() if approvers have a deadline.`);
            const resolved = (list: FlowPlanValue[]): FlowPlanValue[] => list.filter(v => !(v.kind === 'literal' && v.value === ''));
            const inputs: Record<string, FlowPlanValue> = {
                record, table: { kind: 'literal', value: ctx.table },
                approval_conditions: { kind: 'approvalRules', ruleType, action: 'ApprovesRejects', users: resolved(users), groups: resolved(groups) },
            };
            if (settings.custom('approval_column')) inputs.approval_field = { kind: 'literal', value: settings.value('approval_column') };
            if (settings.custom('approval_history')) inputs.journal_field = { kind: 'literal', value: settings.value('approval_history') };
            return finish({
                kind: 'action', id, source: src, action: 'action.core.askForApproval', label: a.name, output: branchesOnExit ? output : undefined,
                inputs, confidence, notes, stage, waits: true,
            }, confidence);
        }

        case 'Set Values': {
            const { fields, partial } = templateFields(settings.value('values'));
            if (partial) notes.push('Some values are scripts (javascript:) or ${…} expressions the workflow evaluated; compute them in a step before this one, or use data pills.');
            const confidence: FlowPlanConfidence = partial ? 'partial' : 'direct';
            return finish({
                kind: 'action', id, source: src, action: 'action.core.updateRecord', label: a.name,
                inputs: { table_name: { kind: 'literal', value: ctx.table }, record, values: { kind: 'template', fields } },
                confidence, notes, stage, waits: false,
            }, confidence);
        }

        case 'Catalog Task':
        case 'Create Task': {
            const catalog = a.type === 'Catalog Task';
            let confidence: FlowPlanConfidence = 'direct';
            const fields: Record<string, FlowPlanValue> = {};
            const mode = settings.value('task_value_type') || 'Fields';
            if (mode === 'Values') {
                const parsed = templateFields(settings.value('task_set_values'));
                Object.assign(fields, parsed.fields);
                if (parsed.partial) {
                    confidence = 'partial';
                    notes.push('Some task values are scripts (javascript:) or ${…} expressions; check how each should be set.');
                }
            } else if (mode === 'Template') {
                confidence = 'partial';
                notes.push(`Task values came from the template "${settings.display('task_template')}"; copy its fields into the field values.`);
            }
            // Fields-mode settings apply only in Fields mode (the form keeps them when the mode changes).
            const fieldMode: Record<string, string> = {
                task_fulfillment_group: 'assignment_group', task_assigned_to: 'assigned_to', task_short_description: 'short_description', task_instructions: 'description',
            };
            for (const [element, field] of Object.entries(fieldMode)) {
                const value = settings.value(element);
                if (mode === 'Fields' && value) fields[field] = { kind: 'literal', value };
            }
            if (settings.value('task_priority') && !fields.priority) fields.priority = { kind: 'literal', value: settings.value('task_priority') };

            const advanced = settings.flag('advanced') ? settings.custom('advanced_script') : '';
            settings.use('advanced_script');
            if (advanced) {
                confidence = 'partial';
                notes.push(`An advanced script runs on the new task (task) and the record (current); carry over what it sets:\n${advanced}`);
                decide(ctx, 'task', `${a.name}: its advanced script sets values on the task or the record; port them (field values, Update Record, or a script step).`, a.sysId);
            }
            const variables = settings.value('task_variables');
            if (variables) notes.push(`Catalog variables shown on the task: ${variables.split(',').join(', ')}. Set catalog_variables (needs the catalog item's variables).`);
            const timer = settings.timer();
            if (timer.length) notes.push(`The workflow set a due date (${timer.join(', ')}); set due_date in the field values if the task needs one.`);
            const wait = settings.value('wait_for_completion') !== '' ? settings.flag('wait_for_completion') : true;
            // Branching on how the task closed needs the task as a data pill: Create Task's Record
            // output dot-walks, Create Catalog Task's "Catalog Task" output cannot be a pill in Fluent.
            const asTask = !catalog || branchesOnExit;
            const taskTable = catalog ? 'sc_task' : settings.value('task_table') || 'task';
            // The handler also links these task tables to the record it runs on.
            const linkField = ({ sc_task: ['sc_req_item', 'request_item'], change_task: ['change_request', 'change_request'],
                problem_task: ['problem', 'problem'] } as Record<string, [string, string]>)[taskTable];
            const link: Record<string, FlowPlanValue> = catalog ? { request_item: record }
                : linkField && ctx.recordPill && ctx.table === linkField[0] ? { [linkField[1]]: record } : {};
            if (branchesOnExit) {
                ctx.outputs.set(a.sysId, id);
                if (catalog) notes.push('Created with Create Task on sc_task (not Create Catalog Task) so the flow can branch on the task\'s state.');
            }
            const extra = Object.fromEntries(Object.entries(fields).filter(([f]) => f !== 'short_description'));
            const inputs: Record<string, FlowPlanValue> = asTask
                ? {
                    task_table: { kind: 'literal', value: taskTable },
                    field_values: { kind: 'template', fields: { ...link, parent: record, ...fields } },
                    wait: { kind: 'literal', value: wait },
                }
                : {
                    ah_requested_item: record,
                    ...(fields.short_description ? { ah_short_description: fields.short_description } : {}),
                    ...(Object.keys(extra).length ? { ah_fields: { kind: 'template', fields: extra } } : {}),
                    ah_wait: { kind: 'literal', value: wait },
                };
            return finish({
                kind: 'action', id, source: src, action: asTask ? 'action.core.createTask' : 'action.core.createCatalogTask', label: a.name,
                output: branchesOnExit ? id : undefined, inputs, confidence, notes, stage, waits: wait,
            }, confidence);
        }

        case 'Timer': {
            const timerType = settings.value('timer_type');
            const seconds = durationSeconds(settings.value('duration'));
            const modifier = settings.value('modifier');
            if (timerType !== 'script') settings.use('script');
            if (!timerType && seconds !== undefined && !modifier) {
                settings.use(...TIMER_ELEMENTS);
                return finish({ kind: 'waitForADuration', id, source: src, seconds, confidence: 'direct', notes }, 'direct');
            }
            const how = timerType === 'relative_duration' ? `the relative duration "${settings.display('relative_duration')}"`
                : timerType === 'field' ? `the ${settings.value('field')} field`
                    : timerType === 'script' ? `a script:\n${settings.value('script')}`
                        : `a duration of ${seconds ?? '?'} seconds`;
            const timer = settings.timer();
            notes.push(`The timer waited for ${how}${modifier ? ` (${modifier})` : ''}${timer.length ? `; ${timer.join(', ')}` : ''}. `
                + (timerType === 'field' ? 'Use Wait For Condition, or a wait relative to that field.' : 'Set the duration by hand.'));
            return finish({ kind: 'waitForADuration', id, source: src, seconds: seconds ?? 0, confidence: 'partial', notes }, 'partial');
        }

        case 'Wait for condition': {
            const conditions = settings.value('wait_for_condition');
            let confidence: FlowPlanConfidence = conditions ? 'direct' : 'manual';
            const script = settings.custom('script_condition');
            if (script) {
                confidence = 'partial';
                notes.push(`It also waited on a script:\n${script}`);
            }
            if (/variables\./.test(conditions)) confidence = 'partial';
            if (/javascript:/i.test(conditions)) {
                confidence = 'partial';
                notes.push('The condition evaluates a script (javascript:); flows do not run it there. Compute the value in a step before this one.');
            }
            return finish({
                kind: 'action', id, source: src, action: 'action.core.waitForCondition', label: a.name,
                inputs: {
                    record: recordText,
                    conditions: { kind: 'literal', value: nameCatalogVariables(s.data, conditions).replace(/\^EQ$/, '') },
                    table_name: { kind: 'literal', value: ctx.table },
                },
                confidence, notes, stage, waits: true,
            }, confidence);
        }

        case 'Notification': {
            const to = [...approvers(settings.value('email_to'), ctx.recordPill), ...approvers(settings.value('email_to_group'), ctx.recordPill)]
                .filter(v => !(v.kind === 'literal' && v.value === ''));
            const body = settings.value('email');
            let confidence: FlowPlanConfidence = 'direct';
            if (/\$\{/.test(body)) {
                confidence = 'partial';
                notes.push('The message uses ${…} substitutions; rebuild them as data pills in the email body, or send a notification record instead.');
            }
            if (settings.flag('advanced') && settings.custom('email_to_script')) {
                confidence = 'partial';
                notes.push(`Recipients are also built by script:\n${settings.value('email_to_script')}`);
            }
            return finish({
                kind: 'action', id, source: src, action: 'action.core.sendEmail', label: a.name,
                inputs: {
                    ah_to: { kind: 'list', items: to },
                    ah_subject: substitute(settings.value('subject'), ctx.recordPill),
                    ah_body: { kind: 'literal', value: body },
                    record, table_name: { kind: 'literal', value: ctx.table },
                },
                confidence, notes, stage, waits: false,
            }, confidence);
        }

        case 'Log Message':
            return finish({
                kind: 'action', id, source: src, action: 'action.core.log', label: a.name,
                inputs: { log_level: { kind: 'literal', value: 'info' }, log_message: substitute(settings.value('message'), ctx.recordPill) },
                confidence: 'direct', notes, stage, waits: false,
            }, 'direct');

        case 'Create Event': {
            const params = [settings.custom('event_param1'), settings.custom('event_param2')];
            if (params.some(Boolean)) notes.push(`Event parameters were scripts; compute them in a step before this one:\n${params.filter(Boolean).join('\n---\n')}`);
            const confidence: FlowPlanConfidence = params.some(Boolean) ? 'partial' : 'direct';
            return finish({
                kind: 'action', id, source: src, action: 'action.core.fireEvent', label: a.name,
                inputs: {
                    event_name: { kind: 'literal', value: settings.display('event_name') },
                    record: recordText,
                },
                confidence, notes, stage, waits: false,
            }, confidence);
        }

        case 'Run Script': {
            const script = settings.value('script');
            const assigned = simpleAssignments(script);
            if (assigned && Object.keys(assigned.scratchpad).length && !Object.keys(assigned.current).length) {
                for (const [key, value] of Object.entries(assigned.scratchpad)) {
                    if (!ctx.flowVariables.has(key)) ctx.flowVariables.set(key, typeOfLiteral(String(value.kind === 'literal' ? value.value : '')));
                }
                return finish({ kind: 'setFlowVariables', id, source: src, values: assigned.scratchpad, notes }, 'direct');
            }
            if (assigned && Object.keys(assigned.current).length && !Object.keys(assigned.scratchpad).length) {
                return finish({
                    kind: 'action', id, source: src, action: 'action.core.updateRecord', label: a.name,
                    inputs: { table_name: { kind: 'literal', value: ctx.table }, record, values: { kind: 'template', fields: assigned.current } },
                    confidence: 'direct', notes: [...notes, `From the script: ${oneLine(script, 200)}`], stage, waits: false,
                }, 'direct');
            }
            decide(ctx, 'script', `${a.name}: a ${lineCount(script)}-line script. Port it to a custom action with a script step, or to declarative actions if it only reads and writes records.`, a.sysId);
            return finish(todo(ctx, a, 'Script: port it to a custom action with a script step (see the workflow-migration skill).', script), 'manual');
        }

        case 'Workflow': {
            const target = a.subflow?.name ?? (settings.display('workflow_instance') || '?');
            settings.use('workflow_instance');
            decide(ctx, 'subflow', `${a.name} runs the workflow "${target}": convert that workflow to a subflow and call it here.`, a.sysId);
            return finish(todo(ctx, a, `Runs the workflow "${target}": convert it to a subflow, then call it here (wfa.subflow).`), 'manual');
        }

        case 'Return Value':
            return finish(todo(ctx, a, 'The subflow\'s result: declare an output and set it with Assign Subflow Outputs.', settings.value('value')), 'partial');

        default: {
            const detail = a.variables.filter(v => !v.isDefault && v.value).map(v => `${v.element} = ${v.value}`).join('\n');
            settings.use(...a.variables.map(v => v.element));
            const description = oneLine(s.typeOf(a.sysId)?.description ?? '', 200);
            decide(ctx, 'other', `${a.name} [${a.type}] has no planned Flow Designer equivalent.${description ? ` ${description}` : ''}`, a.sysId);
            return finish(todo(ctx, a, `No planned Flow Designer equivalent for "${a.type}".`, detail || undefined), 'manual');
        }
    }
}

// ------------------------------------------------------------------ helpers

function todo(ctx: Context, a: WorkflowExportActivity, reason: string, detail?: string): Extract<FlowPlanNode, { kind: 'todo' }> {
    return { kind: 'todo', id: newId(ctx, `todo_${a.name}`), source: source(ctx, a.sysId), reason, ...(detail ? { detail } : {}) };
}

function decide(ctx: Context, topic: FlowPlanDecision['topic'], detail: string, activity: string): void {
    ctx.decisions.push({ topic, detail, activities: [activity] });
}

function source(ctx: Context, sysId: string): FlowPlanSource {
    const a = ctx.s.activity(sysId);
    return { activity: sysId, name: a?.name ?? sysId, type: a?.type ?? '', number: ctx.numbers.get(sysId) ?? 0 };
}

function newId(ctx: Context, text: string): string {
    const short = identifierFrom(identifierFrom(text, 120).replace(new RegExp(`(^|_)${ctx.prefix}_`), '$1'), 60);
    const base = RESERVED.has(short) ? `step_${short}` : short;
    let id = base;
    for (let i = 2; ctx.ids.has(id); i++) id = `${base}_${i}`;
    ctx.ids.add(id);
    return id;
}

function oneLine(text: string, limit = 160): string {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** `${field}` / `${current.field}` → a data pill on the workflow's record; catalog variables are not pills. */
function referencePill(expression: string, recordPill: string): FlowPlanValue | undefined {
    if (!recordPill) return undefined;
    const m = /^\$\{\s*(?:current\.)?([a-z_][\w.]*)\s*\}$/i.exec(expression.trim());
    if (!m || m[1].startsWith('variables.')) return undefined;
    return { kind: 'pill', expr: `${recordPill}.${m[1]}`, type: 'reference' };
}

/**
 * Users, groups or recipients: sys_ids and addresses as literals, `${field}` as data pills;
 * anything else (scripted expressions) as an empty literal for the caller to flag.
 */
function approvers(value: string, recordPill: string): FlowPlanValue[] {
    if (!value) return [];
    return value.split(',').map(part => part.trim()).filter(Boolean).map((part): FlowPlanValue =>
        (/^[0-9a-f]{32}$/i.test(part) || /^[^\s@${}]+@[^\s@]+$/.test(part) ? { kind: 'literal', value: part }
            : referencePill(part, recordPill) ?? { kind: 'literal', value: '' }));
}

/** Text with `${field}` substitutions → text with data pills (catalog variables and expressions stay text). */
function substitute(text: string, recordPill: string): FlowPlanValue {
    if (!/\$\{/.test(text) || !recordPill) return { kind: 'literal', value: text };
    const parts: Array<string | { expr: string; type: string }> = [];
    let last = 0;
    for (const m of text.matchAll(/\$\{\s*(?:current\.)?([a-z_][\w.]*)\s*\}/gi)) {
        parts.push(text.slice(last, m.index));
        parts.push(m[1].startsWith('variables.') ? m[0] : { expr: `${recordPill}.${m[1]}`, type: 'string' });
        last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    return { kind: 'text', parts: parts.filter(p => p !== '') };
}

/** An encoded template (`field=value^field2=value2`) → a field map; `javascript:` and `${…}` values flag it partial. */
function templateFields(template: string): { fields: Record<string, FlowPlanValue>; partial: boolean } {
    const fields: Record<string, FlowPlanValue> = {};
    let partial = false;
    for (const term of (template || '').replace(/\^EQ$/, '').split('^').filter(Boolean)) {
        const at = term.indexOf('=');
        if (at <= 0) continue;
        const value = term.slice(at + 1);
        if (/^javascript:|\$\{/i.test(value)) partial = true;
        fields[term.slice(0, at)] = { kind: 'literal', value };
    }
    return { fields, partial };
}

/** Stored duration (`1970-01-02 01:00:00`) → seconds. */
function durationSeconds(value: string): number | undefined {
    if (!value) return 0;
    const m = /^1970-01-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (!m) return undefined;
    return (Number(m[1]) - 1) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** A script made only of `current.x = <literal>;` and `workflow.scratchpad.y = <literal>;` statements. */
function simpleAssignments(script: string): { current: Record<string, FlowPlanValue>; scratchpad: Record<string, FlowPlanValue> } | undefined {
    const statements = compact(script).split(';').filter(Boolean);
    if (!statements.length) return undefined;
    const current: Record<string, FlowPlanValue> = {};
    const scratchpad: Record<string, FlowPlanValue> = {};
    for (const statement of statements) {
        const m = /^(current|workflow\.scratchpad)\.([a-z_]\w*)=(.+)$/i.exec(statement);
        if (!m || !SCRIPT_LITERAL.test(m[3])) return undefined;
        const raw = m[3];
        const value: string | number | boolean = raw === 'true' ? true : raw === 'false' ? false
            : /^-?\d/.test(raw) ? Number(raw) : raw.replace(/^'|'$/g, '');
        (m[1] === 'current' ? current : scratchpad)[m[2]] = { kind: 'literal', value };
    }
    return { current, scratchpad };
}

// ------------------------------------------------------------------ rendering

/** The plan as readable text: trigger, flow body, notes and the open decisions. */
export function renderFlowPlan(plan: FlowConversionPlan): string {
    const out: string[] = [];
    out.push(`# Flow Designer plan for "${plan.name}"  (${plan.kind}, from wf_workflow ${plan.source.workflowSysId}, version ${plan.source.versionSysId})`);
    const t = plan.trigger;
    if (t.kind === 'serviceCatalog') out.push(`TRIGGER Service Catalog (${t.table})${t.catalogItems.length ? ` for ${t.catalogItems.map(c => `"${c.name}"`).join(', ')}` : ''}`);
    else if (t.kind === 'record') out.push(`TRIGGER ${t.table} created${t.condition ? ` where ${t.condition}` : ''}`);
    else out.push(`SUBFLOW inputs: record (${t.table})${t.inputs.length ? `, ${t.inputs.map(i => `${i.name}: ${i.type}`).join(', ')}` : ''}`);
    for (const note of t.notes) out.push(`  note: ${note}`);
    if (plan.flowVariables.length) out.push(`FLOW VARIABLES (from workflow.scratchpad): ${plan.flowVariables.map(v => `${v.name}: ${v.type}`).join(', ')}`);
    out.push(`COVERAGE: ${plan.coverage.direct} direct, ${plan.coverage.partial} partial, ${plan.coverage.manual} to design by hand`);
    out.push('');

    const pill = (expr: string): string => `{{${expr.replace(/^params\.trigger\./, 'trigger.').replace(/^params\.inputs\./, 'input.').replace(/^params\.flowVariables\./, 'flow_variables.')}}}`;
    const value = (v: FlowPlanValue): string => {
        switch (v.kind) {
            case 'literal': return JSON.stringify(v.value);
            case 'pill': return pill(v.expr);
            case 'text': return v.parts.map(p => (typeof p === 'string' ? p : pill(p.expr))).join('');
            case 'template': return Object.entries(v.fields).map(([k, x]) => `${k}=${value(x)}`).join(', ');
            case 'approvalRules': return `${v.ruleType} of${v.users.length ? ` users [${v.users.map(value).join(', ')}]` : ''}${v.groups.length ? ` groups [${v.groups.map(value).join(', ')}]` : ''}`;
            case 'duration': return `${v.seconds}s`;
            case 'list': return `[${v.items.map(value).join(', ')}]`;
        }
    };
    const condition = (c: FlowPlanCondition): string => (c.derived
        ? c.expression.replace(/\$\{wfa\.dataPill\(([\w.]+), "\w+"\)\}/g, (_m, expr: string) => pill(expr))
        : `TODO(${oneLine(c.source, 120)})`);
    const mark = (c: FlowPlanConfidence): string => (c === 'direct' ? '' : c === 'partial' ? ' [PARTIAL]' : ' [MANUAL]');
    const from = (n: FlowPlanNode): string => `   ← ${n.source.number}. ${n.source.name}`;
    const noteLines = (notes: string[], pad: string): void => {
        for (const note of notes) out.push(`${pad}  note: ${oneLine(note, 220)}`);
    };

    const render = (nodes: FlowPlanNode[], depth: number): void => {
        const pad = '    '.repeat(depth);
        for (const n of nodes) {
            switch (n.kind) {
                case 'action':
                    out.push(`${pad}${n.action.replace('action.core.', '')}${n.output ? ` → ${n.output}` : ''}${n.waits ? ' [WAIT]' : ''}${mark(n.confidence)}${from(n)}`);
                    for (const [k, v] of Object.entries(n.inputs)) out.push(`${pad}  - ${k} = ${oneLine(value(v), 200)}`);
                    noteLines(n.notes, pad);
                    break;
                case 'waitForADuration':
                    out.push(`${pad}waitForADuration ${n.seconds}s [WAIT]${mark(n.confidence)}${from(n)}`);
                    noteLines(n.notes, pad);
                    break;
                case 'setFlowVariables':
                    out.push(`${pad}setFlowVariables ${Object.entries(n.values).map(([k, v]) => `${k}=${value(v)}`).join(', ')}${from(n)}`);
                    noteLines(n.notes, pad);
                    break;
                case 'if':
                    n.branches.forEach((b, i) => {
                        out.push(`${pad}${i ? 'else if' : 'if'} ${condition(b.condition)}   [${b.label}]${i ? '' : `${mark(n.confidence)}${from(n)}`}`);
                        render(b.body, depth + 1);
                    });
                    if (n.otherwise) {
                        out.push(`${pad}else   [${n.otherwise.label}]`);
                        render(n.otherwise.body, depth + 1);
                    }
                    noteLines(n.notes, pad);
                    break;
                case 'parallel':
                    out.push(`${pad}in parallel${from(n)}`);
                    noteLines(n.notes, pad);
                    n.lanes.forEach((lane, k) => {
                        out.push(`${pad}  branch ${k + 1}:`);
                        render(lane, depth + 1);
                    });
                    break;
                case 'endFlow':
                    out.push(`${pad}endFlow`);
                    break;
                case 'todo':
                    out.push(`${pad}TODO: ${oneLine(n.reason, 220)}${from(n)}`);
                    break;
            }
        }
    };
    render(plan.steps, 0);
    if (plan.openDecisions.length) {
        out.push('', 'OPEN DECISIONS:');
        for (const d of plan.openDecisions) out.push(`  - [${d.topic}] ${oneLine(d.detail, 400)}`);
    }
    return out.join('\n');
}
