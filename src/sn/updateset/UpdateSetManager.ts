import { ServiceNowInstance } from "../ServiceNowInstance";
import { Logger } from "../../util/Logger";
import { CSRFTokenHelper } from "../../util/CSRFTokenHelper";
import { ServiceNowRequest } from "../../comm/http/ServiceNowRequest";
import { TableAPIRequest } from "../../comm/http/TableAPIRequest";
import { HTTPRequest } from "../../comm/http/HTTPRequest";
import { IHttpResponse } from "../../comm/http/IHttpResponse";
import { BackgroundScriptExecutor } from "../BackgroundScriptExecutor";
import {
    SetUpdateSetOptions,
    ListUpdateSetsOptions,
    CreateUpdateSetOptions,
    MoveRecordsOptions,
    MoveRecordsResult,
    CloneUpdateSetResult,
    InspectUpdateSetResult,
    UpdateSetRecord,
    UpdateSetResponse,
    UpdateSetSingleResponse,
    UpdateXmlRecord,
    UpdateXmlResponse,
    UpdateXmlSingleResponse,
    CurrentUpdateSetResponse
} from './UpdateSetModels';

/**
 * UpdateSetManager provides operations for managing ServiceNow update sets.
 * Supports setting/getting the current update set, listing, creating,
 * moving records between update sets, cloning, and inspecting update sets.
 */
export class UpdateSetManager {
    private static readonly UI_UPDATESET_PATH = '/api/now/ui/concoursepicker/updateset';
    private static readonly UI_CONCOURSEPICKER_CURRENT_PATH = '/api/now/ui/concoursepicker/current';
    private static readonly UPDATE_SET_TABLE = 'sys_update_set';
    private static readonly UPDATE_XML_TABLE = 'sys_update_xml';
    private static readonly UPDATE_SET_EXPORT_PATH = '/export_base_update_set.do';
    private static readonly UPLOAD_DO_PATH = '/upload.do';

    private _logger: Logger = new Logger("UpdateSetManager");
    private _req: ServiceNowRequest;
    private _tableAPI: TableAPIRequest;
    private _instance: ServiceNowInstance;

    public constructor(instance: ServiceNowInstance) {
        this._instance = instance;
        this._req = new ServiceNowRequest(instance);
        this._tableAPI = new TableAPIRequest(instance);
    }

    /**
     * Set the current update set for the session.
     * Uses PUT /api/now/ui/concoursepicker/updateset
     *
     * @param options The update set name and sysId to set as current
     * @throws Error if name or sysId is empty or if the API call fails
     */
    public async setCurrentUpdateSet(options: SetUpdateSetOptions): Promise<void> {
        if (!options.name || options.name.trim().length === 0) {
            throw new Error('Update set name is required');
        }
        if (!options.sysId || options.sysId.trim().length === 0) {
            throw new Error('Update set sysId is required');
        }

        this._logger.info(`Setting current update set to: ${options.name} (${options.sysId})`);

        const request: HTTPRequest = {
            method: 'PUT',
            path: UpdateSetManager.UI_UPDATESET_PATH,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            query: null,
            body: null,
            json: { name: options.name, sysId: options.sysId }
        };

        const resp: IHttpResponse<unknown> = await this._req.put<unknown>(request);

        if (resp.status !== 200) {
            throw new Error(`Failed to set current update set. Status: ${resp.status}`);
        }

        this._logger.info(`Successfully set current update set to: ${options.name}`);
    }

    /**
     * Get the current update set.
     * Uses GET /api/now/ui/concoursepicker/current
     *
     * @returns The current update set record or null if not set
     */
    public async getCurrentUpdateSet(): Promise<UpdateSetRecord | null> {
        this._logger.info('Getting current update set');

        const request: HTTPRequest = {
            method: 'GET',
            path: UpdateSetManager.UI_CONCOURSEPICKER_CURRENT_PATH,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            query: null,
            body: null
        };

        const resp: IHttpResponse<CurrentUpdateSetResponse> = await this._req.get<CurrentUpdateSetResponse>(request);

        if (resp.status === 200 && resp.bodyObject?.result?.currentUpdateSet) {
            const current = resp.bodyObject.result.currentUpdateSet;
            this._logger.info(`Current update set: ${current.name}`);
            return {
                sys_id: current.sysId,
                name: current.name,
                state: 'in progress'
            };
        }

        throw new Error(`Failed to get current update set. Status: ${resp.status}`);
    }

    /**
     * List update sets from the sys_update_set table.
     * Uses Table API GET on sys_update_set.
     *
     * @param options Optional query, limit, and fields options
     * @returns Array of UpdateSetRecord
     */
    public async listUpdateSets(options: ListUpdateSetsOptions = {}): Promise<UpdateSetRecord[]> {
        const { encodedQuery, limit = 100, fields } = options;

        this._logger.info(`Listing update sets with query: ${encodedQuery || 'none'}`);

        const query: Record<string, string | number> = {
            sysparm_limit: limit
        };

        if (encodedQuery) {
            query.sysparm_query = encodedQuery;
        }
        if (fields) {
            query.sysparm_fields = fields;
        }

        const response: IHttpResponse<UpdateSetResponse> = await this._tableAPI.get<UpdateSetResponse>(
            UpdateSetManager.UPDATE_SET_TABLE,
            query
        );

        if (response.status === 200 && response.bodyObject?.result) {
            this._logger.info(`Retrieved ${response.bodyObject.result.length} update sets`);
            return response.bodyObject.result;
        }

        throw new Error(`Failed to list update sets. Status: ${response.status}`);
    }

    /**
     * Create a new update set.
     * Uses Table API POST on sys_update_set.
     *
     * @param options The update set name and optional description, application, state
     * @returns The created UpdateSetRecord
     * @throws Error if name is empty or if the API call fails
     */
    public async createUpdateSet(options: CreateUpdateSetOptions): Promise<UpdateSetRecord> {
        if (!options.name || options.name.trim().length === 0) {
            throw new Error('Update set name is required');
        }

        this._logger.info(`Creating update set: ${options.name}`);

        const body: Record<string, string> = {
            name: options.name,
            state: options.state || 'in progress'
        };

        if (options.description) {
            body.description = options.description;
        }
        if (options.application) {
            body.application = options.application;
        }

        const response: IHttpResponse<UpdateSetSingleResponse> = await this._tableAPI.post<UpdateSetSingleResponse>(
            UpdateSetManager.UPDATE_SET_TABLE, {}, body
        );

        if (response && (response.status === 200 || response.status === 201) && response.bodyObject?.result) {
            this._logger.info(`Created update set: ${options.name} with sys_id: ${response.bodyObject.result.sys_id}`);
            return response.bodyObject.result;
        }

        throw new Error(`Failed to create update set '${options.name}'. Status: ${response?.status ?? 'unknown'}`);
    }

    /**
     * Move records to a target update set.
     * Queries sys_update_xml records based on options and updates each to the target update set.
     *
     * @param targetUpdateSetId The sys_id of the target update set
     * @param options Options for selecting which records to move
     * @returns Result summary of the move operation
     * @throws Error if targetUpdateSetId is empty or no selection criteria provided
     */
    public async moveRecordsToUpdateSet(
        targetUpdateSetId: string,
        options: MoveRecordsOptions = {}
    ): Promise<MoveRecordsResult> {
        if (!targetUpdateSetId || targetUpdateSetId.trim().length === 0) {
            throw new Error('Target update set ID is required');
        }

        if (!options.recordSysIds && !options.timeRange && !options.sourceUpdateSet) {
            throw new Error('At least one selection criteria is required: recordSysIds, timeRange, or sourceUpdateSet');
        }

        this._logger.info(`Moving records to update set: ${targetUpdateSetId}`);

        const result: MoveRecordsResult = {
            moved: 0,
            failed: 0,
            records: [],
            errors: []
        };

        let records: UpdateXmlRecord[] = [];

        if (options.recordSysIds && options.recordSysIds.length > 0) {
            // Fetch specific records by sys_id
            const sysIdQuery = `sys_idIN${options.recordSysIds.join(',')}`;
            const queryParams: Record<string, string | number> = {
                sysparm_query: sysIdQuery,
                sysparm_limit: options.recordSysIds.length
            };

            const resp: IHttpResponse<UpdateXmlResponse> = await this._tableAPI.get<UpdateXmlResponse>(
                UpdateSetManager.UPDATE_XML_TABLE,
                queryParams
            );

            if (resp.status === 200 && resp.bodyObject?.result) {
                records = resp.bodyObject.result;
            }
        } else if (options.sourceUpdateSet) {
            // Fetch records from a source update set
            let encodedQuery = `update_set=${options.sourceUpdateSet}`;
            if (options.timeRange) {
                encodedQuery += `^sys_created_onBETWEEN${options.timeRange.start}@${options.timeRange.end}`;
            }

            const queryParams: Record<string, string | number> = {
                sysparm_query: encodedQuery,
                sysparm_limit: 1000
            };

            const resp: IHttpResponse<UpdateXmlResponse> = await this._tableAPI.get<UpdateXmlResponse>(
                UpdateSetManager.UPDATE_XML_TABLE,
                queryParams
            );

            if (resp.status === 200 && resp.bodyObject?.result) {
                records = resp.bodyObject.result;
            }
        } else if (options.timeRange) {
            const encodedQuery = `sys_created_onBETWEEN${options.timeRange.start}@${options.timeRange.end}`;
            const queryParams: Record<string, string | number> = {
                sysparm_query: encodedQuery,
                sysparm_limit: 1000
            };

            const resp: IHttpResponse<UpdateXmlResponse> = await this._tableAPI.get<UpdateXmlResponse>(
                UpdateSetManager.UPDATE_XML_TABLE,
                queryParams
            );

            if (resp.status === 200 && resp.bodyObject?.result) {
                records = resp.bodyObject.result;
            }
        }

        // Move each record to the target update set
        for (const record of records) {
            try {
                if (options.onProgress) {
                    options.onProgress(`Moving record ${record.sys_id} (${record.name || record.type || 'unknown'})`);
                }

                const putResp: IHttpResponse<UpdateXmlSingleResponse> = await this._tableAPI.put<UpdateXmlSingleResponse>(
                    UpdateSetManager.UPDATE_XML_TABLE,
                    record.sys_id,
                    { update_set: targetUpdateSetId }
                );

                if (putResp && (putResp.status === 200 || putResp.status === 201)) {
                    result.moved++;
                    result.records.push({
                        sys_id: record.sys_id,
                        name: record.name,
                        type: record.type,
                        status: 'moved'
                    });
                } else {
                    result.failed++;
                    result.records.push({
                        sys_id: record.sys_id,
                        name: record.name,
                        type: record.type,
                        status: 'failed'
                    });
                    result.errors.push({
                        sys_id: record.sys_id,
                        error: `Unexpected status: ${putResp?.status ?? 'unknown'}`
                    });
                }
            } catch (err) {
                result.failed++;
                result.records.push({
                    sys_id: record.sys_id,
                    name: record.name,
                    type: record.type,
                    status: 'failed'
                });
                result.errors.push({
                    sys_id: record.sys_id,
                    error: err instanceof Error ? err.message : String(err)
                });
            }
        }

        this._logger.info(`Move complete: ${result.moved} moved, ${result.failed} failed`);
        return result;
    }

    /**
     * Clone an update set by creating a new update set and copying all sys_update_xml records.
     *
     * @param sourceUpdateSetId The sys_id of the source update set to clone
     * @param newName The name for the new cloned update set
     * @param onProgress Optional callback for progress updates
     * @returns Result of the clone operation
     * @throws Error if sourceUpdateSetId or newName is empty
     */
    public async cloneUpdateSet(
        sourceUpdateSetId: string,
        newName: string,
        onProgress?: (message: string) => void
    ): Promise<CloneUpdateSetResult> {
        if (!sourceUpdateSetId || sourceUpdateSetId.trim().length === 0) {
            throw new Error('Source update set ID is required');
        }
        if (!newName || newName.trim().length === 0) {
            throw new Error('New update set name is required');
        }

        this._logger.info(`Cloning update set ${sourceUpdateSetId} as "${newName}"`);

        if (onProgress) {
            onProgress('Fetching source update set...');
        }

        // Get the source update set
        const sourceQuery: Record<string, string | number> = {
            sysparm_query: `sys_id=${sourceUpdateSetId}`,
            sysparm_limit: 1
        };

        const sourceResp: IHttpResponse<UpdateSetResponse> = await this._tableAPI.get<UpdateSetResponse>(
            UpdateSetManager.UPDATE_SET_TABLE,
            sourceQuery
        );

        if (!sourceResp || sourceResp.status !== 200 || !sourceResp.bodyObject?.result || sourceResp.bodyObject.result.length === 0) {
            throw new Error(`Source update set '${sourceUpdateSetId}' not found`);
        }

        const sourceSet = sourceResp.bodyObject.result[0];

        if (onProgress) {
            onProgress(`Found source update set: ${sourceSet.name}`);
        }

        // Create the new update set
        const newSetBody: Record<string, string> = {
            name: newName,
            state: 'in progress'
        };

        if (sourceSet.description) {
            newSetBody.description = sourceSet.description;
        }
        if (sourceSet.application) {
            newSetBody.application = sourceSet.application;
        }

        const createResp: IHttpResponse<UpdateSetSingleResponse> = await this._tableAPI.post<UpdateSetSingleResponse>(
            UpdateSetManager.UPDATE_SET_TABLE, {}, newSetBody
        );

        if (!createResp || (createResp.status !== 200 && createResp.status !== 201) || !createResp.bodyObject?.result) {
            throw new Error(`Failed to create new update set '${newName}'. Status: ${createResp?.status ?? 'unknown'}`);
        }

        const newSet = createResp.bodyObject.result;

        if (onProgress) {
            onProgress(`Created new update set: ${newSet.name} (${newSet.sys_id})`);
        }

        // Get all sys_update_xml records from the source update set
        const xmlQuery: Record<string, string | number> = {
            sysparm_query: `update_set=${sourceUpdateSetId}`,
            sysparm_limit: 10000
        };

        const xmlResp: IHttpResponse<UpdateXmlResponse> = await this._tableAPI.get<UpdateXmlResponse>(
            UpdateSetManager.UPDATE_XML_TABLE,
            xmlQuery
        );

        const sourceRecords = (xmlResp.status === 200 && xmlResp.bodyObject?.result) ? xmlResp.bodyObject.result : [];
        let recordsCloned = 0;

        if (onProgress) {
            onProgress(`Found ${sourceRecords.length} records to clone`);
        }

        // Clone each record into the new update set
        for (const record of sourceRecords) {
            try {
                const cloneBody: Record<string, unknown> = {
                    update_set: newSet.sys_id,
                    name: record.name,
                    type: record.type,
                    target_name: record.target_name,
                    payload: record.payload,
                    category: record.category
                };

                const cloneResp: IHttpResponse<UpdateXmlSingleResponse> = await this._tableAPI.post<UpdateXmlSingleResponse>(
                    UpdateSetManager.UPDATE_XML_TABLE, {}, cloneBody
                );

                if (cloneResp && (cloneResp.status === 200 || cloneResp.status === 201)) {
                    recordsCloned++;
                    if (onProgress) {
                        onProgress(`Cloned record ${recordsCloned}/${sourceRecords.length}: ${record.name || record.type || 'unknown'}`);
                    }
                }
            } catch (err) {
                this._logger.error(`Failed to clone record ${record.sys_id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        this._logger.info(`Clone complete: ${recordsCloned}/${sourceRecords.length} records cloned`);

        return {
            newUpdateSetId: newSet.sys_id,
            newUpdateSetName: newSet.name,
            sourceUpdateSetId: sourceUpdateSetId,
            sourceUpdateSetName: sourceSet.name,
            recordsCloned: recordsCloned,
            totalSourceRecords: sourceRecords.length
        };
    }

    /**
     * Inspect an update set by querying its sys_update_xml records and grouping by type.
     *
     * @param updateSetSysId The sys_id of the update set to inspect
     * @returns Inspection result with grouped components
     * @throws Error if updateSetSysId is empty or the update set is not found
     */
    public async inspectUpdateSet(updateSetSysId: string): Promise<InspectUpdateSetResult> {
        if (!updateSetSysId || updateSetSysId.trim().length === 0) {
            throw new Error('Update set sys_id is required');
        }

        this._logger.info(`Inspecting update set: ${updateSetSysId}`);

        // Get the update set record
        const setQuery: Record<string, string | number> = {
            sysparm_query: `sys_id=${updateSetSysId}`,
            sysparm_limit: 1
        };

        const setResp: IHttpResponse<UpdateSetResponse> = await this._tableAPI.get<UpdateSetResponse>(
            UpdateSetManager.UPDATE_SET_TABLE,
            setQuery
        );

        if (!setResp || setResp.status !== 200 || !setResp.bodyObject?.result || setResp.bodyObject.result.length === 0) {
            throw new Error(`Update set '${updateSetSysId}' not found`);
        }

        const updateSet = setResp.bodyObject.result[0];

        // Get all sys_update_xml records for this update set
        const xmlQuery: Record<string, string | number> = {
            sysparm_query: `update_set=${updateSetSysId}`,
            sysparm_limit: 10000
        };

        const xmlResp: IHttpResponse<UpdateXmlResponse> = await this._tableAPI.get<UpdateXmlResponse>(
            UpdateSetManager.UPDATE_XML_TABLE,
            xmlQuery
        );

        const records = (xmlResp.status === 200 && xmlResp.bodyObject?.result) ? xmlResp.bodyObject.result : [];

        // Group records by type
        const typeGroups = new Map<string, string[]>();
        for (const record of records) {
            const type = record.type || 'unknown';
            if (!typeGroups.has(type)) {
                typeGroups.set(type, []);
            }
            typeGroups.get(type).push(record.target_name || record.name || record.sys_id);
        }

        const components = Array.from(typeGroups.entries()).map(([type, items]) => ({
            type,
            count: items.length,
            items
        }));

        this._logger.info(`Inspection complete: ${records.length} records in ${components.length} component types`);

        return {
            updateSet: {
                sys_id: updateSet.sys_id,
                name: updateSet.name,
                state: updateSet.state,
                description: updateSet.description
            },
            totalRecords: records.length,
            components
        };
    }

    public async exportUpdateSet(updateSetSysId: string): Promise<string> {
        if (!updateSetSysId || updateSetSysId.trim().length === 0) {
            throw new Error('Update set sys_id is required');
        }

        this._logger.info(`Exporting update set: ${updateSetSysId}`);

        // Step 1: Get CSRF token
        const csrfToken = await this._getUploadCSRFToken();
        if (!csrfToken) {
            throw new Error(
                'Failed to obtain CSRF token from /upload.do. ' +
                'This may indicate an authentication failure or insufficient permissions.'
            );
        }

        const backgroundScriptExecutor = new BackgroundScriptExecutor(this._instance, 'global');

        const script = `
            var updateSet = new GlideRecord('sys_update_set');
            updateSet.get('${updateSetSysId}');
            if (updateSet.isValidRecord()) {
                var util = new UpdateSetExport();
                var exportID = util.exportHierarchy(updateSet);
                gs.print(exportID);
            }
        `;

        const result = await backgroundScriptExecutor.executeScript(script, 'global', this._instance);

        if (result.scriptResults.length === 0) {
            throw new Error(
                'Failed to export update set: background script produced no output lines. ' +
                `rawResult length: ${result.rawResult.length}`
            );
        }

        // gs.print output may include HTML (e.g. <BR/>) from the script runner UI
        const rawLine = result.scriptResults[0].line.trim();
        const idMatch = rawLine.match(/[0-9a-f]{32}/i);
        if (!idMatch) {
            throw new Error(`Invalid export ID: ${rawLine}`);
        }
        const exportID = idMatch[0];

        const exportRequest: HTTPRequest = {
            path: UpdateSetManager.UPDATE_SET_EXPORT_PATH,
            headers: { Accept: 'application/xml, text/xml, */*' },
            query: {
                sysparm_sys_id: `${exportID}`,
                sysparm_ck: csrfToken,
                sysparm_delete_when_done: true,
                sysparm_is_remote: false
            },
            body: null
        };

        const response: IHttpResponse<string> = await this._req.get<string>(exportRequest);

        if (response.status !== 200 || response.data === null || response.data === undefined) {
            throw new Error(`Failed to download exported update set XML. Status: ${response.status}`);
        }

        if (typeof response.data !== 'string') {
            throw new Error('Export response was not XML text');
        }

        return response.data;
    }

    /**
     * Fetch the CSRF token from /upload.do by parsing the sysparm_ck hidden input.
     */
    private async _getUploadCSRFToken(): Promise<string | null> {
        const request: HTTPRequest = {
            path: UpdateSetManager.UPLOAD_DO_PATH,
            headers: null,
            query: null,
            body: null
        };

        const response: IHttpResponse<string> = await this._req.get<string>(request);

        if (response.status === 200 && response.data) {
            const token = CSRFTokenHelper.extractCSRFToken(response.data);
            this._logger.debug('CSRF token received for update set export', { token });
            return token;
        }

        this._logger.error('Failed to fetch CSRF token from /upload.do', { status: response.status });
        return null;
    }
}
