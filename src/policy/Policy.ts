import {
    Decision,
    LayerAnswer,
    PolicyLayer,
    Requirement,
    Target,
    Verb,
} from "./PolicyTypes";

/**
 * Process-wide permission policy.
 *
 * INERT UNTIL CONFIGURED. With no policy installed every check allows, so importing
 * this library changes nothing for existing consumers — `new TableAPIRequest(i).post()`
 * behaves exactly as it did. The applications that are actually driven by agents (the
 * `nex` CLI and the MCP server) install a deny-by-default policy in their entrypoints.
 *
 * That split is deliberate. The risk being managed is "an agent drives the CLI or the
 * MCP server", not "a program imports this library"; denying by default here would
 * break every embedder to mitigate a risk they do not have.
 */

/**
 * Layers in priority order. The FIRST layer to answer anything other than `abstain`
 * decides.
 *
 * Ordered layers rather than an escalating if-chain because not every source is a
 * grant: `--read-only` (NEX-76) REVOKES, and an escalate-only model cannot express a
 * source that lowers permission. Getting this shape right now is what lets NEX-76 add
 * `ApprovalToken` and `--approve-all` later without a rewrite.
 *
 * Index 0 is the only layer an agent cannot reach — see `denyFromEnvironment`.
 */
const DEFAULT_LAYER = "default";

let layers: readonly PolicyLayer[] = [];
let installed = false;

/** True once an application has installed a policy. Until then, everything is allowed. */
export function isPolicyInstalled(): boolean {
    return installed;
}

/**
 * Installs the process policy. Call once, from the application that owns the entry
 * point — never from a library.
 *
 * Layers are supplied in priority order (highest first).
 */
export function installPolicy(orderedLayers: readonly PolicyLayer[]): void {
    layers = [...orderedLayers];
    installed = true;
}

/** Removes the policy, returning to the permissive default. Test seam. */
export function resetPolicyForTests(): void {
    layers = [];
    installed = false;
}

/** The layers currently installed, highest priority first. Diagnostics and `nex policy status`. */
export function currentLayers(): readonly PolicyLayer[] {
    return layers;
}

/**
 * Resolves a single verb against the ladder.
 *
 * Returns the deciding layer's name alongside the answer so refusals can say which one
 * spoke. Without that, a precedence bug is invisible: the user sees "refused" and has
 * no way to tell whether the environment denied it or nothing granted it.
 */
function resolveVerb(verb: Verb): { granted: boolean; decidingLayer: string } {
    for (const layer of layers) {
        const answer: LayerAnswer = layer.answer(verb);
        if (answer === "grant") {
            return { granted: true, decidingLayer: layer.name };
        }
        if (answer === "deny") {
            return { granted: false, decidingLayer: layer.name };
        }
    }
    return { granted: false, decidingLayer: DEFAULT_LAYER };
}

/**
 * Decides whether an operation may proceed.
 *
 * Only `target: "instance"` is gated. A local file write or a session-preference change
 * is not what this exists to prevent, and refusing them would produce false refusals on
 * operations that never touch instance data (`script-sync pull` being the clearest).
 */
export function checkRequirement(requirement: Requirement): Decision {
    if (!installed || requirement.verbs.length === 0 || requirement.target !== "instance") {
        return {
            allowed: true,
            verbs: requirement.verbs,
            decidingLayer: installed ? "not-gated" : "no-policy",
        };
    }

    // Every required verb must be granted. A script needing execute AND write is not
    // satisfied by execute alone.
    for (const verb of requirement.verbs) {
        const { granted, decidingLayer } = resolveVerb(verb);
        if (!granted) {
            return {
                allowed: false,
                verbs: requirement.verbs,
                decidingLayer,
                remediation: remediationFor(requirement.verbs, verb, decidingLayer),
            };
        }
    }

    return {
        allowed: true,
        verbs: requirement.verbs,
        decidingLayer: resolveVerb(requirement.verbs[0]).decidingLayer,
    };
}

/**
 * How the application explains a refusal.
 *
 * Set by the CLI to name its flags. Left unset by the MCP server, whose caller is the
 * model — naming the parameter there would advertise the escape hatch.
 */
let remediationWriter: ((verbs: readonly Verb[], missing: Verb, layer: string) => string) | undefined;

export function setRemediationWriter(
    writer: (verbs: readonly Verb[], missing: Verb, layer: string) => string,
): void {
    remediationWriter = writer;
}

function remediationFor(verbs: readonly Verb[], missing: Verb, layer: string): string {
    if (remediationWriter) {
        return remediationWriter(verbs, missing, layer);
    }
    return `This operation requires ${missing} permission on the instance, which has not been granted.`;
}

/**
 * A layer that denies the listed verbs outright.
 *
 * Placed at the top of the ladder so nothing below can grant past it. This is the layer
 * that makes pointing the tool at production meaningful.
 *
 * The guarantee has a precise limit, and the docs must state it: this only holds when
 * the variable is set somewhere the agent cannot write — a shell profile, a systemd
 * unit, a container environment. A project-local `.mcp.json` is a file in the workspace,
 * and an agent with file-write access can edit it.
 */
export function denyLayer(name: string, denied: readonly Verb[]): PolicyLayer {
    const set = new Set(denied);
    return {
        name,
        answer: (verb) => (set.has(verb) ? "deny" : "abstain"),
    };
}

/** A layer that grants the listed verbs and abstains on the rest. */
export function grantLayer(name: string, granted: readonly Verb[]): PolicyLayer {
    const set = new Set(granted);
    return {
        name,
        answer: (verb) => (set.has(verb) ? "grant" : "abstain"),
    };
}

/** Convenience for tests and for embedders that want the old unrestricted behaviour. */
export function allowAllLayer(): PolicyLayer {
    return grantLayer("allow-all", ["write", "execute"]);
}

export type { Decision, PolicyLayer, Requirement, Target, Verb };
