/**
 * Precedence and default posture.
 *
 * Ordered layers, not an escalating chain: `--read-only` (NEX-76) revokes rather than
 * grants, and a model where every source can only escalate cannot express that. These
 * tests pin the ordering so a later refactor into an if-chain fails loudly.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import {
    allowAllLayer,
    checkRequirement,
    denyLayer,
    grantLayer,
    installPolicy,
    isPolicyInstalled,
    resetPolicyForTests,
} from "../../../src/policy/Policy";
import { READ_ONLY, Requirement } from "../../../src/policy/PolicyTypes";

const write: Requirement = { verbs: ["write"], target: "instance" };
const execute: Requirement = { verbs: ["execute"], target: "instance" };
const both: Requirement = { verbs: ["execute", "write"], target: "instance" };

afterEach(() => resetPolicyForTests());

describe("no policy installed", () => {
    it("allows everything, so importing the library changes nothing for embedders", () => {
        expect(isPolicyInstalled()).toBe(false);
        expect(checkRequirement(write).allowed).toBe(true);
        expect(checkRequirement(both).allowed).toBe(true);
    });

    it("reports why it allowed, so the audit log can distinguish it from a grant", () => {
        expect(checkRequirement(write).decidingLayer).toBe("no-policy");
    });
});

describe("default posture once installed", () => {
    it("denies when no layer grants", () => {
        installPolicy([]);
        const decision = checkRequirement(write);
        expect(decision.allowed).toBe(false);
        expect(decision.decidingLayer).toBe("default");
    });

    it("still allows requirements that need no verbs", () => {
        installPolicy([]);
        expect(checkRequirement(READ_ONLY).allowed).toBe(true);
    });

    it("does not gate local or session targets", () => {
        installPolicy([]);
        // script-sync pull overwrites a local file; scope set changes session state.
        // Refusing these would be a false refusal on something that never touches
        // instance data.
        expect(checkRequirement({ verbs: ["write"], target: "local" }).allowed).toBe(true);
        expect(checkRequirement({ verbs: ["write"], target: "session" }).allowed).toBe(true);
    });
});

describe("precedence", () => {
    it("a higher deny layer beats a lower grant — this is the production guarantee", () => {
        installPolicy([denyLayer("env-deny", ["write"]), grantLayer("cli-flag", ["write"])]);
        const decision = checkRequirement(write);
        expect(decision.allowed).toBe(false);
        expect(decision.decidingLayer).toBe("env-deny");
    });

    it("a grant applies when no higher layer denies", () => {
        installPolicy([denyLayer("env-deny", ["execute"]), grantLayer("cli-flag", ["write"])]);
        expect(checkRequirement(write).allowed).toBe(true);
        expect(checkRequirement(execute).allowed).toBe(false);
    });

    it("abstain is not deny — a lower layer still gets to speak", () => {
        // If abstain collapsed into deny, an unset env var would refuse everything.
        installPolicy([denyLayer("env-deny", []), grantLayer("env-allow", ["write"])]);
        expect(checkRequirement(write).allowed).toBe(true);
        expect(checkRequirement(write).decidingLayer).toBe("env-allow");
    });

    it("the first non-abstaining layer decides, not the last", () => {
        installPolicy([
            grantLayer("first", ["write"]),
            denyLayer("second", ["write"]),
        ]);
        expect(checkRequirement(write).decidingLayer).toBe("first");
        expect(checkRequirement(write).allowed).toBe(true);
    });
});

describe("multi-verb requirements", () => {
    it("requires EVERY verb — execute alone does not satisfy execute+write", () => {
        // The case that matters: a background script that inserts records.
        installPolicy([grantLayer("cli-flag", ["execute"])]);
        const decision = checkRequirement(both);
        expect(decision.allowed).toBe(false);
        expect(decision.verbs).toEqual(["execute", "write"]);
    });

    it("allows when every verb is granted", () => {
        installPolicy([grantLayer("cli-flag", ["execute", "write"])]);
        expect(checkRequirement(both).allowed).toBe(true);
    });

    it("names the layer that refused the missing verb, not the one that granted", () => {
        installPolicy([denyLayer("env-deny", ["write"]), grantLayer("cli-flag", ["execute"])]);
        expect(checkRequirement(both).decidingLayer).toBe("env-deny");
    });
});

describe("allowAllLayer", () => {
    it("restores unrestricted behaviour for embedders that want it", () => {
        installPolicy([allowAllLayer()]);
        expect(checkRequirement(both).allowed).toBe(true);
    });
});

describe("audit attribution", () => {
    it("names every layer that granted, not just the first verb's", () => {
        // Raised in review of #49. execute from one layer, write from another: naming
        // only the first makes the audit log wrong about how a mutation was permitted,
        // and that log is what surfaces a missing floor rule.
        installPolicy([grantLayer("env-allow", ["execute"]), grantLayer("default", ["write"])]);
        const decision = checkRequirement(both);

        expect(decision.allowed).toBe(true);
        expect(decision.decidingLayer).toContain("env-allow");
        expect(decision.decidingLayer).toContain("default");
    });

    it("does not repeat a layer that granted both verbs", () => {
        installPolicy([grantLayer("default", ["write", "execute"])]);
        expect(checkRequirement(both).decidingLayer).toBe("default");
    });
});
