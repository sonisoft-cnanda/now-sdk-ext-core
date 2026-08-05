import { parseXml, getScopeMetadataFromInstance, getNowTableRequest, monitorUninstallWorkerCompletion, getAppAndSummary } from "@servicenow/sdk-cli-core/dist/util/index.js";
import { getSafeUserSession } from "@servicenow/sdk-cli-core/dist/util/sessionToken.js";
import { ServiceNowRequest } from "../comm/http/ServiceNowRequest";
import { ServiceNowInstance } from "./ServiceNowInstance";
import { HTTPRequest } from "../comm/http/HTTPRequest";
import { IHttpResponse } from "../comm/http/IHttpResponse";
import { Logger } from "../util/Logger";


export class Application {

    snRequest: ServiceNowRequest;
    instance: ServiceNowInstance;

    _scope: string;
    _applicationId: string;

    _logger:Logger = new Logger("Application");

    public constructor( instance:ServiceNowInstance, scope:string, applicationId: string  ) {
       
        this._scope = scope;
        this._applicationId = applicationId;

        this.instance = instance;
        this.snRequest = new ServiceNowRequest(this.instance);
}

    public async changeApplication() : Promise<boolean> {

       let userSession = await this.snRequest.getUserSession();
        const fd:FormData = new FormData();
        fd.append("sysparm_processor", "com.snc.apps.AppsAjaxProcessor");
        fd.append("sysparm_function", "changeApplication");
        fd.append("sysparm_ck", userSession.userToken ?? '');
        fd.append("sysparm_value", this._applicationId);

        const params:URLSearchParams = new URLSearchParams(fd as any );
        const request: HTTPRequest = {
            method: 'POST',
            path: '/xmlhttp.do',
            headers: {"Content-Type":"application/x-www-form-urlencoded"},
            query: null,
            body: params
        };
        const response: IHttpResponse<string> = await this.snRequest.post<string>(request);
        if (response.status == 200) {
            return true;
        }else{
            return false;
        }
        // const r = await (makeRequest)({
        //     auth: userSession,
        //     method: 'POST',
        //     path: '/xmlhttp.do',
        //     fields: params,
        // });
        // if (!r.ok) {
        //     (parseResponseBody)(r.clone());
        // }
    }

    public async convertToStoreApp() : Promise<boolean> {
        let userSession = await this.snRequest.getUserSession();
        let params = {
            sysparm_processor: "com.snc.apps.AppsAjaxProcessor",
            sysparm_function: "convertToStoreApp",
            sysparm_ck: userSession.userToken ?? '',
            sysparm_sys_id: this._applicationId,
            sysparm_name: "start",
            sysparm_scope: "global"
        }
        
        const request: HTTPRequest = {
            method: 'POST',
            path: '/xmlhttp.do',
            headers: {},
            query: null,
            fields: params,
            body: null
        };
        const response: IHttpResponse<string> = await this.snRequest.post<string>(request);
        if (response.status == 200) {
            return true;
        }else{
            return false;
        }
    }

    public async uninstall() : Promise<boolean> {
        let userSession = await this.snRequest.getUserSession();
        const { appID, sys_class_name, upgrade_finished } = await this.getAppAndSummary();

        await this.uninstallApplication(userSession, appID, this._scope, sys_class_name, this._logger);
        return true;
    }

    async uninstallApplication(userSession, appID, scopeId, sys_class_name, logger) {
        const uninstallStoreApp = sys_class_name === 'sys_store_app';
        const progressID = await this.uninstallScopedApp(userSession, appID, uninstallStoreApp);
        if (!(await (monitorUninstallWorkerCompletion)(userSession, progressID, this._logger))) {
            throw new Error();
        }
        if (!(await this.monitorMutexRelease(userSession, this._logger))) {
            throw new Error();
        }
        await this.verifyAppUninstall(scopeId, userSession, uninstallStoreApp);
    }
    
    private async monitorMutexRelease(auth, logger) {
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const r = await (getNowTableRequest)(auth, 'sys_mutex', {
                sysparm_fields: 'sys_id',
                sysparm_query: 'name=Update-Mutex^acquiredISNOTEMPTY',
            }, logger);
            if (!r || (r && r.length < 1)) {
                logger.debug('Update-Mutex released: proceeding with install');
                return true;
            }
            // Query instance once per second
            await new Promise((resolve) => setTimeout(resolve, 1000));
            attempt += 1;
            if (attempt === 30) {
                logger.error('Update-Mutex was not released within appropriate time\n\t' +
                    'Either this operation is taking a while or another CICD operation may be underway on the instance.\n\t' +
                    'Please try again when sys_mutex table indicates Update-Mutex is released');
                return false;
            }
            // Log tracker status every 15 seconds if tracker hasn't completed
            if (attempt % 15 === 0) {
                logger.debug('Uninstall pending, waiting on Update-Mutex release');
            }
        }
    }
    
    private async uninstallScopedApp(auth, appID, isStoreApp) {
        const params = {
            sysparm_processor: 'com.snc.apps.AppsAjaxProcessor',
            sysparm_function: isStoreApp ? 'uninstallApplication' : 'deleteApplication',
            sysparm_sys_id: appID,
            sysparm_fluent_app: 'true',
            sysparm_delete_all: 'true',
            sysparm_ck: auth.userToken ?? '',
        };
        // Routed through snRequest, not makeRequest directly.
        //
        // This is the most destructive call in the library — sysparm_delete_all on an
        // application — and calling makeRequest here put it OUTSIDE the one point every
        // other request passes through, so the permission gate could not see it. The
        // gate would have been true of everything except the thing that matters most.
        //
        // Not an architectural requirement: changeApplication and convertToStoreApp in
        // this same class already go through snRequest. Line was simply left behind.
        const request: HTTPRequest = {
            method: 'POST',
            path: '/xmlhttp.do',
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            query: null,
            body: null,
            fields: params,
        };
        const response: IHttpResponse<string> = await this.snRequest.post<string>(request);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const xml = await (parseXml)(response.data);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
        return xml['xml']['@_answer'];
    }
    
    private async verifyAppUninstall(scopeId, auth, uninstallStoreApp) {
        const scopeMetadata = await (getScopeMetadataFromInstance)(scopeId, auth);
        if (scopeMetadata && scopeMetadata.sys_id) {
            if (uninstallStoreApp && scopeMetadata.active === 'false') {
                return;
            }
            throw new Error();
        }
    }

    private async getAppAndSummary() : Promise<{appID:string, sys_class_name:string, upgrade_finished:string}> {
        let userSession = await this.snRequest.getUserSession();
        const { appID, sys_class_name, upgrade_finished } = await (getAppAndSummary)(this._applicationId, this._scope, userSession);
        return { appID, sys_class_name, upgrade_finished };
    }

}