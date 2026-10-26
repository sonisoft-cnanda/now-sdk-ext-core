import type { FlowDebugErrorCode, FlowDebugErrorDetail } from './FlowDebugModels';

const ID = /^[a-f0-9]{32}$/i;
const NAME = /^[a-z0-9_.$-]{1,80}$/i;

function safeDetail(detail?: FlowDebugErrorDetail): FlowDebugErrorDetail | undefined {
    if (!detail) return undefined;
    const safe: FlowDebugErrorDetail = {};
    if (detail.contextId && ID.test(detail.contextId)) safe.contextId = detail.contextId;
    if (detail.state && /^[A-Z_]{1,40}$/.test(detail.state)) safe.state = detail.state;
    if (detail.status !== undefined && Number.isInteger(detail.status)) safe.status = detail.status;
    // The debugger's messages name context ids and states, never data; still bounded.
    if (detail.serverMessage) safe.serverMessage = String(detail.serverMessage).slice(0, 300);
    if (detail.inputs) safe.inputs = detail.inputs.filter(name => NAME.test(name)).slice(0, 50);
    if (detail.validSteps) safe.validSteps = detail.validSteps.filter(n => Number.isSafeInteger(n)).slice(0, 200);
    if (detail.cancelled !== undefined) safe.cancelled = detail.cancelled === true;
    return Object.keys(safe).length ? safe : undefined;
}

/** A flow debugger call that was refused or failed. Messages carry codes, never caller values. */
export class FlowDebugError extends Error {
    public readonly detail?: FlowDebugErrorDetail;

    /**
     * @param cause The error that led to this one, when it came from elsewhere: for a run that could
     *   not be set up after it started, the original failure (a session or policy error, say).
     */
    public constructor(public readonly code: FlowDebugErrorCode, detail?: FlowDebugErrorDetail, cause?: unknown) {
        super(`Flow debugger: ${code}`, cause === undefined ? undefined : { cause });
        this.name = 'FlowDebugError';
        this.detail = safeDetail(detail);
    }
}
