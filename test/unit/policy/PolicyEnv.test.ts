/**
 * Environment layers, and the fail-closed rule.
 *
 * `NEX_POLICY_DENY` is the layer an agent cannot reach, so a typo in it must not
 * silently disable the protection it was set to provide.
 */

import { describe, it, expect } from "@jest/globals";
import {
    ALLOW_ENV,
    DENY_ENV,
    allowFromEnvironment,
    denyFromEnvironment,
    parseVerbList,
} from "../../../src/policy/PolicyEnv";

describe("parseVerbList", () => {
    it.each([
        ["write", ["write"]],
        ["execute", ["execute"]],
        ["write,execute", ["write", "execute"]],
        [" write , execute ", ["write", "execute"]],
        ["WRITE", ["write"]],
        ["all", ["write", "execute"]],
    ])("parses %p", (raw, expected) => {
        expect(parseVerbList(raw).verbs).toEqual(expected);
    });

    it("reports unrecognised tokens rather than dropping them", () => {
        // Load-bearing: the deny layer fails closed on these.
        const parsed = parseVerbList("write,wrtie");
        expect(parsed.verbs).toEqual(["write"]);
        expect(parsed.unknown).toEqual(["wrtie"]);
    });

    it("treats an unset value as empty, not as an error", () => {
        expect(parseVerbList(undefined)).toEqual({ verbs: [], unknown: [] });
    });
});

describe("denyFromEnvironment", () => {
    it("is absent when the variable is unset", () => {
        expect(denyFromEnvironment({})).toBeUndefined();
        expect(denyFromEnvironment({ [DENY_ENV]: "   " })).toBeUndefined();
    });

    it("denies the listed verbs and abstains on the rest", () => {
        const layer = denyFromEnvironment({ [DENY_ENV]: "write" });
        expect(layer?.answer("write")).toBe("deny");
        expect(layer?.answer("execute")).toBe("abstain");
    });

    it("FAILS CLOSED on a malformed value, and says so", () => {
        // A typo in the variable protecting production must not quietly protect nothing.
        const warnings: string[] = [];
        const layer = denyFromEnvironment({ [DENY_ENV]: "wrtie" }, (m) => warnings.push(m));

        expect(layer?.answer("write")).toBe("deny");
        expect(layer?.answer("execute")).toBe("deny");
        expect(warnings.join()).toMatch(/unrecognised/i);
        expect(layer?.name).toMatch(/failing closed/i);
    });

    it("fails closed even when part of the value is valid", () => {
        const layer = denyFromEnvironment({ [DENY_ENV]: "write,typo" });
        expect(layer?.answer("execute")).toBe("deny");
    });

    it("all denies everything", () => {
        const layer = denyFromEnvironment({ [DENY_ENV]: "all" });
        expect(layer?.answer("write")).toBe("deny");
        expect(layer?.answer("execute")).toBe("deny");
    });
});

describe("allowFromEnvironment", () => {
    it("grants the listed verbs and abstains on the rest", () => {
        const layer = allowFromEnvironment({ [ALLOW_ENV]: "write" });
        expect(layer?.answer("write")).toBe("grant");
        expect(layer?.answer("execute")).toBe("abstain");
    });

    it("drops unrecognised tokens with a warning rather than failing closed", () => {
        // Opposite of DENY on purpose: this variable only grants, so a typo already
        // fails safe — the operation is refused and the operator sees why.
        const warnings: string[] = [];
        const layer = allowFromEnvironment({ [ALLOW_ENV]: "write,typo" }, (m) => warnings.push(m));
        expect(layer?.answer("write")).toBe("grant");
        expect(warnings.join()).toMatch(/ignored/i);
    });

    it("is absent when nothing valid remains", () => {
        expect(allowFromEnvironment({ [ALLOW_ENV]: "typo" })).toBeUndefined();
    });
});
