# ApplicationManager

The `ApplicationManager` class provides comprehensive application management capabilities including validation, batch installation, and version comparison.

## Table of Contents

- [Overview](#overview)
- [Constructor](#constructor)
- [Methods](#methods)
  - [getApplicationDetails](#getapplicationdetails)
  - [validateBatchDefinition](#validatebatchdefinition)
  - [validateBatchInstallation](#validatebatchinstallation)
  - [validateApplication](#validateapplication)
  - [checkInstalledApplications](#checkinstalledapplications)
  - [getApplicationsNeedingAction](#getapplicationsneedingaction)
  - [installBatch](#installbatch)
  - [repairStoreApplication](#repairstoreapplication)
- [Interfaces](#interfaces)
- [Examples](#examples)

## Overview

The `ApplicationManager` is your primary tool for managing ServiceNow applications. It provides:

- **Application Details**: Retrieve comprehensive information about installed applications
- **Validation**: Check if applications are installed and verify versions
- **Batch Operations**: Install multiple applications in a single operation
- **Version Management**: Compare installed versions with required versions
- **Smart Deployment**: Identify which applications need installation or updates
- **Repair**: Reinstall an installed store or company application's version from its repository, without uninstalling it

## Constructor

```typescript
constructor(instance: ServiceNowInstance)
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `instance` | `ServiceNowInstance` | Configured ServiceNow instance connection |

### Example

```typescript
import { ServiceNowInstance, ApplicationManager } from '@sonisoft/now-sdk-ext-core';
import { getCredentials } from '@servicenow/sdk-cli/dist/auth';

const credential = await getCredentials('my-instance');
const instance = new ServiceNowInstance({
    alias: 'my-instance',
    credential: credential
});

const appManager = new ApplicationManager(instance);
```

## Methods

### getApplicationDetails

Retrieves detailed information about a specific application.

```typescript
async getApplicationDetails(appID: string): Promise<ApplicationDetailModel>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `appID` | `string` | The sys_id of the application |

#### Returns

`Promise<ApplicationDetailModel>` - Detailed application information including:
- `name`: Application name
- `version`: Current version
- `scope`: Application scope
- `isInstalled`: Installation status
- `isInstalledAndUpdateAvailable`: Whether an update is available
- `vendor`: Application vendor
- And many more fields...

#### Example

```typescript
const appDetails = await appManager.getApplicationDetails('012fa9ad7367ad6393ae5dea97af6f65');

console.log(`Application: ${appDetails.name}`);
console.log(`Version: ${appDetails.version}`);
console.log(`Installed: ${appDetails.isInstalled}`);
console.log(`Update Available: ${appDetails.isInstalledAndUpdateAvailable}`);
```

---

### validateBatchDefinition

Validates a batch definition file against currently installed applications.

```typescript
async validateBatchDefinition(batchDefinitionPath: string): Promise<BatchValidationResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `batchDefinitionPath` | `string` | Path to the batch definition JSON file |

#### Returns

`Promise<BatchValidationResult>` containing:
- `applications`: Array of validation results for each app
- `totalApplications`: Total number of applications
- `alreadyValid`: Count of apps with correct versions
- `needsInstallation`: Count of apps not installed
- `needsUpgrade`: Count of apps needing upgrades
- `errors`: Count of validation errors
- `isValid`: Overall validation status

#### Batch Definition Format

```json
{
    "name": "My Application Batch",
    "packages": [
        {
            "id": "app-sys-id-1",
            "type": "application",
            "load_demo_data": true,
            "requested_version": "1.0.0",
            "notes": "Core application"
        },
        {
            "id": "app-sys-id-2",
            "type": "application",
            "load_demo_data": false,
            "requested_version": "2.5.3",
            "notes": "Plugin for core"
        }
    ]
}
```

#### Example

```typescript
const result = await appManager.validateBatchDefinition('./apps/production-batch.json');

console.log(`Total Applications: ${result.totalApplications}`);
console.log(`✓ Already Valid: ${result.alreadyValid}`);
console.log(`⚠ Need Installation: ${result.needsInstallation}`);
console.log(`↑ Need Upgrade: ${result.needsUpgrade}`);
console.log(`✗ Errors: ${result.errors}`);

if (!result.isValid) {
    console.error('Validation failed - see errors above');
}

// Check individual app statuses
result.applications.forEach(app => {
    console.log(`${app.name}: ${app.validationStatus}`);
    if (app.needsAction) {
        console.log(`  Action needed: ${app.requested_version} requested, ${app.installed_version || 'not installed'} found`);
    }
});
```

---

### validateBatchInstallation

Validates a `BatchInstallation` object directly (without file I/O).

```typescript
async validateBatchInstallation(batchInstall: BatchInstallation): Promise<BatchValidationResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `batchInstall` | `BatchInstallation` | BatchInstallation object to validate |

#### Returns

`Promise<BatchValidationResult>` - Same as `validateBatchDefinition`

#### Example

```typescript
import { BatchInstallation, BatchDefinition } from '@sonisoft/now-sdk-ext-core';

const batch = new BatchInstallation();
batch.packages = [
    new BatchDefinition('app-id-1', true, 'notes', '', '1.0.0', 'application'),
    new BatchDefinition('app-id-2', true, 'notes', '', '2.0.0', 'application')
];

const result = await appManager.validateBatchInstallation(batch);
```

---

### validateApplication

Validates a single application from a batch definition.

```typescript
async validateApplication(pkg: BatchDefinition): Promise<ApplicationValidationResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `pkg` | `BatchDefinition` | Application definition to validate |

#### Returns

`Promise<ApplicationValidationResult>` containing:
- `id`: Application sys_id
- `name`: Application name (if installed)
- `requested_version`: Version requested in batch
- `installed_version`: Currently installed version
- `isInstalled`: Whether app is installed
- `isVersionMatch`: Whether versions match exactly
- `isUpdateAvailable`: Whether ServiceNow shows update available
- `needsAction`: Whether installation/upgrade is needed
- `validationStatus`: One of:
  - `'valid'`: Installed with correct version
  - `'mismatch'`: Version doesn't match (usually newer installed)
  - `'not_installed'`: App not found on instance
  - `'update_needed'`: Older version installed
  - `'error'`: Validation error occurred
- `error`: Error message if validation failed
- `appDetails`: Full application details if available

#### Example

```typescript
import { BatchDefinition } from '@sonisoft/now-sdk-ext-core';

const appDef = new BatchDefinition(
    '012fa9ad7367ad6393ae5dea97af6f65', // sys_id
    true,                                 // load_demo_data
    'Mobile Card Builder',                // notes
    '',                                   // requested_customization_version
    '25.10.0',                           // requested_version
    'application'                         // type
);

const result = await appManager.validateApplication(appDef);

console.log(`Application: ${result.name}`);
console.log(`Status: ${result.validationStatus}`);
console.log(`Requested: ${result.requested_version}`);
console.log(`Installed: ${result.installed_version || 'Not installed'}`);
console.log(`Action Needed: ${result.needsAction ? 'Yes' : 'No'}`);

if (result.validationStatus === 'update_needed') {
    console.log('⚠ Application needs to be upgraded');
} else if (result.validationStatus === 'not_installed') {
    console.log('⚠ Application needs to be installed');
} else if (result.validationStatus === 'valid') {
    console.log('✓ Application is up to date');
}
```

---

### checkInstalledApplications

Returns only the applications from a batch that are currently installed.

```typescript
async checkInstalledApplications(batchDefinitionPath: string): Promise<ApplicationValidationResult[]>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `batchDefinitionPath` | `string` | Path to batch definition JSON file |

#### Returns

`Promise<ApplicationValidationResult[]>` - Array of validation results for installed applications only

#### Example

```typescript
const installedApps = await appManager.checkInstalledApplications('./apps.json');

console.log(`Found ${installedApps.length} installed applications:`);

installedApps.forEach(app => {
    const versionMatch = app.isVersionMatch ? '✓' : '✗';
    console.log(`  ${versionMatch} ${app.name}: v${app.installed_version}`);
    
    if (!app.isVersionMatch) {
        console.log(`    (requested: v${app.requested_version})`);
    }
});
```

---

### getApplicationsNeedingAction

Returns applications that need installation or upgrade.

```typescript
async getApplicationsNeedingAction(batchDefinitionPath: string): Promise<ApplicationValidationResult[]>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `batchDefinitionPath` | `string` | Path to batch definition JSON file |

#### Returns

`Promise<ApplicationValidationResult[]>` - Array of applications needing installation or upgrade

#### Example

```typescript
const needsAction = await appManager.getApplicationsNeedingAction('./apps.json');

if (needsAction.length === 0) {
    console.log('✓ All applications are up to date!');
} else {
    console.log(`⚠ ${needsAction.length} applications need attention:\n`);
    
    needsAction.forEach(app => {
        if (app.validationStatus === 'not_installed') {
            console.log(`  📦 Install: ${app.id} v${app.requested_version}`);
        } else if (app.validationStatus === 'update_needed') {
            console.log(`  ↑ Upgrade: ${app.name} from v${app.installed_version} to v${app.requested_version}`);
        }
    });
}
```

---

### installBatch

Installs all applications defined in a batch definition file.

```typescript
async installBatch(batchDefinitionPath: string): Promise<boolean>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `batchDefinitionPath` | `string` | Path to batch definition JSON file |

#### Returns

`Promise<boolean>` - `true` if installation completed successfully

#### Example

```typescript
try {
    console.log('Starting batch installation...');
    const success = await appManager.installBatch('./apps/production-apps.json');
    
    if (success) {
        console.log('✓ Batch installation completed successfully');
    }
} catch (error) {
    console.error('✗ Batch installation failed:', error.message);
    throw error;
}
```

#### Installation Workflow Example

```typescript
// Complete validation and installation workflow
async function smartDeploy(batchFile: string) {
    const appManager = new ApplicationManager(instance);
    
    // Step 1: Validate
    console.log('Step 1: Validating applications...');
    const validation = await appManager.validateBatchDefinition(batchFile);
    
    console.log(`  Total: ${validation.totalApplications}`);
    console.log(`  Valid: ${validation.alreadyValid}`);
    console.log(`  Need Action: ${validation.needsInstallation + validation.needsUpgrade}`);
    
    if (!validation.isValid) {
        throw new Error('Validation failed with errors');
    }
    
    // Step 2: Check what needs to be done
    const needsAction = await appManager.getApplicationsNeedingAction(batchFile);
    
    if (needsAction.length === 0) {
        console.log('✓ All applications already up to date');
        return;
    }
    
    // Step 3: Show plan
    console.log('\nStep 2: Installation plan:');
    needsAction.forEach(app => {
        console.log(`  - ${app.id}: ${app.validationStatus}`);
    });
    
    // Step 4: Execute
    console.log('\nStep 3: Installing applications...');
    await appManager.installBatch(batchFile);
    
    console.log('✓ Deployment complete!');
}
```

---

### repairStoreApplication

Repairs an installed store or company application, as the **Repair Application** link on its
`sys_store_app` record does: the App Client reinstalls the **installed** version from the
application repository, without uninstalling the app, and reapplies its customization
version if it has one. Use it when an installed app is broken, or when an install or update
skipped files it should have applied.

```typescript
async repairStoreApplication(options: StoreAppRepairOptions): Promise<StoreAppRepairStart>
async repairStoreApplicationAndWait(options: StoreAppRepairOptions, pollIntervalMs?: number,
    timeoutMs?: number, onProgress?: OperationProgressCallback): Promise<StoreAppRepairResult>
async waitForStoreApplicationRepair(started: StoreAppRepairStart, pollIntervalMs?: number,
    timeoutMs?: number, onProgress?: OperationProgressCallback): Promise<StoreAppRepairResult>
```

#### Options

| Option | Type | Description |
|--------|------|-------------|
| `app` | `string` | The installed app's `sys_store_app` sys_id, or its scope |
| `loadDemoData` | `boolean` | Also load demo data. Refused for an app that has none |

#### What it checks first

As the platform does, it refuses (`StoreAppRepairError`, with a `code`) before sending anything:

| Code | When |
|------|------|
| `invalid_app` | `app` is neither a sys_id nor a scope |
| `app_not_found` | No installed store or company app matches |
| `not_a_store_app` | The app was developed on this instance (`sys_app`): there is no repository copy |
| `app_inactive` | The app is not active |
| `contains_plugins` | The app contains plugins; repair it from the UI, which sends the plugin list |
| `no_demo_data` | `loadDemoData` for an app without demo data |
| `start_failed` | The App Client refused or returned no tracker (`detail.status`, `detail.serverMessage`) |

#### How it repairs

- With queued installation on (`sn_appclient.use_queued_installation`, the default) it calls
  `GET /api/sn_appclient/appmanager/app/repair`. A queued repair can wait several minutes
  before it runs.
- With it off, the repair endpoint hands its reinstall flag on as a boolean where the App
  Client compares a string, and the "repair" becomes *no upgrade necessary*. In that case
  it calls `app/install` with `isReinstall=true`, which reaches the reinstall. `endpoint` in
  the result says which was used.
- The App Client reports success for *no upgrade necessary* as well, so the wait also reads
  `sys_upgrade_history` (`to_version` = the scope). `repaired` is true only when the
  tracker succeeded **and** a new history row appeared. `history` carries that row's counts
  and up to 50 files that were not applied (skipped, errors, manual merge, apply-once), read
  from `sys_upgrade_history_log` without their payloads.

A repair is a write: `--read-only` / `--deny-write` refuse it at the HTTP layer.

#### Example

```typescript
const result = await appManager.repairStoreApplicationAndWait({ app: 'x_acme_app' });
if (!result.repaired) console.warn(result.error ?? result.warnings.join('\n'));
for (const file of result.history?.skippedFiles ?? []) {
    console.log(`${file.dispositionLabel}: ${file.type} ${file.targetName} (${file.fileName})`);
}
```

## Interfaces

### ApplicationValidationResult

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
```

### BatchValidationResult

```typescript
interface BatchValidationResult {
    applications: ApplicationValidationResult[];
    totalApplications: number;
    alreadyValid: number;
    needsInstallation: number;
    needsUpgrade: number;
    errors: number;
    isValid: boolean;
}
```

## Examples

### Example 1: Pre-Deployment Validation

```typescript
async function preDeploymentCheck() {
    const appManager = new ApplicationManager(instance);
    const validation = await appManager.validateBatchDefinition('./apps.json');
    
    if (validation.errors > 0) {
        console.error('❌ Validation errors detected');
        validation.applications
            .filter(app => app.validationStatus === 'error')
            .forEach(app => console.error(`  - ${app.id}: ${app.error}`));
        return false;
    }
    
    if (validation.needsInstallation + validation.needsUpgrade === 0) {
        console.log('✅ All applications are already up to date');
        return true;
    }
    
    console.log(`⚠️  ${validation.needsInstallation} apps to install`);
    console.log(`⚠️  ${validation.needsUpgrade} apps to upgrade`);
    return true;
}
```

### Example 2: Selective Installation

```typescript
async function installOnlyMissing() {
    const appManager = new ApplicationManager(instance);
    
    // Get all apps that need action
    const needsAction = await appManager.getApplicationsNeedingAction('./apps.json');
    
    // Filter to only not-installed apps (skip upgrades)
    const needsInstall = needsAction.filter(
        app => app.validationStatus === 'not_installed'
    );
    
    if (needsInstall.length > 0) {
        console.log(`Installing ${needsInstall.length} missing applications...`);
        // Create a custom batch with only these apps
        // Then install
    }
}
```

### Example 3: Version Report

```typescript
async function generateVersionReport() {
    const appManager = new ApplicationManager(instance);
    const validation = await appManager.validateBatchDefinition('./apps.json');
    
    console.log('=== Application Version Report ===\n');
    
    validation.applications.forEach(app => {
        console.log(`Application: ${app.name || app.id}`);
        console.log(`  Requested: ${app.requested_version}`);
        console.log(`  Installed: ${app.installed_version || 'Not installed'}`);
        console.log(`  Status: ${app.validationStatus}`);
        console.log('');
    });
}
```

## Best Practices

1. **Always Validate First**: Run validation before installation
2. **Check Errors**: Inspect `validation.errors` before proceeding
3. **Handle Version Mismatches**: Decide policy for `mismatch` status
4. **Monitor Progress**: Use proper timeout and error handling for batch installs
5. **Log Operations**: Keep detailed logs of all operations for auditing

## Related

- [Getting Started Guide](./GettingStarted.md)
- [App Repository Documentation](./AppRepoApplication.md)
- [API Reference](./APIReference.md)
- [Examples](./Examples.md)

