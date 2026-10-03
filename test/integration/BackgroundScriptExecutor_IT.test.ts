import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../src/sn/ServiceNowInstance';
import { BackgroundScriptExecutor } from '../../src/sn/BackgroundScriptExecutor';
import { getCredentials } from "@servicenow/sdk-cli/dist/auth/index.js";
import { SN_INSTANCE_ALIAS } from '../test_utils/test_config';
import { isScriptScopeError } from '../../src/exception/ScriptScopeError';

import * as path from 'path';
import * as fs from 'fs';
import { info } from "console";


describe('BackgroundScriptExecutor', () => {
    let instance: ServiceNowInstance;
    let executor: BackgroundScriptExecutor | null = null;
    const TEST_SCOPE = 'global';


    beforeEach(async () => {

        const credential = await getCredentials(SN_INSTANCE_ALIAS);

         if(credential){
            const snSettings:ServiceNowSettingsInstance = {
            alias: SN_INSTANCE_ALIAS,
            credential: credential
            }
            instance = new ServiceNowInstance(snSettings);
            executor = new BackgroundScriptExecutor( instance,TEST_SCOPE );
        }
         
        if(executor == null)
            throw new Error("Could not get credentials.");
        
    });

    describe('getBackgroundScriptCSRFToken', () => {

        it('should return csrf token and log its format', async () => {
           const result:string | undefined = await executor?.getBackgroundScriptCSRFToken();

           console.log('\n=== CSRF Token Result ===');
           console.log('Token:', result);
           console.log('Token length:', result?.length);

           expect(result).toBeDefined();
           expect(result).not.toBeNull();
           expect(result.length).toBeGreaterThan(0);
        }, 100000);

    });
    
    describe('executeScript', () => {

        xit('should throw error if instance is not a ServiceNowInstance', () => {
            const script = 'testScript';
            const scope = TEST_SCOPE;
            const instance = {}; // mock object, not an instance of ServiceNowInstance
            // @ts-expect-error - returning arguments must be valid column names
            expect(() => executor.executeScript( script, scope, instance )).rejects.toThrow('instance must be a ServiceNowInstance')
        });

        xit('should throw error if scope is not a string', () => {
            const script = 'testScript';
            const scope = 123; // mock object, not a string
            // @ts-expect-error - returning arguments must be valid column names
            expect(() => executor.executeScript(script, scope, instance )).rejects.toThrow('scope must be a string')
        });

        xit('should throw error if script is not a string', () => {
            const scope = TEST_SCOPE;
            const script = 123; // mock object, not a string
            // @ts-expect-error - returning arguments must be valid column names
            expect(() => executor.executeScript( script, scope, instance )).rejects.toThrow('script must be a string')
        })

        it('should execute simple gs.info script and capture full payload', async () => {
            const sVal = "TESTING_BG_SCRIPT_" + Date.now();
            const script = `gs.info("${sVal}")`;
            const scope = TEST_SCOPE;
            const result = await executor?.executeScript(script, scope, instance);

            console.log('\n=== BackgroundScriptExecutor simple gs.info result ===');
            console.log('Full result:', JSON.stringify(result, null, 2));
            console.log('Raw XML (first 3000 chars):', result?.raw?.substring(0, 3000));

            expect(result).toBeDefined();
            expect(result).not.toBeNull();
            expect(result?.result).toBeDefined();
            expect(result?.result).toContain(sVal);
            expect(result?.scriptResults).toBeDefined();
            expect(Array.isArray(result?.scriptResults)).toBe(true);
        }, 100000);

        it('should execute script with debug output and capture payload', async () => {
            const script = `gs.info("INFO_LINE_1"); gs.debug("DEBUG_LINE_1"); gs.info("INFO_LINE_2");`;
            const scope = TEST_SCOPE;
            const result = await executor?.executeScript(script, scope, instance);

            console.log('\n=== BackgroundScriptExecutor debug output result ===');
            console.log('Full result:', JSON.stringify(result, null, 2));
            console.log('Console result lines:', result?.consoleResult);
            console.log('Script results:', JSON.stringify(result?.scriptResults, null, 2));
            console.log('Raw XML (first 3000 chars):', result?.raw?.substring(0, 3000));

            expect(result).toBeDefined();
            expect(result?.consoleResult).toBeDefined();
            expect(result?.consoleResult.length).toBeGreaterThanOrEqual(1);
        }, 100000);

        it('should execute script with mixed system and script output', async () => {
            // This script generates both system output and script output
            const script = `
                var gr = new GlideRecord("sys_properties");
                gr.setLimit(1);
                gr.query();
                if(gr.next()){
                    gs.info("Property: " + gr.getValue("name"));
                }
                gs.info("Script complete");
            `;
            const scope = TEST_SCOPE;
            const result = await executor?.executeScript(script, scope, instance);

            console.log('\n=== BackgroundScriptExecutor mixed output result ===');
            console.log('Full result:', JSON.stringify(result, null, 2));
            console.log('Console result lines:', result?.consoleResult);
            console.log('Script results classification:', result?.scriptResults?.map(sr => ({
                line: (sr as any)._line,
                isDebug: (sr as any)._isDebug,
                isSystem: (sr as any)._isSystem,
                isScript: (sr as any)._isScript
            })));
            console.log('Raw XML (first 3000 chars):', result?.raw?.substring(0, 3000));

            expect(result).toBeDefined();
            expect(result?.consoleResult).toBeDefined();
        }, 100000);

        it('should execute script from file with given scope', async () => {
            const filePath:string = path.resolve('./test/unit/testScript1.js');
            if (!fs.existsSync(filePath)) {
                console.log('Skipping: testScript1.js not found at', filePath);
                return;
            }
            const script:string = fs.readFileSync(filePath).toString('utf8');

            const scope = TEST_SCOPE;
            const result = await executor?.executeScript(script, scope, instance);

            console.log('\n=== BackgroundScriptExecutor file script result ===');
            console.log('Full result:', JSON.stringify(result, null, 2));

            expect(result).toBeDefined();
            expect(result).not.toBeNull();
            expect(result?.result).toBeDefined();

            const consoleResult:string[] = result?.consoleResult;
            expect(consoleResult.length).toBeGreaterThan(1);
        }, 100000);

    })

    describe('executeScript - bug fix validations', () => {

        // NEX-2: Script that produces no gs.print/gs.info output should not crash
        it('should handle script with no output (NEX-2)', async () => {
            const script = `var x = 1 + 1;`;
            const result = await executor?.executeScript(script, TEST_SCOPE, instance);

            console.log('\n=== NEX-2: No output script ===');
            console.log('Full result:', JSON.stringify(result, null, 2));

            expect(result).toBeDefined();
            expect(result).not.toBeNull();
            expect(result?.scriptResults).toBeDefined();
            expect(Array.isArray(result?.scriptResults)).toBe(true);
            // No crash — the key assertion for NEX-2
        }, 100000);

        // NEX-2 variant: Script that only queries records without printing
        it('should handle GlideRecord query with no output (NEX-2)', async () => {
            const script = `
                var gr = new GlideRecord("sys_properties");
                gr.setLimit(1);
                gr.query();
                gr.next();
            `;
            const result = await executor?.executeScript(script, TEST_SCOPE, instance);

            console.log('\n=== NEX-2: GlideRecord no output ===');
            console.log('Full result:', JSON.stringify(result, null, 2));

            expect(result).toBeDefined();
            expect(result).not.toBeNull();
            // Should return empty arrays, not crash
            expect(Array.isArray(result?.scriptResults)).toBe(true);
            expect(Array.isArray(result?.consoleResult)).toBe(true);
        }, 100000);

        // NEX-13: Validates that real ServiceNow HTML with void elements parses correctly
        // The raw response contains <HR/>, <BR/>, and potentially </meta>, </link> in HEAD
        it('should parse real response HTML without void element errors (NEX-13)', async () => {
            const script = `gs.info("void_element_test")`;
            const result = await executor?.executeScript(script, TEST_SCOPE, instance);

            console.log('\n=== NEX-13: Void element handling ===');
            console.log('Raw HTML (first 500 chars):', result?.raw?.substring(0, 500));

            expect(result).toBeDefined();
            expect(result?.result).toContain("void_element_test");
            // Verify the raw response contains void elements that would have crashed before
            expect(result?.raw).toContain('<HR/>');
            expect(result?.raw).toContain('<BR/>');
        }, 100000);

        // NEX-14: Validates stopNodes case handling — real SN returns uppercase <PRE>
        it('should correctly extract content from uppercase PRE tags (NEX-14)', async () => {
            const uniqueVal = "STOPNODE_TEST_" + Date.now();
            const script = `gs.info("${uniqueVal}")`;
            const result = await executor?.executeScript(script, TEST_SCOPE, instance);

            console.log('\n=== NEX-14: stopNodes case test ===');
            console.log('Raw result:', result?.rawResult);
            console.log('Script results:', JSON.stringify(result?.scriptResults, null, 2));

            expect(result).toBeDefined();
            // Verify that the uppercase <PRE> content was extracted (not empty)
            expect(result?.rawResult).toContain(uniqueVal);
            // Verify script line was classified correctly
            const scriptLines = result?.scriptResults?.filter(
                (l: any) => (l as any)._isScript === true
            );
            expect(scriptLines?.length).toBeGreaterThan(0);
        }, 100000);

        // NEX-15: Validates error cause is preserved when script execution fails
        it('should preserve error cause on invalid instance (NEX-15)', async () => {
            const badInstance = new ServiceNowInstance({
                alias: 'nonexistent-instance-12345',
                credential: { instanceUrl: '<servicenow_instance_url>', token: 'bad' } as any
            });
            const badExecutor = new BackgroundScriptExecutor(badInstance, TEST_SCOPE);

            try {
                await badExecutor.executeScript('gs.info("test")', TEST_SCOPE, badInstance);
                expect(true).toBe(false); // should not reach here
            } catch (error) {
                console.log('\n=== NEX-15: Error cause preservation ===');
                console.log('Error message:', (error as Error).message);
                console.log('Has cause:', !!(error as Error).cause);

                expect((error as Error).message).toContain('Error executing script');
                expect((error as Error).cause).toBeDefined();
            }
        }, 100000);

        // NEX-2 + NEX-13 combined: Insert a record (the original reported scenario)
        it('should execute insert script and return result without parsing errors', async () => {
            // Insert and immediately delete to avoid test data pollution
            const script = `
                var gr = new GlideRecord("incident");
                gr.initialize();
                gr.setValue("short_description", "NEX_INTEGRATION_TEST_" + new Date().getTime());
                gr.setValue("category", "inquiry");
                var sys_id = gr.insert();
                gs.info("Inserted: " + sys_id);
                // Clean up
                if (sys_id) {
                    var del = new GlideRecord("incident");
                    if (del.get(sys_id)) {
                        del.deleteRecord();
                        gs.info("Cleaned up: " + sys_id);
                    }
                }
            `;
            const result = await executor?.executeScript(script, TEST_SCOPE, instance);

            console.log('\n=== NEX-2+13: Insert script result ===');
            console.log('Full result:', JSON.stringify(result, null, 2));

            expect(result).toBeDefined();
            expect(result).not.toBeNull();
            expect(result?.rawResult).toContain("Inserted:");
            expect(result?.scriptResults?.length).toBeGreaterThan(0);
        }, 100000);
    });

    describe('parseScriptResult', () => {
        it('should parse script result with known XML', async () => {
            const xmlBody = `[0:00:00.066]
                <HTML>
                    <BODY>
                        Script completed in scope global: script<HR/>
                        Script execution history and recovery <A target='blank' HREF='sys_script_execution_history.do?sys_id=8453505893a30210e1feb2ddfaba102c'>available here</A>
                        <HR/>
                        <PRE>
                            *** Script: testResult<BR/>
                        </PRE>
                        <HR/>
                    </BODY>
                </HTML>`;
            const resultObj = executor?.parseScriptResult(xmlBody);

            console.log('\n=== parseScriptResult result ===');
            console.log('Full parsed result:', JSON.stringify(resultObj, null, 2));

            expect(resultObj).toBeDefined();
            expect(resultObj?.result).toContain("testResult");
        });

        it('should parse XML with multiple output lines', async () => {
            const xmlBody = `[0:00:00.100]
                <HTML>
                    <BODY>
                        Script completed in scope global: script<HR/>
                        <HR/>
                        <PRE>
                            *** Script: Line 1
*** Script: Line 2
*** Script: [DEBUG] Debug line
System output here<BR/>
                        </PRE>
                        <HR/>
                    </BODY>
                </HTML>`;
            const resultObj = executor?.parseScriptResult(xmlBody);

            console.log('\n=== parseScriptResult multi-line result ===');
            console.log('Full parsed result:', JSON.stringify(resultObj, null, 2));
            console.log('Console result:', resultObj?.consoleResult);
            console.log('Script results:', JSON.stringify(resultObj?.scriptResults, null, 2));

            expect(resultObj).toBeDefined();
            expect(resultObj?.consoleResult.length).toBeGreaterThan(0);
        });
    })

    describe('executeScriptViaTrigger', () => {
        it('should create a sys_trigger record to execute a script', async () => {
            const script = `gs.info('NEX_IT_TRIGGER_TEST_${Date.now()}');`;
            const result = await executor?.executeScriptViaTrigger(script, 'IT Test Trigger', true);

            console.log('\n=== executeScriptViaTrigger Result ===');
            console.log('Result:', JSON.stringify(result, null, 2));

            expect(result).toBeDefined();
            expect(result!.success).toBe(true);
            expect(result!.triggerSysId).toBeDefined();
            expect(result!.triggerSysId.length).toBeGreaterThan(0);
            expect(result!.triggerName).toBe('IT Test Trigger');
            expect(result!.autoDelete).toBe(true);
            expect(result!.message).toContain('created successfully');
        }, 100000);
    });

    describe('executeScriptAuto', () => {
        it('should execute a script using the best available method', async () => {
            const script = `gs.info('NEX_IT_AUTO_TEST_${Date.now()}');`;
            const result = await executor?.executeScriptAuto(script, TEST_SCOPE);

            console.log('\n=== executeScriptAuto Result ===');
            console.log('Result:', JSON.stringify(result, null, 2));

            expect(result).toBeDefined();
            // Result could be either BackgroundScriptExecutionResult or TriggerExecutionResult
            // Just verify we got something back
            if ('triggerSysId' in result!) {
                expect(result!.success).toBe(true);
                expect(result!.triggerSysId).toBeDefined();
            } else {
                expect(result!.raw).toBeDefined();
            }
        }, 100000);
    });

    describe('scope resolution', () => {
        // scope=global alone matches every global-scoped application in sys_scope;
        // the Global scope itself is the row with source=global.
        it('should run "global" in the Global scope itself', async () => {
            const result = await executor?.executeScript(`gs.info('SCOPE_IT=' + gs.getCurrentScopeName());`, 'global', instance);

            expect(result?.raw).toContain('Script completed in scope global');
            expect(result?.result).toContain('SCOPE_IT=rhino.global');
        }, 100000);

        it('should refuse a scope that is no application, before sending the script', async () => {
            const error = await executor?.executeScript(`gs.info('SHOULD_NOT_RUN');`, 'x_nex_it_no_such_scope', instance)
                .catch((e: unknown) => e);

            expect(isScriptScopeError(error)).toBe(true);
            expect((error as { reason?: string }).reason).toBe('SCOPE_NOT_FOUND');
            expect((error as Error).message).toContain('x_nex_it_no_such_scope');
        }, 100000);

        it('should refuse a sys_id that is no application, before sending the script', async () => {
            const error = await executor?.executeScript(`gs.info('SHOULD_NOT_RUN');`, '0123456789abcdef0123456789abcdef', instance)
                .catch((e: unknown) => e);

            expect(isScriptScopeError(error)).toBe(true);
            expect((error as { reason?: string }).reason).toBe('SCOPE_NOT_FOUND');
        }, 100000);
    });
});
