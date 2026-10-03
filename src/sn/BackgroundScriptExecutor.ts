/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { ServiceNowInstance } from "./ServiceNowInstance";

import { ServiceNowRequest } from "../comm/http/ServiceNowRequest";
//import { XMLParser } from "../utils";
import { X2jOptions, XMLParser } from 'fast-xml-parser';
import { Logger } from "../util/Logger";

import { HTTPRequest } from "../comm/http/HTTPRequest";
import { BG_SCRIPT_ENDPOINT } from "../constants/ServiceNow";
import { checkRequirement } from "../policy/Policy";
import { isPolicyRefusal, policyRefusal } from "../policy/PolicyRefusal";
import { requirementForScript } from "../policy/ScanScript";
import { Requirement } from "../policy/PolicyTypes";
import { IHttpResponse } from "../comm/http/IHttpResponse";
import { isNil } from "../util/utils";
import { CSRFTokenHelper } from "../util/CSRFTokenHelper";
import { TableAPIRequest } from "../comm/http/TableAPIRequest";
import { SessionManager } from "../comm/http/SessionManager";
import { ScriptScopeError, ScriptScopeMatch, isScriptScopeError } from "../exception/ScriptScopeError";


export class BackgroundScriptExecutor {
    snRequest: ServiceNowRequest;
    instance: ServiceNowInstance;
    scope: string;
    private _tableAPI: TableAPIRequest;
    private _scopeCache: Map<string, string> = new Map();

    _logger:Logger = new Logger("BackgroundScriptExecutor");

    public constructor( instance:ServiceNowInstance, scope:string  ) {
       
            this.instance = instance;
            this.scope = scope;
            this.snRequest = SessionManager.getInstance().getRequest(this.instance);
            this._tableAPI = new TableAPIRequest(this.instance);
    }

    /**
     * Refuses a script the policy does not permit, before it is sent anywhere.
     *
     * Running caller-supplied code always needs `execute`; the scan decides whether it
     * also needs `write`. The scan is unsound by design and leans toward `write` on
     * anything it cannot resolve — see ScanScript for what it cannot see at all.
     *
     * Pass the script that will ACTUALLY be sent. Callers doing `{param}` substitution
     * must substitute first, or a parameter value of `gr.insert()` walks straight past.
     */
    private assertScriptPermitted(script: string): Requirement {
        const { verbs, reasons } = requirementForScript(script);
        const decision = checkRequirement({ verbs, target: "instance" });
        if (decision.allowed) {
            return { verbs, target: "instance" };
        }

        this._logger.warn("Refused a background script", {
            verbs: decision.verbs,
            decidingLayer: decision.decidingLayer,
            detected: reasons,
        });

        const detail = reasons.length > 0
            ? `${decision.remediation ?? "Not permitted."} The script ${reasons.join("; ")}.`
            : decision.remediation;
        throw policyRefusal({ ...decision, remediation: detail });
    }

    /** @returns what this script needs, for the HTTP layer to agree with. */

    public async executeScript(script: string, scope: string = this.scope, instance:ServiceNowInstance = this.instance): Promise<BackgroundScriptExecutionResult> {
        if (!instance || !(instance instanceof ServiceNowInstance)) {
            throw new Error("instance must be a ServiceNowInstance");
        }
        if (!scope || typeof scope != "string") {
            throw new Error("scope must be a string");
        }
        if (!script || typeof script != "string") {
            throw new Error("script must be a string");
        }

        const scriptRequirement = this.assertScriptPermitted(script);

        try {

           const gck:string =  await this.getBackgroundScriptCSRFToken();
           if (isNil(gck)) {
               throw new Error(
                   "Failed to obtain CSRF token from the ServiceNow instance. " +
                   "This may indicate an authentication failure or that the user " +
                   "does not have permission to access Scripts - Background."
               );
           }
           // Resolve scope name to sys_id if needed (sys.scripts.do expects a sys_id)
           const resolvedScopeId = await this._resolveScopeToSysId(scope);

           const fd:FormData = new FormData();
           fd.append("script", script);
           fd.append("sysparm_ck", gck);
           fd.append("runscript",  "Run script");
           fd.append("sys_scope", resolvedScopeId);
           fd.append("record_for_rollback", "off");
           fd.append("quota_managed_transaction", "off");
        

           
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            const params:URLSearchParams = new URLSearchParams(fd as any );
            const request: HTTPRequest = {
                path: BG_SCRIPT_ENDPOINT,
                headers: {"Content-Type":"application/x-www-form-urlencoded"},
                query: null,
                body: params,
                // Declared so the HTTP gate reaches the SAME conclusion the script scan
                // did. Without it the POST default adds `write` on top of the floor's
                // `execute`, and a read-only diagnostic script needs write for no reason.
                requires: scriptRequirement
            };
            this._logger.debug("Execute Background Script Request.", {request:request, formData:fd})
            const response: IHttpResponse<string> = await this.snRequest.post<string>(request);
            if (response.status == 200) {
                const bodyXml:string = response?.data;
                if(bodyXml){
                    const resultObj:BackgroundScriptExecutionResult = this.parseScriptResult(bodyXml);
                    return resultObj;
                }else{
                    throw new Error("Body not XML String");
                }
               
            } else {
                throw new Error(`Script Execution Request resulted in ${response.status}`);
            }
        } catch (error) {
            // Unwrapped, so consumers can recognise it and show its remediation; its
            // message already says what went wrong and what to do.
            if (isScriptScopeError(error)) {
                throw error;
            }
            const err:Error = error as Error;
            throw new Error(`Error executing script: ${err.message}`, { cause: error });
        }
    }

    public parseScriptResult(responseXML: string) : BackgroundScriptExecutionResult {
        const options: X2jOptions = {
            ignoreAttributes: false,
            unpairedTags: ["hr", "br", "link", "meta", "img", "input", "HR", "BR", "LINK", "META", "IMG", "INPUT"],
            stopNodes: ["*.pre", "*.script", "*.PRE", "*.SCRIPT"],
            processEntities: true,
            htmlEntities: true,
            tagValueProcessor: (tagName: string, tagValue: any) => {
                if (tagName === "PRE" || tagName === "pre") {
                    return tagValue + "\n";
                }
                return tagValue;
            }
        };
        const parser: XMLParser = new XMLParser(options);
        let strippedResponseXML:string = responseXML.replace(/^\[[0-9:.]+\]/g, "");
        strippedResponseXML = this.fixMalformedHTML(strippedResponseXML);
        const jObj:ScriptExecutionXMLResult = parser.parse(strippedResponseXML) as ScriptExecutionXMLResult;
        
        const compositeResult:CompositeScriptExecutionResult =  this._parseBGScriptResult(jObj);
        const affectedRecords = this._parseAffectedRecords(jObj);

        const scriptResult:BackgroundScriptExecutionResult = {
            raw: responseXML,
            result: compositeResult.rawResult,
            consoleResult: compositeResult.consoleResult,
            rawResult: compositeResult.rawResult,
            scriptResults: compositeResult.scriptResults,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            affectedRecords: affectedRecords
        };

        this._logger.debug("parseScriptResult return value.", scriptResult);

        return scriptResult;
    }

    public async getBackgroundScriptCSRFToken() : Promise<string> {
        let csrfToken:string = null;

        const request: HTTPRequest = {
            path: BG_SCRIPT_ENDPOINT,
            headers: null,
            query: null,
            body: null
        };
        const response: IHttpResponse<string> = await this.snRequest.get<string>(request);
        const isLoggedIn:boolean = response.headers["x-is-logged-in"] === "true" ? true : false
        if(response.status == 200 && isLoggedIn && !isNil(response.data)){
            csrfToken = CSRFTokenHelper.extractCSRFToken(response.data);
            // The token is deliberately not interpolated into the message. Logger's
            // redaction format can scrub a `csrfToken` field but cannot scrub free text,
            // so a secret concatenated into the message string reaches disk verbatim.
            this._logger.debug("CSRF token received.", {received: !isNil(csrfToken)});
        }else{
            this._logger.error("getBackgroundScriptCSRFToken: Invalid response. Status not 200, not logged in, or response data is empty.", {response:response});
        }
          

        return csrfToken;
      }

    /**
     * Execute a script by creating a sys_trigger record.
     * This is an alternative to the background script page approach.
     * Creates a scheduled job that runs the script once and optionally deletes itself.
     *
     * @param script The script to execute
     * @param description Optional description for the trigger
     * @param autoDelete If true, wraps the script in try/finally to delete the trigger after execution
     * @returns TriggerExecutionResult with details about the created trigger
     */
    public async executeScriptViaTrigger(script: string, description?: string, autoDelete: boolean = true): Promise<TriggerExecutionResult> {
        if (!script || typeof script !== 'string') {
            throw new Error("script must be a non-empty string");
        }

        // Gated independently of executeScript. This method is public, so it is
        // directly reachable — and persisting a sys_trigger is a LARGER privilege than
        // running the script inline, because the job outlives the request that made it.
        this.assertScriptPermitted(script);

        // And `write` unconditionally, whatever the scan concluded about the script
        // body: creating the sys_trigger record IS a write, independent of what the
        // scheduled script goes on to do.
        const triggerDecision = checkRequirement({ verbs: ["write"], target: "instance" });
        if (!triggerDecision.allowed) {
            throw policyRefusal({
                ...triggerDecision,
                remediation:
                    `${triggerDecision.remediation ?? "Not permitted."} ` +
                    `Scheduling a script creates a sys_trigger record, which is a write.`,
            });
        }

        const triggerName = description || `ExtCore_Trigger_${Date.now()}`;

        // Calculate next_action as 1 second from now
        const now = new Date();
        now.setSeconds(now.getSeconds() + 1);
        const nextAction = this._formatDateForServiceNow(now);

        let finalScript = script;

        // If autoDelete, wrap the script in try/finally that deletes the trigger record
        if (autoDelete) {
            finalScript =
                `(function() {\n` +
                `    try {\n` +
                `        ${script}\n` +
                `    } finally {\n` +
                `        var gr = new GlideRecord('sys_trigger');\n` +
                `        gr.addQuery('name', '${triggerName.replace(/'/g, "\\'")}');\n` +
                `        gr.query();\n` +
                `        if (gr.next()) {\n` +
                `            gr.deleteRecord();\n` +
                `        }\n` +
                `    }\n` +
                `})();`;
        }

        this._logger.info(`Creating sys_trigger '${triggerName}' with next_action: ${nextAction}`);

        const body = {
            name: triggerName,
            trigger_type: '0',
            state: '0',
            script: finalScript,
            next_action: nextAction
        };

        const response: IHttpResponse<TriggerRecordResponse> = await this._tableAPI.post<TriggerRecordResponse>(
            'sys_trigger',
            {},
            body
        );

        if (response && (response.status === 200 || response.status === 201) && response.bodyObject?.result) {
            const record = response.bodyObject.result;
            this._logger.info(`Successfully created sys_trigger with sys_id: ${record.sys_id}`);

            return {
                success: true,
                triggerSysId: record.sys_id,
                triggerName: triggerName,
                nextAction: nextAction,
                autoDelete: autoDelete,
                message: `Trigger '${triggerName}' created successfully. Script will execute at ${nextAction}.`
            };
        }

        throw new Error(
            `Failed to create sys_trigger '${triggerName}'. Status: ${response?.status ?? 'unknown'}`
        );
    }

    /**
     * Execute a script using the best available method.
     * First tries the standard executeScript() (background script page),
     * and on failure falls back to executeScriptViaTrigger().
     *
     * @param script The script to execute
     * @param scope Optional scope for the background script execution
     * @returns Either a BackgroundScriptExecutionResult or TriggerExecutionResult
     */
    public async executeScriptAuto(script: string, scope?: string): Promise<BackgroundScriptExecutionResult | TriggerExecutionResult> {
        // BEFORE the try, deliberately. The catch below falls back to sys_trigger on
        // any failure, so a refusal raised inside executeScript would be swallowed and
        // the refused script would run anyway — later, on a schedule, silently.
        this.assertScriptPermitted(script);

        try {
            this._logger.info("Attempting script execution via background script page...");
            const result = await this.executeScript(script, scope || this.scope);
            return result;
        } catch (error) {
            // Second layer: even if the check above is ever refactored away, a refusal
            // must never be treated as "the page failed, try the other route".
            if (isPolicyRefusal(error)) {
                throw error;
            }
            // Nor is an unusable scope. sys_trigger takes no scope, so falling back
            // would run a script meant for one application in global instead.
            if (isScriptScopeError(error)) {
                throw error;
            }
            const err: Error = error as Error;
            this._logger.warn(`Background script execution failed: ${err.message}. Falling back to sys_trigger.`);
            const triggerResult = await this.executeScriptViaTrigger(script);
            return triggerResult;
        }
    }

    /**
     * Format a Date object into ServiceNow datetime format: YYYY-MM-DD HH:MM:SS
     */
    private _formatDateForServiceNow(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    /**
     * Resolve a scope value to a sys_id for use with /sys.scripts.do.
     * ServiceNow's background script form expects a sys_id in the sys_scope field,
     * not a scope name, and only runs in Global or in an application developed on
     * the instance (sys_app). This method handles:
     * - 32-char hex strings: passed through as-is (already a sys_id)
     * - "global": the sys_scope record with source=global. scope=global alone is NOT
     *   unique — every global-scoped application also carries scope=global.
     * - Any other name: looked up in sys_app. A name that is not a sys_app (an installed
     *   store app, or nothing at all) throws a ScriptScopeError explaining which.
     * Results are cached per executor instance to avoid repeated lookups.
     */
    private async _resolveScopeToSysId(scope: string): Promise<string> {
        const hexPattern = /^[0-9a-fA-F]{32}$/;
        if (hexPattern.test(scope)) {
            return scope;
        }

        if (this._scopeCache.has(scope)) {
            return this._scopeCache.get(scope);
        }

        // The name goes into an encoded query, so `^` or `=` would rewrite the query
        // itself — `x^ORscope=global` must not quietly resolve to something else.
        if (!/^[A-Za-z0-9_.-]+$/.test(scope)) {
            throw new ScriptScopeError({
                scope,
                reason: 'INVALID_SCOPE_NAME',
                problem: `'${scope}' is not a valid application scope name.`,
                remediation: `Pass "global", the scope of an application developed on this instance (e.g. "x_acme_myapp"), or a 32-character sys_id.`
            });
        }

        this._logger.info(`Resolving scope name '${scope}' to sys_id...`);

        // Case-insensitive on purpose: "Global" sent to sys_app would match the
        // global-scoped applications, because the instance compares case-insensitively.
        const isGlobal = scope.toLowerCase() === 'global';
        const table = isGlobal ? 'sys_scope' : 'sys_app';
        const results = await this._lookupScope(scope, table, {
            sysparm_query: isGlobal ? 'source=global^scope=global' : `scope=${scope}`,
            sysparm_limit: 1,
            sysparm_fields: 'sys_id,scope,name'
        });
        if (results.length > 0) {
            const sysId = results[0].sys_id;
            this._logger.info(`Resolved scope '${scope}' → sys_id '${sysId}' (${results[0].name})`);
            this._scopeCache.set(scope, sysId);
            return sysId;
        }

        if (isGlobal) {
            throw new ScriptScopeError({
                scope,
                reason: 'GLOBAL_NOT_FOUND',
                problem: `Could not find the Global scope record (sys_scope where source=global) on this instance.`,
                remediation: `Check that the authenticated user can read the sys_scope table.`
            });
        }

        throw await this._explainUnrunnableScope(scope);
    }

    /**
     * Builds the error for a name that is not a sys_app, after finding out what — if
     * anything — it IS. "Not found" and "exists but is a store app" need different
     * advice, and only one extra lookup on the failure path tells them apart.
     */
    private async _explainUnrunnableScope(scope: string): Promise<ScriptScopeError> {
        const [match] = await this._lookupScope(scope, 'sys_scope', {
            // An App Customization leaves a second, inactive row with the same scope;
            // describe the live application, not that leftover.
            sysparm_query: `scope=${scope}^ORDERBYDESCactive`,
            sysparm_limit: 1,
            sysparm_fields: 'sys_id,scope,name,sys_class_name,active'
        });
        if (!match) {
            return new ScriptScopeError({
                scope,
                reason: 'SCOPE_NOT_FOUND',
                problem: `No application with scope '${scope}' exists on this instance.`,
                remediation:
                    `Check the spelling. Scripts can run in "global" or in an application developed on this instance; ` +
                    `the scopes of those applications are listed in the sys_app table.`
            });
        }

        const foundAs: ScriptScopeMatch = {
            sysId: match.sys_id,
            name: match.name,
            className: match.sys_class_name,
            active: String(match.active) === 'true'
        };
        const kind = foundAs.className === 'sys_store_app'
            ? 'an installed store/repository application (sys_store_app)'
            : `a ${foundAs.className || 'sys_scope'} record, not an application developed on this instance (sys_app)`;
        return new ScriptScopeError({
            scope,
            reason: 'NOT_A_DEVELOPED_APP',
            foundAs,
            problem:
                `Scope '${scope}' (${foundAs.name}) is ${kind}. Scripts - Background can only run in "global" ` +
                `or in an application developed on this instance (sys_app).`,
            remediation:
                `Run the script in "global" and call the application's API fully qualified ` +
                `(e.g. ${scope}.MyScriptInclude), or use an application developed on this instance.`
        });
    }

    /**
     * One Table API read for scope resolution. A plain HTTP failure becomes a
     * LOOKUP_FAILED ScriptScopeError naming the table, keeping the original text so
     * transient-failure detection on the message still works. Errors that already
     * identify themselves — a policy refusal, or anything with a `code` (session,
     * stale instance, network) — pass through untouched.
     */
    private async _lookupScope(scope: string, table: string, query: Record<string, string | number>): Promise<ScopeTableResult["result"]> {
        let response: IHttpResponse<ScopeTableResult>;
        try {
            response = await this._tableAPI.get<ScopeTableResult>(table, query);
        } catch (error) {
            if (isPolicyRefusal(error) || (error as { code?: unknown })?.code !== undefined) {
                throw error;
            }
            throw new ScriptScopeError({
                scope,
                reason: 'LOOKUP_FAILED',
                problem: `Could not look up scope '${scope}' in ${table}: ${(error as Error)?.message ?? String(error)}`,
                remediation: `Check that the authenticated user can read the ${table} table, then retry.`
            }, { cause: error });
        }

        if (response?.status === 200 && Array.isArray(response.bodyObject?.result)) {
            return response.bodyObject.result;
        }
        throw new ScriptScopeError({
            scope,
            reason: 'LOOKUP_FAILED',
            problem: `Could not look up scope '${scope}': the ${table} query returned HTTP ${response?.status ?? 'no response'}.`,
            remediation: `Check that the authenticated user can read the ${table} table, then retry.`
        });
    }

    /**
     * Strips closing tags for HTML void elements that fast-xml-parser cannot handle.
     * ServiceNow's /sys.scripts.do returns malformed HTML with closing tags for
     * void elements like </meta>, </link>, </br>, </hr>, </img>, etc.
     */
    private fixMalformedHTML(html: string): string {
        const voidElements = [
            "area", "base", "br", "col", "embed", "hr", "img", "input",
            "link", "meta", "param", "source", "track", "wbr"
        ];
        const pattern = new RegExp(`</(${voidElements.join("|")})\\s*>`, "gi");
        return html.replace(pattern, "");
    }

    private _parseBGScriptResult(parsedXMLObj: ScriptExecutionXMLResult) : CompositeScriptExecutionResult {
        this._logger.debug("_parseBGScriptResult enter", parsedXMLObj);

        const scriptResults:ScriptExecutionOutputLine[] = [];

        // Null-safe navigation — PRE or #text may be absent when script produces no output.
        // fast-xml-parser stores text in #text when the element has attributes (e.g. <PRE class="outputtext">),
        // but stores it directly as a string when the element has no attributes (e.g. <PRE>).
        const pre = parsedXMLObj?.HTML?.BODY?.PRE;
        const result:string | undefined = (typeof pre === "string" ? pre : pre?.["#text"]) as string | undefined;

        if (isNil(result) || result.trim().length === 0) {
            return { rawResult: "", consoleResult: [], scriptResults: [] } as CompositeScriptExecutionResult;
        }

        const spl:string[] = result.split("\n");
        spl.forEach((line: string, index:number) => {
            if(isNil(line) )
                spl[index] = null;
            else{
                line = line.trim();
                //If the output does not have a "*** Script: " before it, then it is system output
                if(line.indexOf("*** Script: ") == -1){

                    scriptResults.push(new ScriptExecutionOutputLine(line).asSystemLine());
                //If the output does have a  "*** Script: " prefixing it, it is output from this script or a script being called
                }else if(line.indexOf("*** Script: ") !== -1){
                    line = line.replace("*** Script: ", "");
                    if(line.indexOf("[DEBUG]") !== -1){
                        scriptResults.push(new ScriptExecutionOutputLine(line).asDebugLine());
                    }else{
                        scriptResults.push(new ScriptExecutionOutputLine(line).asScriptLine());
                    }
                }
                //Keep the original array intact in order to preserve the order with system outputs.
                spl[index] = line;
            }

        });

        const filteredSpl = spl.filter(line => line !== null);

        return {rawResult: result, consoleResult: filteredSpl, scriptResults:scriptResults} as CompositeScriptExecutionResult;
    }
    private _parseAffectedRecords(parsedXMLObj: ScriptExecutionXMLResult) {
        return parsedXMLObj?.HTML?.BODY?.div
    }
}

interface ScriptExecutionXMLResult{
    HTML?: {
        BODY?: {
            PRE?: string | {
                "#text"?: string;
            };
            div?: string;
        };
    };
}

export type CompositeScriptExecutionResult = {
    consoleResult: string[];
    rawResult: string;
    scriptResults:ScriptExecutionOutputLine[];
}

export type BackgroundScriptExecutionResult = {
    raw: string;
    result: string;
    affectedRecords: string;
    consoleResult: string[];
    rawResult:string;
    scriptResults:ScriptExecutionOutputLine[];
};

export class ScriptExecutionOutputLine{
    private _line:string;
    private _isDebug:boolean = false;
    private _isSystem:boolean = false;
    private _isScript:boolean = false;

    public constructor(line:string){
        this._line = line;
    }

    public get line():string{
        return this._line;
    }

    public set line(val:string){
        this._line = val;
    }

    public asDebugLine(isDebugLine:boolean = true):ScriptExecutionOutputLine{
        this._isDebug = isDebugLine;

        return this;
    }

    public asSystemLine(isSystemLine:boolean = true):ScriptExecutionOutputLine{
        this._isSystem = isSystemLine;

        return this;
    }

    public asScriptLine(isScriptLine:boolean = true):ScriptExecutionOutputLine{
        this._isScript = isScriptLine;

        return this;
    }
}

// export type ScriptExecutionOutputLine = {
//     line:string;
//     isDebug:boolean;
//     isSystem:boolean;
//     isScript:boolean;
// };

export interface BackgroundScriptExecutorOptions {
    instance?: ServiceNowInstance;
    scope?: string;
}

export interface TriggerExecutionResult {
    success: boolean;
    triggerSysId: string;
    triggerName: string;
    nextAction: string;
    autoDelete: boolean;
    message: string;
}

interface TriggerRecord {
    sys_id: string;
    name: string;
    trigger_type: string;
    state: string;
    script: string;
    next_action: string;
    [key: string]: unknown;
}

interface TriggerRecordResponse {
    result: TriggerRecord;
}

interface ScopeTableResult {
    result: Array<{ sys_id: string; scope: string; name: string; sys_class_name?: string; active?: string | boolean }>;
}
