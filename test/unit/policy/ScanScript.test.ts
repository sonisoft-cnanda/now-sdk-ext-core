/**
 * Script scanning.
 *
 * The scan is unsound and the tests are written to keep that honest: the cases that
 * matter most are the ones where it must ESCALATE rather than the ones where it detects
 * cleanly. A scanner that quietly passes `gr['inse'+'rt']()` is worse than none, because
 * it looks like it checked.
 */

import { describe, it, expect } from "@jest/globals";
import { requirementForScript, scanScript } from "../../../src/policy/ScanScript";

describe("obvious mutations", () => {
    it.each([
        ["insert", "var gr = new GlideRecord('incident'); gr.initialize(); gr.insert();"],
        ["update", "var gr = new GlideRecord('incident'); gr.get('1'); gr.update();"],
        ["deleteRecord", "var gr = new GlideRecord('incident'); gr.get('1'); gr.deleteRecord();"],
        ["deleteMultiple", "var gr = new GlideRecord('incident'); gr.query(); gr.deleteMultiple();"],
        ["updateMultiple", "var gr = new GlideRecord('incident'); gr.query(); gr.updateMultiple();"],
    ])("detects .%s()", (method, script) => {
        const result = scanScript(script);
        expect(result.verbs).toEqual(["write"]);
        expect(result.reasons.join()).toContain(method);
    });

    it("survives formatting a regex would trip on", () => {
        const script = `
            var gr = new GlideRecord('incident');
            gr
                .deleteRecord();
        `;
        expect(scanScript(script).verbs).toEqual(["write"]);
    });

    it("ignores a mutation that only appears in a comment", () => {
        // A regex scan reports this; the AST does not, because it is not code.
        const script = "// gr.deleteRecord();\nvar gr = new GlideRecord('incident'); gr.query();";
        expect(scanScript(script).verbs).toEqual([]);
    });

    it("ignores a method name that only appears in a string", () => {
        expect(scanScript("gs.info('call insert to add a record');").verbs).toEqual([]);
    });
});

describe("read-only scripts", () => {
    it.each([
        "gs.info('hello');",
        "var gr = new GlideRecord('incident'); gr.query(); while (gr.next()) { gs.print(gr.number); }",
        "var ga = new GlideAggregate('incident'); ga.addAggregate('COUNT'); ga.query();",
        "gs.print(gs.getUser().getName());",
    ])("needs nothing extra for %p", (script) => {
        expect(scanScript(script).verbs).toEqual([]);
    });

    it("still requires execute overall — the scan never removes it", () => {
        // Permitting a script to run at all is the real decision.
        expect(requirementForScript("gs.info('hi');").verbs).toEqual(["execute"]);
    });

    it("adds write on top of execute when the script mutates", () => {
        expect(requirementForScript("new GlideRecord('x').insert();").verbs).toEqual([
            "execute",
            "write",
        ]);
    });
});

describe("escalation — the cases that must not pass", () => {
    it("escalates on computed member access, the obvious evasion", () => {
        const result = scanScript("var gr = new GlideRecord('incident'); gr['inse' + 'rt']();");
        expect(result.verbs).toEqual(["write"]);
        expect(result.escalated).toBe(true);
        expect(result.reasons.join()).toMatch(/chosen at runtime/i);
    });

    it("escalates on a method chosen from a variable", () => {
        const result = scanScript("var m = 'deleteRecord'; var gr = new GlideRecord('x'); gr[m]();");
        expect(result.verbs).toEqual(["write"]);
        expect(result.escalated).toBe(true);
    });

    it("still detects a computed access with a literal name", () => {
        // gr['insert']() is resolvable — report it as the mutation it is, not as an
        // unresolvable escalation.
        const result = scanScript("var gr = new GlideRecord('x'); gr['insert']();");
        expect(result.verbs).toEqual(["write"]);
        expect(result.reasons.join()).toContain("insert");
    });

    it("escalates on eval", () => {
        const result = scanScript("eval(payload);");
        expect(result.verbs).toEqual(["write"]);
        expect(result.escalated).toBe(true);
    });

    it("escalates on gs.eval", () => {
        const result = scanScript("gs.eval(someString);");
        expect(result.verbs).toEqual(["write"]);
        expect(result.escalated).toBe(true);
    });

    it("escalates when the script cannot be parsed at all", () => {
        // Unreadable means unknowable. Passing here would be the worst possible default.
        const result = scanScript("this is not javascript {{{");
        expect(result.verbs).toEqual(["write"]);
        expect(result.escalated).toBe(true);
        expect(result.reasons.join()).toMatch(/could not be parsed/i);
    });

    it("parses modern syntax rather than escalating on it", () => {
        // ES5 fails, latest succeeds — must not be treated as unparseable.
        const result = scanScript("const f = (x) => x * 2; gs.info(`${f(2)}`);");
        expect(result.verbs).toEqual([]);
        expect(result.escalated).toBe(false);
    });
});

describe("degenerate input", () => {
    it.each([["", []], ["   ", []]])("returns nothing for %p", (script, expected) => {
        expect(scanScript(script).verbs).toEqual(expected);
    });

    it("does not throw on a non-string", () => {
        expect(() => scanScript(undefined as unknown as string)).not.toThrow();
    });

    it("does not report the same reason twice", () => {
        const result = scanScript("a.insert(); b.insert(); c.insert();");
        expect(result.reasons).toEqual(["calls .insert()"]);
    });
});
