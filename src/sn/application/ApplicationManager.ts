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
    StoreAppFinalResult
} from "./StoreApplicationModels";
import { OperationProgressCallback, createProgressEmitter } from "../OperationProgress";

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
    DEFAULT_INSTALL_TIMEOUT = 1000 * 60 * 30;
    DEFAULT_POLL_INTERVAL = 5000;
    BATCH_INSTALL_TIMEOUT = 1000 * 60 * 30 ;
    _logger:Logger = new Logger("ApplicationManager");

    _req:ServiceNowRequest;

  


    public constructor(instance:ServiceNowInstance){
        this._instance = instance;
        this._req = new ServiceNowRequest(instance);
    }

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
       emit({
           message: progress.status_message || progress.status_label || 'Installation started',
           percentComplete: progress.percent_complete,
           status: progress.status
       });

       while (progress.percent_complete < 100 && (Date.now() - startTime) < timeoutMs) {
           await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
           progress = await progressWorker.getProgress(progressId);
           this._logger.info(`Installation progress: ${progress.percent_complete}%`);
           emit({
               message: progress.status_message || progress.status_label || 'Installing',
               percentComplete: progress.percent_complete,
               status: progress.status
           });
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