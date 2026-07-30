/**
 * Progress reporting for long-running platform operations.
 *
 * App installs, app-repo publishes and ATF suite runs all poll a tracker for
 * minutes — up to a 30-minute default timeout — and until now reported nothing
 * until they finished. A caller could not distinguish "working" from "hung".
 *
 * This is a structured callback rather than the `(message: string) => void`
 * shape used by the older batch and update-set options. That is a deliberate
 * divergence: the tracker returns `percent_complete`, so these operations know
 * how far along they are, and flattening that into a string would throw away the
 * one thing that lets a consumer render real progress instead of a spinner. The
 * MCP server, for instance, can only send a determinate `progress`/`total`
 * notification if it receives a number.
 */

export interface OperationProgress {
    /** Human-readable description of the current state, suitable for display. */
    message: string;

    /**
     * Completion percentage, 0-100, where the platform reports one.
     * Absent rather than zero when genuinely unknown — a caller rendering a bar
     * needs to tell "no information" apart from "not started".
     */
    percentComplete?: number;

    /** Raw platform status code, for callers that need to branch on it. */
    status?: string;
}

export type OperationProgressCallback = (progress: OperationProgress) => void;

/**
 * Wraps a callback so it only fires when the reported state actually changes.
 *
 * The poll loops run every 5 seconds by default. Over a 30-minute install that
 * is 360 ticks, almost all of them identical — forwarding each one would bury
 * the handful of updates that mean something, and for the MCP server it would
 * mean 360 notifications for perhaps five state changes.
 *
 * Returns a no-op when no callback is supplied, so the loops can call it
 * unconditionally rather than guarding at every site.
 */
export function createProgressEmitter(
    onProgress?: OperationProgressCallback,
): OperationProgressCallback {
    if (!onProgress) {
        return () => { /* no callback supplied — nothing to report to */ };
    }

    let lastKey: string | undefined;
    return (progress: OperationProgress) => {
        const key = `${progress.percentComplete ?? ""}|${progress.status ?? ""}|${progress.message}`;
        if (key === lastKey) {
            return;
        }
        lastKey = key;

        // Best-effort. A consumer's reporting sink is not allowed to abort the
        // operation it is reporting on: a throwing callback would otherwise take
        // down a thirty-minute install that had already succeeded. Swallowed
        // rather than logged here, because this module has no logger and adding
        // one would make an error-reporting path able to fail on its own.
        try {
            onProgress(progress);
        } catch {
            /* progress reporting must never fail the operation */
        }
    };
}

/**
 * Shape of the tracker payloads returned by ProgressWorker and the ATF and
 * app-repo progress endpoints. Structural rather than imported, because the
 * three sources declare their own near-identical response types.
 */
export interface TrackerLikeProgress {
    percent_complete?: number;
    status?: string;
    status_label?: string;
    status_message?: string;
}

/**
 * Builds an OperationProgress from a tracker payload.
 *
 * Exists because the same message-fallback chain was repeated at six call sites
 * across three files, differing only in the fallback string — the kind of
 * duplication where one copy quietly drifts.
 *
 * `fallback` is only used when the platform reports no message at all. It is
 * phrased by the caller because "started" is wrong for a poll that has been
 * running for ten minutes.
 */
export function toOperationProgress(
    progress: TrackerLikeProgress,
    fallback: string,
): OperationProgress {
    return {
        message: progress.status_message || progress.status_label || fallback,
        percentComplete: progress.percent_complete,
        status: progress.status,
    };
}
