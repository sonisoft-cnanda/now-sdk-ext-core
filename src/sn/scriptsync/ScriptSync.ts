import * as fs from 'fs';
import { ServiceNowInstance } from "../ServiceNowInstance";
import { Logger } from "../../util/Logger";
import { checkRequirement } from "../../policy/Policy";
import { isPolicyRefusal, policyRefusal } from "../../policy/PolicyRefusal";
import { ServiceNowRequest } from "../../comm/http/ServiceNowRequest";
import { TableAPIRequest } from "../../comm/http/TableAPIRequest";
import { IHttpResponse } from "../../comm/http/IHttpResponse";
import {
    SCRIPT_TYPES,
    ScriptTypeConfig,
    SyncScriptOptions,
    SyncResult,
    SyncAllOptions,
    SyncAllResult,
    ParsedFileName,
    ScriptRecord,
    ScriptRecordListResponse
} from './ScriptSyncModels';

/**
 * ScriptSync provides bidirectional synchronization between local files
 * and ServiceNow script records (Script Includes, Business Rules, etc.).
 */
export class ScriptSync {
    private _logger: Logger = new Logger("ScriptSync");
    private _req: ServiceNowRequest;
    private _tableAPI: TableAPIRequest;
    private _instance: ServiceNowInstance;

    public constructor(instance: ServiceNowInstance) {
        this._instance = instance;
        this._req = new ServiceNowRequest(instance);
        this._tableAPI = new TableAPIRequest(instance);
    }

    /**
     * Pull a script from ServiceNow and write it to a local file.
     * Queries the appropriate table by name and writes the script field to filePath.
     */
    public async pullScript(options: SyncScriptOptions): Promise<SyncResult> {
        const { scriptName, scriptType, filePath } = options;
        const timestamp = new Date().toISOString();

        const config: ScriptTypeConfig = SCRIPT_TYPES[scriptType];
        if (!config) {
            return {
                scriptName,
                scriptType,
                filePath,
                direction: 'pull',
                success: false,
                message: `Unknown script type: ${scriptType}`,
                error: `Unknown script type: ${scriptType}`,
                timestamp
            };
        }

        try {
            this._logger.info(`Pulling ${config.label} '${scriptName}' from table '${config.table}'`);

            const query: Record<string, string | number> = {
                sysparm_query: `${config.nameField}=${scriptName}`,
                sysparm_limit: 1
            };

            const response: IHttpResponse<ScriptRecordListResponse> = await this._tableAPI.get<ScriptRecordListResponse>(
                config.table,
                query
            );

            if (response.status !== 200 || !response.bodyObject?.result || response.bodyObject.result.length === 0) {
                return {
                    scriptName,
                    scriptType,
                    filePath,
                    direction: 'pull',
                    success: false,
                    message: `Script '${scriptName}' not found in ${config.table}`,
                    error: `Script not found`,
                    timestamp
                };
            }

            const record: ScriptRecord = response.bodyObject.result[0];
            const scriptContent: string = record[config.scriptField] as string || '';

            fs.writeFileSync(filePath, scriptContent, 'utf-8');

            this._logger.info(`Successfully pulled '${scriptName}' to ${filePath}`);

            return {
                scriptName,
                scriptType,
                filePath,
                direction: 'pull',
                success: true,
                sysId: record.sys_id,
                message: `Successfully pulled ${config.label} '${scriptName}'`,
                timestamp
            };
        } catch (error) {
            const err: Error = error as Error;
            this._logger.error(`Error pulling script '${scriptName}': ${err.message}`);
            return {
                scriptName,
                scriptType,
                filePath,
                direction: 'pull',
                success: false,
                message: `Failed to pull ${config.label} '${scriptName}'`,
                error: err.message,
                timestamp
            };
        }
    }

    /** A pushed script runs on the instance: it needs execute as well as write, as any other code written to it does. */
    private requireExecute(): void {
        const decision = checkRequirement({ verbs: ['write', 'execute'], target: 'instance' });
        if (decision.allowed) return;
        this._logger.warn('Refused a script push', { verbs: decision.verbs, decidingLayer: decision.decidingLayer });
        throw policyRefusal({ ...decision, remediation: `${decision.remediation} A pushed script runs on the instance, so it needs execute as well as write.` });
    }

    /**
     * Push a local file to ServiceNow by updating the script field on the matching record.
     * Reads the file from filePath, queries the table by name to find the sys_id,
     * then updates the script field via TableAPIRequest.put().
     */
    public async pushScript(options: SyncScriptOptions): Promise<SyncResult> {
        const { scriptName, scriptType, filePath } = options;
        const timestamp = new Date().toISOString();

        const config: ScriptTypeConfig = SCRIPT_TYPES[scriptType];
        if (!config) {
            return {
                scriptName,
                scriptType,
                filePath,
                direction: 'push',
                success: false,
                message: `Unknown script type: ${scriptType}`,
                error: `Unknown script type: ${scriptType}`,
                timestamp
            };
        }

        this.requireExecute();

        try {
            this._logger.info(`Pushing '${scriptName}' to ${config.table}`);

            const scriptContent: string = fs.readFileSync(filePath, 'utf-8');

            const query: Record<string, string | number> = {
                sysparm_query: `${config.nameField}=${scriptName}`,
                sysparm_limit: 1
            };

            const response: IHttpResponse<ScriptRecordListResponse> = await this._tableAPI.get<ScriptRecordListResponse>(
                config.table,
                query
            );

            if (response.status !== 200 || !response.bodyObject?.result || response.bodyObject.result.length === 0) {
                return {
                    scriptName,
                    scriptType,
                    filePath,
                    direction: 'push',
                    success: false,
                    message: `Script '${scriptName}' not found in ${config.table}`,
                    error: `Script not found`,
                    timestamp
                };
            }

            const record: ScriptRecord = response.bodyObject.result[0];
            const sysId: string = record.sys_id;

            const body: Record<string, string> = {};
            body[config.scriptField] = scriptContent;

            const putResponse = await this._tableAPI.put(config.table, sysId, body);

            if (!putResponse || (putResponse.status !== 200 && putResponse.status !== 201)) {
                return {
                    scriptName,
                    scriptType,
                    filePath,
                    direction: 'push',
                    success: false,
                    sysId,
                    message: `Failed to update ${config.label} '${scriptName}'`,
                    error: `Update failed with status: ${putResponse?.status ?? 'unknown'}`,
                    timestamp
                };
            }

            this._logger.info(`Successfully pushed '${scriptName}' to ${config.table} (sys_id: ${sysId})`);

            return {
                scriptName,
                scriptType,
                filePath,
                direction: 'push',
                success: true,
                sysId,
                message: `Successfully pushed ${config.label} '${scriptName}'`,
                timestamp
            };
        } catch (error) {
            // A refusal is a decision, not a failed push: it keeps its identity.
            if (isPolicyRefusal(error)) throw error;
            const err: Error = error as Error;
            this._logger.error(`Error pushing script '${scriptName}': ${err.message}`);
            return {
                scriptName,
                scriptType,
                filePath,
                direction: 'push',
                success: false,
                message: `Failed to push ${config.label} '${scriptName}'`,
                error: err.message,
                timestamp
            };
        }
    }

    /**
     * Sync all scripts in a directory. Reads filenames, parses them to determine
     * script name and type, and pushes each to ServiceNow.
     */
    public async syncAllScripts(options: SyncAllOptions): Promise<SyncAllResult> {
        const { directory } = options;
        const scriptTypes: string[] = options.scriptTypes || Object.keys(SCRIPT_TYPES);
        const timestamp = new Date().toISOString();
        const scripts: SyncResult[] = [];

        // Refused once, up front, rather than once per file.
        this.requireExecute();

        try {
            const files: string[] = fs.readdirSync(directory);

            const validFiles: { fileName: string; parsed: ParsedFileName }[] = [];
            for (const fileName of files) {
                const parsed = ScriptSync.parseFileName(fileName);
                if (parsed.isValid && parsed.scriptType && scriptTypes.includes(parsed.scriptType)) {
                    validFiles.push({ fileName, parsed });
                }
            }

            for (const { fileName, parsed } of validFiles) {
                const filePath = `${directory}/${fileName}`;
                const result = await this.pushScript({
                    scriptName: parsed.scriptName!,
                    scriptType: parsed.scriptType!,
                    filePath
                });
                scripts.push(result);
            }

            const synced = scripts.filter(s => s.success).length;
            const failed = scripts.filter(s => !s.success).length;

            return {
                directory,
                scriptTypes,
                totalFiles: validFiles.length,
                synced,
                failed,
                scripts,
                timestamp
            };
        } catch (error) {
            if (isPolicyRefusal(error)) throw error;
            const err: Error = error as Error;
            this._logger.error(`Error syncing all scripts: ${err.message}`);
            return {
                directory,
                scriptTypes,
                totalFiles: 0,
                synced: 0,
                failed: 0,
                scripts,
                timestamp
            };
        }
    }

    /**
     * Parse a filename in the format "{name}.{type}.js" to extract the script name and type.
     * Valid types are keys of SCRIPT_TYPES.
     */
    public static parseFileName(fileName: string): ParsedFileName {
        if (!fileName || typeof fileName !== 'string') {
            return { isValid: false };
        }

        // Expected format: {name}.{type}.js
        // The name may contain dots, so we parse from the end.
        if (!fileName.endsWith('.js')) {
            return { isValid: false };
        }

        // Remove the .js extension
        const withoutExt = fileName.slice(0, -3);

        // Find the last dot to split name from type
        const lastDotIndex = withoutExt.lastIndexOf('.');
        if (lastDotIndex <= 0) {
            return { isValid: false };
        }

        const scriptName = withoutExt.substring(0, lastDotIndex);
        const scriptType = withoutExt.substring(lastDotIndex + 1);

        if (!scriptName || !scriptType || !SCRIPT_TYPES[scriptType]) {
            return { isValid: false };
        }

        return {
            isValid: true,
            scriptName,
            scriptType
        };
    }

    /**
     * Generate a filename in the format "{name}.{type}.js".
     */
    public static generateFileName(scriptName: string, scriptType: string): string {
        return `${scriptName}.${scriptType}.js`;
    }
}
