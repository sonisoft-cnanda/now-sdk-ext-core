/** Categories discoverable from a table's configuration. */
export const BEHAVIOR_CATEGORIES = ['business_rules', 'ui_actions', 'client_scripts', 'ui_policies', 'data_policies', 'workflows', 'flows', 'state_models'] as const;

/** A table behavior category. */
export type BehaviorCategory = typeof BEHAVIOR_CATEGORIES[number];

/** Artifact kinds accepted by batched detail retrieval. */
export type BehaviorKind = BehaviorCategory | 'subflow' | 'action' | 'script_include' | 'decision_table';

/** Optional payloads; conditions and declarative field actions are always included. */
export type BehaviorDetail = 'scripts' | 'definitions' | 'dependencies';

/** Stable record identity; sourceTable must be an allowlisted table for kind. */
export interface BehaviorReference {
    kind: BehaviorKind;
    sysId: string;
    sourceTable: string;
}

/** Options shared by discovery and direct detail retrieval. */
export interface BehaviorDetailOptions {
    details?: BehaviorDetail[];
    dependencyDepth?: 0 | 1;
    maxBytes?: number;
    scope?: string;
}

/** Filters and per-category continuation for table discovery. */
export interface TableBehaviorOptions extends BehaviorDetailOptions {
    categories?: BehaviorCategory[];
    includeInherited?: boolean;
    includeInactive?: boolean;
    name?: string;
    sysIds?: string[];
    limit?: number;
    cursors?: Partial<Record<BehaviorCategory, string>>;
}

/** Completeness describes accessible configuration, never effective runtime behavior. */
export type BehaviorStatus = 'complete' | 'partial' | 'unavailable' | 'failed';

/** Machine-readable omission or failure with a targeted recovery path. */
export interface BehaviorWarning {
    code: 'permission_denied' | 'unsupported' | 'request_failed' | 'malformed_response' | 'not_found' | 'truncated' | 'unresolved' | 'missing_fields';
    message: string;
    sourceTable?: string;
    reference?: BehaviorReference;
}

/** Declarative configuration retains ServiceNow's raw values and field names. */
export type BehaviorConfiguration = Record<string, unknown>;

/** A related record such as a policy action, workflow activity, or transition gate. */
export interface BehaviorRelatedRecord {
    sourceTable: string;
    sysId: string;
    configuration: BehaviorConfiguration;
    scripts?: Record<string, string>;
}

/** A dependency found in a definition or inferred from literal script syntax. */
export interface BehaviorDependency {
    reference?: BehaviorReference;
    name?: string;
    evidence: string;
    snapshotSysId?: string;
    resolution: 'explicit' | 'inferred' | 'unresolved';
}

/** One configured behavior, with provenance and explicitly requested detail. */
export interface BehaviorItem {
    reference: BehaviorReference;
    name: string;
    table?: string;
    inherited?: boolean;
    active?: boolean;
    scope?: string;
    configuration: BehaviorConfiguration;
    scriptFields: string[];
    scripts?: Record<string, string>;
    definition?: BehaviorConfiguration;
    definitionSource?: 'design_time';
    related?: BehaviorRelatedRecord[];
    dependencies?: BehaviorDependency[];
    warnings: BehaviorWarning[];
    omittedDetails?: BehaviorDetail[];
}

/** A paged category; an empty items array is meaningful only with its status. */
export interface BehaviorCategoryResult {
    category: BehaviorCategory;
    status: BehaviorStatus;
    items: BehaviorItem[];
    warnings: BehaviorWarning[];
    nextCursor?: string;
}

/** Reusable table behavior inventory shared by CLI and MCP. */
export interface TableBehaviorResult {
    table: string;
    ancestors: string[];
    requestedDetails: BehaviorDetail[];
    categories: BehaviorCategoryResult[];
    dependencies: BehaviorItem[];
    warnings: BehaviorWarning[];
    visibility: 'accessible_configuration';
}

/** Batched details with per-reference failures and resumable omitted items. */
export interface BehaviorDetailsResult {
    items: BehaviorItem[];
    dependencies: BehaviorItem[];
    warnings: BehaviorWarning[];
    remainingReferences: BehaviorReference[];
    requestedDetails: BehaviorDetail[];
    visibility: 'accessible_configuration';
}
