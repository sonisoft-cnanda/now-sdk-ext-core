/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { XMLParser } from "fast-xml-parser";
import { ServiceNowRequest } from "../../comm/http/ServiceNowRequest";
import { InvalidParameterException } from "../../exception/InvalidParameterException";
import { ServiceNowTableResponse } from "../../model/types";
import { READ_ONLY } from "../../policy/PolicyTypes";
import { redactMessage, stripSecretsFromError } from "../../util/redact";
import { ServiceNowInstance } from "../ServiceNowInstance";
import {
    ClusterTransaction,
    GetTransactionsOptions,
    KillTransactionOptions,
    KillTransactionResult,
} from "./ClusterTransactionModels";

interface ProgressStatus {
    state?: string;
    percent_complete?: string;
    message?: string;
    detail_message?: string;
}

interface UIActionRecord {
    sys_id: string;
    name: string;
}

const SYS_ID = /^[0-9a-f]{32}$/i;
const TRANSACTION_FIELDS = [
    "node_id", "user", "age", "url", "type", "foreground", "thread", "state",
    "query_count", "acl_time", "br_count", "br_time", "business_rule", "db_time", "event_count",
] as const;

export class ClusterTransactionManager {
    private _req: ServiceNowRequest;
    private _killActionSysId?: string;
    private _xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

    public constructor(instance: ServiceNowInstance) {
        this._req = new ServiceNowRequest(instance);
    }

    public async getTransactions(options: GetTransactionsOptions = {}): Promise<ClusterTransaction[]> {
        const pollIntervalMs = this.requireNonNegativeNumber(options.pollIntervalMs, 1000, "pollIntervalMs");
        const timeoutMs = this.requireNonNegativeNumber(options.timeoutMs, 60000, "timeoutMs");
        const limit = this.requirePositiveInteger(options.limit, 1000, "limit");

        try {
            this.throwIfAborted(options.signal);
            const initialize = await this._req.get<string>({
                method: "GET", path: "/loading_transactions.do", headers: null,
                query: null, body: null, requires: READ_ONLY,
            });
            const page = this.responseText(initialize.data);
            const executionMatch = /\bvar\s+executionID\s*=\s*(['"])(.*?)\1\s*;/.exec(page);
            if (!executionMatch) {
                throw new Error("Could not parse the collection execution id from /loading_transactions.do");
            }
            const executionId = executionMatch[2];
            if (executionId && executionId !== "null") {
                if (!SYS_ID.test(executionId)) {
                    throw new Error("The collection execution id from /loading_transactions.do was invalid");
                }
                await this.waitForCollection(executionId, pollIntervalMs, timeoutMs, options.signal);
            }
            return await this.readTransactionList(options.query, limit);
        } catch (error) {
            throw this.sanitizeError(error);
        }
    }

    public async killTransaction(
        sysId: string,
        options: KillTransactionOptions = {},
    ): Promise<KillTransactionResult> {
        if (typeof sysId !== "string" || !SYS_ID.test(sysId.trim())) {
            throw new InvalidParameterException("A transaction sysId must be a 32-character hexadecimal value");
        }
        const transactionSysId = sysId.trim();
        try {
            const actionSysId = options.killActionSysId
                ? this.validateActionSysId(options.killActionSysId)
                : await this.resolveKillActionSysId();
            const security = await this._req.post<string>({
                method: "POST", path: "/xmlhttp.do", headers: null, query: null, body: null,
                requires: READ_ONLY,
                fields: {
                    sysparm_processor: "AJAXActionSecurity", sysparm_scope: "global",
                    sys_target: "v_cluster_transaction", sys_action: actionSysId,
                    sysparm_checked_items: transactionSysId, sysparm_target: "v_cluster_transaction",
                    sysparm_synch: "true",
                },
            });
            if (!this.canExecuteAction(this.responseText(security.data), actionSysId, transactionSysId)) {
                throw new Error("The Kill action is unavailable or was not authorized for the selected transaction");
            }
            const session = await this._req.getUserSession();
            if (!session?.userToken) {
                throw new Error("An authenticated ServiceNow session token is required to kill a transaction");
            }
            const result = await this._req.post<string>({
                method: "POST", path: "/v_cluster_transaction_list.do", headers: null,
                query: null, body: null,
                fields: {
                    sys_target: "v_cluster_transaction", sys_action: actionSysId,
                    sys_is_list: "true", sysparm_checked_items: transactionSysId,
                    sysparm_ck: session.userToken, sysparm_query: "",
                    sysparm_referring_url: "v_cluster_transaction_list.do",
                },
            });
            const body = this.responseText(result.data);
            if (/login\.do|Security constraints prevent access/i.test(body)) {
                throw new Error("ServiceNow did not accept the transaction kill request");
            }
            return { accepted: true, sysId: transactionSysId };
        } catch (error) {
            throw this.sanitizeError(error);
        }
    }

    private async waitForCollection(
        executionId: string,
        pollIntervalMs: number,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<void> {
        const startedAt = Date.now();
        let last: ProgressStatus = {};
        while (true) {
            this.throwIfAborted(signal);
            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error(`Transaction collection timed out after ${timeoutMs} ms (last state ${last.state ?? "unknown"}, ${last.percent_complete ?? "unknown"}%)`);
            }
            const response = await this._req.post<string>({
                method: "POST", path: "/xmlhttp.do", headers: null, query: null, body: null,
                requires: READ_ONLY,
                fields: {
                    sysparm_processor: "AJAXProgressStatusChecker", sysparm_name: "getStatus",
                    sysparm_scope: "global", sysparm_execution_id: executionId,
                },
            });
            last = this.parseProgress(this.responseText(response.data));
            if (last.state === "2") return;
            if (last.state !== "0" && last.state !== "1") {
                const detail = last.detail_message || last.message || "no platform detail was provided";
                throw new Error(`Transaction collection failed: ${detail}`);
            }
            await this.delay(pollIntervalMs, signal);
        }
    }

    private parseProgress(xml: string): ProgressStatus {
        try {
            const parsed = this._xmlParser.parse(xml);
            const answer = parsed?.xml?.answer;
            if (typeof answer !== "string") throw new Error();
            const status = JSON.parse(answer);
            if (!status || typeof status !== "object" || typeof status.state !== "string") throw new Error();
            return status;
        } catch {
            throw new Error("Could not parse the AJAXProgressStatusChecker response");
        }
    }

    private async readTransactionList(query: string | undefined, limit: number): Promise<ClusterTransaction[]> {
        // A live Table API probe was unavailable during implementation, so use the captured,
        // stable list-2 structure. Keeping this behind one method preserves the planned seam.
        const response = await this._req.get<string>({
            method: "GET", path: "/v_cluster_transaction_list.do", headers: null, body: null,
            requires: READ_ONLY,
            query: { sysparm_query: query ?? "", sysparm_limit: limit },
        });
        return this.parseTransactionList(this.responseText(response.data), limit);
    }

    private parseTransactionList(html: string, limit: number): ClusterTransaction[] {
        try {
            const columns = [...html.matchAll(/<th\b[^>]*\bname=["']([^"']+)["'][^>]*\bglide_type=["'][^"']*["'][^>]*>/gi)]
                .map((match) => match[1])
                .filter((name) => TRANSACTION_FIELDS.includes(name as typeof TRANSACTION_FIELDS[number]));
            if (columns.length !== TRANSACTION_FIELDS.length || !TRANSACTION_FIELDS.every((field) => columns.includes(field))) {
                throw new Error();
            }
            const records: ClusterTransaction[] = [];
            const rows = html.matchAll(/<tr\b[^>]*\bsys_id=["']([0-9a-f]{32})["'][^>]*>([\s\S]*?)<\/tr>/gi);
            for (const row of rows) {
                const cells = [...row[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
                    .map((cell) => this.decodeHtml(this.stripTags(cell[1])));
                // List-2 rows surround the data with selection/icon and trailing spacer cells.
                const dataCells = cells.length === columns.length ? cells : cells.slice(2, 2 + columns.length);
                if (dataCells.length !== columns.length) throw new Error();
                const record = { sys_id: row[1] } as ClusterTransaction;
                columns.forEach((column, index) => { record[column] = dataCells[index] ?? ""; });
                records.push(record);
                if (records.length >= limit) break;
            }
            return records;
        } catch {
            throw new Error("Could not parse /v_cluster_transaction_list.do transaction rows");
        }
    }

    private async resolveKillActionSysId(): Promise<string> {
        if (this._killActionSysId) return this._killActionSysId;
        const response = await this._req.get<ServiceNowTableResponse<UIActionRecord>>({
            method: "GET", path: "/api/now/table/sys_ui_action", headers: { Accept: "application/json" },
            body: null,
            query: {
                sysparm_query: "table=v_cluster_transaction^active=true^name=Kill",
                sysparm_fields: "sys_id,name", sysparm_limit: 2, sysparm_display_value: "false",
            },
        });
        const candidates = (response.bodyObject ?? response.data)?.result;
        if (!Array.isArray(candidates) || candidates.length !== 1 || !SYS_ID.test(candidates[0].sys_id)) {
            const names = Array.isArray(candidates) ? candidates.map((candidate) => candidate.name).filter(Boolean) : [];
            const detail = names.length ? ` Candidates: ${names.join(", ")}.` : "";
            throw new Error(`Could not uniquely resolve the Kill UI action.${detail} Supply killActionSysId to override it.`);
        }
        this._killActionSysId = candidates[0].sys_id;
        return this._killActionSysId;
    }

    private canExecuteAction(xml: string, actionSysId: string, transactionSysId: string): boolean {
        try {
            const parsed = this._xmlParser.parse(xml);
            const action = parsed?.xml?.[`action_${actionSysId}`];
            const keys = Array.isArray(action?.key) ? action.key : action?.key ? [action.key] : [];
            return keys.some((key) => String(key.can_execute) === "true" && key.sys_id === transactionSysId);
        } catch {
            return false;
        }
    }

    private validateActionSysId(value: string): string {
        const actionSysId = typeof value === "string" ? value.trim() : "";
        if (!SYS_ID.test(actionSysId)) {
            throw new InvalidParameterException("killActionSysId must be a 32-character hexadecimal value");
        }
        return actionSysId;
    }

    private responseText(data: unknown): string {
        if (typeof data === "string") return data;
        if (data instanceof String) return data.toString();
        throw new Error("ServiceNow returned an unexpected response type");
    }

    private requireNonNegativeNumber(value: number | undefined, fallback: number, name: string): number {
        const result = value ?? fallback;
        if (!Number.isFinite(result) || result < 0) throw new InvalidParameterException(`${name} must be a non-negative number`);
        return result;
    }

    private requirePositiveInteger(value: number | undefined, fallback: number, name: string): number {
        const result = value ?? fallback;
        if (!Number.isInteger(result) || result <= 0) throw new InvalidParameterException(`${name} must be a positive integer`);
        return result;
    }

    private delay(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            const onAbort = (): void => {
                clearTimeout(timer);
                reject(new Error("Transaction collection was aborted"));
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    private throwIfAborted(signal?: AbortSignal): void {
        if (signal?.aborted) throw new Error("Transaction collection was aborted");
    }

    private sanitizeError<T>(error: T): T {
        if (error instanceof Error) error.message = redactMessage(error.message);
        return stripSecretsFromError(error);
    }

    private stripTags(value: string): string { return value.replace(/<[^>]*>/g, "").trim(); }
    private decodeHtml(value: string): string {
        return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    }
}
