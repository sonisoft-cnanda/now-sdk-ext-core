import type { StoreAppRepairErrorCode } from './StoreApplicationModels';

/** Values a StoreAppRepairError may carry: ids and scopes are checked, server text is bounded. */
export interface StoreAppRepairErrorDetail {
    app?: string;
    scope?: string;
    status?: number;
    serverMessage?: string;
}

const MESSAGES: Record<StoreAppRepairErrorCode, string> = {
    invalid_app: 'Give the installed application as its sys_store_app sys_id or its scope.',
    app_not_found: 'No installed store or company application matches.',
    not_a_store_app: 'The application was developed on this instance (sys_app), so there is no repository copy to repair it from.',
    app_inactive: 'The application is not active. The platform offers Repair only for an active application.',
    contains_plugins: 'The application contains plugins. Repair it from its sys_store_app record in the UI, which sends the plugin list.',
    no_demo_data: 'The application has no demo data to load.',
    start_failed: 'The App Client did not start the repair.',
};

const SYS_ID = /^[a-f0-9]{32}$/;
const SCOPE = /^[a-z0-9_]{1,40}$/i;

/** A repair that was refused before it started, or that the App Client would not start. */
export class StoreAppRepairError extends Error {
    public readonly detail?: StoreAppRepairErrorDetail;

    public constructor(public readonly code: StoreAppRepairErrorCode, detail?: StoreAppRepairErrorDetail, cause?: unknown) {
        super(`Store application repair refused (${code}): ${MESSAGES[code]}`, cause === undefined ? undefined : { cause });
        this.name = 'StoreAppRepairError';
        const safe: StoreAppRepairErrorDetail = {};
        if (detail?.app && (SYS_ID.test(detail.app) || SCOPE.test(detail.app))) safe.app = detail.app;
        if (detail?.scope && SCOPE.test(detail.scope)) safe.scope = detail.scope;
        if (detail?.status !== undefined && Number.isInteger(detail.status)) safe.status = detail.status;
        if (detail?.serverMessage) safe.serverMessage = String(detail.serverMessage).slice(0, 300);
        this.detail = Object.keys(safe).length ? safe : undefined;
    }
}
