import { HTTPRequest } from "../../comm/http/HTTPRequest";
import { Requirement, Verb } from "../PolicyTypes";

/**
 * Works out what permission an outgoing request needs.
 *
 * NOT keyed on the HTTP verb, because the verb lies in both directions:
 *
 *   - `ApplicationManager.installStoreApplication` and `updateStoreApplication` mutate
 *     via **GET**, and `exportUpdateSet` GETs with `sysparm_delete_when_done=true`.
 *   - `ServiceNowProcessorRequest` **POSTs to read** — syslog tailing is a POST.
 *
 * So "block POST/PUT/DELETE" is simultaneously too loose and too strict. Instead three
 * tiers are joined, strongest first:
 *
 *   1. FLOOR    — matched on path AND query params. Cannot be lowered by anything.
 *   2. DECLARED — `request.requires`, set by the two call sites the default gets wrong.
 *   3. DEFAULT  — GET needs nothing, everything else needs write.
 *
 * The failure modes are asymmetric on purpose. A missing DECLARED entry on a reading
 * POST is a visible false refusal — someone files a bug. A missing FLOOR entry on a
 * mutating GET is a silent hole. That is why mutating GETs live in the floor, which
 * nobody has to remember to opt into, rather than relying on a declaration.
 */

interface FloorRule {
    /** Human-readable, appears in the audit log. */
    readonly why: string;
    readonly verbs: readonly Verb[];
    matches(path: string, query: Record<string, unknown>): boolean;
}

const pathIs = (needle: string) => (path: string) => path.split("?")[0].endsWith(needle);
const pathHas = (needle: string) => (path: string) => path.includes(needle);

/**
 * Un-lowerable minimums.
 *
 * Every entry here exists because the tier-3 default would get it wrong. Adding a new
 * mutating endpoint that travels as a GET means adding a row here — there is no way to
 * detect that statically, so it is called out in the contribution checklist and the
 * audit log is the backstop.
 */
const FLOOR: readonly FloorRule[] = [
    {
        why: "background script execution",
        verbs: ["execute"],
        matches: (p) => pathIs("/sys.scripts.do")(p),
    },
    // NOTE: /xmlhttp.do is deliberately NOT a floor rule, even though the most
    // destructive call in the library (Application.uninstall) goes through it. The same
    // endpoint is used to READ — syslog tailing POSTs to it — and a floor rule cannot be
    // lowered, so listing it here would refuse `nex log` with no way to correct it.
    // Coverage instead comes from three narrower places: the sysparm_delete_all rule
    // below catches the uninstall, the tier-3 default makes every other POST a write,
    // and the two callers that read or execute through it declare so explicitly.
    {
        why: "store application install (issued as a GET)",
        verbs: ["write"],
        matches: (p) => pathHas("/api/sn_appclient/appmanager/app/install")(p),
    },
    {
        why: "store application update (issued as a GET)",
        verbs: ["write"],
        matches: (p) => pathHas("/api/sn_appclient/appmanager/app/update")(p),
    },
    {
        why: "sys_trigger scheduled job — persisting a job outlives the request that made it",
        verbs: ["write"],
        matches: (p) => pathHas("/api/now/table/sys_trigger")(p),
    },
    {
        why: "sysparm_delete_all",
        verbs: ["write"],
        matches: (_p, q) => "sysparm_delete_all" in q,
    },
    {
        why: "sysparm_delete_when_done",
        verbs: ["write"],
        matches: (_p, q) => {
            const value = q["sysparm_delete_when_done"];
            if (value === undefined) {
                return false;
            }
            // Only primitives are meaningful here; an object would stringify to
            // "[object Object]" and match, which would be a false positive.
            const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
                ? String(value)
                : "";
            return text.toLowerCase() !== "false" && text.length > 0;
        },
    },
];

function normalizeQuery(request: HTTPRequest): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const query = request.query as Record<string, unknown> | null | undefined;
    if (query && typeof query === "object") {
        for (const [key, value] of Object.entries(query)) {
            out[key] = value;
        }
    }
    // Some callers put parameters in `fields` (form-encoded) rather than the query
    // string — Application.uninstall sends sysparm_delete_all that way.
    const fields = request.fields as Record<string, unknown> | null | undefined;
    if (fields && typeof fields === "object") {
        for (const [key, value] of Object.entries(fields)) {
            if (!(key in out)) {
                out[key] = value;
            }
        }
    }
    return out;
}

/** Matched floor rules, for the audit log and for tests. */
export function floorFor(request: HTTPRequest): { verbs: Verb[]; reasons: string[] } {
    const path = typeof request.path === "string" ? request.path : "";
    const query = normalizeQuery(request);

    const verbs = new Set<Verb>();
    const reasons: string[] = [];
    for (const rule of FLOOR) {
        if (rule.matches(path, query)) {
            rule.verbs.forEach((v) => verbs.add(v));
            reasons.push(rule.why);
        }
    }
    return { verbs: [...verbs], reasons };
}

/** Tier 3. GET is assumed to read; anything else is assumed to write. */
function verbDefault(method: string | null | undefined): Verb[] {
    const verb = (method ?? "get").toLowerCase();
    return verb === "get" ? [] : ["write"];
}

/**
 * The joined requirement for a request.
 *
 * DECLARED replaces the default when present, but the floor is unioned in afterwards so
 * a declaration can correct a wrong default without ever lowering a floor entry.
 */
export function classify(request: HTTPRequest): Requirement & { reasons: string[] } {
    const declared = request.requires;
    const base: readonly Verb[] = declared ? declared.verbs : verbDefault(request.method);
    const target = declared?.target ?? "instance";

    const { verbs: floorVerbs, reasons } = floorFor(request);

    const verbs = new Set<Verb>(base);
    floorVerbs.forEach((v) => verbs.add(v));

    return {
        verbs: [...verbs],
        // A floor match is always about the instance, whatever the caller declared —
        // otherwise declaring `target: "local"` would be a way to opt out of the floor.
        target: floorVerbs.length > 0 ? "instance" : target,
        reasons,
    };
}
