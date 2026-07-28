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
import { IHttpResponse } from "../comm/http/IHttpResponse";
import { isNil } from "../util/utils";
import { CSRFTokenHelper } from "../util/CSRFTokenHelper";
import { TableAPIRequest } from "../comm/http/TableAPIRequest";
import { SessionManager } from "../comm/http/SessionManager";


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
                body: params
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
            this._logger.debug("CSRF Token Received: " + csrfToken, {csrfToken:csrfToken});
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
        try {
            this._logger.info("Attempting script execution via background script page...");
            const result = await this.executeScript(script, scope || this.scope);
            return result;
        } catch (error) {
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
     * not a scope name. This method handles:
     * - 32-char hex strings: passed through as-is (already a sys_id)
     * - Scope names (e.g., "global", "x_myapp_custom"): looked up in sys_scope table
     * Results are cached per executor instance to avoid repeated lookups.
     */
    private async _resolveScopeToSysId(scope: string): Promise<string> {
        const hexPattern = /^[0-9a-fA-F]{32}$/;
        if (hexPattern.test(scope)) {
            return scope;
        }

        if (this._scopeCache.has(scope)) {
            return this._scopeCache.get(scope)!;
        }

        this._logger.info(`Resolving scope name '${scope}' to sys_id...`);
        const query: Record<string, string | number> = {
            sysparm_query: `scope=${scope}`,
            sysparm_limit: 1,
            sysparm_fields: 'sys_id,scope,name'
        };

        const response = await this._tableAPI.get<ScopeTableResult>('sys_scope', query);

        if (response.status === 200 && response.bodyObject?.result) {
            const results = response.bodyObject.result;
            if (results.length > 0) {
                const sysId = results[0].sys_id;
                this._logger.info(`Resolved scope '${scope}' → sys_id '${sysId}' (${results[0].name})`);
                this._scopeCache.set(scope, sysId);
                return sysId;
            }
        }

        throw new Error(
            `Scope '${scope}' not found in sys_scope table. ` +
            `Use a valid scope name (e.g., "global", "x_myapp_custom") or a 32-character sys_id.`
        );
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
    result: Array<{ sys_id: string; scope: string; name: string }>;
}
