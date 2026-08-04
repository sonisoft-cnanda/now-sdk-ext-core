import * as winston from "winston";
import { getRootLogger, logEpoch } from "./LogConfig";

/**
 * A named handle onto the process-wide logger.
 *
 * This used to build its own winston logger with four File transports per instance. It
 * no longer builds anything: there are ~43 of these across the codebase, and
 * `ServiceNowRequest` is constructed per HTTP call, so each request was opening four
 * more never-closed append streams. That is where the 120 MB of logs came from, and it
 * also made rotation impossible — File transports track size independently, so several
 * on one path interleave renames and lose lines.
 *
 * Destination, level, and rotation now live in LogConfig and are set once by the
 * application. See `configureLogging`.
 */
export class Logger {
    _labelName: string;

    /** Set only by `setLogger`. Overrides the shared root for this instance. */
    private _override?: winston.Logger;

    private _cached?: winston.Logger;
    private _epochSeen = -1;

    /**
     * @param labelName Appears as `label` on every record from this instance.
     * @param level Ignored. Kept so existing call sites still compile.
     * @deprecated Pass the level to `configureLogging` instead — it applies process-wide.
     */
    public constructor(labelName: string, level?: string) {
        this._labelName = labelName;
        void level;
    }

    /** Replaces the underlying winston logger for this instance only. Test seam. */
    public setLogger(logger: winston.Logger): void {
        this._override = logger;
    }

    public getLabel(): string {
        return this._labelName;
    }

    /**
     * @deprecated The `level` argument the constructor accepts is ignored; use
     * `configureLogging({level})`.
     */
    public static createLogger(labelName: string): Logger {
        return new Logger(labelName);
    }

    /** Resolves the shared root, rebuilding the cached reference if config changed. */
    private root(): winston.Logger {
        if (this._override) {
            return this._override;
        }
        if (this._epochSeen !== logEpoch()) {
            this._cached = getRootLogger();
            this._epochSeen = logEpoch();
        }
        return this._cached;
    }

    /**
     * Attaches this instance's label to the record.
     *
     * The label used to be a winston format bound to a per-instance logger. With one
     * shared root it has to travel with the call. Callers pass all sorts of things as
     * `metadata`, so a non-object is nested rather than spread — spreading a string
     * would scatter it across numeric keys.
     */
    private meta(metadata?: unknown): Record<string, unknown> {
        if (metadata === undefined || metadata === null) {
            return { label: this._labelName };
        }
        if (typeof metadata === "object" && !Array.isArray(metadata)) {
            // Label last, deliberately. Metadata objects here are assembled ad hoc and
            // grow over time; a caller key named `label` would otherwise misattribute
            // the record to a component that never emitted it.
            return { ...(metadata as Record<string, unknown>), label: this._labelName };
        }
        return { label: this._labelName, meta: metadata };
    }

    public debug(message: string, metadata?: unknown): void {
        this.root().debug(message, this.meta(metadata));
    }

    public info(message: string, metadata?: unknown): void {
        this.root().info(message, this.meta(metadata));
    }

    public error(message: string, metadata?: unknown): void {
        this.root().error(message, this.meta(metadata));
    }

    public warn(message: string, metadata?: unknown): void {
        this.root().warn(message, this.meta(metadata));
    }

    public verbose(message: string, metadata?: unknown): void {
        this.root().verbose(message, this.meta(metadata));
    }

    public http(message: string, metadata?: unknown): void {
        this.root().http(message, this.meta(metadata));
    }

    public silly(message: string, metadata?: unknown): void {
        this.root().silly(message, this.meta(metadata));
    }

    public addInfoMessage(message: string, metadata?: unknown): void {
        this.info(message, metadata);
    }

    public addErrorMessage(message: string, metadata?: unknown): void {
        this.error(message, metadata);
    }

    public addWarnMessage(message: string, metadata?: unknown): void {
        this.warn(message, metadata);
    }

    public successful(message: string, metadata?: unknown): void {
        this.info(message, metadata);
    }
}
