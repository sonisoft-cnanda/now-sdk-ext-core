import { APP_TAB_CONTEXT } from './ApplicationManager';
import { ApplicationDetailModel } from './ApplicationDetailModel';

// ============================================================
// Search / List Applications
// ============================================================

/**
 * Options for searching/listing store applications.
 */
export interface StoreAppSearchOptions {
    /** Required: Tab context filter */
    tabContext: APP_TAB_CONTEXT;

    /** Optional: Search keyword to filter applications */
    searchKey?: string;

    /** Optional: Maximum number of results (default: 10,000) */
    limit?: number;

    /** Optional: Pagination offset (default: 0) */
    offset?: number;

    /** Optional: Request body for POST /apps endpoint (for advanced filtering) */
    requestBody?: Record<string, unknown>;
}

/**
 * Response wrapper from POST /api/sn_appclient/appmanager/apps
 */
export interface StoreAppSearchResponse {
    result: StoreAppSearchResult;
}

/**
 * The result payload inside the search response.
 */
export interface StoreAppSearchResult {
    apps: ApplicationDetailModel[];
    total?: number;
}

// ============================================================
// Install / Update Application
// ============================================================

/**
 * Options for installing a store application.
 */
export interface StoreAppInstallOptions {
    /** Required: The app_id (source app id) of the application */
    appId: string;

    /** Required: The version to install */
    version: string;

    /** Optional: Customization version to apply */
    customizationVersion?: string;

    /** Optional: Whether to load demo data */
    loadDemoData?: boolean;
}

/**
 * Options for updating a store application.
 */
export interface StoreAppUpdateOptions {
    /** Required: The app_id (source app id) of the application */
    appId: string;

    /** Required: The version to update to */
    version: string;

    /** Optional: Customization version to apply */
    customizationVersion?: string;

    /** Optional: Whether to load demo data */
    loadDemoData?: boolean;
}

/**
 * Response from store app install or update.
 */
export interface StoreAppOperationResponse {
    result: StoreAppOperationResult;
}

/**
 * Result of initiating an install or update operation.
 */
export interface StoreAppOperationResult {
    /** Tracker ID for monitoring progress (snake_case variant) */
    tracker_id?: string;

    /** Tracker ID for monitoring progress (camelCase variant) */
    trackerId?: string;

    /** Status of the initiated operation */
    status?: string;

    /** Any message from the server */
    message?: string;

    /** Links (may include progress link) */
    links?: {
        progress?: {
            id: string;
            url: string;
        };
    };
}

/**
 * Final result after an install/update operation completes.
 */
export interface StoreAppFinalResult {
    /** Whether the operation completed successfully */
    success: boolean;

    /** Final status */
    status: string;

    /** Status label */
    status_label: string;

    /** Status message */
    status_message: string;

    /** Error message if any */
    error?: string;

    /** Completion percentage */
    percent_complete: number;
}

// ============================================================
// Repair Application
// ============================================================

/**
 * Options for repairing an installed store or company application: reinstalling the
 * installed version from its repository without uninstalling it, as the platform's
 * Repair Application link on sys_store_app does.
 */
export interface StoreAppRepairOptions {
    /** The installed application's sys_store_app sys_id, or its scope (e.g. "x_acme_app"). */
    app: string;

    /** Load the application's demo data as well. Refused for an app that has none. */
    loadDemoData?: boolean;
}

/** The installed application a repair reinstalls. */
export interface StoreAppRepairTarget {
    /** sys_store_app sys_id, which the App Client takes as app_id. */
    sysId: string;
    name: string;
    scope: string;
    /** The installed version: a repair reinstalls this version, never another. */
    version: string;
    /** The customization version reapplied with it, when the app has one. */
    customizationVersion?: string;
    /** Whether the application ships demo data. */
    hasDemoData: boolean;
}

/**
 * Which App Client endpoint started the repair.
 * - `repair`: GET appmanager/app/repair, used when queued installation is on (the default).
 * - `install`: GET appmanager/app/install with isReinstall=true. With queued installation
 *   off, the repair endpoint passes its reinstall flag on as a boolean where a string is
 *   compared, and the repair silently becomes "no upgrade necessary"; this path does not.
 */
export type StoreAppRepairEndpoint = 'repair' | 'install';

/** A repair that has been started: pass it to waitForStoreApplicationRepair. */
export interface StoreAppRepairStart {
    app: StoreAppRepairTarget;
    trackerId: string;
    endpoint: StoreAppRepairEndpoint;
    /** The app's sys_upgrade_history rows from the newest second before the repair, to tell the repair's own row apart. */
    previousHistoryIds: string[];
    /** sys_created_on of the newest of those rows; absent when the app had no history. */
    previousHistoryCreated?: string;
    /** The App Client's response. */
    operation: StoreAppOperationResult;
}

/** Counts from the repair's sys_upgrade_history row. */
export interface StoreAppRepairCounts {
    added: number;
    updated: number;
    deleted: number;
    unchanged: number;
    skipped: number;
    skippedError: number;
    skippedManualMerge: number;
    skippedApplyOnce: number;
}

/** A file the repair did not apply, from sys_upgrade_history_log. Payloads are never read. */
export interface StoreAppRepairSkippedFile {
    fileName: string;
    type: string;
    targetName: string;
    disposition: string;
    dispositionLabel: string;
    reason?: string;
}

/** The upgrade history the repair wrote. */
export interface StoreAppRepairHistory {
    sysId: string;
    started?: string;
    finished?: string;
    status?: string;
    counts: StoreAppRepairCounts;
    /** Skipped and failed files, at most STORE_APP_REPAIR_SKIPPED_LIMIT of them. */
    skippedFiles: StoreAppRepairSkippedFile[];
    /** True when there were more skipped files than skippedFiles holds. */
    skippedFilesTruncated: boolean;
}

/** A finished (or timed-out) repair. */
export interface StoreAppRepairResult extends StoreAppFinalResult {
    app: StoreAppRepairTarget;
    trackerId: string;
    endpoint: StoreAppRepairEndpoint;
    /** The sys_upgrade_history row this repair wrote; absent when it wrote none. */
    history?: StoreAppRepairHistory;
    /**
     * True only when the App Client reported success AND a new upgrade history row was
     * written and finished. The App Client reports success for "no upgrade necessary" too,
     * so success alone does not show that anything was reinstalled.
     */
    repaired: boolean;
    warnings: string[];
}

/** Why a repair was refused or could not start. */
export type StoreAppRepairErrorCode =
    | 'invalid_app'
    | 'app_not_found'
    | 'not_a_store_app'
    | 'app_inactive'
    | 'contains_plugins'
    | 'no_demo_data'
    | 'start_failed';

/** Most skipped files a repair result lists. */
export const STORE_APP_REPAIR_SKIPPED_LIMIT = 50;
