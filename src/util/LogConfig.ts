/**
 * Where logging goes, and whether it happens at all.
 *
 * The bug this exists for (NEX-3): `Logger` built four Winston File transports at
 * hard-coded RELATIVE paths, with no console transport and no injectable destination.
 * Winston's File transport mkdirs in its own constructor, so merely constructing a
 * Logger created `./logs/` — in whatever directory the process happened to start in.
 * For a published library that is the consumer's project directory; for the MCP server
 * it is whatever cwd its client chose. There was no way to turn it off.
 *
 * Configuration is process-global rather than constructor-injected because there are
 * ~43 field initializers of the form `private _logger = new Logger("FlowManager")`,
 * none of which receive arguments. Threading options through them would mean changing
 * every manager constructor. The consuming application configures once at boot; the
 * library reads its own environment so that a Logger used BEFORE that call still
 * behaves — which makes boot order an optimization rather than a correctness
 * requirement, and is what lets this work under Jest.
 */

import * as winston from "winston";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { redactValue, isSecretKey, redactMessage, REDACTED } from "./redact";

const { combine, timestamp, json, metadata, printf } = winston.format;

/** Directory name used under whichever per-user state root applies. */
const APP_DIR = "now-sdk-ext";

/** Winston's npm levels, which are the only levels the transports understand. */
const VALID_LEVELS = Object.keys(winston.config.npm.levels);

/**
 * `trace` is not a winston level, but the CLI has always offered it. Left unmapped it
 * does not merely fail validation: a transport with no explicit level compares against
 * an undefined threshold and drops EVERY record, while level-pinned transports keep
 * working. Partial and invisible, which is worse than rejecting it.
 */
const LEVEL_ALIASES: Readonly<Record<string, string>> = {
    trace: "silly",
    verbose: "verbose",
    warning: "warn",
    err: "error",
};

export interface LogOptions {
    /** Write log files. Off by default. */
    file?: boolean;
    /** Directory for log files. Implies `file` when set. */
    dir?: string;
    /** Threshold for what is recorded at all. */
    level?: string;
    /** Emit to stderr. On by default — stdout is reserved for `--json` and JSON-RPC. */
    console?: boolean;
    /** Threshold for stderr specifically. Defaults to `warn`. */
    consoleLevel?: string;
    /** Rotate after this many bytes. */
    maxSizeBytes?: number;
    /** Keep this many rotated files. */
    maxFiles?: number;
}

export interface ResolvedLogConfig {
    readonly file: boolean;
    readonly dir: string;
    readonly level: string;
    readonly console: boolean;
    readonly consoleLevel: string;
    readonly maxSizeBytes: number;
    readonly maxFiles: number;
}

let explicit: LogOptions = {};
let resolved: ResolvedLogConfig | undefined;
let root: winston.Logger | undefined;
let epochCounter = 0;
const warnedOnce = new Set<string>();

/** Resolves when `event` fires, and never rejects. */
function once(emitter: { once(event: string, cb: () => void): unknown }, event: string): Promise<void> {
    return new Promise<void>((resolveOnce) => emitter.once(event, () => resolveOnce()));
}

function delay(ms: number): Promise<void> {
    return new Promise<void>((resolveDelay) => {
        const timer = setTimeout(resolveDelay, ms);
        // Must not hold the process open just because a flush is pending.
        timer.unref?.();
    });
}

/**
 * Yields until the logger stream has no records left queued, bounded.
 *
 * A single `setImmediate` moves exactly one record through the Transform, so a burst
 * logged in one tick needs one turn each.
 */
async function settle(turns: number): Promise<void> {
    for (let i = 0; i < turns; i++) {
        await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    }
}

/** True while a File transport still has bytes it has not handed to the OS. */
function fileTransportBusy(transport: unknown): boolean {
    const t = transport as { _opening?: boolean; _drain?: boolean; _pendingSize?: number };
    return Boolean(t._opening) || Boolean(t._drain) || (t._pendingSize ?? 0) > 0;
}

/** Complains to stderr at most once per distinct problem. */
function warnOnce(key: string, message: string): void {
    if (warnedOnce.has(key)) {
        return;
    }
    warnedOnce.add(key);
    process.stderr.write(`[now-sdk-ext] ${message}\n`);
}

/** Matches sn-credstore's `envFlag` exactly, so the two packages agree on truthiness. */
function envFlag(name: string): boolean | undefined {
    const value = process.env[name];
    if (value === undefined) {
        return undefined;
    }
    return value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function normalizeLevel(level: string | undefined, source: string): string | undefined {
    if (!level) {
        return undefined;
    }
    const lowered = level.trim().toLowerCase();
    const mapped = LEVEL_ALIASES[lowered] ?? lowered;
    if (!VALID_LEVELS.includes(mapped)) {
        warnOnce(`level:${mapped}`, `ignoring unknown log level "${level}" from ${source}`);
        return undefined;
    }
    return mapped;
}

/**
 * The user's home directory, or undefined if there isn't a usable one.
 *
 * Reads the environment before falling back to `os.homedir()`, which is what homedir()
 * itself does on both POSIX and Windows — so this is the same answer, reachable from a
 * test. A daemon with no HOME gets "/" back, and `join("/", ".local", …)` is an EACCES
 * waiting to happen on the first write.
 */
function resolveHome(): string | undefined {
    let raw: string | undefined;
    try {
        raw = (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) ?? homedir();
    } catch {
        return undefined;
    }
    const trimmed = raw?.trim();
    if (!trimmed || trimmed === "/" || trimmed === ".") {
        return undefined;
    }
    return trimmed;
}

/**
 * Per-user state directory for logs.
 *
 * XDG_STATE_HOME is honoured on every platform, not just Linux. That is deliberate: it
 * makes the whole thing testable with one environment variable and no mocking, and it
 * matches how sn-credstore resolves its own state.
 */
export function defaultLogDir(): string {
    const xdg = process.env.XDG_STATE_HOME?.trim();
    if (xdg) {
        return join(xdg, APP_DIR, "logs");
    }

    const home = resolveHome();
    if (!home) {
        return join(tmpdir(), APP_DIR, "logs");
    }
    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
        return join(localAppData, APP_DIR, "Logs");
    }
    if (process.platform === "darwin") {
        return join(home, "Library", "Logs", APP_DIR);
    }
    return join(home, ".local", "state", APP_DIR, "logs");
}

function resolve(): ResolvedLogConfig {
    if (resolved) {
        return resolved;
    }

    const envDir = process.env.NEX_LOG_DIR?.trim() || undefined;
    const envFile = envFlag("NEX_LOG_FILE");
    const envLevel = normalizeLevel(process.env.NEX_LOG_LEVEL, "NEX_LOG_LEVEL");

    const dir = explicit.dir ?? envDir ?? defaultLogDir();

    // A directory alone implies enable. Without that, `--log-dir ./logs` produces
    // nothing and looks like a bug in the flag rather than a missing second flag.
    const impliedByDir = explicit.dir !== undefined || envDir !== undefined;
    const file = explicit.file ?? envFile ?? (impliedByDir ? true : false);

    const level = normalizeLevel(explicit.level, "configureLogging") ?? envLevel ?? "info";
    const consoleLevel =
        normalizeLevel(explicit.consoleLevel, "configureLogging") ?? "warn";

    resolved = Object.freeze({
        file,
        dir,
        level,
        console: explicit.console ?? true,
        consoleLevel,
        maxSizeBytes: explicit.maxSizeBytes ?? 10 * 1024 * 1024,
        maxFiles: explicit.maxFiles ?? 5,
    });
    return resolved;
}

/**
 * Strips credential material from every record.
 *
 * Applied as a format rather than fixed at each call site on purpose. There are ~40
 * logging calls across src/, several of which pass whole request configs and session
 * objects, and the set grows. Auditing call sites catches today's leaks and none of
 * tomorrow's; a format in the pipeline catches both.
 *
 * The specific leak that motivated it: RequestHandler built `{auth: this._session}` and
 * logged it at debug on every single request, writing live cookies and tokens to disk.
 */
const redactSecrets = winston.format((info) => {
    if (typeof info.message === "string") {
        info.message = redactMessage(info.message);
    }
    for (const key of Object.keys(info)) {
        if (key === "level" || key === "message" || key === "timestamp" || key === "label") {
            continue;
        }
        if (isSecretKey(key)) {
            (info as Record<string, unknown>)[key] = REDACTED;
            continue;
        }
        (info as Record<string, unknown>)[key] = redactValue(
            (info as Record<string, unknown>)[key],
        );
    }
    return info;
});

/** Human-shaped single line for stderr. */
const consoleLine = printf((info) => {
    const meta = info.metadata as Record<string, unknown> | undefined;
    const label = typeof info.label === "string" ? info.label : "-";
    let tail = "";
    if (meta && Object.keys(meta).length > 0) {
        try {
            tail = ` ${JSON.stringify(meta)}`;
        } catch {
            tail = " [unserializable]";
        }
    }
    // Both are `unknown` on the info object; stringify defensively rather than trusting
    // a shape, because a caller can log anything.
    const stamp = typeof info.timestamp === "string" ? info.timestamp : "";
    const text = typeof info.message === "string" ? info.message : JSON.stringify(info.message);
    return `${stamp} [${label}] ${info.level}: ${text}${tail}`;
});

function buildFileTransport(cfg: ResolvedLogConfig): winston.transport | undefined {
    try {
        return new winston.transports.File({
            filename: join(cfg.dir, "nex.log"),
            maxsize: cfg.maxSizeBytes,
            maxFiles: cfg.maxFiles,
            // Keep the newest data in nex.log, which is what `tail -f` users expect.
            tailable: true,
            format: combine(timestamp(), json()),
        });
    } catch (e) {
        // mkdirSync runs inside the File transport constructor and precedes its own
        // `lazy` handling, so EACCES/EROFS/ENOSPC lands here. Degrade to console rather
        // than throwing out of whatever business call happened to log first.
        const reason = e instanceof Error ? e.message : String(e);
        warnOnce("filetransport", `file logging disabled: ${reason}`);
        return undefined;
    }
}

/**
 * The one winston logger for the process.
 *
 * Shared rather than per-`Logger` because rotation requires it: each File transport
 * tracks its own size and rotates independently, so N transports on one path interleave
 * renames and lose lines. It also fixes an fd leak — `ServiceNowRequest` is constructed
 * per HTTP call, and each one used to open four more append streams that were never
 * closed. That is where the 120 MB came from.
 */
export function getRootLogger(): winston.Logger {
    if (root) {
        return root;
    }
    const cfg = resolve();
    const transports: winston.transport[] = [];

    if (cfg.file) {
        const fileTransport = buildFileTransport(cfg);
        if (fileTransport) {
            transports.push(fileTransport);
        }
    }

    // Stream, not Console. transports.Console routes by a stderrLevels MAP and falls
    // through to stdout for any level absent from it, so it is a denylist by omission —
    // one added level and MCP's JSON-RPC framing on fd 1 is corrupted. Stream writes
    // where it is told.
    transports.push(
        new winston.transports.Stream({
            stream: process.stderr,
            level: cfg.consoleLevel,
            silent: !cfg.console,
            format: consoleLine,
        }),
    );

    root = winston.createLogger({
        level: cfg.level,
        format: combine(
            // First in the chain: redact before anything reshapes, nests, or serializes
            // the entry, so no later format can capture a raw value.
            redactSecrets(),
            timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
            metadata({ fillExcept: ["message", "level", "timestamp", "label"] }),
        ),
        // Never an empty transport array: winston console.error's the RAW info object
        // when a logger has no transports, and it does so BEFORE the format chain runs,
        // so redaction never happens. "Off" is a silent transport.
        transports,
        exitOnError: false,
    });
    return root;
}

/** Bumped whenever configuration changes, so live `Logger` facades pick up the new root. */
export function logEpoch(): number {
    return epochCounter;
}

/**
 * Sets logging options for the process. Call once, early, from the application that
 * owns the entry point — not from a library.
 *
 * Unset fields keep whatever the environment or the defaults provide, so a consumer can
 * set only what it knows about.
 */
export function configureLogging(options: LogOptions = {}): void {
    explicit = { ...explicit, ...options };
    resolved = undefined;
    const previous = root;
    root = undefined;
    epochCounter++;
    if (previous) {
        // Close rather than drop, or every reconfigure leaks a file stream.
        try {
            previous.close();
        } catch {
            // Closing is best-effort; a failure here must not break configuration.
        }
    }
}

export function getLogConfig(): ResolvedLogConfig {
    return resolve();
}

/**
 * Waits for buffered records to reach disk.
 *
 * Winston's File transport buffers, and `process.exit()` drops whatever is pending. A
 * library cannot register `process.on('exit')` for this because that handler cannot be
 * async, so the application calls this before exiting.
 */
export async function flushLogs(): Promise<void> {
    if (!root) {
        return;
    }
    const current = root;

    // Let the pipeline settle first, and do not remove this. A winston Logger is a
    // Transform stream, and records written in the current tick have not reached the
    // transports yet — calling end() straight after a .info() truncates the pipeline and
    // those records are lost. The documented `logger.on('finish'); logger.end()` idiom
    // silently drops the very last lines without this, which are exactly the lines
    // anyone flushing before exit most wants. One turn moves roughly one record, so give
    // the pipeline several before looking at what the transports still owe.
    await settle(8);

    // A File transport opens its file asynchronously and buffers writes until it does.
    // When the transport was built lazily by the very call being flushed — the common
    // case for a short CLI command — ending here would discard that buffer, so wait for
    // the file to actually be open first.
    const fileTransports = current.transports.filter(
        (t) => t instanceof winston.transports.File,
    );
    // Then wait for what the transports still owe. `_pendingSize` is winston's own count
    // of bytes written but not yet acknowledged, `_opening` means writes are queued
    // behind the file open, `_drain` means the OS buffer is full (file.js:86-90,
    // 129-135, 213-220). Probing for `_stream` instead does not work — it is assigned
    // synchronously inside open(), so it is already set while writes are still queued.
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && fileTransports.some(fileTransportBusy)) {
        await delay(10);
    }
    await settle(2);

    // The logger's own `finish` is not enough. It fires when the logger stream ends,
    // which is before each File transport has drained to disk — so a flush that waits
    // only on the logger returns with the file still empty.
    const waiters: Promise<void>[] = [
        once(current, "finish"),
        ...fileTransports.map((t) => once(t, "finish")),
    ];

    current.end();
    // Bounded: a transport with nothing buffered may never emit, and a flush that can
    // hang is worse than one that returns early.
    await Promise.race([Promise.all(waiters), delay(2000)]);

    if (root === current) {
        root = undefined;
        // Bump the epoch as well, exactly as configureLogging and resetLoggingForTests
        // do. Dropping `root` alone is not enough: a Logger that already cached this
        // instance sees an unchanged epoch, keeps the reference, and its next call is a
        // write to an ended stream — which THROWS ("write after end"), losing the whole
        // call rather than just the line. flushLogs is public API meant to be callable
        // mid-process, not only on the way out.
        epochCounter++;
    }
}

/** Drops all configuration and the built logger. Test seam. */
export function resetLoggingForTests(): void {
    explicit = {};
    resolved = undefined;
    const previous = root;
    root = undefined;
    epochCounter++;
    warnedOnce.clear();
    if (previous) {
        try {
            previous.close();
        } catch {
            // best effort
        }
    }
}
