
import { ServiceNowProcessorRequest } from "../../comm/http/ServiceNowProcessorRequest";
import { ServiceNowRequest } from "../../comm/http/ServiceNowRequest";
import { ReferenceLink, ServiceNowTableResponse } from "../../model/types";
import { HTTPRequest } from "../../comm/http/HTTPRequest";
import { IHttpResponse } from "../../comm/http/IHttpResponse";
import { ServiceNowInstance } from "../ServiceNowInstance";
import { ProgressResult, ProgressResultResponse } from "../ProgressWorker";
import { OperationProgressCallback, createProgressEmitter } from "../OperationProgress";


export class ATFTestExecutor{

    _req:ServiceNowRequest = new ServiceNowRequest();

    _instance:ServiceNowInstance;

    public constructor(instance:ServiceNowInstance){
        this._instance = instance;
        this._req = new ServiceNowRequest(instance);
    }

    async executeTest(testId:string):Promise<TestResult>{

        const dataObj = {
           
            'sysparm_want_session_messages':'true',
            'sysparm_ajax_processor_ut_test_id':testId,
            'sysparm_ajax_processor_test_runner_session_id':'',
            'sysparm_ajax_processor_is_pausing_enabled':'',
            'sysparm_ajax_processor_pause_before_rollback':'',
            'sysparm_ajax_processor_use_cloud_runner':'',
            'sysparm_ajax_processor_performance_run':'',
            'ni.nolog.x_referer':'ignore',
            'x_referer':'sys_atf_test.do%3Fsys_id%3D817a3214835b4210a9f8aec0deaad3f4%26sysparm_view%3D%26sysparm_domain%3Dnull%26sysparm_domain_scope%3Dnull'
        };

        const proc:ServiceNowProcessorRequest = new ServiceNowProcessorRequest(this._instance);
        const result:string =  await proc.execute("TestExecutorAjax", "start", "global", dataObj);

        //In this case, result is the progress worker id.
        if(result != null){
          const resultId:string =  await this.waitForTestCompletion(result);
          if(resultId){
            const testResult:TestResult = await this.getTestResult(resultId);
            if(testResult)
                return testResult;
          }
          
        }

        return null;
    }

    private async waitForTestCompletion(progressId:string):Promise<string>{
        let pr:ProgressResult = await this.doGetTestProgress(progressId);
        //console.log("Percent Complete: " + pr.percent_complete);
      
        while(pr.percent_complete != null && pr.percent_complete < 100){
            await new Promise(resolve => setTimeout(resolve, 500));
            pr = await this.doGetTestProgress(progressId);
            //console.log("Percent Complete: " + pr.percent_complete);
        }
        
        if(pr && pr.percent_complete == 100 && pr.links.results && pr.links.results.id){
            return pr.links.results.id;
        }

        return null;
    }

   private async  doGetTestProgress(progressId:string):Promise<ProgressResult>{
        const data:ProgressResultResponse = await this.getTestProgress(progressId);
      
        try{
            if(data.result ){
               
                return data.result;
            }
                
        }catch{
            return null;
        }
      
        return null;
    }



    private async getTestProgress(progressId:string):Promise<ProgressResultResponse>{
       

        const request:HTTPRequest = { path: "/api/sn_cicd/progress/"+progressId, headers: null, query: null, body:null};
        const resp:IHttpResponse<ProgressResultResponse> = await this._req.get<ProgressResultResponse>(request);
        if(resp.status == 200){
            return resp.bodyObject;
        }

        return null;
    }

    private async getTestResult(testResultId:string):Promise<TestResult>{
       

        const request:HTTPRequest = { path: "/api/now/table/sys_atf_test_result?sysparm_query=sys_id="+testResultId, headers: null, query: null, body:null};
        const resp:IHttpResponse<ServiceNowTableResponse<TestResult>> = await this._req.get<ServiceNowTableResponse<TestResult>>(request);
        if(resp.status == 200){
            const tableResp:ServiceNowTableResponse<TestResult> =  resp.bodyObject;
            if(tableResp.result && tableResp.result.length > 0){
                return tableResp.result[0];
            }
            
        }

        return null;
    }

    // private async getTestStepResults(){

    // }

    /**
     * Executes a test suite by sys_id using the ServiceNow CI/CD API
     * @param testSuiteSysId The sys_id of the test suite to execute
     * @param options Optional execution parameters
     * @returns Promise<TestSuiteExecutionResponse> The execution response with progress information
     */
    async executeTestSuite(testSuiteSysId: string, options?: Partial<TestSuiteExecutionRequest>): Promise<TestSuiteExecutionResponse> {
        const queryParams: TestSuiteQueryParams = {
            test_suite_sys_id: testSuiteSysId
        };

        // Add optional parameters if provided
        if (options) {
            if (options.browser_name) queryParams.browser_name = options.browser_name;
            if (options.browser_version) queryParams.browser_version = options.browser_version;
            if (options.is_performance_run !== undefined) queryParams.is_performance_run = options.is_performance_run;
            if (options.os_name) queryParams.os_name = options.os_name;
            if (options.os_version) queryParams.os_version = options.os_version;
            if (options.run_in_cloud !== undefined) queryParams.run_in_cloud = options.run_in_cloud;
        }

        const request: HTTPRequest = {
            path: "/api/sn_cicd/testsuite/run",
            headers: {
                'Accept': 'application/json'
            },
            query: queryParams,
            body: null
        };

        const resp: IHttpResponse<{ result: TestSuiteExecutionResponse }> = await this._req.post<{ result: TestSuiteExecutionResponse }>(request);
        
        if (resp.status === 200 && resp.bodyObject && resp.bodyObject.result) {
            return resp.bodyObject.result;
        }

        throw new Error(`Failed to execute test suite. Status: ${resp.status}, Response: ${JSON.stringify(resp.bodyObject)}`);
    }

    /**
     * Executes a test suite by name using the ServiceNow CI/CD API
     * @param testSuiteName The name of the test suite to execute
     * @param options Optional execution parameters
     * @returns Promise<TestSuiteExecutionResponse> The execution response with progress information
     */
    async executeTestSuiteByName(testSuiteName: string, options?: Partial<TestSuiteExecutionRequest>): Promise<TestSuiteExecutionResponse> {
        const queryParams: TestSuiteQueryParams = {
            test_suite_name: testSuiteName
        };

        // Add optional parameters if provided
        if (options) {
            if (options.browser_name) queryParams.browser_name = options.browser_name;
            if (options.browser_version) queryParams.browser_version = options.browser_version;
            if (options.is_performance_run !== undefined) queryParams.is_performance_run = options.is_performance_run;
            if (options.os_name) queryParams.os_name = options.os_name;
            if (options.os_version) queryParams.os_version = options.os_version;
            if (options.run_in_cloud !== undefined) queryParams.run_in_cloud = options.run_in_cloud;
        }

        const request: HTTPRequest = {
            path: "/api/sn_cicd/testsuite/run",
            headers: {
                'Accept': 'application/json'
            },
            query: queryParams,
            body: null
        };

        const resp: IHttpResponse<{ result: TestSuiteExecutionResponse }> = await this._req.post<{ result: TestSuiteExecutionResponse }>(request);
        
        if (resp.status === 200 && resp.bodyObject && resp.bodyObject.result) {
            return resp.bodyObject.result;
        }

        throw new Error(`Failed to execute test suite by name. Status: ${resp.status}, Response: ${JSON.stringify(resp.bodyObject)}`);
    }

    /**
     * Gets the progress of a test suite execution
     * @param progressId The progress ID from the execution response
     * @returns Promise<TestSuiteExecutionResponse> The current progress information
     */
    async getTestSuiteProgress(progressId: string): Promise<TestSuiteExecutionResponse> {
        const request: HTTPRequest = {
            path: `/api/sn_cicd/progress/${progressId}`,
            headers: {
                'Accept': 'application/json'
            },
            query: null,
            body: null
        };

        const resp: IHttpResponse<{ result: TestSuiteExecutionResponse }> = await this._req.get<{ result: TestSuiteExecutionResponse }>(request);
        
        if (resp.status === 200 && resp.bodyObject && resp.bodyObject.result) {
            return resp.bodyObject.result;
        }

        throw new Error(`Failed to get test suite progress. Status: ${resp.status}, Response: ${JSON.stringify(resp.bodyObject)}`);
    }

    /**
     * Waits for test suite execution to complete and returns the results
     * @param progressId The progress ID from the execution response
     * @param pollIntervalMs Polling interval in milliseconds (default: 5000)
     * @returns Promise<TestSuiteExecutionResult> The final execution results
     */
    async waitForTestSuiteCompletion(progressId: string, pollIntervalMs: number = 5000, onProgress?: OperationProgressCallback): Promise<TestSuiteExecutionResult> {
        const emit = createProgressEmitter(onProgress);
        let progress: TestSuiteExecutionResponse = await this.getTestSuiteProgress(progressId);
        emit({
            message: progress.status_message || progress.status_label || 'Test suite started',
            percentComplete: progress.percent_complete,
            status: progress.status
        });

        while (progress.percent_complete < 100 && progress.status !== "3" && progress.status !== "4") {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            progress = await this.getTestSuiteProgress(progressId);
            emit({
                message: progress.status_message || progress.status_label || 'Running test suite',
                percentComplete: progress.percent_complete,
                status: progress.status
            });
        }

        if (progress.links && progress.links.results && progress.links.results.id) {
            return await this.getTestSuiteResults(progress.links.results.id);
        }

        throw new Error(`Test suite execution did not complete successfully. Status: ${progress.status_label}, Error: ${progress.error}`);
    }

    /**
     * Gets the results of a completed test suite execution
     * @param resultsId The results ID from the progress response
     * @returns Promise<TestSuiteExecutionResult> The execution results
     */
    async getTestSuiteResults(resultsId: string): Promise<TestSuiteExecutionResult> {
        const request: HTTPRequest = {
            path: `/api/now/table/sys_atf_test_suite_result?sysparm_query=sys_id=${resultsId}`,
            headers: {
                'Accept': 'application/json'
            },
            query: null,
            body: null
        };

        const resp: IHttpResponse<ServiceNowTableResponse<TestSuiteExecutionResult>> = await this._req.get<ServiceNowTableResponse<TestSuiteExecutionResult>>(request);
        
        if (resp.status === 200 && resp.bodyObject && resp.bodyObject.result && resp.bodyObject.result.length > 0) {
            return resp.bodyObject.result[0];
        }

        throw new Error(`Failed to get test suite results. Status: ${resp.status}, Response: ${JSON.stringify(resp.bodyObject)}`);
    }

    /**
     * Executes a test suite and waits for completion
     * @param testSuiteSysId The sys_id of the test suite to execute
     * @param options Optional execution parameters
     * @param pollIntervalMs Polling interval in milliseconds (default: 5000)
     * @returns Promise<TestSuiteExecutionResult> The final execution results
     */
    async executeTestSuiteAndWait(testSuiteSysId: string, options?: Partial<TestSuiteExecutionRequest>, pollIntervalMs: number = 5000, onProgress?: OperationProgressCallback): Promise<TestSuiteExecutionResult> {
        const executionResponse = await this.executeTestSuite(testSuiteSysId, options);
        return await this.waitForTestSuiteCompletion(executionResponse.links.progress.id, pollIntervalMs, onProgress);
    }

    /**
     * Executes a test suite by name and waits for completion
     * @param testSuiteName The name of the test suite to execute
     * @param options Optional execution parameters
     * @param pollIntervalMs Polling interval in milliseconds (default: 5000)
     * @returns Promise<TestSuiteExecutionResult> The final execution results
     */
    async executeTestSuiteByNameAndWait(testSuiteName: string, options?: Partial<TestSuiteExecutionRequest>, pollIntervalMs: number = 5000, onProgress?: OperationProgressCallback): Promise<TestSuiteExecutionResult> {
        const executionResponse = await this.executeTestSuiteByName(testSuiteName, options);
        return await this.waitForTestSuiteCompletion(executionResponse.links.progress.id, pollIntervalMs, onProgress);
    }

}

export type TestResult = {
    "end_time_millis":string;
    "execution_tracker":ReferenceLink;
    "test_name":string;
    "test":ReferenceLink;
    "rollback_context":ReferenceLink;
    "root_tracker_id":ReferenceLink;
    "output":string;
    "sys_id":string;
    "run_time":string;
    "status":string;
}

export interface TestSuiteExecutionRequest {
    test_suite_sys_id?: string;
    test_suite_name?: string;
    browser_name?: string;
    browser_version?: string;
    is_performance_run?: boolean;
    os_name?: string;
    os_version?: string;
    run_in_cloud?: boolean;
}

interface TestSuiteQueryParams {
    test_suite_sys_id?: string;
    test_suite_name?: string;
    browser_name?: string;
    browser_version?: string;
    is_performance_run?: boolean;
    os_name?: string;
    os_version?: string;
    run_in_cloud?: boolean;
}

export interface TestSuiteExecutionResponse {
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

export interface TestSuiteExecutionResult {
    sys_id: string;
    number: string;
    test_suite: ReferenceLink;
    status: string;
    success: string;
    start_time: string;
    end_time: string;
    run_time: string;
    success_count: string;
    failure_count: string;
    skip_count: string;
    error_count: string;
    parent: string;
    base_suite_result: ReferenceLink;
    execution_tracker: ReferenceLink;
    schedule_run: ReferenceLink;
}

