import { ServiceNowInstance } from "../ServiceNowInstance";
import { Logger } from "../../util/Logger";
import { HTTPRequest } from "../../comm/http/HTTPRequest";
import { IHttpResponse } from "../../comm/http/IHttpResponse";
import { ServiceNowRequest } from "../../comm/http/ServiceNowRequest";
import * as fs from 'fs';
import { ProgressWorker } from "../ProgressWorker";
import { ApplicationDetailModel, ApplicationDetailModelResponse } from "./ApplicationDetailModel";
import { BatchInstallation } from "./BatchInstallation";
import { BatchDefinition } from "./BatchDefinition";
import {
    StoreAppSearchOptions,
    StoreAppSearchResponse,
    StoreAppInstallOptions,
    StoreAppUpdateOptions,
    StoreAppOperationResponse,
    StoreAppOperationResult,
    StoreAppFinalResult,
    StoreAppRepairEndpoint,
    StoreAppRepairHistory,
    StoreAppRepairOptions,
    StoreAppRepairResult,
    StoreAppRepairStart,
    StoreAppRepairTarget,
    STORE_APP_REPAIR_SKIPPED_LIMIT
} from "./StoreApplicationModels";
import { StoreAppRepairError } from "./StoreAppRepairError";
import { TableAPIRequest } from "../../comm/http/TableAPIRequest";
import { OperationProgressCallback, createProgressEmitter, toOperationProgress } from "../OperationProgress";

export enum APP_TAB_CONTEXT {
    AVAILABLE_FOR_YOU = "available_for_you",
    INSTALLED = "installed",
    UPDATES = "updates"
}

export class ApplicationManager {
    BATCH_API_URL = "/api/sn_cicd/app/batch/install";
    APP_DETAILS_API_URL = "/api/sn_appclient/appmanager/app/{appID}";
    APP_SEARCH_API_URL = "/api/sn_appclient/appmanager/apps?search_key={searchKey}&sysparm_limit={limit}&tab_context={tabContext}";

    APP_INSTALL_API_URL = "/api/sn_appclient/appmanager/app/install";
    APP_SEARCH_POST_API_URL = "/api/sn_appclient/appmanager/apps";
    APP_UPDATE_API_URL = "/api/sn_appclient/appmanager/app/update";
    APP_REPAIR_API_URL = "/api/sn_appclient/appmanager/app/repair";
    /** Reads of the upgrade history after a repair reports success, and the pause between them. */
    REPAIR_HISTORY_ATTEMPTS = 15;
    REPAIR_HISTORY_SETTLE_MS = 2000;
    DEFAULT_INSTALL_TIMEOUT = 1000 * 60 * 30;
    DEFAULT_POLL_INTERVAL = 5000;
    BATCH_INSTALL_TIMEOUT = 1000 * 60 * 30 ;
    _logger:Logger = new Logger("ApplicationManager");

    _req:ServiceNowRequest;

  


    public constructor(instance:ServiceNowInstance){
        this._instance = instance;
        this._req = new ServiceNowRequest(instance);
        this._tableAPI = new TableAPIRequest(instance);
    }

    private _tableAPI: TableAPIRequest;

    private _instance:ServiceNowInstance;

   public async installBatch(batchDefinitionPath:string) : Promise<boolean> {

    const batchDefinitionRequest = fs.readFileSync(batchDefinitionPath, 'utf8');
    this._logger.info(`Batch definition loaded from: ${batchDefinitionPath}`);
    const batchInstall = JSON.parse(batchDefinitionRequest) as BatchInstallation;

    const batchDefinitionJson = JSON.stringify(batchInstall);
    this._logger.info(`Batch definition: ${batchDefinitionJson}`);
    const result = await this.executeBatchInstallRequest(batchInstall);
    this._logger.info(`Batch install result: ${JSON.stringify(result)}`);
    this._logger.info(`Batch install links: ${JSON.stringify(result.result.links)}`);

    if(result.result.links && result.result.links.progress){
        await this.waitForBatchInstallCompletion(result.result);
    }


    return true;
   }

   private async getInstallableApplicationPackages(batchInstall:BatchInstallation):Promise<BatchDefinition[]>{
    for (const appPackage of batchInstall.packages) {
        const appDetails = await this.getApplicationDetails(appPackage.id);
        this._logger.info(`App details for ${appPackage.id}: ${JSON.stringify(appDetails)}`);
        if(appDetails && appDetails.version == appPackage.requested_version){
            batchInstall.packages.splice(batchInstall.packages.indexOf(appPackage), 1);
        }
    }
    return batchInstall.packages;
   }



   public async getApplicationDetails(appID:string):Promise<ApplicationDetailModel>{
    const request:HTTPRequest = { method: 'GET', path: this.APP_DETAILS_API_URL.replace("{appID}", appID), headers: null, query: null, body:null};
    const resp:IHttpResponse<ApplicationDetailModelResponse> = await this._req.get<ApplicationDetailModelResponse>(request);
    if(resp.status == 200){
        return resp.bodyObject.result.app_info_on_instance;
    }
    return null;
   }

   private async waitForBatchInstallCompletion(batchInstallResult:BatchInstallResult){
    const startTime = Date.now();
    let progressResult = await this.getBatchProgress(batchInstallResult);
    this._logger.info(`Batch install progress: ${JSON.stringify(progressResult)}`);

    while(progressResult.percent_complete < 100 && (Date.now() - startTime) < this.BATCH_INSTALL_TIMEOUT){
        await new Promise(resolve => setTimeout(resolve, 5000));
        progressResult = await this.getBatchProgress(batchInstallResult);
        this._logger.info(`Batch install progress: ${progressResult.percent_complete}%`);
    }

    if(progressResult.percent_complete < 100){
        throw new Error("Batch install timed out");
    }

    if(progressResult.error){
        throw new Error(progressResult.error);
    }

    if(progressResult.status === "3"){
        throw new Error(progressResult.status_label + " : " + progressResult.status_message);
    }

    return true;
   }


   private async executeBatchInstallRequest(batchDefinitionRequest:object) {
    
    const request:HTTPRequest = { method: 'POST', path: this.BATCH_API_URL, headers: { 'Content-Type': 'application/json' }, query: null, json:batchDefinitionRequest, body:null};
    const resp:IHttpResponse<BatchInstallResultResponse> = await this._req.post<BatchInstallResultResponse>(request);
    if(resp.status == 200){
        return resp.bodyObject;
    }
    return null;
   }

   private async getBatchProgress(batchInstallResult:BatchInstallResult){
    const progressWorker = new ProgressWorker(this._instance);
    const progressResult = await progressWorker.getProgress(batchInstallResult.links.progress?.id || '');
    return progressResult;
   }

   /**
    * Validates a batch definition file against currently installed applications
    * @param batchDefinitionPath Path to the batch definition JSON file
    * @returns Promise<BatchValidationResult> Validation results for all applications in the batch
    */
   public async validateBatchDefinition(batchDefinitionPath: string): Promise<BatchValidationResult> {
       const batchDefinitionRequest = fs.readFileSync(batchDefinitionPath, 'utf8');
       const batchInstall = JSON.parse(batchDefinitionRequest) as BatchInstallation;
       
       return await this.validateBatchInstallation(batchInstall);
   }

   /**
    * Validates a BatchInstallation object against currently installed applications
    * @param batchInstall BatchInstallation object to validate
    * @returns Promise<BatchValidationResult> Validation results for all applications in the batch
    */
   public async validateBatchInstallation(batchInstall: BatchInstallation): Promise<BatchValidationResult> {
       const validationResults: ApplicationValidationResult[] = [];
       
       // Process each application in parallel for better performance
       const validationPromises = batchInstall.packages.map(async (pkg) => {
           return await this.validateApplication(pkg);
       });
       
       const results = await Promise.all(validationPromises);
       validationResults.push(...results);
       
       // Calculate summary statistics
       const totalApplications = validationResults.length;
       const alreadyValid = validationResults.filter(r => r.validationStatus === 'valid').length;
       const needsInstallation = validationResults.filter(r => r.validationStatus === 'not_installed').length;
       const needsUpgrade = validationResults.filter(r => r.validationStatus === 'update_needed' || r.validationStatus === 'mismatch').length;
       const errors = validationResults.filter(r => r.validationStatus === 'error').length;
       const isValid = errors === 0;
       
       return {
           applications: validationResults,
           totalApplications,
           alreadyValid,
           needsInstallation,
           needsUpgrade,
           errors,
           isValid
       };
   }

   /**
    * Validates a single application from a batch definition
    * @param pkg BatchDefinition to validate
    * @returns Promise<ApplicationValidationResult> Validation result for the application
    */
   public async validateApplication(pkg: BatchDefinition): Promise<ApplicationValidationResult> {
       try {
           const appDetails = await this.getApplicationDetails(pkg.id);
           
           if (!appDetails) {
               // Application not found or not installed
               return {
                   id: pkg.id,
                   requested_version: pkg.requested_version,
                   isInstalled: false,
                   isVersionMatch: false,
                   isUpdateAvailable: false,
                   needsAction: true,
                   validationStatus: 'not_installed',
                   error: 'Application not found on instance'
               };
           }
           
           const isInstalled = appDetails.isInstalled || false;
           const installedVersion = appDetails.version || '';
           const requestedVersion = pkg.requested_version;
           
           // Compare versions
           const versionComparison = this.compareVersions(installedVersion, requestedVersion);
           const isVersionMatch = versionComparison === 0;
           const isUpdateAvailable = appDetails.isInstalledAndUpdateAvailable || false;
           
           let validationStatus: 'valid' | 'mismatch' | 'not_installed' | 'update_needed' | 'error';
           let needsAction = false;
           
           if (!isInstalled) {
               validationStatus = 'not_installed';
               needsAction = true;
           } else if (isVersionMatch) {
               validationStatus = 'valid';
               needsAction = false;
           } else if (versionComparison < 0) {
               // Installed version is older than requested
               validationStatus = 'update_needed';
               needsAction = true;
           } else {
               // Installed version is newer than requested
               validationStatus = 'mismatch';
               needsAction = false; // May not need action if newer version is acceptable
           }
           
           return {
               id: pkg.id,
               name: appDetails.name,
               requested_version: requestedVersion,
               installed_version: installedVersion,
               isInstalled,
               isVersionMatch,
               isUpdateAvailable,
               needsAction,
               validationStatus,
               appDetails
           };
       } catch (error) {
           this._logger.error(`Error validating application ${pkg.id}: ${error}`);
           return {
               id: pkg.id,
               requested_version: pkg.requested_version,
               isInstalled: false,
               isVersionMatch: false,
               isUpdateAvailable: false,
               needsAction: false,
               validationStatus: 'error',
               error: error instanceof Error ? error.message : String(error)
           };
       }
   }

   /**
    * Checks which applications from a batch definition are currently installed
    * @param batchDefinitionPath Path to the batch definition JSON file
    * @returns Promise<ApplicationValidationResult[]> Array of validation results
    */
   public async checkInstalledApplications(batchDefinitionPath: string): Promise<ApplicationValidationResult[]> {
       const validationResult = await this.validateBatchDefinition(batchDefinitionPath);
       return validationResult.applications.filter(app => app.isInstalled);
   }

   /**
    * Gets applications that need installation or upgrade from a batch definition
    * @param batchDefinitionPath Path to the batch definition JSON file
    * @returns Promise<ApplicationValidationResult[]> Array of applications needing action
    */
   public async getApplicationsNeedingAction(batchDefinitionPath: string): Promise<ApplicationValidationResult[]> {
       const validationResult = await this.validateBatchDefinition(batchDefinitionPath);
       return validationResult.applications.filter(app => app.needsAction);
   }

   // ============================================================
   // Store Application Management
   // ============================================================

   /**
    * Search/list store applications by tab context with optional search key and pagination.
    * Uses POST /api/sn_appclient/appmanager/apps
    * @param options Search options including tabContext, searchKey, limit, offset, requestBody
    * @returns Array of ApplicationDetailModel matching the search criteria
    */
   public async searchApplications(options: StoreAppSearchOptions): Promise<ApplicationDetailModel[]> {
       const queryParams: Record<string, string> = {
           tab_context: options.tabContext
       };
       if (options.searchKey) {
           queryParams.search_key = options.searchKey;
       }
       if (options.limit !== undefined) {
           queryParams.sysparm_limit = String(options.limit);
       }
       if (options.offset !== undefined) {
           queryParams.sysparm_offset = String(options.offset);
       }

       const request: HTTPRequest = {
           method: 'POST',
           path: this.APP_SEARCH_POST_API_URL,
           headers: { 'Content-Type': 'application/json' },
           query: queryParams,
           json: options.requestBody || {},
           body: null
       };

       const resp: IHttpResponse<StoreAppSearchResponse> = await this._req.post<StoreAppSearchResponse>(request);
       if (resp.status === 200 && resp.bodyObject?.result?.apps) {
           return resp.bodyObject.result.apps;
       }
       return [];
   }

   /**
    * Initiate installation of a store application.
    * Uses GET /api/sn_appclient/appmanager/app/install
    * @param options Install options including appId and version
    * @returns StoreAppOperationResult with tracker info for monitoring progress
    */
   public async installStoreApplication(options: StoreAppInstallOptions): Promise<StoreAppOperationResult> {
       const queryParams: Record<string, string> = {
           app_id: options.appId,
           version: options.version
       };
       if (options.customizationVersion) {
           queryParams.customization_version = options.customizationVersion;
       }
       if (options.loadDemoData !== undefined) {
           queryParams.load_demo_data = String(options.loadDemoData);
       }

       const request: HTTPRequest = {
           method: 'GET',
           path: this.APP_INSTALL_API_URL,
           headers: null,
           query: queryParams,
           body: null
       };

       const resp: IHttpResponse<StoreAppOperationResponse> = await this._req.get<StoreAppOperationResponse>(request);
       if (resp.status === 200 && resp.bodyObject?.result) {
           return resp.bodyObject.result;
       }
       throw new Error(`Failed to initiate store app install: HTTP ${resp.status}`);
   }

   /**
    * Install a store application and wait for completion by polling the tracker.
    * @param options Install options including appId and version
    * @param pollIntervalMs Polling interval in ms (default: 5000)
    * @param timeoutMs Timeout in ms (default: 30 min)
    * @returns StoreAppFinalResult with success status and details
    */
   public async installStoreApplicationAndWait(
       options: StoreAppInstallOptions,
       pollIntervalMs?: number,
       timeoutMs?: number,
       onProgress?: OperationProgressCallback
   ): Promise<StoreAppFinalResult> {
       const operationResult = await this.installStoreApplication(options);
       const trackerId = operationResult.tracker_id || operationResult.trackerId || operationResult.links?.progress?.id;
       if (!trackerId) {
           throw new Error('No tracker ID returned from install operation');
       }
       return await this.waitForInstallationCompletion(
           trackerId,
           pollIntervalMs || this.DEFAULT_POLL_INTERVAL,
           timeoutMs || this.DEFAULT_INSTALL_TIMEOUT,
           onProgress
       );
   }

   /**
    * Initiate update of a store application.
    * Uses GET /api/sn_appclient/appmanager/app/update
    * @param options Update options including appId and version
    * @returns StoreAppOperationResult with tracker info for monitoring progress
    */
   public async updateStoreApplication(options: StoreAppUpdateOptions): Promise<StoreAppOperationResult> {
       const queryParams: Record<string, string> = {
           app_id: options.appId,
           version: options.version
       };
       if (options.customizationVersion) {
           queryParams.customization_version = options.customizationVersion;
       }
       if (options.loadDemoData !== undefined) {
           queryParams.load_demo_data = String(options.loadDemoData);
       }

       const request: HTTPRequest = {
           method: 'GET',
           path: this.APP_UPDATE_API_URL,
           headers: null,
           query: queryParams,
           body: null
       };

       const resp: IHttpResponse<StoreAppOperationResponse> = await this._req.get<StoreAppOperationResponse>(request);
       if (resp.status === 200 && resp.bodyObject?.result) {
           return resp.bodyObject.result;
       }
       throw new Error(`Failed to initiate store app update: HTTP ${resp.status}`);
   }

   /**
    * Update a store application and wait for completion by polling the tracker.
    * @param options Update options including appId and version
    * @param pollIntervalMs Polling interval in ms (default: 5000)
    * @param timeoutMs Timeout in ms (default: 30 min)
    * @returns StoreAppFinalResult with success status and details
    */
   public async updateStoreApplicationAndWait(
       options: StoreAppUpdateOptions,
       pollIntervalMs?: number,
       timeoutMs?: number,
       onProgress?: OperationProgressCallback
   ): Promise<StoreAppFinalResult> {
       const operationResult = await this.updateStoreApplication(options);
       const trackerId = operationResult.tracker_id || operationResult.trackerId || operationResult.links?.progress?.id;
       if (!trackerId) {
           throw new Error('No tracker ID returned from update operation');
       }
       return await this.waitForInstallationCompletion(
           trackerId,
           pollIntervalMs || this.DEFAULT_POLL_INTERVAL,
           timeoutMs || this.DEFAULT_INSTALL_TIMEOUT,
           onProgress
       );
   }

   // ============================================================
   // Store Application Repair
   // ============================================================

   /**
    * Start a repair of an installed store or company application: the platform's Repair
    * Application link on sys_store_app. It reinstalls the INSTALLED version from the
    * application repository without uninstalling the app, reapplying its files and its
    * customization version, if any.
    *
    * Refused before anything is sent, as the platform refuses it, for an inactive app, an
    * app that contains plugins, an app developed on this instance, and demo data the app
    * does not have.
    *
    * Uses GET /api/sn_appclient/appmanager/app/repair, or app/install with isReinstall=true
    * when the instance has queued installation off (see StoreAppRepairEndpoint).
    * @returns The started repair, for waitForStoreApplicationRepair
    * @throws StoreAppRepairError when the repair is refused or the App Client does not start it
    */
   public async repairStoreApplication(options: StoreAppRepairOptions): Promise<StoreAppRepairStart> {
       const app = await this._repairTarget(options);
       const previousHistory = await this._historyBefore(app.scope);
       const endpoint: StoreAppRepairEndpoint = await this._queuedInstallation() ? 'repair' : 'install';

       const query: Record<string, string> = {
           app_id: app.sysId,
           version: app.version,
           load_demo_data: String(options.loadDemoData === true)
       };
       if (app.customizationVersion) query.customization_version = app.customizationVersion;
       if (endpoint === 'install') query.isReinstall = 'true';

       let resp: IHttpResponse<StoreAppOperationResponse>;
       try {
           resp = await this._req.get<StoreAppOperationResponse>({
               path: endpoint === 'repair' ? this.APP_REPAIR_API_URL : this.APP_INSTALL_API_URL,
               headers: null,
               query,
               body: null
           });
       } catch (error) {
           throw this._repairStartFailure(error, app);
       }

       const operation = resp.bodyObject?.result;
       const trackerId = operation?.trackerId || operation?.tracker_id || operation?.links?.progress?.id;
       if (resp.status !== 200 || !operation || !trackerId) {
           throw new StoreAppRepairError('start_failed', { app: app.sysId, status: resp.status, serverMessage: operation?.message });
       }
       this._logger.info(`Repair of ${app.scope} ${app.version} started (${endpoint}), tracker ${trackerId}`);
       return { app, trackerId, endpoint, ...previousHistory, operation };
   }

   /**
    * Repair an installed store or company application and wait for it to finish.
    * See repairStoreApplication.
    * @param pollIntervalMs Polling interval in ms (default: 5000)
    * @param timeoutMs Timeout in ms (default: 30 min). A queued repair can wait minutes before it runs.
    */
   public async repairStoreApplicationAndWait(
       options: StoreAppRepairOptions,
       pollIntervalMs?: number,
       timeoutMs?: number,
       onProgress?: OperationProgressCallback
   ): Promise<StoreAppRepairResult> {
       const started = await this.repairStoreApplication(options);
       return await this.waitForStoreApplicationRepair(started, pollIntervalMs, timeoutMs, onProgress);
   }

   /**
    * Wait for a started repair, then read the upgrade history it wrote.
    *
    * `repaired` is true only when the App Client reported success and a new
    * sys_upgrade_history row appeared for the app: the App Client also reports success
    * when it decided no reinstall was necessary.
    */
   public async waitForStoreApplicationRepair(
       started: StoreAppRepairStart,
       pollIntervalMs?: number,
       timeoutMs?: number,
       onProgress?: OperationProgressCallback
   ): Promise<StoreAppRepairResult> {
       const final = await this.waitForInstallationCompletion(
           started.trackerId,
           pollIntervalMs || this.DEFAULT_POLL_INTERVAL,
           timeoutMs || this.DEFAULT_INSTALL_TIMEOUT,
           onProgress
       );

       // The tracker can report success before the history row is finished: on dev206299 the
       // row appeared mid-install and its counts were filled seconds after the tracker ended.
       let row = await this._repairHistoryRow(started);
       for (let attempt = 0; final.success && !historyComplete(row) && attempt < this.REPAIR_HISTORY_ATTEMPTS; attempt++) {
           await new Promise(resolve => setTimeout(resolve, this.REPAIR_HISTORY_SETTLE_MS));
           row = await this._repairHistoryRow(started);
       }
       const history = row ? await this._repairHistory(row) : undefined;

       const complete = historyComplete(row);
       const warnings: string[] = [];
       if (final.success && !history) {
           warnings.push('The App Client reported success but wrote no upgrade history for this application, so it may not have reinstalled anything.');
       }
       if (row && !complete) {
           warnings.push('The upgrade history was still being written when the wait ended, so its counts may be incomplete.');
       }
       if (history) {
           // The counts leave out Table Not Found, Fatal Error and Not Loaded; the listed files do not.
           // Apply-once files are expected to be left alone on a reinstall.
           const c = history.counts;
           const counted = c.skipped + c.skippedError + c.skippedManualMerge;
           const listed = history.skippedFiles.filter(file => file.disposition !== '11').length;
           const notApplied = Math.max(counted, listed);
           if (notApplied > 0) {
               const more = history.skippedFilesTruncated && listed >= counted ? ' or more' : '';
               warnings.push(`${notApplied}${more} file(s) were not applied (skipped ${c.skipped}, errors ${c.skippedError}, manual merge ${c.skippedManualMerge}). See the skipped files and the upgrade history.`);
           }
       }

       return {
           ...final,
           app: started.app,
           trackerId: started.trackerId,
           endpoint: started.endpoint,
           history,
           repaired: final.success && history !== undefined && complete,
           warnings
       };
   }

   private async _repairTarget(options: StoreAppRepairOptions): Promise<StoreAppRepairTarget> {
       const given = typeof options?.app === 'string' ? options.app.trim() : '';
       const bySysId = /^[a-f0-9]{32}$/i.test(given);
       const key = bySysId ? given.toLowerCase() : given;
       // Validated before it goes into an encoded query: a ^ would add conditions.
       if (!bySysId && !/^[a-z0-9_]{1,40}$/i.test(key)) throw new StoreAppRepairError('invalid_app');
       const match = bySysId ? `sys_id=${key}` : `scope=${key}`;

       const [app] = await this._rows<RepairStoreAppRow>('sys_store_app', match, 'sys_id,name,scope,version,active,contains_plugins,demo_data', 1);
       if (!app) {
           const [local] = await this._rows<{ sys_id: string }>('sys_app', match, 'sys_id', 1);
           throw new StoreAppRepairError(local ? 'not_a_store_app' : 'app_not_found', { app: key });
       }
       if (app.active !== 'true') throw new StoreAppRepairError('app_inactive', { app: app.sys_id, scope: app.scope });
       if (app.contains_plugins === 'true') throw new StoreAppRepairError('contains_plugins', { app: app.sys_id, scope: app.scope });
       const hasDemoData = app.demo_data !== 'no_demo_data';
       if (options.loadDemoData && !hasDemoData) throw new StoreAppRepairError('no_demo_data', { app: app.sys_id, scope: app.scope });

       // As the Repair dialog does: an app under source control has no customization to
       // reapply; otherwise the installed customization version goes with it.
       let customizationVersion: string | undefined;
       const [repoConfig] = await this._rows<{ sys_id: string }>('sys_repo_config', `sys_app=${app.sys_id}`, 'sys_id', 1);
       if (!repoConfig) {
           const [customization] = await this._rows<{ version: string }>('sys_app_customization', `vendor_app=${app.sys_id}^version!=none`, 'version', 1);
           if (customization?.version) customizationVersion = customization.version;
       }

       return {
           sysId: app.sys_id,
           name: app.name,
           scope: app.scope,
           version: app.version,
           customizationVersion,
           hasDemoData
       };
   }

   private async _queuedInstallation(): Promise<boolean> {
       const [property] = await this._rows<{ value: string }>('sys_properties', 'name=sn_appclient.use_queued_installation', 'value', 1);
       return property?.value === 'true';
   }

   /**
    * What the app's upgrade history held before the repair. sys_created_on has whole-second
    * precision, so every row from the newest second is remembered, not only the first returned.
    */
   private async _historyBefore(scope: string): Promise<Pick<StoreAppRepairStart, 'previousHistoryIds' | 'previousHistoryCreated'>> {
       const [newest] = await this._rows<{ sys_id: string; sys_created_on: string }>(
           'sys_upgrade_history', `to_version=${scope}^ORDERBYDESCsys_created_on`, 'sys_id,sys_created_on', 1);
       if (!newest) return { previousHistoryIds: [] };
       const sameSecond = await this._rows<{ sys_id: string }>(
           'sys_upgrade_history', `to_version=${scope}^sys_created_on=${newest.sys_created_on}`, 'sys_id', 100);
       return {
           previousHistoryIds: [...new Set([newest.sys_id, ...sameSecond.map(row => row.sys_id)])],
           previousHistoryCreated: newest.sys_created_on
       };
   }

   /**
    * The newest upgrade history row the repair can have written: created no earlier than the
    * newest row before it, and not one of those. Another install of the same scope while the
    * repair waited in the queue would be indistinguishable; the history row names no tracker.
    */
   private async _repairHistoryRow(started: StoreAppRepairStart): Promise<RepairHistoryRow | undefined> {
       const since = started.previousHistoryCreated ? `^sys_created_on>=${started.previousHistoryCreated}` : '';
       const rows = await this._rows<RepairHistoryRow>(
           'sys_upgrade_history',
           `to_version=${started.app.scope}${since}^ORDERBYDESCsys_created_on`,
           'sys_id,sys_created_on,upgrade_started,upgrade_finished,summary_complete_status,added,updated,deleted,unchanged,skipped,skipped_error,skipped_manual_merge,skipped_apply_once',
           started.previousHistoryIds.length + 1
       );
       return rows.find(row => !started.previousHistoryIds.includes(row.sys_id));
   }

   private async _repairHistory(row: RepairHistoryRow): Promise<StoreAppRepairHistory> {
       const skippedRows = await this._rows<RepairHistoryLogRow>(
           'sys_upgrade_history_log',
           `upgrade_history=${row.sys_id}^dispositionIN${Object.keys(SKIPPED_DISPOSITIONS).join(',')}^ORDERBYfile_name`,
           'file_name,type,target_name,disposition,reason',
           STORE_APP_REPAIR_SKIPPED_LIMIT + 1
       );
       const count = (value: string | undefined) => Number.parseInt(value ?? '', 10) || 0;
       return {
           sysId: row.sys_id,
           started: row.upgrade_started || undefined,
           finished: row.upgrade_finished || undefined,
           status: row.summary_complete_status || undefined,
           counts: {
               added: count(row.added),
               updated: count(row.updated),
               deleted: count(row.deleted),
               unchanged: count(row.unchanged),
               skipped: count(row.skipped),
               skippedError: count(row.skipped_error),
               skippedManualMerge: count(row.skipped_manual_merge),
               skippedApplyOnce: count(row.skipped_apply_once)
           },
           skippedFiles: skippedRows.slice(0, STORE_APP_REPAIR_SKIPPED_LIMIT).map(file => ({
               fileName: file.file_name,
               type: file.type,
               targetName: file.target_name,
               disposition: file.disposition,
               dispositionLabel: SKIPPED_DISPOSITIONS[file.disposition] ?? file.disposition,
               reason: file.reason || undefined
           })),
           skippedFilesTruncated: skippedRows.length > STORE_APP_REPAIR_SKIPPED_LIMIT
       };
   }

   private _repairStartFailure(error: unknown, app: StoreAppRepairTarget): unknown {
       // Policy refusals and session errors say what is wrong themselves.
       const message = error instanceof Error ? error.message : '';
       const failed = /^(?:Error during request\. Status: |Request failed with status )(\d{3})/.exec(message);
       if (!failed) return error;
       let serverMessage: string | undefined;
       const body = /Body: (.*)$/s.exec(message)?.[1];
       try {
           const parsed = (body ? JSON.parse(body) : undefined) as { error?: { message?: string; detail?: string } } | undefined;
           serverMessage = parsed?.error?.message || parsed?.error?.detail || undefined;
       } catch {
           serverMessage = undefined;
       }
       return new StoreAppRepairError('start_failed', { app: app.sysId, status: Number(failed[1]), serverMessage }, error);
   }

   private async _rows<T>(table: string, query: string, fields: string, limit: number): Promise<T[]> {
       const resp = await this._tableAPI.get<{ result: T[] }>(table, {
           sysparm_query: query,
           sysparm_fields: fields,
           sysparm_limit: String(limit),
           sysparm_exclude_reference_link: 'true'
       });
       return resp.bodyObject?.result ?? [];
   }

   /**
    * Poll installation progress via ProgressWorker until complete, timed out, or failed.
    * Uses GET /api/sn_cicd/progress/{progressId}
    * @param progressId Progress ID from an install/update operation
    * @param pollIntervalMs Polling interval in ms
    * @param timeoutMs Timeout in ms
    * @returns StoreAppFinalResult with success status
    */
   private async waitForInstallationCompletion(
       progressId: string,
       pollIntervalMs: number,
       timeoutMs: number,
       onProgress?: OperationProgressCallback
   ): Promise<StoreAppFinalResult> {
       const progressWorker = new ProgressWorker(this._instance);
       const emit = createProgressEmitter(onProgress);
       const startTime = Date.now();
       let progress = await progressWorker.getProgress(progressId);
       this._logger.info(`Installation progress: ${JSON.stringify(progress)}`);
       emit(toOperationProgress(progress, 'Installation in progress'));

       while (progress.percent_complete < 100 && (Date.now() - startTime) < timeoutMs) {
           await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
           progress = await progressWorker.getProgress(progressId);
           this._logger.info(`Installation progress: ${progress.percent_complete}%`);
           emit(toOperationProgress(progress, 'Installation in progress'));
       }

       if (progress.percent_complete < 100) {
           return {
               success: false,
               status: progress.status,
               status_label: progress.status_label,
               status_message: progress.status_message,
               error: 'Installation timed out',
               percent_complete: progress.percent_complete
           };
       }

       if (progress.error) {
           return {
               success: false,
               status: progress.status,
               status_label: progress.status_label,
               status_message: progress.status_message,
               error: progress.error,
               percent_complete: progress.percent_complete
           };
       }

       // Status "3" typically indicates failure in ServiceNow
       if (progress.status === '3') {
           return {
               success: false,
               status: progress.status,
               status_label: progress.status_label,
               status_message: progress.status_message,
               error: `${progress.status_label}: ${progress.status_message}`,
               percent_complete: progress.percent_complete
           };
       }

       return {
           success: true,
           status: progress.status,
           status_label: progress.status_label,
           status_message: progress.status_message,
           percent_complete: progress.percent_complete
       };
   }

   /**
    * Compares two version strings
    * @param version1 First version string (e.g., "1.2.3")
    * @param version2 Second version string (e.g., "1.2.4")
    * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
    */
   private compareVersions(version1: string, version2: string): number {
       if (!version1 && !version2) return 0;
       if (!version1) return -1;
       if (!version2) return 1;
       
       const v1parts = version1.split('.').map(v => parseInt(v) || 0);
       const v2parts = version2.split('.').map(v => parseInt(v) || 0);
       
       const maxLength = Math.max(v1parts.length, v2parts.length);
       
       for (let i = 0; i < maxLength; i++) {
           const v1 = v1parts[i] || 0;
           const v2 = v2parts[i] || 0;
           
           if (v1 < v2) return -1;
           if (v1 > v2) return 1;
       }
       
       return 0;
   }
}

/** sys_upgrade_history_log dispositions a repair reports as not applied. */
const SKIPPED_DISPOSITIONS: Record<string, string> = {
    "4": "Skipped",
    "6": "Table Not Found",
    "9": "Skipped Error",
    "10": "Skipped Manual Merge",
    "11": "Skipped Apply Once",
    "104": "Skipped (second pass)",
    "106": "Table Not Found (second pass)",
    "301": "Fatal Error",
    "302": "Not Loaded"
};

/** A history row is finished once it has an end time and its summary is complete. */
function historyComplete(row: RepairHistoryRow | undefined): boolean {
    return !!row?.upgrade_finished && row.summary_complete_status === "complete";
}

interface RepairStoreAppRow {
    sys_id: string;
    name: string;
    scope: string;
    version: string;
    active: string;
    contains_plugins: string;
    demo_data: string;
}

interface RepairHistoryRow {
    sys_id: string;
    upgrade_started?: string;
    upgrade_finished?: string;
    summary_complete_status?: string;
    added?: string;
    updated?: string;
    deleted?: string;
    unchanged?: string;
    skipped?: string;
    skipped_error?: string;
    skipped_manual_merge?: string;
    skipped_apply_once?: string;
}

interface RepairHistoryLogRow {
    file_name: string;
    type: string;
    target_name: string;
    disposition: string;
    reason?: string;
}

export class BatchInstallResultResponse{
    result:BatchInstallResult;
}

export interface BatchInstallResultLinks {
    progress?: {
        id: string;
        url: string;
    };
}

export class BatchInstallResult{
    links: BatchInstallResultLinks;
}

/**
 * Represents the validation result for a single application in a batch definition
 */
export interface ApplicationValidationResult {
    /** Application sys_id from batch definition */
    id: string;
    /** Application name */
    name?: string;
    /** Requested version from batch definition */
    requested_version: string;
    /** Currently installed version (if any) */
    installed_version?: string;
    /** Whether the application is currently installed */
    isInstalled: boolean;
    /** Whether the installed version matches the requested version */
    isVersionMatch: boolean;
    /** Whether an update is available */
    isUpdateAvailable: boolean;
    /** Whether the application needs to be installed or upgraded */
    needsAction: boolean;
    /** Validation status: 'valid', 'mismatch', 'not_installed', 'update_needed', 'error' */
    validationStatus: 'valid' | 'mismatch' | 'not_installed' | 'update_needed' | 'error';
    /** Any error message if validation failed */
    error?: string;
    /** Full application details if available */
    appDetails?: ApplicationDetailModel;
}

/**
 * Represents the validation result for an entire batch definition
 */
export interface BatchValidationResult {
    /** Array of validation results for each application */
    applications: ApplicationValidationResult[];
    /** Total number of applications in batch */
    totalApplications: number;
    /** Number of applications already installed with correct version */
    alreadyValid: number;
    /** Number of applications that need installation */
    needsInstallation: number;
    /** Number of applications that need upgrade */
    needsUpgrade: number;
    /** Number of applications with errors during validation */
    errors: number;
    /** Overall validation passed (all apps either valid or can be installed/upgraded) */
    isValid: boolean;
}