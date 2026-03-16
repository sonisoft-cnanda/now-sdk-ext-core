import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { getCredentials } from "@servicenow/sdk-cli/dist/auth/index.js";
import { SN_INSTANCE_ALIAS } from '../../../test_utils/test_config';

import {
    CompanyApplications,
    CompanyApplication,
    CompanyApplicationsResponse
} from '../../../../src/sn/application/CompanyApplications';

import {
    AppRepoApplication,
    AppRepoInstallRequest,
    AppRepoInstallResponse,
    AppRepoOperationResult
} from '../../../../src/sn/application/AppRepoApplication';

describe('CompanyApplications Integration Tests', () => {
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

    describe('getCompanyApplications', () => {
        it('should retrieve list of company applications', async () => {
            const companyApps = new CompanyApplications(instance);
            const response: CompanyApplicationsResponse = await companyApps.getCompanyApplications();
            
            console.log('\n=== Company Applications Response ===');
            console.log(`Total Applications: ${response.data.length}`);
            console.log(`Processing Time: ${response.dataProcessingTime}ms`);
            console.log(`Repository Response Time: ${response.reporesponsetime}ms`);
            console.log(`Store URL: ${response.storeURL}`);
            
            expect(response).toBeDefined();
            expect(response.data).toBeDefined();
            expect(Array.isArray(response.data)).toBe(true);
            expect(response.data.length).toBeGreaterThan(0);
            expect(response.appServer).toBeDefined();
            expect(response.storeURL).toBeDefined();
            
            // Log first few applications
            console.log('\nFirst 5 Applications:');
            response.data.slice(0, 5).forEach((app, index) => {
                console.log(`  ${index + 1}. ${app.name}`);
                console.log(`     Scope: ${app.scope}`);
                console.log(`     Version: ${app.latest_version}`);
                console.log(`     Installed: ${app.isInstalled}`);
                console.log(`     Vendor: ${app.vendor}`);
            });
        }, 60 * SECONDS);

        it('should retrieve and filter applications by vendor', async () => {
            const companyApps = new CompanyApplications(instance);
            const response: CompanyApplicationsResponse = await companyApps.getCompanyApplications();
            
            // Filter by vendor
            const vendorApps = response.data.filter(app => app.vendor === '<vendor_name>');

            console.log(`\nFound ${vendorApps.length} vendor applications:`);
            vendorApps.forEach(app => {
                console.log(`  - ${app.name} (${app.scope}) - v${app.latest_version}`);
            });

            expect(vendorApps.length).toBeGreaterThan(0);
        }, 60 * SECONDS);

        it('should retrieve and show application details', async () => {
            const companyApps = new CompanyApplications(instance);
            const response: CompanyApplicationsResponse = await companyApps.getCompanyApplications();
            
            if (response.data.length > 0) {
                const firstApp = response.data[0];
                
                console.log('\n=== Application Details ===');
                console.log(`Name: ${firstApp.name}`);
                console.log(`Scope: ${firstApp.scope}`);
                console.log(`Sys ID: ${firstApp.sys_id}`);
                console.log(`Latest Version: ${firstApp.latest_version}`);
                console.log(`Is Installed: ${firstApp.isInstalled}`);
                console.log(`Vendor: ${firstApp.vendor}`);
                console.log(`Dependencies: ${firstApp.dependencies || 'None'}`);
                console.log(`Can Install/Upgrade: ${firstApp.can_install_or_upgrade}`);
                console.log(`Available Versions: ${firstApp.versions.length}`);
                
                if (firstApp.versions.length > 0) {
                    console.log('\nVersion History:');
                    firstApp.versions.forEach((version, idx) => {
                        console.log(`  ${idx + 1}. v${version.version} - ${version.publish_date_display}`);
                        if (version.dependencies) {
                            console.log(`     Dependencies: ${version.dependencies}`);
                        }
                    });
                }
                
                expect(firstApp.name).toBeDefined();
                expect(firstApp.scope).toBeDefined();
                expect(firstApp.sys_id).toBeDefined();
                expect(firstApp.versions).toBeDefined();
                expect(Array.isArray(firstApp.versions)).toBe(true);
            }
        }, 60 * SECONDS);
    });

    describe('getCompanyApplicationByScope', () => {
        it('should find a specific application by scope', async () => {
            const companyApps = new CompanyApplications(instance);
            
            // First get all apps to find a valid scope
            const allApps = await companyApps.getCompanyApplications();
            expect(allApps.data.length).toBeGreaterThan(0);
            
            const testScope = allApps.data[0].scope;
            
            // Now search for it by scope
            const app = await companyApps.getCompanyApplicationByScope(testScope);
            
            expect(app).toBeDefined();
            expect(app?.scope).toBe(testScope);
            expect(app?.name).toBeDefined();
            
            console.log(`\nFound application by scope '${testScope}':`);
            console.log(`  Name: ${app?.name}`);
            console.log(`  Latest Version: ${app?.latest_version}`);
        }, 60 * SECONDS);

        it('should return null for non-existent scope', async () => {
            const companyApps = new CompanyApplications(instance);
            const app = await companyApps.getCompanyApplicationByScope('x_non_existent_scope_12345');
            
            expect(app).toBeNull();
        }, 60 * SECONDS);
    });

    describe('getCompanyApplicationBySysId', () => {
        it('should find a specific application by sys_id', async () => {
            const companyApps = new CompanyApplications(instance);
            
            // First get all apps to find a valid sys_id
            const allApps = await companyApps.getCompanyApplications();
            expect(allApps.data.length).toBeGreaterThan(0);
            
            const testSysId = allApps.data[0].sys_id;
            
            // Now search for it by sys_id
            const app = await companyApps.getCompanyApplicationBySysId(testSysId);
            
            expect(app).toBeDefined();
            expect(app?.sys_id).toBe(testSysId);
            expect(app?.name).toBeDefined();
            
            console.log(`\nFound application by sys_id '${testSysId}':`);
            console.log(`  Name: ${app?.name}`);
            console.log(`  Scope: ${app?.scope}`);
        }, 60 * SECONDS);

        it('should return null for non-existent sys_id', async () => {
            const companyApps = new CompanyApplications(instance);
            const app = await companyApps.getCompanyApplicationBySysId('invalid_sys_id_1234567890');
            
            expect(app).toBeNull();
        }, 60 * SECONDS);
    });

    describe('getInstalledCompanyApplications', () => {
        it('should retrieve only installed company applications', async () => {
            const companyApps = new CompanyApplications(instance);
            const installedApps = await companyApps.getInstalledCompanyApplications();
            
            console.log(`\nFound ${installedApps.length} installed company applications:`);
            installedApps.forEach((app, idx) => {
                console.log(`  ${idx + 1}. ${app.name} - v${app.version}`);
                console.log(`     Scope: ${app.scope}`);
            });
            
            expect(installedApps).toBeDefined();
            expect(Array.isArray(installedApps)).toBe(true);
            
            // Verify all returned apps are actually installed
            installedApps.forEach(app => {
                expect(app.isInstalled).toBe(true);
                expect(app.version).toBeDefined();
                expect(app.version.length).toBeGreaterThan(0);
            });
        }, 60 * SECONDS);
    });

    describe('Integration: CompanyApplications + AppRepoApplication', () => {
        it('should get company apps and identify installable applications', async () => {
            console.log('\n=== Integration Test: List & Identify Installable Apps ===');
            
            const companyApps = new CompanyApplications(instance);
            const response = await companyApps.getCompanyApplications();
            
            console.log(`\nTotal company applications found: ${response.data.length}`);
            
            // Find applications that are not installed but can be installed
            const installableApps = response.data.filter(app => 
                !app.isInstalled && app.can_install_or_upgrade
            );
            
            console.log(`\nApplications that can be installed (not currently installed): ${installableApps.length}`);
            
            if (installableApps.length > 0) {
                console.log('\nInstallable Applications:');
                installableApps.slice(0, 10).forEach((app, idx) => {
                    console.log(`  ${idx + 1}. ${app.name}`);
                    console.log(`     Scope: ${app.scope}`);
                    console.log(`     Sys ID: ${app.sys_id}`);
                    console.log(`     Latest Version: ${app.latest_version}`);
                    console.log(`     Vendor: ${app.vendor}`);
                    if (app.dependencies) {
                        console.log(`     Dependencies: ${app.dependencies}`);
                    }
                });
            }
            
            // Find applications that need updates
            const updateableApps = response.data.filter(app => 
                app.isInstalled && app.can_install_or_upgrade
            );
            
            console.log(`\nApplications that can be upgraded (currently installed): ${updateableApps.length}`);
            
            expect(response.data.length).toBeGreaterThan(0);
        }, 60 * SECONDS);

        it('should prepare install request from company application data', async () => {
            console.log('\n=== Preparing Install Request from Company App Data ===');
            
            const companyApps = new CompanyApplications(instance);
            const response = await companyApps.getCompanyApplications();
            
            // Find an application that can be installed
            const installableApp = response.data.find(app => 
                !app.isInstalled && app.can_install_or_upgrade && !app.block_install
            );
            
            if (installableApp) {
                console.log(`\nSelected application for install preparation:`);
                console.log(`  Name: ${installableApp.name}`);
                console.log(`  Scope: ${installableApp.scope}`);
                console.log(`  Sys ID: ${installableApp.sys_id}`);
                console.log(`  Latest Version: ${installableApp.latest_version}`);
                
                // Prepare the install request
                const installRequest: AppRepoInstallRequest = {
                    scope: installableApp.scope,
                    sys_id: installableApp.sys_id,
                    version: installableApp.latest_version
                };
                
                console.log(`\nPrepared Install Request:`);
                console.log(JSON.stringify(installRequest, null, 2));
                
                expect(installRequest.scope).toBeDefined();
                expect(installRequest.sys_id).toBeDefined();
                expect(installRequest.version).toBeDefined();
                
                console.log(`\n✓ Install request prepared successfully`);
                console.log(`  (Actual installation not executed in this test)`);
            } else {
                console.log('\nNo installable applications found (all may already be installed)');
            }
        }, 60 * SECONDS);

        // NOTE: This test actually installs an application - use with caution!
        it('should complete full workflow: list -> select -> install application', async () => {
            console.log('\n=== Full Integration Workflow: List -> Select -> Install ===');
            
            // Step 1: Get company applications
            console.log('\nStep 1: Fetching company applications...');
            const companyApps = new CompanyApplications(instance);
            const response = await companyApps.getCompanyApplications();
            
            console.log(`  Found ${response.data.length} company applications`);
            
            // Step 2: Select an application to install
            // IMPORTANT: Modify this to select a specific test application
            const targetScope = '<app_scope>'; // Replace with actual test app scope
            const selectedApp = response.data.find(app => 
                app.scope === targetScope && !app.isInstalled && app.can_install_or_upgrade
            );
            
            if (!selectedApp) {
                console.log(`\nNo suitable application found with scope '${targetScope}'`);
                console.log('Skipping installation test.');
                return;
            }
            
            console.log('\nStep 2: Selected application for installation:');
            console.log(`  Name: ${selectedApp.name}`);
            console.log(`  Scope: ${selectedApp.scope}`);
            console.log(`  Sys ID: ${selectedApp.sys_id}`);
            console.log(`  Version: ${selectedApp.latest_version}`);
            
            // Step 3: Prepare install request
            const installRequest: AppRepoInstallRequest = {
                scope: selectedApp.scope,
                sys_id: selectedApp.sys_id,
                version: selectedApp.latest_version
            };
            
            console.log('\nStep 3: Initiating installation...');
            const appRepo = new AppRepoApplication(instance);
            const installResponse: AppRepoInstallResponse = await appRepo.installFromAppRepo(installRequest);
            
            console.log(`  Install initiated (Progress ID: ${installResponse.links.progress.id})`);
            console.log(`  Initial status: ${installResponse.status_label}`);
            console.log(`  Initial progress: ${installResponse.percent_complete}%`);
            
            // Step 4: Monitor installation progress
            console.log('\nStep 4: Monitoring installation progress...');
            let progress = await appRepo.getProgress(installResponse.links.progress.id);
            
            let iterations = 0;
            const maxIterations = 120; // 10 minutes max
            
            while (progress.percent_complete < 100 && iterations < maxIterations) {
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
                progress = await appRepo.getProgress(installResponse.links.progress.id);
                console.log(`  Progress: ${progress.percent_complete}% - ${progress.status_label}`);
                iterations++;
            }
            
            // Step 5: Verify installation completion
            console.log('\nStep 5: Verifying installation...');
            expect(progress.percent_complete).toBe(100);
            
            if (progress.status === "2") { // Status 2 = Successful
                console.log('✓ Installation completed successfully!');
                
                // Verify the app is now installed
                const verifyApp = await companyApps.getCompanyApplicationByScope(selectedApp.scope);
                console.log(`\nInstalled Application Status:`);
                console.log(`  Is Installed: ${verifyApp?.isInstalled}`);
                console.log(`  Installed Version: ${verifyApp?.version}`);
                
                expect(verifyApp?.isInstalled).toBe(true);
            } else {
                console.log(`✗ Installation failed with status: ${progress.status_label}`);
                console.log(`  Error: ${progress.error || progress.status_message}`);
                throw new Error(`Installation failed: ${progress.status_label}`);
            }
            
            console.log('\n=== Workflow Complete ===');
        }, 600 * SECONDS); // 10 minute timeout for full installation
    });

    describe('Application Version Analysis', () => {
        it('should analyze version information for company applications', async () => {
            const companyApps = new CompanyApplications(instance);
            const response = await companyApps.getCompanyApplications();
            
            console.log('\n=== Application Version Analysis ===');
            
            // Find apps with multiple versions
            const appsWithMultipleVersions = response.data.filter(app => app.versions.length > 1);
            
            console.log(`\nApplications with multiple versions: ${appsWithMultipleVersions.length}`);
            
            if (appsWithMultipleVersions.length > 0) {
                const sampleApp = appsWithMultipleVersions[0];
                
                console.log(`\nSample Application: ${sampleApp.name}`);
                console.log(`Total Versions Available: ${sampleApp.versions.length}`);
                console.log(`Latest Version: ${sampleApp.latest_version}`);
                console.log(`Currently Installed: ${sampleApp.isInstalled ? sampleApp.version : 'Not Installed'}`);
                
                console.log('\nVersion History:');
                sampleApp.versions.forEach((version, idx) => {
                    console.log(`  ${idx + 1}. Version ${version.version}`);
                    console.log(`     Published: ${version.publish_date_display}`);
                    console.log(`     Upload Info: ${version.upload_info}`);
                    if (version.dependencies) {
                        console.log(`     Dependencies: ${version.dependencies}`);
                    }
                });
            }
            
            expect(response.data.length).toBeGreaterThan(0);
        }, 60 * SECONDS);

        it('should identify applications with dependencies', async () => {
            const companyApps = new CompanyApplications(instance);
            const response = await companyApps.getCompanyApplications();
            
            const appsWithDependencies = response.data.filter(app => 
                app.dependencies && app.dependencies.length > 0
            );
            
            console.log(`\nApplications with dependencies: ${appsWithDependencies.length}`);
            
            appsWithDependencies.slice(0, 5).forEach(app => {
                console.log(`\n  ${app.name} (${app.scope})`);
                console.log(`    Dependencies: ${app.dependencies}`);
            });
            
            expect(response.data.length).toBeGreaterThan(0);
        }, 60 * SECONDS);
    });
});

