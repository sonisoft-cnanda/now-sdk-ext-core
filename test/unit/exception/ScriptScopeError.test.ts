/**
 * ScriptScopeError has to stay recognisable on the way out of this library: the CLI and
 * the MCP server identify it by `code`, and `executeScriptAuto` must re-throw it rather
 * than fall back to sys_trigger — which would run the script in global instead.
 */

import { describe, it, expect } from "@jest/globals";
import { ScriptScopeError, isScriptScopeError } from "../../../src/exception/ScriptScopeError";
import { redactError, stripSecretsFromError } from "../../../src/util/redact";

const storeAppError = () => new ScriptScopeError({
    scope: "x_acme_util",
    reason: "NOT_A_DEVELOPED_APP",
    problem: "Scope 'x_acme_util' (Acme Utilities) is an installed store/repository application (sys_store_app).",
    remediation: "Run the script in \"global\" and call the application's API fully qualified.",
    foundAs: { sysId: "abc", name: "Acme Utilities", className: "sys_store_app", active: true }
});

describe("ScriptScopeError", () => {
    it("is a real Error with its own name", () => {
        const error = storeAppError();
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("ScriptScopeError");
        expect(typeof error.stack).toBe("string");
    });

    it("carries the same code on the class and the instance", () => {
        expect(storeAppError().code).toBe(ScriptScopeError.code);
        expect(ScriptScopeError.code).toBe("NEX_SCRIPT_SCOPE_UNAVAILABLE");
    });

    it("puts the remediation in the message, so message-only consumers still get it", () => {
        const error = storeAppError();
        expect(error.message).toContain("sys_store_app");
        expect(error.message).toContain(error.remediation);
    });

    it("keeps the cause when given one", () => {
        const cause = new Error("Status: 403");
        const error = new ScriptScopeError(
            { scope: "x", reason: "LOOKUP_FAILED", problem: "Could not look up scope 'x'.", remediation: "Retry." },
            { cause }
        );
        expect(error.cause).toBe(cause);
    });

    it("serialises its structured fields", () => {
        expect(JSON.parse(JSON.stringify(storeAppError()))).toEqual({
            name: "ScriptScopeError",
            message: storeAppError().message,
            code: "NEX_SCRIPT_SCOPE_UNAVAILABLE",
            remediation: "Run the script in \"global\" and call the application's API fully qualified.",
            scope: "x_acme_util",
            reason: "NOT_A_DEVELOPED_APP",
            foundAs: { sysId: "abc", name: "Acme Utilities", className: "sys_store_app", active: true }
        });
    });
});

describe("isScriptScopeError", () => {
    it("recognises an instance", () => {
        expect(isScriptScopeError(storeAppError())).toBe(true);
    });

    it("recognises one from another copy of the package by code alone", () => {
        const foreign = Object.assign(new Error("from elsewhere"), { code: "NEX_SCRIPT_SCOPE_UNAVAILABLE" });
        expect(isScriptScopeError(foreign)).toBe(true);
    });

    it("rejects other errors and non-errors", () => {
        expect(isScriptScopeError(new Error("Error executing script: boom"))).toBe(false);
        expect(isScriptScopeError(Object.assign(new Error("x"), { code: "NEX_SESSION_EXPIRED" }))).toBe(false);
        expect(isScriptScopeError(null)).toBe(false);
        expect(isScriptScopeError(undefined)).toBe(false);
    });
});

describe("survives the error path it actually travels", () => {
    it("is still recognisable after stripSecretsFromError", () => {
        const error = storeAppError();
        expect(() => stripSecretsFromError(error)).not.toThrow();
        expect(isScriptScopeError(error)).toBe(true);
        expect(error.remediation).toContain("global");
    });

    it("keeps code, reason and remediation when redacted as a nested cause", () => {
        const wrapper = new Error("outer", { cause: storeAppError() });
        const redacted = redactError(wrapper);
        expect(redacted.cause).toMatchObject({
            code: "NEX_SCRIPT_SCOPE_UNAVAILABLE",
            reason: "NOT_A_DEVELOPED_APP",
            scope: "x_acme_util"
        });
        expect((redacted.cause as Record<string, unknown>).remediation).toContain("global");
    });
});
