import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { getCredentials } from "@servicenow/sdk-cli/dist/auth/index.js";
import { SN_INSTANCE_ALIAS } from '../../../test_utils/test_config';

import { SyslogReader } from '../../../../src/sn/syslog/SyslogReader';
import { SyslogRecord, SyslogAppScopeRecord } from '../../../../src/sn/syslog/SyslogRecord';

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('SyslogReader', () => {
    let instance: ServiceNowInstance;
    let credential: unknown;
    const SECONDS = 1000;

    beforeEach(async () => {
        credential = await getCredentials(SN_INSTANCE_ALIAS);
        
        if (credential) {
            const snSettings: ServiceNowSettingsInstance = {
                alias: SN_INSTANCE_ALIAS,
                credential: credential
            };
            instance = new ServiceNowInstance(snSettings);
        }
    });

    describe('querySyslog', () => {
        it('should query syslog table without encoded query', async () => {
            const syslogReader = new SyslogReader(instance);
            const logs: SyslogRecord[] = await syslogReader.querySyslog(undefined, 10);
            
            console.log(`\nRetrieved ${logs.length} syslog records`);
            
            expect(logs).toBeDefined();
            expect(Array.isArray(logs)).toBe(true);
            
            if (logs.length > 0) {
                const firstLog = logs[0];
                expect(firstLog.sys_id).toBeDefined();
                expect(firstLog.sys_created_on).toBeDefined();
                expect(firstLog.level).toBeDefined();
                expect(firstLog.message).toBeDefined();
                
                console.log('\nSample log record:');
                console.log(`  Level: ${firstLog.level}`);
                console.log(`  Created: ${firstLog.sys_created_on}`);
                console.log(`  Message: ${firstLog.message.substring(0, 100)}...`);
            }
        }, 60 * SECONDS);

        it('should query syslog with encoded query for errors only', async () => {
            const syslogReader = new SyslogReader(instance);
            const encodedQuery = 'levelSTARTSWITHerror^ORDERBYDESCsys_created_on';
            const logs: SyslogRecord[] = await syslogReader.querySyslog(encodedQuery, 10);
            
            console.log(`\nRetrieved ${logs.length} error logs`);
            
            expect(logs).toBeDefined();
            expect(Array.isArray(logs)).toBe(true);
            
            // All logs should be error level
            logs.forEach(log => {
                expect(log.level.toLowerCase()).toContain('error');
            });
        }, 60 * SECONDS);

        it('should query syslog with time-based encoded query', async () => {
            const syslogReader = new SyslogReader(instance);
            // Get logs from last hour
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const encodedQuery = `sys_created_on>${oneHourAgo}^ORDERBYDESCsys_created_on`;
            const logs: SyslogRecord[] = await syslogReader.querySyslog(encodedQuery, 20);
            
            console.log(`\nRetrieved ${logs.length} logs from last hour`);
            
            expect(logs).toBeDefined();
            expect(Array.isArray(logs)).toBe(true);
        }, 60 * SECONDS);
    });

    describe('querySyslogAppScope', () => {
        it('should query syslog_app_scope table', async () => {
            const syslogReader = new SyslogReader(instance);
            const logs: SyslogAppScopeRecord[] = await syslogReader.querySyslogAppScope(undefined, 10);
            
            console.log(`\nRetrieved ${logs.length} app scope log records`);
            
            expect(logs).toBeDefined();
            expect(Array.isArray(logs)).toBe(true);
            
            if (logs.length > 0) {
                const firstLog = logs[0];
                expect(firstLog.sys_id).toBeDefined();
                expect(firstLog.app_scope).toBeDefined();
                
                console.log('\nSample app scope log:');
                console.log(`  App Scope: ${firstLog.app_scope}`);
                console.log(`  Level: ${firstLog.level}`);
                console.log(`  Message: ${firstLog.message?.substring(0, 100)}...`);
            }
        }, 60 * SECONDS);

        it('should query app scope logs with encoded query for specific scope', async () => {
            const syslogReader = new SyslogReader(instance);
            const encodedQuery = 'app_scopeSTARTSWITHx_^ORDERBYDESCsys_created_on';
            const logs: SyslogAppScopeRecord[] = await syslogReader.querySyslogAppScope(encodedQuery, 10);
            
            console.log(`\nRetrieved ${logs.length} app scope logs for custom scopes`);
            
            expect(logs).toBeDefined();
            expect(Array.isArray(logs)).toBe(true);
            
            logs.forEach(log => {
                if (log.app_scope) {
                    expect(log.app_scope).toMatch(/^x_/);
                }
            });
        }, 60 * SECONDS);
    });

    describe('formatAsTable', () => {
        it('should format logs as ASCII table', async () => {
            const syslogReader = new SyslogReader(instance);
            const logs: SyslogRecord[] = await syslogReader.querySyslog(undefined, 5);
            
            if (logs.length > 0) {
                const tableOutput = syslogReader.formatAsTable(logs);
                
                console.log('\n=== Formatted Table Output ===');
                console.log(tableOutput);
                
                expect(tableOutput).toBeDefined();
                expect(typeof tableOutput).toBe('string');
                expect(tableOutput.length).toBeGreaterThan(0);
                expect(tableOutput).toContain('┌');
                expect(tableOutput).toContain('└');
            }
        }, 60 * SECONDS);

        it('should format with custom fields', async () => {
            const syslogReader = new SyslogReader(instance);
            const logs: SyslogRecord[] = await syslogReader.querySyslog(undefined, 5);
            
            if (logs.length > 0) {
                const tableOutput = syslogReader.formatAsTable(logs, {
                    fields: ['sys_created_on', 'level', 'message'],
                    maxMessageWidth: 60,
                    dateFormat: 'relative'
                });
                
                console.log('\n=== Custom Format Table ===');
                console.log(tableOutput);
                
                expect(tableOutput).toBeDefined();
            }
        }, 60 * SECONDS);
    });

    describe('printTable', () => {
        it('should print logs to console', async () => {
            const syslogReader = new SyslogReader(instance);
            const logs: SyslogRecord[] = await syslogReader.querySyslog(undefined, 3);
            
            if (logs.length > 0) {
                console.log('\n=== Print Table Test ===');
                syslogReader.printTable(logs, {
                    fields: ['sys_created_on', 'level', 'source', 'message'],
                    maxMessageWidth: 70
                });
                
                expect(logs.length).toBeGreaterThan(0);
            }
        }, 60 * SECONDS);
    });

    describe('saveToFile', () => {
        const outputDir = path.join(__dirname, '../../../tmp/syslog');
        
        beforeEach(() => {
            // Clean up test output directory
            if (fs.existsSync(outputDir)) {
                fs.rmSync(outputDir, { recursive: true });
            }
        });

        it('should save logs as JSON', async () => {
            const syslogReader = new SyslogReader(instance);
            const logs: SyslogRecord[] = await syslogReader.querySyslog(undefined, 5);
            
            if (logs.length > 0) {
                const filePath = path.join(outputDir, 'logs.json');
                await syslogReader.saveToFile(logs, filePath, 'json');
                
                expect(fs.existsSync(filePath)).toBe(true);
                const content = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(content);
                
                expect(Array.isArray(parsed)).toBe(true);
                expect(parsed.length).toBe(logs.length);
                
                console.log(`\nSaved ${logs.length} logs to ${filePath}`);
            }
        }, 60 * SECONDS);

        it('should save logs as CSV', async () => {
            const syslogReader = new SyslogReader(instance);
            const logs: SyslogRecord[] = await syslogReader.querySyslog(undefined, 5);
            
            if (logs.length > 0) {
                const filePath = path.join(outputDir, 'logs.csv');
                await syslogReader.saveToFile(logs, filePath, 'csv');
                
                expect(fs.existsSync(filePath)).toBe(true);
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n');
                
                expect(lines.length).toBeGreaterThan(1); // Header + data rows
                
                console.log(`\nSaved ${logs.length} logs as CSV to ${filePath}`);
            }
        }, 60 * SECONDS);

        it('should save logs as formatted table', async () => {
            const syslogReader = new SyslogReader(instance);
            const logs: SyslogRecord[] = await syslogReader.querySyslog(undefined, 5);
            
            if (logs.length > 0) {
                const filePath = path.join(outputDir, 'logs.txt');
                await syslogReader.saveToFile(logs, filePath, 'table');
                
                expect(fs.existsSync(filePath)).toBe(true);
                const content = fs.readFileSync(filePath, 'utf8');
                
                expect(content).toContain('┌');
                expect(content).toContain('└');
                
                console.log(`\nSaved ${logs.length} logs as table to ${filePath}`);
            }
        }, 60 * SECONDS);

        it('should append to existing file', async () => {
            const syslogReader = new SyslogReader(instance);
            const logs: SyslogRecord[] = await syslogReader.querySyslog(undefined, 3);
            
            if (logs.length > 0) {
                const filePath = path.join(outputDir, 'append-test.json');
                
                // First write
                await syslogReader.saveToFile([logs[0]], filePath, 'json', false);
                const size1 = fs.statSync(filePath).size;
                
                // Append
                await syslogReader.saveToFile([logs[1]], filePath, 'json', true);
                const size2 = fs.statSync(filePath).size;
                
                expect(size2).toBeGreaterThan(size1);
                
                console.log('\nAppend test: File size grew from', size1, 'to', size2);
            }
        }, 60 * SECONDS);
    });

    describe('encoded query examples', () => {
        it('should demonstrate various encoded query patterns', async () => {
            const syslogReader = new SyslogReader(instance);
            
            console.log('\n=== Encoded Query Examples ===\n');
            
            // Example 1: Filter by level
            console.log('1. Errors only:');
            console.log('   Query: level=error');
            const errors = await syslogReader.querySyslog('level=error', 3);
            console.log(`   Found: ${errors.length} records\n`);
            
            // Example 2: Multiple conditions
            console.log('2. Errors OR warnings:');
            console.log('   Query: level=error^ORlevel=warn');
            const errorsOrWarns = await syslogReader.querySyslog('level=error^ORlevel=warn', 3);
            console.log(`   Found: ${errorsOrWarns.length} records\n`);
            
            // Example 3: Time-based query
            console.log('3. Recent logs (last 10 minutes):');
            const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '');
            console.log(`   Query: sys_created_on>${tenMinsAgo}`);
            const recent = await syslogReader.querySyslog(`sys_created_on>${tenMinsAgo}`, 3);
            console.log(`   Found: ${recent.length} records\n`);
            
            // Example 4: Source filter
            console.log('4. Specific source:');
            console.log('   Query: sourceSTARTSWITHsecurity');
            const securityLogs = await syslogReader.querySyslog('sourceSTARTSWITHsecurity', 3);
            console.log(`   Found: ${securityLogs.length} records\n`);
            
            expect(true).toBe(true); // Just to satisfy Jest
        }, 120 * SECONDS);
    });

    // ChannelAjax tail test - skipped by default as it runs indefinitely
    describe.skip('startTailingWithChannelAjax', () => {
        it('should tail logs using ChannelAjax processor', async () => {
            const syslogReader = new SyslogReader(instance);
            const outputFile = path.join(__dirname, '../../../tmp/syslog/channel-tail-output.txt');
            
            console.log('\n=== Starting ChannelAjax Tail Test (will run for 30 seconds) ===');
            
            const receivedLogs: SyslogRecord[] = [];
            
            await syslogReader.startTailingWithChannelAjax({
                interval: 1000, // Poll every second
                onLog: (log) => {
                    receivedLogs.push(log as SyslogRecord);
                    console.log(`\n[New Log] Seq:${log.sequence || 'N/A'} - ${log.message.substring(0, 80)}...`);
                },
                outputFile: outputFile,
                append: true
            });
            
            // Run for 30 seconds
            await new Promise(resolve => setTimeout(resolve, 30000));
            
            syslogReader.stopTailing();
            
            console.log(`\nReceived ${receivedLogs.length} new logs during tail`);
            expect(syslogReader.isTailing).toBe(false);
            
            // Verify logs have sequence numbers
            if (receivedLogs.length > 0) {
                const hasSequences = receivedLogs.some(log => log.sequence);
                expect(hasSequences).toBe(true);
            }
        }, 45 * SECONDS);
    });

    // Tail test - skipped by default as it runs indefinitely
    describe.skip('startTailing', () => {
        it('should tail syslog in real-time', async () => {
            const syslogReader = new SyslogReader(instance);
            const outputFile = path.join(__dirname, '../../../tmp/syslog/tail-output.txt');
            
            console.log('\n=== Starting Tail Test (will run for 30 seconds) ===');
            
            const receivedLogs: SyslogRecord[] = [];
            
            await syslogReader.startTailing('syslog', {
                interval: 3000, // Check every 3 seconds
                initialLimit: 5,
                query: 'ORDERBYDESCsys_created_on',
                onLog: (log) => {
                    receivedLogs.push(log as SyslogRecord);
                    console.log(`\n[New Log] ${log.level}: ${log.message.substring(0, 50)}...`);
                },
                formatOptions: {
                    fields: ['sys_created_on', 'level', 'source', 'message'],
                    maxMessageWidth: 60,
                    dateFormat: 'relative'
                },
                outputFile: outputFile,
                append: true
            });
            
            // Run for 30 seconds
            await new Promise(resolve => setTimeout(resolve, 30000));
            
            syslogReader.stopTailing();
            
            console.log(`\nReceived ${receivedLogs.length} new logs during tail`);
            expect(syslogReader.isTailing).toBe(false);
        }, 45 * SECONDS);
    });
});

