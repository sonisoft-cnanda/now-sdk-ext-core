/** One active transaction, as collected from a cluster node. */
export interface ClusterTransaction {
    sys_id: string;
    node_id: string;
    user: string;
    age: string;
    url: string;
    type: string;
    foreground: string;
    thread: string;
    /** The transaction state, unrelated to the collection progress state. */
    state: string;
    query_count: string;
    acl_time: string;
    br_count: string;
    br_time: string;
    business_rule: string;
    db_time: string;
    event_count: string;
}

export interface GetTransactionsOptions {
    pollIntervalMs?: number;
    timeoutMs?: number;
    query?: string;
    limit?: number;
    signal?: AbortSignal;
}

export interface KillTransactionOptions {
    /** Override for instances whose Kill UI action cannot be resolved automatically. */
    killActionSysId?: string;
}

export interface KillTransactionResult {
    accepted: boolean;
    sysId: string;
}
