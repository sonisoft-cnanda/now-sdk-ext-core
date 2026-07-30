import { ServiceNowInstance } from "../ServiceNowInstance";
import { Logger } from "../../util/Logger";
import { HTTPRequest } from "../../comm/http/HTTPRequest";
import { IHttpResponse } from "../../comm/http/IHttpResponse";
import { ServiceNowRequest } from "../../comm/http/ServiceNowRequest";
import { ProgressWorker, ProgressResult } from "../ProgressWorker";
import { OperationProgressCallback, createProgressEmitter, toOperationProgress } from "../OperationProgress";

/**
 * AppRepoApplication class for managing application repository operations
 * Provides methods to install applications from and publish applications to
 * a company's ServiceNow application repository using the CI/CD API
 */
export class AppRepoApplication {
    private readonly APP_REPO_INSTALL_API_URL = "/api/sn_cicd/app_repo/install";
    private readonly APP_REPO_PUBLISH_API_URL = "/api/sn_cicd/app_repo/publish";
    private readonly PROGRESS_API_URL = "/api/sn_cicd/progress/{progressId}";
    
    private readonly DEFAULT_TIMEOUT = 1000 * 60 * 30; // 30 minutes
    private readonly DEFAULT_POLL_INTERVAL = 5000; // 5 seconds
    
    private _logger: Logger = new Logger("AppRepoApplication");
    private _req: ServiceNowRequest;
    private _instance: ServiceNowInstance;

    public constructor(instance: ServiceNowInstance) {
        this._instance = instance;
        this._req = new ServiceNowRequest(instance);
    }

    /**
     * Installs an application from the application repository
     * @param request AppRepoInstallRequest containing installation parameters
     * @returns Promise<AppRepoInstallResponse> Installation response with progress information
     */
    public async installFromAppRepo(request: AppRepoInstallRequest): Promise<AppRepoInstallResponse> {
        const queryParams: Record<string, string | boolean> = {
            scope: request.scope,
            sys_id: request.sys_id
        };

        // Add optional parameters
        if (request.version !== undefined) {
            queryParams.version = request.version;
        }
        if (request.auto_upgrade_base_app !== undefined) {
            queryParams.auto_upgrade_base_app = request.auto_upgrade_base_app;
        }
        if (request.base_app_version !== undefined) {
            queryParams.base_app_version = request.base_app_version;
        }

        const httpRequest: HTTPRequest = {
            path: this.APP_REPO_INSTALL_API_URL,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            query: queryParams,
            body: null
        };

        this._logger.info(`Installing application from app repo: ${request.scope} (${request.sys_id})`);
        
        const resp: IHttpResponse<{ result: AppRepoInstallResponse }> = await this._req.post<{ result: AppRepoInstallResponse }>(httpRequest);
        
        if (resp.status === 200 && resp.bodyObject && resp.bodyObject.result) {
            this._logger.info(`App repo install initiated successfully for ${request.scope}`);
            return resp.bodyObject.result;
        }

        throw new Error(`Failed to install application from app repo. Status: ${resp.status}, Response: ${JSON.stringify(resp.bodyObject)}`);
    }

    /**
     * Installs an application from the app repository and waits for completion
     * @param request AppRepoInstallRequest containing installation parameters
     * @param pollIntervalMs Polling interval in milliseconds (default: 5000)
     * @param timeoutMs Timeout in milliseconds (default: 30 minutes)
     * @returns Promise<AppRepoOperationResult> Final operation result
     */
    public async installFromAppRepoAndWait(
        request: AppRepoInstallRequest, 
        pollIntervalMs: number = this.DEFAULT_POLL_INTERVAL,
        timeoutMs: number = this.DEFAULT_TIMEOUT,
        onProgress?: OperationProgressCallback
    ): Promise<AppRepoOperationResult> {
        const installResponse = await this.installFromAppRepo(request);
        
        if (!installResponse.links?.progress?.id) {
            throw new Error('No progress ID returned from install operation');
        }

        return await this.waitForCompletion(
            installResponse.links.progress.id, 
            pollIntervalMs, 
            timeoutMs,
            onProgress
        );
    }

    /**
     * Publishes an application to the application repository
     * @param request AppRepoPublishRequest containing publish parameters
     * @returns Promise<AppRepoPublishResponse> Publish response with progress information
     */
    public async publishToAppRepo(request: AppRepoPublishRequest): Promise<AppRepoPublishResponse> {
        const queryParams: Record<string, string | boolean> = {
            scope: request.scope,
            sys_id: request.sys_id
        };

        // Add optional parameters
        if (request.version !== undefined) {
            queryParams.version = request.version;
        }
        if (request.dev_notes !== undefined) {
            queryParams.dev_notes = request.dev_notes;
        }

        const httpRequest: HTTPRequest = {
            path: this.APP_REPO_PUBLISH_API_URL,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            query: queryParams,
            body: null
        };

        this._logger.info(`Publishing application to app repo: ${request.scope} (${request.sys_id})`);
        
        const resp: IHttpResponse<{ result: AppRepoPublishResponse }> = await this._req.post<{ result: AppRepoPublishResponse }>(httpRequest);
        
        if (resp.status === 200 && resp.bodyObject && resp.bodyObject.result) {
            this._logger.info(`App repo publish initiated successfully for ${request.scope}`);
            return resp.bodyObject.result;
        }

        throw new Error(`Failed to publish application to app repo. Status: ${resp.status}, Response: ${JSON.stringify(resp.bodyObject)}`);
    }

    /**
     * Publishes an application to the app repository and waits for completion
     * @param request AppRepoPublishRequest containing publish parameters
     * @param pollIntervalMs Polling interval in milliseconds (default: 5000)
     * @param timeoutMs Timeout in milliseconds (default: 30 minutes)
     * @returns Promise<AppRepoOperationResult> Final operation result
     */
    public async publishToAppRepoAndWait(
        request: AppRepoPublishRequest,
        pollIntervalMs: number = this.DEFAULT_POLL_INTERVAL,
        timeoutMs: number = this.DEFAULT_TIMEOUT,
        onProgress?: OperationProgressCallback
    ): Promise<AppRepoOperationResult> {
        const publishResponse = await this.publishToAppRepo(request);
        
        if (!publishResponse.links?.progress?.id) {
            throw new Error('No progress ID returned from publish operation');
        }

        return await this.waitForCompletion(
            publishResponse.links.progress.id,
            pollIntervalMs,
            timeoutMs,
            onProgress
        );
    }

    /**
     * Gets the current progress of an app repo operation
     * @param progressId Progress ID from the operation response
     * @returns Promise<ProgressResult> Current progress information
     */
    public async getProgress(progressId: string): Promise<ProgressResult> {
        const progressWorker = new ProgressWorker(this._instance);
        return await progressWorker.getProgress(progressId);
    }

    /**
     * Waits for an app repo operation to complete
     * @param progressId Progress ID to monitor
     * @param pollIntervalMs Polling interval in milliseconds
     * @param timeoutMs Timeout in milliseconds
     * @returns Promise<AppRepoOperationResult> Final operation result
     */
    private async waitForCompletion(
        progressId: string,
        pollIntervalMs: number,
        timeoutMs: number,
        onProgress?: OperationProgressCallback
    ): Promise<AppRepoOperationResult> {
        const startTime = Date.now();
        const emit = createProgressEmitter(onProgress);
        let progress = await this.getProgress(progressId);

        this._logger.info(`Waiting for operation completion. Progress: ${progress.percent_complete}%`);
        emit(toOperationProgress(progress, 'Operation in progress'));

        while (progress.percent_complete < 100 && (Date.now() - startTime) < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            progress = await this.getProgress(progressId);
            this._logger.info(`Operation progress: ${progress.percent_complete}% - ${progress.status_label}`);
            emit(toOperationProgress(progress, 'Operation in progress'));
        }

        if (progress.percent_complete < 100) {
            throw new Error(`Operation timed out after ${timeoutMs}ms`);
        }

        if (progress.error) {
            throw new Error(`Operation failed: ${progress.error}`);
        }

        if (progress.status === "3") { // FAILED status
            throw new Error(`Operation failed: ${progress.status_label} - ${progress.status_message}`);
        }

        return {
            success: progress.status === "2", // SUCCESSFUL status
            status: progress.status,
            status_label: progress.status_label,
            status_message: progress.status_message,
            status_detail: progress.status_detail,
            error: progress.error,
            percent_complete: progress.percent_complete,
            links: progress.links
        };
    }
}

/**
 * Request parameters for installing an application from the app repository
 */
export interface AppRepoInstallRequest {
    /** Required: Scope name of the application to install */
    scope: string;
    
    /** Required: Sys ID of the application in the repository */
    sys_id: string;
    
    /** Optional: Version of the application to install */
    version?: string;
    
    /** Optional: Whether to automatically upgrade the base application if required (default: false) */
    auto_upgrade_base_app?: boolean;
    
    /** Optional: Version of the base application to upgrade to */
    base_app_version?: string;
}

/**
 * Request parameters for publishing an application to the app repository
 */
export interface AppRepoPublishRequest {
    /** Required: Scope name of the application to publish */
    scope: string;
    
    /** Required: Sys ID of the application to publish */
    sys_id: string;
    
    /** Optional: Version number for the published application */
    version?: string;
    
    /** Optional: Developer notes for this version */
    dev_notes?: string;
}

/**
 * Response from app repo install operation
 */
export interface AppRepoInstallResponse {
    /** Links to related resources */
    links: {
        progress: {
            id: string;
            url: string;
        };
    };
    
    /** Status code of the operation */
    status: string;
    
    /** Human-readable status label */
    status_label: string;
    
    /** Additional status message */
    status_message: string;
    
    /** Detailed status information */
    status_detail: string;
    
    /** Error message if operation failed */
    error: string;
    
    /** Percentage of completion (0-100) */
    percent_complete: number;
}

/**
 * Response from app repo publish operation
 */
export interface AppRepoPublishResponse {
    /** Links to related resources */
    links: {
        progress: {
            id: string;
            url: string;
        };
    };
    
    /** Status code of the operation */
    status: string;
    
    /** Human-readable status label */
    status_label: string;
    
    /** Additional status message */
    status_message: string;
    
    /** Detailed status information */
    status_detail: string;
    
    /** Error message if operation failed */
    error: string;
    
    /** Percentage of completion (0-100) */
    percent_complete: number;
}

/**
 * Final result of an app repo operation after completion
 */
export interface AppRepoOperationResult {
    /** Whether the operation completed successfully */
    success: boolean;
    
    /** Status code */
    status: string;
    
    /** Status label */
    status_label: string;
    
    /** Status message */
    status_message: string;
    
    /** Detailed status */
    status_detail: string;
    
    /** Error message if any */
    error: string;
    
    /** Final completion percentage */
    percent_complete: number;
    
    /** Links to related resources */
    links: {
        progress: {
            id: string;
            url: string;
        };
        results?: {
            id: string;
            url: string;
        };
    };
}

