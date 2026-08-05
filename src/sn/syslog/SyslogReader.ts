import { ServiceNowInstance } from "../ServiceNowInstance";
import { Logger } from "../../util/Logger";
import { TableAPIRequest } from "../../comm/http/TableAPIRequest";
import { IHttpResponse } from "../../comm/http/IHttpResponse";
import { ServiceNowProcessorRequest } from "../../comm/http/ServiceNowProcessorRequest";
import { READ_ONLY } from "../../policy/PolicyTypes";
import { Parser } from 'xml2js';
import * as fs from 'fs';
import * as path from 'path';
import {
    SyslogRecord,
    SyslogAppScopeRecord,
    SyslogResponse,
    SyslogAppScopeResponse,
    SyslogFormatOptions,
    SyslogTailOptions,
    LogTailResponse,
    LogTailItem
} from './SyslogRecord';

/**
 * SyslogReader class for querying and tailing ServiceNow syslog tables
 * Supports encoded query strings, formatted table output, and file export
 */
export class SyslogReader {
    private readonly SYSLOG_TABLE = 'syslog';
    private readonly SYSLOG_APP_SCOPE_TABLE = 'syslog_app_scope';
    
    private _logger: Logger = new Logger("SyslogReader");
    private _tableAPI: TableAPIRequest;
    private _processorRequest: ServiceNowProcessorRequest;
    private _instance: ServiceNowInstance;
    private _tailInterval?: NodeJS.Timeout;
    private _lastFetchedSysId?: string;
    private _lastSequence?: string;
    private _isTailing: boolean = false;

    public constructor(instance: ServiceNowInstance) {
        this._instance = instance;
        this._tableAPI = new TableAPIRequest(instance);
        this._processorRequest = new ServiceNowProcessorRequest(instance);
    }

    /**
     * Query the syslog table with an encoded query string
     * @param encodedQuery ServiceNow encoded query string (e.g., "levelSTARTSWITHerror^ORDERBYDESCsys_created_on")
     * @param limit Maximum number of records to return (default: 100)
     * @returns Promise<SyslogRecord[]> Array of syslog records
     */
    public async querySyslog(encodedQuery?: string, limit: number = 100): Promise<SyslogRecord[]> {
        this._logger.info(`Querying syslog table with query: ${encodedQuery || 'none'}`);
        
        const query: Record<string, string | number> = {
            sysparm_limit: limit,
            sysparm_display_value: 'false'
        };
        
        if (encodedQuery) {
            query.sysparm_query = encodedQuery;
        }
        
        const response: IHttpResponse<SyslogResponse> = await this._tableAPI.get<SyslogResponse>(
            this.SYSLOG_TABLE,
            query
        );
        
        if (response.status === 200 && response.bodyObject?.result) {
            this._logger.info(`Retrieved ${response.bodyObject.result.length} syslog records`);
            return response.bodyObject.result;
        }
        
        throw new Error(`Failed to query syslog table. Status: ${response.status}`);
    }

    /**
     * Query the syslog_app_scope table with an encoded query string
     * @param encodedQuery ServiceNow encoded query string
     * @param limit Maximum number of records to return (default: 100)
     * @returns Promise<SyslogAppScopeRecord[]> Array of syslog_app_scope records
     */
    public async querySyslogAppScope(encodedQuery?: string, limit: number = 100): Promise<SyslogAppScopeRecord[]> {
        this._logger.info(`Querying syslog_app_scope table with query: ${encodedQuery || 'none'}`);
        
        const query: Record<string, string | number> = {
            sysparm_limit: limit,
            sysparm_display_value: 'false'
        };
        
        if (encodedQuery) {
            query.sysparm_query = encodedQuery;
        }
        
        const response: IHttpResponse<SyslogAppScopeResponse> = await this._tableAPI.get<SyslogAppScopeResponse>(
            this.SYSLOG_APP_SCOPE_TABLE,
            query
        );
        
        if (response.status === 200 && response.bodyObject?.result) {
            this._logger.info(`Retrieved ${response.bodyObject.result.length} syslog_app_scope records`);
            return response.bodyObject.result;
        }
        
        throw new Error(`Failed to query syslog_app_scope table. Status: ${response.status}`);
    }

    /**
     * Format syslog records as a table for console output
     * @param records Array of syslog records
     * @param options Formatting options
     * @returns string Formatted table as string
     */
    public formatAsTable(
        records: (SyslogRecord | SyslogAppScopeRecord)[],
        options: SyslogFormatOptions = {}
    ): string {
        const {
            fields = ['sys_created_on', 'level', 'source', 'message'],
            maxMessageWidth = 80,
            includeHeaders = true,
            dateFormat = 'locale'
        } = options;

        if (records.length === 0) {
            return 'No records found.';
        }

        // Determine if we have app_scope records
        const hasAppScope = 'app_scope' in records[0];
        const displayFields = hasAppScope && !fields.includes('app_scope') 
            ? [...fields.slice(0, 2), 'app_scope', ...fields.slice(2)] 
            : fields;

        // Define column widths
        const colWidths: Record<string, number> = {
            'sys_created_on': 25,
            'level': 10,
            'source': 30,
            'app_scope': 30,
            'message': maxMessageWidth,
            'sys_id': 36
        };

        // Build rows
        const rows: string[][] = [];
        
        if (includeHeaders) {
            rows.push(displayFields.map(f => f.toUpperCase()));
        }

        records.forEach(record => {
            const row = displayFields.map(field => {
                let value: string;
                if (field === 'sys_created_on') {
                    value = this.formatDate(record[field], dateFormat);
                } else if (field === 'level') {
                    value = this.colorizeLevel(record[field]);
                } else {
                    value = String(record[field] || '');
                }
                
                const width = colWidths[field] || 30;
                return this.truncateString(value, width);
            });
            rows.push(row);
        });

        // Format as table
        return this.buildAsciiTable(rows, displayFields.map(f => colWidths[f] || 30), includeHeaders);
    }

    /**
     * Build ASCII table from rows
     * @param rows Array of row data
     * @param colWidths Column widths
     * @param hasHeader Whether first row is header
     * @returns Formatted table string
     */
    private buildAsciiTable(rows: string[][], colWidths: number[], hasHeader: boolean): string {
        const lines: string[] = [];
        
        // Top border
        lines.push('┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐');
        
        // Header row
        if (hasHeader && rows.length > 0) {
            const header = rows[0];
            lines.push('│ ' + header.map((cell, i) => this.padString(cell, colWidths[i])).join(' │ ') + ' │');
            lines.push('├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤');
        }
        
        // Data rows
        const startIdx = hasHeader ? 1 : 0;
        for (let i = startIdx; i < rows.length; i++) {
            const row = rows[i];
            lines.push('│ ' + row.map((cell, j) => this.padString(cell, colWidths[j])).join(' │ ') + ' │');
        }
        
        // Bottom border
        lines.push('└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘');
        
        return lines.join('\n');
    }

    /**
     * Pad string to specified width
     * @param str String to pad
     * @param width Target width
     * @returns Padded string
     */
    private padString(str: string, width: number): string {
        // Remove ANSI color codes for length calculation
        const strippedStr = str.replace(/\x1b\[[0-9;]*m/g, '');
        const padding = width - strippedStr.length;
        if (padding <= 0) return str;
        return str + ' '.repeat(padding);
    }

    /**
     * Format and print syslog records to console
     * @param records Array of syslog records
     * @param options Formatting options
     */
    public printTable(
        records: (SyslogRecord | SyslogAppScopeRecord)[],
        options: SyslogFormatOptions = {}
    ): void {
        this._logger.info(this.formatAsTable(records, options));
    }

    /**
     * Save syslog records to a file
     * @param records Array of syslog records
     * @param filePath Path to save the file
     * @param format Output format ('json', 'csv', 'table')
     * @param append Whether to append to existing file (default: false)
     */
    public async saveToFile(
        records: (SyslogRecord | SyslogAppScopeRecord)[],
        filePath: string,
        format: 'json' | 'csv' | 'table' = 'json',
        append: boolean = false
    ): Promise<void> {
        const dir = path.dirname(filePath);
        
        // Ensure directory exists
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        let content: string;

        switch (format) {
            case 'json':
                content = JSON.stringify(records, null, 2);
                break;
            case 'csv':
                content = this.formatAsCSV(records);
                break;
            case 'table':
                content = this.formatAsTable(records);
                break;
            default:
                content = JSON.stringify(records, null, 2);
        }

        if (append) {
            fs.appendFileSync(filePath, content + '\n');
        } else {
            fs.writeFileSync(filePath, content);
        }

        this._logger.info(`Saved ${records.length} records to ${filePath}`);
    }

    /**
     * Tail syslog in real-time (like tail -f)
     * @param tableName Table to tail ('syslog' or 'syslog_app_scope')
     * @param options Tail options including query, interval, and callbacks
     */
    public async startTailing(
        tableName: 'syslog' | 'syslog_app_scope' = 'syslog',
        options: SyslogTailOptions = {}
    ): Promise<void> {
        if (this._isTailing) {
            throw new Error('Already tailing logs. Stop current tail before starting a new one.');
        }

        const {
            interval = 5000,
            initialLimit = 10,
            query,
            onLog,
            formatOptions,
            outputFile,
            append = true
        } = options;

        this._isTailing = true;
        this._logger.info(`Starting to tail ${tableName} table with ${interval}ms interval`);

        // Fetch initial records
        const queryMethod = tableName === 'syslog' 
            ? this.querySyslog.bind(this) 
            : this.querySyslogAppScope.bind(this);

        let initialQuery = query || '';
        if (initialQuery && !initialQuery.includes('ORDERBY')) {
            initialQuery += '^ORDERBYDESCsys_created_on';
        } else if (!initialQuery) {
            initialQuery = 'ORDERBYDESCsys_created_on';
        }

        const initialRecords = await queryMethod(initialQuery, initialLimit);
        
        if (initialRecords.length > 0) {
            this._lastFetchedSysId = initialRecords[0].sys_id;
            this._logger.info('\n=== Initial Logs ===');
            this.printTable(initialRecords, formatOptions);
            
            if (outputFile) {
                await this.saveToFile(initialRecords, outputFile, 'table', append);
            }
        }

        // Start polling for new records
        this._tailInterval = setInterval(async () => {
            try {
                let newQuery = query || '';
                
                // Add filter for records newer than last fetched
                if (this._lastFetchedSysId) {
                    newQuery = newQuery 
                        ? `${newQuery}^sys_idNOT IN${this._lastFetchedSysId}^ORDERBYDESCsys_created_on`
                        : `sys_idNOT IN${this._lastFetchedSysId}^ORDERBYDESCsys_created_on`;
                }

                const newRecords = await queryMethod(newQuery, 100);
                
                if (newRecords.length > 0) {
                    this._lastFetchedSysId = newRecords[0].sys_id;
                    
                    // Process each new record
                    newRecords.reverse().forEach(record => {
                        if (onLog) {
                            onLog(record);
                        }
                        
                        // Print to console
                        this.printTable([record], formatOptions);
                    });
                    
                    // Append to file if specified
                    if (outputFile) {
                        await this.saveToFile(newRecords, outputFile, 'table', true);
                    }
                }
            } catch (error) {
                this._logger.error(`Error while tailing: ${error}`);
            }
        }, interval);

        //console.log(`\n👀 Tailing ${tableName} table (press Ctrl+C to stop)...`);
    }

    /**
     * Tail ServiceNow logs using the ChannelAjax logtail processor
     * This is more efficient than polling the table API as it uses sequence numbers
     * @param options Tail options including interval and callbacks
     */
    public async startTailingWithChannelAjax(options: Omit<SyslogTailOptions, 'query' | 'initialLimit'> = {}): Promise<void> {
        if (this._isTailing) {
            throw new Error('Already tailing logs. Stop current tail before starting a new one.');
        }

        const {
            interval = 1000, // Poll every 1 second by default
            onLog,
            formatOptions,
            outputFile,
            append = true
        } = options;

        this._isTailing = true;
        this._logger.info(`Starting to tail logs using ChannelAjax with ${interval}ms interval`);

        // Fetch initial logs to get starting sequence
        const initialLogs = await this.fetchLogsFromChannelAjax();
        
        if (initialLogs && initialLogs.length > 0) {
            this._logger.info('\n=== Initial Logs ===');
            initialLogs.forEach(item => {
                const formattedLog = this.formatLogTailItem(item);
                this._logger.info(formattedLog);
                
                if (onLog) {
                    // Convert LogTailItem to SyslogRecord format for callback
                    const syslogRecord = this.logTailItemToSyslogRecord(item);
                    onLog(syslogRecord);
                }
            });

            if (outputFile) {
                const logText = initialLogs.map(item => this.formatLogTailItem(item)).join('\n');
                this.saveTextToFile(logText, outputFile, append);
            }
        }

        // Start polling for new logs
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        this._tailInterval = setInterval(async () => {
            try {
                const newLogs = await this.fetchLogsFromChannelAjax();
                
                if (newLogs && newLogs.length > 0) {
                    newLogs.forEach(item => {
                        const formattedLog = this.formatLogTailItem(item);
                        this._logger.debug(formattedLog);
                        
                        if (onLog) {
                            const syslogRecord = this.logTailItemToSyslogRecord(item);
                            onLog(syslogRecord);
                        }
                    });

                    if (outputFile) {
                        const logText = newLogs.map(item => this.formatLogTailItem(item)).join('\n');
                        this.saveTextToFile(logText, outputFile, true);
                    }
                }
            } catch (error) {
                this._logger.error(`Error while tailing: ${error}`);
            }
        }, interval);

        //console.log(`\n👀 Tailing logs via ChannelAjax (press Ctrl+C to stop)...`);
    }

    /**
     * Fetch logs from the ChannelAjax logtail processor
     * @returns Array of log tail items
     */
    private async fetchLogsFromChannelAjax(): Promise<LogTailItem[]> {
        const processorArgs: Record<string, string> = {
            sysparm_type: 'read',
            sysparm_value: this._lastSequence || '0',
            sysparm_want_session_messages: 'true',
            sysparm_silent_request: 'true',
            sysparm_express_transaction: 'true',
            'ni.nolog.x_referer': 'ignore',
            'x_referer': 'channel.do?sysparm_channel=logtail'
        };

        const response = await this._processorRequest.doXmlHttpRequest(
            'ChannelAjax',
            'logtail',
            'global',
            processorArgs,
            // Tailing reads. It only needs a POST because that is how the AJAX
            // processor endpoint works, and the default would otherwise class every
            // `nex log` as a write and refuse it.
            READ_ONLY
        );

        if (response.status === 200) {
            const xmlData = response.data as string;
            const parsedData = await this.parseLogTailXml(xmlData);
            
            if (parsedData) {
                // Update the sequence for the next request
                this._lastSequence = parsedData.channel_last_sequence;
                return parsedData.item || [];
            }
        }

        return [];
    }

    /**
     * Parse XML response from ChannelAjax logtail
     * @param xmlData XML string from response
     * @returns Parsed LogTailResponse
     */
    private async parseLogTailXml(xmlData: string): Promise<LogTailResponse | null> {
        return new Promise((resolve, reject) => {
            const parser = new Parser({
                explicitArray: false,
                mergeAttrs: true
            });

            parser.parseString(xmlData, (err, result) => {
                if (err) {
                    this._logger.error(`Error parsing XML: ${err}`);
                    reject(err);
                    return;
                }

                if (result && result.xml) {
                    const xmlRoot = result.xml;
                    const response: LogTailResponse = {
                        channel_last_sequence: xmlRoot.channel_last_sequence || '0',
                        client_last_sequence: xmlRoot.client_last_sequence || '0',
                        sysparm_max: xmlRoot.sysparm_max || '15',
                        item: []
                    };

                    // Handle both single item and array of items
                    if (xmlRoot.item) {
                        if (Array.isArray(xmlRoot.item)) {
                            response.item = xmlRoot.item;
                        } else {
                            response.item = [xmlRoot.item];
                        }
                    }

                    resolve(response);
                } else {
                    resolve(null);
                }
            });
        });
    }

    /**
     * Format a LogTailItem for console output
     * @param item Log tail item
     * @returns Formatted string
     */
    private formatLogTailItem(item: LogTailItem): string {
        const timestamp = new Date(parseInt(item.date));
        const formattedDate = timestamp.toLocaleString();
        return `[${formattedDate}] [${item.sequence}] ${item.message}`;
    }

    /**
     * Convert LogTailItem to SyslogRecord format
     * @param item Log tail item
     * @returns SyslogRecord
     */
    private logTailItemToSyslogRecord(item: LogTailItem): SyslogRecord {
        const timestamp = new Date(parseInt(item.date));
        return {
            sys_id: item.sequence, // Use sequence as ID
            sys_created_on: timestamp.toISOString(),
            level: 'info', // Default level as it's not provided in logtail
            message: item.message,
            source: 'logtail',
            sequence: item.sequence
        };
    }

    /**
     * Save text content to a file
     * @param content Text content to save
     * @param filePath File path
     * @param append Whether to append
     */
    private saveTextToFile(content: string, filePath: string, append: boolean): void {
        const dir = path.dirname(filePath);
        
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (append) {
            fs.appendFileSync(filePath, content + '\n');
        } else {
            fs.writeFileSync(filePath, content + '\n');
        }
    }

    /**
     * Stop tailing logs
     */
    public stopTailing(): void {
        if (this._tailInterval) {
            clearInterval(this._tailInterval);
            this._tailInterval = undefined;
        }
        this._isTailing = false;
        this._lastFetchedSysId = undefined;
        this._lastSequence = undefined;
        this._logger.info('Stopped tailing logs');
        //console.log('\n✓ Stopped tailing logs');
    }

    /**
     * Check if currently tailing
     */
    public get isTailing(): boolean {
        return this._isTailing;
    }

    /**
     * Format records as CSV
     * @param records Array of records
     * @returns CSV string
     */
    private formatAsCSV(records: (SyslogRecord | SyslogAppScopeRecord)[]): string {
        if (records.length === 0) return '';

        const keys = Object.keys(records[0]);
        const header = keys.join(',');
        const rows = records.map(record => 
            keys.map(key => {
                const value = String(record[key] || '');
                return value.includes(',') ? `"${value.replace(/"/g, '""')}"` : value;
            }).join(',')
        );

        return [header, ...rows].join('\n');
    }

    /**
     * Format date based on format option
     * @param dateString ISO date string
     * @param format Date format option
     * @returns Formatted date string
     */
    private formatDate(dateString: string, format: 'iso' | 'locale' | 'relative'): string {
        if (!dateString) return '';
        
        const date = new Date(dateString);
        
        switch (format) {
            case 'iso':
                return date.toISOString();
            case 'locale':
                return date.toLocaleString();
            case 'relative':
                return this.getRelativeTime(date);
            default:
                return date.toLocaleString();
        }
    }

    /**
     * Get relative time string (e.g., "2 minutes ago")
     * @param date Date object
     * @returns Relative time string
     */
    private getRelativeTime(date: Date): string {
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffSecs < 60) return `${diffSecs}s ago`;
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        return `${diffDays}d ago`;
    }

    /**
     * Colorize log level for console output
     * @param level Log level
     * @returns Colorized level string
     */
    private colorizeLevel(level: string): string {
        const colors: Record<string, string> = {
            error: '\x1b[31m', // Red
            warn: '\x1b[33m',  // Yellow
            info: '\x1b[32m',  // Green
            debug: '\x1b[36m', // Cyan
        };
        const reset = '\x1b[0m';
        const color = colors[level.toLowerCase()] || '';
        return `${color}${level.toUpperCase()}${reset}`;
    }

    /**
     * Truncate string to maximum length
     * @param str String to truncate
     * @param maxLength Maximum length
     * @returns Truncated string
     */
    private truncateString(str: string, maxLength: number): string {
        if (str.length <= maxLength) return str;
        return str.substring(0, maxLength - 3) + '...';
    }
}

