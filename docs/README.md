# ServiceNow SDK Extension Core

> A comprehensive TypeScript SDK for ServiceNow CI/CD operations, application management, and automated testing.

## Overview

The ServiceNow SDK Extension Core provides a powerful, type-safe interface for automating ServiceNow development workflows including:

- 🚀 **Application Management** - Install, publish, and validate ServiceNow applications
- 📦 **App Repository Operations** - Manage applications in your company's app repository
- 🧪 **Automated Testing** - Execute and manage ATF (Automated Test Framework) tests and suites
- ✅ **Batch Operations** - Install multiple applications in a single operation
- 📊 **Progress Monitoring** - Track long-running operations with built-in progress tracking
- 🔄 **Version Management** - Compare and validate application versions

## Installation

```bash
npm install @sonisoft/now-sdk-ext-core
```

## Quick Start

```typescript
import { 
    ServiceNowInstance, 
    ApplicationManager,
    AppRepoApplication,
    ATFTestExecutor 
} from '@sonisoft/now-sdk-ext-core';
import { getCredentials } from '@servicenow/sdk-cli/dist/auth';

// Setup instance connection
const credential = await getCredentials('my-instance-alias');
const instance = new ServiceNowInstance({
    alias: 'my-instance-alias',
    credential: credential
});

// Use the SDK
const appManager = new ApplicationManager(instance);
const appDetails = await appManager.getApplicationDetails('app-sys-id');
console.log(`Application: ${appDetails.name} v${appDetails.version}`);
```

## Core Components

### 1. Application Management

Manage ServiceNow applications with comprehensive validation and batch operations.

```typescript
const appManager = new ApplicationManager(instance);

// Validate batch installation
const validation = await appManager.validateBatchDefinition('./batch.json');
console.log(`${validation.alreadyValid} apps already valid`);
console.log(`${validation.needsInstallation} apps need installation`);

// Install batch
await appManager.installBatch('./batch.json');
```

[→ Full ApplicationManager Documentation](./ApplicationManager.md)

### 2. App Repository Operations

Install and publish applications to/from your company's app repository.

```typescript
const appRepo = new AppRepoApplication(instance);

// Publish to repository
const publishResult = await appRepo.publishToAppRepoAndWait({
    scope: 'x_my_app',
    sys_id: 'app-sys-id',
    version: '1.0.0',
    dev_notes: 'Initial release'
});

// Install from repository
const installResult = await appRepo.installFromAppRepoAndWait({
    scope: 'x_my_app',
    sys_id: 'app-sys-id',
    version: '1.0.0'
});
```

[→ Full AppRepoApplication Documentation](./AppRepoApplication.md)

### 3. Automated Test Framework (ATF)

Execute ATF tests and test suites programmatically.

```typescript
const testExecutor = new ATFTestExecutor(instance);

// Execute a single test
const testResult = await testExecutor.executeTest('test-sys-id');

// Execute a test suite
const suiteResult = await testExecutor.executeTestSuiteAndWait('suite-sys-id', {
    browser_name: 'chrome',
    run_in_cloud: false
});

console.log(`Tests: ${suiteResult.total_tests}, Passed: ${suiteResult.passed_tests}`);
```

[→ Full ATFTestExecutor Documentation](./ATFTestExecutor.md)

## Key Features

### Type Safety

Full TypeScript support with comprehensive type definitions:

```typescript
interface ApplicationValidationResult {
    id: string;
    name?: string;
    requested_version: string;
    installed_version?: string;
    isInstalled: boolean;
    isVersionMatch: boolean;
    validationStatus: 'valid' | 'mismatch' | 'not_installed' | 'update_needed' | 'error';
    needsAction: boolean;
    error?: string;
}
```

### Progress Monitoring

Built-in progress tracking for long-running operations:

```typescript
const response = await appRepo.publishToAppRepo(request);
const progressId = response.links.progress.id;

let progress = await appRepo.getProgress(progressId);
while (progress.percent_complete < 100) {
    console.log(`Progress: ${progress.percent_complete}%`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    progress = await appRepo.getProgress(progressId);
}
```

### Error Handling

Comprehensive error handling with detailed error messages:

```typescript
try {
    await appManager.validateBatchDefinition('./batch.json');
} catch (error) {
    console.error(`Validation failed: ${error.message}`);
}
```

## Documentation

- [Getting Started Guide](./GettingStarted.md) - Step-by-step setup and basic usage
- [Application Manager](./ApplicationManager.md) - Application management and validation
- [App Repository](./AppRepoApplication.md) - Repository install and publish operations
- [ATF Test Executor](./ATFTestExecutor.md) - Automated test execution
- [Script Tracer](./script_tracer/README.md) - Real-time server-side script tracing
- [ActiveSessionRegistry](./ActiveSessionRegistry.md) - Stateful workflow sessions for MCP and CLI
- [API Reference](./APIReference.md) - Complete API documentation
- [Examples & Recipes](./Examples.md) - Common use cases and patterns

## Requirements

- Node.js 18+ or Node.js 20+
- TypeScript 5.0+
- ServiceNow instance with CI/CD API enabled
- Valid ServiceNow credentials configured via `@servicenow/sdk-cli`

## Authentication

This SDK uses the ServiceNow CLI authentication system. Set up your credentials:

```bash
# Add instance credentials
npx @servicenow/sdk auth --add my-instance

# Use in your code
const credential = await getCredentials('my-instance');
```

## CI/CD Integration

Perfect for integration with CI/CD pipelines:

```typescript
// In your CI/CD script
async function deployApplication() {
    const appManager = new ApplicationManager(instance);
    
    // 1. Validate applications
    const validation = await appManager.validateBatchDefinition('./apps.json');
    if (!validation.isValid) {
        throw new Error('Validation failed');
    }
    
    // 2. Install only what's needed
    const needsAction = await appManager.getApplicationsNeedingAction('./apps.json');
    console.log(`Installing ${needsAction.length} applications`);
    
    // 3. Run tests
    const testExecutor = new ATFTestExecutor(instance);
    const testResults = await testExecutor.executeTestSuiteAndWait('test-suite-id');
    
    if (testResults.failed_tests > 0) {
        throw new Error(`${testResults.failed_tests} tests failed`);
    }
}
```

## Support

- [GitHub Issues](https://github.com/sonisoft-cnanda/nowsdk-ext-core/issues)
- [API Documentation](./APIReference.md)
- [Examples](./Examples.md)

## License

See [LICENSE](../LICENSE) file for details.

## Contributing

Contributions are welcome! Please see our contributing guidelines.

---

**Built with ❤️ for the ServiceNow Developer Community**

