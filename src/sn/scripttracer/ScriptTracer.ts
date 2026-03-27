import { AMBClient } from "../amb/AMBClient";
import { ServiceNowInstance } from "../ServiceNowInstance";
import { SessionManager } from "../../comm/http/SessionManager";
import { ServiceNowRequest } from "../../comm/http/ServiceNowRequest";
import { HTTPRequest } from "../../comm/http/HTTPRequest";
import { Logger } from "../../util/Logger";
import {
    ScriptTracerState,
    ScriptTracerOptions,
    ScriptTracerResult,
    ScriptTracerAMBMessage,
    TraceStatement,
    DebuggerStartResponse,
    DebuggerConsoleMessage,
    DebuggerWatcherMessage,
} from "./ScriptTracerModels";

const DEBUGGER_START = "/api/now/js/debugger/start";
const SCRIPTTRACER_START = "/api/now/js/scripttracer/start";
const SCRIPTTRACER_STOP = "/api/now/js/scripttracer/stop";

export class ScriptTracer {

    private _state: ScriptTracerState = 'idle';
    private _sessionId: string | null = null;
    private _traceStatements: TraceStatement[] = [];
    private _ambClient: AMBClient;
    private _instance: ServiceNowInstance;
    private _options: ScriptTracerOptions;
    private _logger: Logger = new Logger("ScriptTracer");
    private _channelListeners: Array<{ channel: any; listener: any }> = [];

    public constructor(ambClient: AMBClient, instance: ServiceNowInstance, options?: ScriptTracerOptions) {
        this._ambClient = ambClient;
        this._instance = instance;
        this._options = options || {};
    }

    public get state(): ScriptTracerState {
        return this._state;
    }

    public get sessionId(): string | null {
        return this._sessionId;
    }

    public get traceStatements(): TraceStatement[] {
        return this._traceStatements;
    }

    public clearTraceStatements(): void {
        this._traceStatements = [];
    }

    public async start(): Promise<ScriptTracerResult> {
        if (this._state === 'tracing') {
            throw new Error("ScriptTracer is already tracing. Call stop() first.");
        }

        this._state = 'starting';
        this._logger.info("Starting script tracer...");

        try {
            const snRequest = SessionManager.getInstance().getRequest(this._instance);

            // Step 1: Start debugger
            const debuggerReq: HTTPRequest = {
                path: DEBUGGER_START,
                method: "post",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                query: null,
                body: null,
                json: { token: "" },
            };
            const debuggerResp = await snRequest.post<DebuggerStartResponse>(debuggerReq);
            this._logger.debug("Debugger started", debuggerResp.bodyObject);

            // Step 2: Extract session ID from debugger/start response token
            const debuggerToken = debuggerResp.bodyObject?.result?.token;
            if (debuggerToken) {
                this._sessionId = debuggerToken;
                this._logger.info(`Session ID from debugger/start: ${this._sessionId}`);
            } else {
                // Fallback: derive from user token (first 32 chars upper-cased)
                const userToken = this._ambClient.getServerConnection().getUserToken();
                this._sessionId = this.deriveSessionId(userToken);
                this._logger.warn(`No token in debugger/start response, derived from user token: ${this._sessionId}`);
            }

            // Guard: session ID must be non-empty before subscribing
            if (!this._sessionId) {
                this._state = 'error';
                throw new Error("Failed to obtain a session ID from debugger/start or user token — cannot subscribe to trace channels");
            }

            // Step 3: Start script tracer
            const tracerReq: HTTPRequest = {
                path: SCRIPTTRACER_START,
                method: "post",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                query: null,
                body: null,
                json: {},
            };
            await snRequest.post(tracerReq);
            this._logger.debug("Script tracer started");

            // Step 4: Subscribe to AMB channels
            this.subscribeToChannels();

            this._state = 'tracing';
            return { success: true, sessionId: this._sessionId };

        } catch (error) {
            this._state = 'error';
            const err = error as Error;
            this._logger.error(`Failed to start script tracer: ${err.message}`);
            throw err;
        }
    }

    public async stop(): Promise<ScriptTracerResult> {
        if (this._state !== 'tracing') {
            throw new Error("ScriptTracer is not currently tracing. Call start() first.");
        }

        this._state = 'stopping';
        this._logger.info("Stopping script tracer...");

        try {
            const snRequest = SessionManager.getInstance().getRequest(this._instance);

            const stopReq: HTTPRequest = {
                path: SCRIPTTRACER_STOP,
                method: "post",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                query: null,
                body: null,
                json: {},
            };
            await snRequest.post(stopReq);

            this.unsubscribeFromChannels();

            this._state = 'stopped';
            this._logger.info("Script tracer stopped");
            return { success: true, sessionId: this._sessionId ?? undefined };

        } catch (error) {
            this._state = 'error';
            const err = error as Error;
            this._logger.error(`Failed to stop script tracer: ${err.message}`);
            throw err;
        }
    }

    private deriveSessionId(userToken: string): string {
        return userToken.substring(0, 32).toUpperCase();
    }

    private subscribeToChannels(): void {
        const sid = this._sessionId;
        const channels = [
            `/scripttracer/${sid}`,
            `/debugger/watcher/console/${sid}`,
            `/debugger/watcher/${sid}`,
            `/debugger/sessionlog/${sid}`,
        ];

        for (const channelName of channels) {
            const channel = this._ambClient.getChannel(channelName, {});
            const listener = (message: any) => this.handleMessage(channelName, message);
            channel.subscribe(listener);
            this._channelListeners.push({ channel, listener });
            this._logger.debug(`Subscribed to ${channelName}`);
        }
    }

    private unsubscribeFromChannels(): void {
        for (const { channel, listener } of this._channelListeners) {
            channel.unsubscribe(listener);
        }
        this._channelListeners = [];
        this._logger.debug("Unsubscribed from all channels");
    }

    private handleMessage(channelName: string, message: any): void {
        if (channelName.startsWith('/scripttracer/')) {
            this.handleTraceMessage(message as ScriptTracerAMBMessage);
        } else if (channelName.includes('/watcher/console/')) {
            this.handleConsoleMessage(message as DebuggerConsoleMessage);
        } else if (channelName.includes('/watcher/')) {
            this.handleDebugMessage(message as DebuggerWatcherMessage);
        }
    }

    private handleTraceMessage(message: ScriptTracerAMBMessage): void {
        if (message?.data?.traceStatements) {
            this._traceStatements.push(...message.data.traceStatements);
            this._options.onTrace?.(message.data.traceStatements);
            this._logger.debug(`Received ${message.data.traceStatements.length} trace statements`);
        }
    }

    private handleConsoleMessage(message: DebuggerConsoleMessage): void {
        this._options.onConsole?.(message);
        this._logger.debug("Received console message");
    }

    private handleDebugMessage(message: DebuggerWatcherMessage): void {
        this._options.onDebugMessage?.(message);
        this._logger.debug("Received debug watcher message");
    }
}
