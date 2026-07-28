export type ScriptTracerState = 'idle' | 'starting' | 'tracing' | 'stopping' | 'stopped' | 'error';

export interface ScriptTracerOptions {
    onTrace?: (statements: TraceStatement[]) => void;
    onConsole?: (message: DebuggerConsoleMessage) => void;
    onDebugMessage?: (message: DebuggerWatcherMessage) => void;
}

export interface TraceStatement {
    scriptField: string;
    fileName: string;
    fileTypeLabel: string;
    currentField: string;
    tableName: string;
    tableLabel: string;
    scriptKey: string;
    condition: string;
    linesContext: TraceLinesContext;
    diff: TraceFieldDiff[];
    state: Record<string, unknown>;
}

export interface TraceLinesContext {
    currentLineNumber: number;
    startLineNumber: number;
    content: string;
}

export interface TraceFieldDiff {
    previous: string | null;
    name: string;
    value: string;
}

export interface ScriptTracerAMBMessage {
    data: {
        sent_by: number;
        traceStatements: TraceStatement[];
    };
}

export interface DebuggerConsoleMessage {
    data: {
        sent_by: number;
        message: string;
        [key: string]: unknown;
    };
}

export interface DebuggerWatcherMessage {
    data: {
        sent_by: number;
        [key: string]: unknown;
    };
}

export interface DebuggerStartResponse {
    result: {
        token?: string;
        sessionId?: string;
        [key: string]: unknown;
    };
}

export interface ScriptTracerStartResponse {
    result: {
        [key: string]: unknown;
    };
}

export interface ScriptTracerResult {
    success: boolean;
    sessionId?: string;
    message?: string;
    error?: string;
}
