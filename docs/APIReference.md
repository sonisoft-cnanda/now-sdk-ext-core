# API Reference

Complete API reference for `@sonisoft/now-sdk-ext-core`.

## Table of Contents

- [Core Classes](#core-classes)
- [Application Management](#application-management)
- [ATF Testing](#atf-testing)
- [Scope & Configuration](#scope--configuration)
- [Code & Schema](#code--schema)
- [Data Operations](#data-operations)
- [Workflow & Task](#workflow--task)
- [Scripting](#scripting)
- [Monitoring & Discovery](#monitoring--discovery)
- [Type Definitions](#type-definitions)
- [Utility Classes](#utility-classes)

## Core Classes

### ServiceNowInstance

Creates a connection to a ServiceNow instance.

```typescript
class ServiceNowInstance {
    constructor(settings: ServiceNowSettingsInstance)
}

interface ServiceNowSettingsInstance {
    alias: string;
    credential: unknown;
}
```

**Usage:**
```typescript
const instance = new ServiceNowInstance({
    alias: 'my-instance',
    credential: await getCredentials('my-instance')
});
```

## Application Management

### ApplicationManager

#### Constructor
```typescript
constructor(instance: ServiceNowInstance)
```

#### Methods

**getApplicationDetails(appID: string): Promise<ApplicationDetailModel>**
- Get detailed information about an application

**validateBatchDefinition(batchDefinitionPath: string): Promise<BatchValidationResult>**
- Validate applications in a batch definition file

**validateBatchInstallation(batchInstall: BatchInstallation): Promise<BatchValidationResult>**
- Validate a BatchInstallation object

**validateApplication(pkg: BatchDefinition): Promise<ApplicationValidationResult>**
- Validate a single application

**checkInstalledApplications(batchDefinitionPath: string): Promise<ApplicationValidationResult[]>**
- Get installed applications from batch

**getApplicationsNeedingAction(batchDefinitionPath: string): Promise<ApplicationValidationResult[]>**
- Get applications needing installation or upgrade

**installBatch(batchDefinitionPath: string): Promise<boolean>**
- Install all applications in batch

### AppRepoApplication

#### Constructor
```typescript
constructor(instance: ServiceNowInstance)
```

#### Methods

**installFromAppRepo(request: AppRepoInstallRequest): Promise<AppRepoInstallResponse>**
- Initiate app installation from repository

**installFromAppRepoAndWait(request: AppRepoInstallRequest, pollIntervalMs?: number, timeoutMs?: number): Promise<AppRepoOperationResult>**
- Install and wait for completion

**publishToAppRepo(request: AppRepoPublishRequest): Promise<AppRepoPublishResponse>**
- Initiate app publish to repository

**publishToAppRepoAndWait(request: AppRepoPublishRequest, pollIntervalMs?: number, timeoutMs?: number): Promise<AppRepoOperationResult>**
- Publish and wait for completion

**getProgress(progressId: string): Promise<ProgressResult>**
- Get operation progress

### BatchDefinition

```typescript
class BatchDefinition {
    constructor(
        id: string,
        load_demo_data: boolean,
        notes: string,
        requested_customization_version: string,
        requested_version: string,
        type: string
    )
    
    toJSON(): object
}
```

### BatchInstallation

```typescript
class BatchInstallation {
    get name(): string
    get packages(): BatchDefinition[]
    set packages(value: BatchDefinition[])
    
    toJSON(): object
}
```

## ATF Testing

### ATFTestExecutor

#### Constructor
```typescript
constructor(instance: ServiceNowInstance)
```

#### Methods

**executeTest(testId: string): Promise<TestResult>**
- Execute a single test

**executeTestSuite(testSuiteSysId: string, options?: Partial<TestSuiteExecutionRequest>): Promise<TestSuiteExecutionResponse>**
- Start test suite execution

**executeTestSuiteByName(testSuiteName: string, options?: Partial<TestSuiteExecutionRequest>): Promise<TestSuiteExecutionResponse>**
- Start test suite by name

**executeTestSuiteAndWait(testSuiteSysId: string, options?: Partial<TestSuiteExecutionRequest>, pollIntervalMs?: number): Promise<TestSuiteExecutionResult>**
- Execute suite and wait for completion

**executeTestSuiteByNameAndWait(testSuiteName: string, options?: Partial<TestSuiteExecutionRequest>, pollIntervalMs?: number): Promise<TestSuiteExecutionResult>**
- Execute suite by name and wait

**getTestSuiteProgress(progressId: string): Promise<TestSuiteExecutionResponse>**
- Get test suite execution progress

**getTestSuiteResults(resultsId: string): Promise<TestSuiteExecutionResult>**
- Get test suite execution results

## Scope & Configuration

### ScopeManager

Manage application scopes. See [ScopeManager Guide](./ScopeManager.md) for full documentation.

```typescript
class ScopeManager {
    constructor(instance: ServiceNowInstance)

    setCurrentApplication(appSysId: string): Promise<SetCurrentApplicationResult>
    getCurrentApplication(): Promise<ApplicationRecord | null>
    listApplications(options?: ListApplicationsOptions): Promise<ApplicationRecord[]>
    getApplication(sysId: string): Promise<ApplicationRecord | null>
}
```

### UpdateSetManager

Manage update sets. See [UpdateSetManager Guide](./UpdateSetManager.md) for full documentation.

```typescript
class UpdateSetManager {
    constructor(instance: ServiceNowInstance)

    setCurrentUpdateSet(options: SetUpdateSetOptions): Promise<void>
    getCurrentUpdateSet(): Promise<UpdateSetRecord | null>
    listUpdateSets(options?: ListUpdateSetsOptions): Promise<UpdateSetRecord[]>
    createUpdateSet(options: CreateUpdateSetOptions): Promise<UpdateSetRecord>
    moveRecordsToUpdateSet(targetUpdateSetId: string, options?: MoveRecordsOptions): Promise<MoveRecordsResult>
    cloneUpdateSet(sourceUpdateSetId: string, newName: string, onProgress?: (msg: string) => void): Promise<CloneUpdateSetResult>
    inspectUpdateSet(updateSetSysId: string): Promise<InspectUpdateSetResult>
}
```

## Code & Schema

### CodeSearch

Search across platform code. See [CodeSearch Guide](./CodeSearch.md) for full documentation.

```typescript
class CodeSearch {
    constructor(instance: ServiceNowInstance)

    search(options: CodeSearchOptions): Promise<CodeSearchResult[]>
    searchRaw(options: CodeSearchOptions): Promise<CodeSearchRecordTypeResult[]>
    searchInApp(term: string, appScope: string, additionalOptions?: Partial<CodeSearchOptions>): Promise<CodeSearchResult[]>
    searchInTable(term: string, tableName: string, searchGroup: string, additionalOptions?: Partial<CodeSearchOptions>): Promise<CodeSearchResult[]>
    getTablesForSearchGroup(searchGroup: string): Promise<CodeSearchTable[]>
    getSearchGroups(options?: CodeSearchGroupQueryOptions): Promise<CodeSearchGroup[]>
    addTableToSearchGroup(options: AddCodeSearchTableOptions): Promise<CodeSearchTableRecord>
    getTableRecordsForSearchGroup(searchGroupSysId: string, options?: CodeSearchGroupQueryOptions): Promise<CodeSearchTableRecord[]>
    static flattenResults(rawResults: CodeSearchRecordTypeResult[]): CodeSearchResult[]
    static formatResultsAsText(results: CodeSearchResult[]): string
}
```

### SchemaDiscovery

Discover table schemas and field metadata. See [SchemaDiscovery Guide](./SchemaDiscovery.md) for full documentation.

```typescript
class SchemaDiscovery {
    constructor(instance: ServiceNowInstance)

    discoverTableSchema(tableName: string, options?: TableSchemaOptions): Promise<TableSchema>
    explainField(tableName: string, fieldName: string): Promise<FieldExplanation>
    validateCatalogConfiguration(catalogItemSysId: string): Promise<CatalogValidationResult>
}
```

## Data Operations

### AttachmentManager

Upload, list, and retrieve file attachments. See [AttachmentManager Guide](./AttachmentManager.md) for full documentation.

```typescript
class AttachmentManager {
    constructor(instance: ServiceNowInstance)

    uploadAttachment(options: UploadAttachmentOptions): Promise<AttachmentRecord>
    listAttachments(options: ListAttachmentsOptions): Promise<AttachmentRecord[]>
    getAttachment(sysId: string): Promise<AttachmentRecord>
}
```

### BatchOperations

Sequential bulk create/update with variable substitution. See [BatchOperations Guide](./BatchOperations.md) for full documentation.

```typescript
class BatchOperations {
    constructor(instance: ServiceNowInstance)

    batchCreate(options: BatchCreateOptions): Promise<BatchCreateResult>
    batchUpdate(options: BatchUpdateOptions): Promise<BatchUpdateResult>
}
```

### QueryBatchOperations

Query-based bulk update/delete with dry-run safety. See [QueryBatchOperations Guide](./QueryBatchOperations.md) for full documentation.

```typescript
class QueryBatchOperations {
    constructor(instance: ServiceNowInstance)

    queryUpdate(options: QueryUpdateOptions): Promise<QueryUpdateResult>
    queryDelete(options: QueryDeleteOptions): Promise<QueryDeleteResult>
}
```

## Workflow & Task

### WorkflowManager

Find, check out, edit and publish legacy workflows with Workflow Editor parity, or create them from a spec. See [WorkflowManager Guide](./WorkflowManager.md) and [Legacy Workflow Internals](./LegacyWorkflowInternals.md).

```typescript
class WorkflowManager {
    constructor(instance: ServiceNowInstance)

    // Reading
    findWorkflows(options?: FindWorkflowsOptions): Promise<WorkflowSummary[]>
    resolveWorkflow(nameOrSysId: string): Promise<WorkflowSummary>
    getWorkflowVersions(workflowSysId: string): Promise<WorkflowVersionSummary[]>
    getWorkflowDefinition(versionSysId: string, options?: GetWorkflowDefinitionOptions): Promise<WorkflowDefinition>
    getWorkflowGraph(versionSysId: string): Promise<WorkflowGraph>
    listActivityDefinitions(options?: ListActivityDefinitionsOptions): Promise<ActivityDefinitionSummary[]>
    getActivityDefinition(nameOrSysId: string, options?: GetActivityDefinitionOptions): Promise<ActivityDefinitionDetail>
    getActivityUsage(nameOrSysId: string, options?: GetActivityUsageOptions): Promise<ActivityUsage>
    exportWorkflow(workflow: string, options?: ExportWorkflowOptions): Promise<WorkflowExport>
    validateWorkflow(versionSysId: string): Promise<WorkflowValidationReport>
    getDraftVersion(workflow: string): Promise<string>

    // Lifecycle (Workflow Editor parity)
    newWorkflow(options: NewWorkflowOptions): Promise<NewWorkflowResult>
    checkout(workflow: string, options?: CheckoutOptions): Promise<CheckoutResult>
    publish(versionSysId: string, options?: PublishOptions): Promise<PublishResult>
    discardCheckout(versionSysId: string): Promise<void>
    deleteWorkflow(workflow: string): Promise<void>
    setWorkflowActive(versionSysId: string, active: boolean): Promise<void>
    updateWorkflowProperties(versionSysId: string, options: UpdateWorkflowPropertiesOptions): Promise<void>

    // Editing a checked-out draft
    addActivity(versionSysId: string, options: AddActivityOptions): Promise<AddActivityResult>
    updateActivity(activitySysId: string, options: UpdateActivityOptions): Promise<void>
    removeActivity(activitySysId: string, options?: RemoveActivityOptions): Promise<void>
    moveActivities(positions: ActivityPosition[]): Promise<void>
    addTransition(options: AddTransitionOptions): Promise<string>
    retargetTransition(transitionSysId: string, toActivitySysId: string): Promise<void>
    removeTransition(transitionSysId: string): Promise<void>
    addCondition(options: AddConditionOptions): Promise<string>
    updateCondition(conditionSysId: string, options: UpdateConditionOptions): Promise<void>
    removeCondition(conditionSysId: string): Promise<void>

    // Record methods (direct Table API inserts)
    createWorkflow(options: CreateWorkflowOptions): Promise<CreateWorkflowResult>
    createWorkflowVersion(options: CreateWorkflowVersionOptions): Promise<CreateWorkflowVersionResult>
    createActivity(options: CreateActivityOptions): Promise<CreateActivityResult>
    createTransition(options: CreateTransitionOptions): Promise<CreateTransitionResult>
    createCondition(options: CreateConditionOptions): Promise<CreateConditionResult>
    publishWorkflow(options: PublishWorkflowOptions): Promise<void>
    createCompleteWorkflow(spec: CompleteWorkflowSpec, onProgress?: (msg: string) => void): Promise<CompleteWorkflowResult>
}
```

### FormRecordWriter

Writes a record through its classic UI form, the way a browser does — the path that saves
variable (`glide_var`) values. A low-level tool for direct instance writes to records not
authored in a now-sdk app. See [FormRecordWriter Guide](./FormRecordWriter.md).

```typescript
class FormRecordWriter {
    constructor(instance: ServiceNowInstance)

    loadForm(table: string, sysId?: string, options?: FormLoadOptions): Promise<FormSnapshot>
    insert(table: string, options?: FormWriteOptions): Promise<FormWriteResult>
    update(table: string, sysId: string, options?: FormWriteOptions): Promise<FormWriteResult>
    submit(snapshot: FormSnapshot, action: 'sysverb_insert' | 'sysverb_update', options?: FormWriteOptions): Promise<FormWriteResult>
}
```

### VariableDefinitions

Reads variable definitions (`var_dictionary`) for a variable model such as `var__m_<activity definition sys_id>`.

```typescript
class VariableDefinitions {
    constructor(instance: ServiceNowInstance)

    list(model: string, options?: ListVariableDefinitionsOptions): Promise<VariableDefinition[]>
}
```

### TaskOperations

Convenience methods for ITSM task management. See [TaskOperations Guide](./TaskOperations.md) for full documentation.

```typescript
class TaskOperations {
    constructor(instance: ServiceNowInstance)

    addComment(options: AddCommentOptions): Promise<TaskRecord>
    assignTask(options: AssignTaskOptions): Promise<TaskRecord>
    resolveIncident(options: ResolveIncidentOptions): Promise<TaskRecord>
    closeIncident(options: CloseIncidentOptions): Promise<TaskRecord>
    approveChange(options: ApproveChangeOptions): Promise<TaskRecord>
    findByNumber(table: string, number: string): Promise<TaskRecord | null>
}
```

## Scripting

### ScriptSync

Bidirectional sync of scripts between local files and ServiceNow. See [ScriptSync Guide](./ScriptSync.md) for full documentation.

```typescript
class ScriptSync {
    constructor(instance: ServiceNowInstance)

    pullScript(options: SyncScriptOptions): Promise<SyncResult>
    pushScript(options: SyncScriptOptions): Promise<SyncResult>
    syncAllScripts(options: SyncAllOptions): Promise<SyncAllResult>
    static parseFileName(fileName: string): ParsedFileName
    static generateFileName(scriptName: string, scriptType: string): string
}
```

## Monitoring & Discovery

### AggregateQuery

Aggregate operations via Stats API. See [AggregateQuery Guide](./AggregateQuery.md) for full documentation.

```typescript
class AggregateQuery {
    constructor(instance: ServiceNowInstance)

    count(options: CountQueryOptions): Promise<number>
    aggregate(options: AggregateQueryOptions): Promise<AggregateResult>
    groupBy(options: AggregateQueryOptions): Promise<GroupedAggregateResult>
}
```

### InstanceHealth

Consolidated health monitoring. See [InstanceHealth Guide](./InstanceHealth.md) for full documentation.

```typescript
class InstanceHealth {
    constructor(instance: ServiceNowInstance, aggregateQuery?: AggregateQuery)

    checkHealth(options?: HealthCheckOptions): Promise<HealthCheckResult>
}
```

### CMDBRelationships

CMDB CI relationship querying and graph traversal. See [CMDBRelationships Guide](./CMDBRelationships.md) for full documentation.

```typescript
class CMDBRelationships {
    constructor(instance: ServiceNowInstance)

    getRelationships(options: GetRelationshipsOptions): Promise<RelationshipsResult>
    traverseGraph(options: TraverseGraphOptions): Promise<GraphTraversalResult>
}
```

### InstanceDiscovery

Discover what exists on an instance. See [InstanceDiscovery Guide](./InstanceDiscovery.md) for full documentation.

```typescript
class InstanceDiscovery {
    constructor(instance: ServiceNowInstance)

    listTables(options?: ListTablesOptions): Promise<TableDefinition[]>
    listScopedApps(options?: ListScopedAppsOptions): Promise<ScopedAppRecord[]>
    listStoreApps(options?: ListStoreAppsOptions): Promise<StoreAppRecord[]>
    listPlugins(options?: ListPluginsOptions): Promise<PluginRecord[]>
}
```

## Type Definitions

### Application Management Types

```typescript
interface ApplicationValidationResult {
    id: string;
    name?: string;
    requested_version: string;
    installed_version?: string;
    isInstalled: boolean;
    isVersionMatch: boolean;
    isUpdateAvailable: boolean;
    needsAction: boolean;
    validationStatus: 'valid' | 'mismatch' | 'not_installed' | 'update_needed' | 'error';
    error?: string;
    appDetails?: ApplicationDetailModel;
}

interface BatchValidationResult {
    applications: ApplicationValidationResult[];
    totalApplications: number;
    alreadyValid: number;
    needsInstallation: number;
    needsUpgrade: number;
    errors: number;
    isValid: boolean;
}

interface ApplicationDetailModel {
    name: string;
    version: string;
    scope: string;
    isInstalled: boolean;
    isInstalledAndUpdateAvailable: boolean;
    vendor: string;
    // ... many more fields
}
```

### App Repository Types

```typescript
interface AppRepoInstallRequest {
    scope: string;
    sys_id: string;
    version?: string;
    auto_upgrade_base_app?: boolean;
    base_app_version?: string;
}

interface AppRepoPublishRequest {
    scope: string;
    sys_id: string;
    version?: string;
    dev_notes?: string;
}

interface AppRepoInstallResponse {
    links: {
        progress: {
            id: string;
            url: string;
        };
    };
    status: string;
    status_label: string;
    status_message: string;
    status_detail: string;
    error: string;
    percent_complete: number;
}

interface AppRepoOperationResult {
    success: boolean;
    status: string;
    status_label: string;
    status_message: string;
    status_detail: string;
    error: string;
    percent_complete: number;
    links: {
        progress: {
            id: string;
            url: string;
        };
        results?: {
            id: string;
            url: string;
        };
    };
}
```

### ATF Testing Types

```typescript
interface TestResult {
    end_time_millis: string;
    execution_tracker: ReferenceLink;
    test_name: string;
    test: ReferenceLink;
    rollback_context: ReferenceLink;
    root_tracker_id: ReferenceLink;
    output: string;
    sys_id: string;
    run_time: string;
    status: string;
}

interface TestSuiteExecutionRequest {
    browser_name?: string;
    browser_version?: string;
    is_performance_run?: boolean;
    os_name?: string;
    os_version?: string;
    run_in_cloud?: boolean;
}

interface TestSuiteExecutionResponse {
    links: {
        progress: {
            id: string;
            url: string;
        };
        results?: {
            id: string;
            url: string;
        };
    };
    status: string;
    status_label: string;
    status_message: string;
    status_detail: string;
    error: string;
    percent_complete: number;
}

interface TestSuiteExecutionResult {
    sys_id: string;
    test_suite: ReferenceLink;
    status: string;
    start_time: string;
    end_time: string;
    duration: string;
    total_tests: number;
    passed_tests: number;
    failed_tests: number;
    skipped_tests: number;
    output: string;
}
```

### Common Types

```typescript
interface ReferenceLink {
    link: string;
    value: string;
}

interface ProgressResult {
    links: {
        progress: {
            id: string;
            url: string;
        };
        results: {
            id: string;
            url: string;
        };
    };
    status: string;
    status_label: string;
    status_message: string;
    status_detail: string;
    error: string;
    percent_complete: number;
}
```

## Utility Classes

### Logger

```typescript
class Logger {
    constructor(name: string)
    
    info(message: string): void
    error(message: string): void
    debug(message: string): void
    warn(message: string): void
}
```

### ProgressWorker

```typescript
class ProgressWorker {
    constructor(instance: ServiceNowInstance)
    
    getProgress(progressId: string): Promise<ProgressResult>
}
```

## HTTP Layer

### ServiceNowRequest

```typescript
class ServiceNowRequest {
    constructor(instance: ServiceNowInstance)
    
    get<T>(request: HTTPRequest): Promise<IHttpResponse<T>>
    post<T>(request: HTTPRequest): Promise<IHttpResponse<T>>
}
```

### HTTPRequest

```typescript
interface HTTPRequest {
    path: string;
    method?: string;
    headers?: Record<string, string> | null;
    query?: Record<string, any> | null;
    body?: any;
    json?: any;
}
```

### IHttpResponse

```typescript
interface IHttpResponse<T> {
    status: number;
    headers: Record<string, string>;
    bodyObject: T;
    body: string;
}
```

## Constants

### Status Codes

```typescript
// Progress status codes
enum ProgressStatus {
    PENDING = "0",
    RUNNING = "1",
    SUCCESSFUL = "2",
    FAILED = "3"
}
```

## Related Documentation

- [Getting Started](./GettingStarted.md)
- [Application Manager](./ApplicationManager.md)
- [Store Applications](./CompanyApplications.md)
- [App Repository](./AppRepoApplication.md)
- [ATF Test Executor](./ATFTestExecutor.md)
- [Scope Manager](./ScopeManager.md)
- [Update Set Manager](./UpdateSetManager.md)
- [Code Search](./CodeSearch.md)
- [Schema Discovery](./SchemaDiscovery.md)
- [Attachment Manager](./AttachmentManager.md)
- [Batch Operations](./BatchOperations.md)
- [Query Batch Operations](./QueryBatchOperations.md)
- [Workflow Manager](./WorkflowManager.md)
- [Legacy Workflow Internals](./LegacyWorkflowInternals.md)
- [FormRecordWriter](./FormRecordWriter.md)
- [Task Operations](./TaskOperations.md)
- [Script Sync](./ScriptSync.md)
- [Aggregate Query](./AggregateQuery.md)
- [Instance Health](./InstanceHealth.md)
- [CMDB Relationships](./CMDBRelationships.md)
- [Instance Discovery](./InstanceDiscovery.md)
- [Syslog Reader](./SyslogReader.md)
- [Examples](./Examples.md)

