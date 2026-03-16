import { describe, it, expect } from '@jest/globals';
import {
    ScriptTracerAMBMessage,
    TraceStatement,
    TraceLinesContext,
    TraceFieldDiff,
    DebuggerConsoleMessage,
    DebuggerWatcherMessage,
    ScriptTracerResult,
    ScriptTracerState,
} from '../../../../src/sn/scripttracer/ScriptTracerModels';

describe('ScriptTracerModels', () => {
    describe('TraceStatement', () => {
        it('matches HAR data shape', () => {
            const statement: TraceStatement = {
                scriptField: 'script',
                fileName: 'user query',
                fileTypeLabel: 'Business Rule',
                currentField: 'condition',
                tableName: 'incident',
                tableLabel: 'Incident',
                scriptKey: 'sys_script.abc123.condition',
                condition: 'gs.getSession().isInteractive()',
                linesContext: {
                    currentLineNumber: 1,
                    startLineNumber: 1,
                    content: 'gs.log("hello")',
                },
                diff: [
                    { previous: null, name: 'Incident state', value: '1' },
                ],
                state: { field1: 'value1' },
            };

            expect(statement.scriptField).toBe('script');
            expect(statement.fileTypeLabel).toBe('Business Rule');
            expect(statement.linesContext.currentLineNumber).toBe(1);
            expect(statement.diff[0].previous).toBeNull();
            expect(statement.diff[0].name).toBe('Incident state');
        });
    });

    describe('ScriptTracerAMBMessage', () => {
        it('wraps traceStatements with sent_by', () => {
            const msg: ScriptTracerAMBMessage = {
                data: {
                    sent_by: 1845728124,
                    traceStatements: [{
                        scriptField: 'script',
                        fileName: 'test',
                        fileTypeLabel: 'Script Include',
                        currentField: 'script',
                        tableName: 'sys_script_include',
                        tableLabel: 'Script Include',
                        scriptKey: 'sys_script_include.xyz.script',
                        condition: '',
                        linesContext: { currentLineNumber: 5, startLineNumber: 1, content: 'var x = 1;' },
                        diff: [],
                        state: {},
                    }],
                },
            };

            expect(msg.data.sent_by).toBe(1845728124);
            expect(msg.data.traceStatements).toHaveLength(1);
            expect(msg.data.traceStatements[0].tableName).toBe('sys_script_include');
        });
    });

    describe('TraceLinesContext', () => {
        it('has required fields', () => {
            const ctx: TraceLinesContext = {
                currentLineNumber: 10,
                startLineNumber: 5,
                content: 'var result = [];',
            };
            expect(ctx.currentLineNumber).toBe(10);
            expect(ctx.startLineNumber).toBe(5);
            expect(ctx.content).toBe('var result = [];');
        });
    });

    describe('TraceFieldDiff', () => {
        it('tracks field changes with previous null for new', () => {
            const diff: TraceFieldDiff = { previous: null, name: 'state', value: '1' };
            expect(diff.previous).toBeNull();
        });

        it('tracks field changes with previous value', () => {
            const diff: TraceFieldDiff = { previous: '1', name: 'state', value: '2' };
            expect(diff.previous).toBe('1');
            expect(diff.value).toBe('2');
        });
    });

    describe('DebuggerConsoleMessage', () => {
        it('has data with message', () => {
            const msg: DebuggerConsoleMessage = {
                data: { sent_by: 123, message: 'test output' },
            };
            expect(msg.data.message).toBe('test output');
        });
    });

    describe('DebuggerWatcherMessage', () => {
        it('has data with sent_by', () => {
            const msg: DebuggerWatcherMessage = {
                data: { sent_by: 456, watchpoint: 'test' },
            };
            expect(msg.data.sent_by).toBe(456);
        });
    });

    describe('ScriptTracerResult', () => {
        it('represents success', () => {
            const result: ScriptTracerResult = {
                success: true,
                sessionId: 'ABCDEF1234567890ABCDEF1234567890',
            };
            expect(result.success).toBe(true);
            expect(result.sessionId).toHaveLength(32);
        });

        it('represents error', () => {
            const result: ScriptTracerResult = {
                success: false,
                error: 'Network failure',
            };
            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });
    });

    describe('ScriptTracerState', () => {
        it('accepts all valid state values', () => {
            const states: ScriptTracerState[] = ['idle', 'starting', 'tracing', 'stopping', 'stopped', 'error'];
            expect(states).toHaveLength(6);
            states.forEach(s => expect(typeof s).toBe('string'));
        });
    });
});
