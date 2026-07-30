
import { HTTPRequest } from './HTTPRequest';
import { IHttpResponse } from './IHttpResponse';
import { HttpResponse } from './HttpResponse';
import { IRequestHandler } from './IRequestHandler';
import { Cookie } from 'tough-cookie';
import { ICookieStore } from './ICookieStore';
import { IAuthenticationHandler } from '../../auth/IAuthenticationHandler';
import { Logger } from '../../util/Logger';
import { makeRequest } from "@servicenow/sdk-cli-core/dist/http/index.js";
import { DOMParser } from '@xmldom/xmldom';
import { IServiceNowInstance } from '../../sn/IServiceNowInstance';
import { StaleInstanceError } from '../../exception/StaleInstanceError';
import { stripSecretsFromError, redactValue } from '../../util/redact';

//axios.defaults.withCredentials = true;

export class RequestHandler implements IRequestHandler{
   
    _logger:Logger = new Logger("RequestHandler");
    //_defaultHeaders:RawAxiosRequestHeaders;
    //httpClient:AxiosInstance;
    _cookies: Cookie[];

    _cookieStore:ICookieStore;
    _authHandler:IAuthenticationHandler;

    _session: any;

    /** Identity of the instance this handler serves. Set once, at construction. */
    private _boundInstanceId: number | undefined;

    /** Identity of the instance the current `_session` was minted for. Written with the session. */
    private _sessionInstanceId: number | undefined;

    /**
     * The Singleton's constructor should always be private to prevent direct
     * construction calls with the `new` operator.
     */
    public constructor(authHandler:IAuthenticationHandler) {
        //this._defaultHeaders = {} as RawAxiosRequestHeaders;
       this._authHandler = authHandler;
        
        //Need to get the config from the extension info
        //baseURL should be instance URL that was added to settings
        //todo: Updated with settings config
        // this.httpClient = axios.create({
        //     withCredentials: true,
        //     baseURL: ExtensionConfiguration.instance.getServiceNowInstanceURL(),
        //   });

        // this.httpClient.defaults.maxRedirects = 0;
         
     }



    public setSession(session: any, instance?: IServiceNowInstance){
        const previous = this._sessionInstanceId;
        this._session = session;
        // Deliberately reset to undefined when no instance is supplied: the session
        // changed and we no longer know whose it is, so the guard must go permissive
        // rather than keep asserting against the previous owner's id.
        this._sessionInstanceId = instance?.getInstanceId?.();

        // Going from known to unknown silently disables the cross-instance guard for
        // this handler. `instance` is optional and easy to forget, so say so out loud
        // rather than only at debug level from inside the assertion.
        if (previous !== undefined && this._sessionInstanceId === undefined) {
            this._logger.warn(
                "Session replaced without an owning instance; the cross-instance guard is now inactive for this handler.",
                { previousSessionInstanceId: previous },
            );
        }
    }

    public bindInstance(instance: IServiceNowInstance){
        this._boundInstanceId = instance?.getInstanceId?.();
    }

    /**
     * Refuses to build a request whose session belongs to a different instance.
     *
     * Placed immediately before `this._session` is read into the outgoing config,
     * because that is the one point every request passes through — both the
     * SessionManager-managed handlers and the ~21 managers that construct their own
     * ServiceNowRequest and never touch SessionManager at all.
     *
     * Permissive when either side is unknown. A handler built without an instance
     * (ATFTestExecutor does this, then immediately replaces it) or a session set by
     * a caller that predates the second parameter would otherwise start throwing on
     * a path that was never actually unsafe.
     */
    /**
     * Prepares a caught value for rethrowing.
     *
     * The original error is preserved rather than wrapped: `new Error(ex)` stringified
     * the cause, discarded the stack, and flattened typed errors so `instanceof` failed
     * at every call site — which would make StaleInstanceError unidentifiable. Secrets
     * are stripped first, because the consumer's logger has no redaction format of its
     * own.
     */
    private toThrowable(ex: unknown): Error {
        if (ex instanceof Error) {
            return stripSecretsFromError(ex);
        }

        // A thrown non-Error still has to be described, and String() on an object
        // yields "[object Object]" — useless in a log. Redact before serializing,
        // since a thrown plain object can carry credentials just as easily.
        if (typeof ex === "string") {
            return new Error(ex);
        }
        // `Object.prototype.toString.call` is typed as returning `any`; the cast keeps
        // the type-checked lint rules satisfied without loosening anything real.
        const fallback = Object.prototype.toString.call(ex) as string;
        let described: string;
        try {
            described = JSON.stringify(redactValue(ex)) ?? fallback;
        } catch {
            // Cycles and throwing getters are already handled inside redactValue, but
            // a hostile toJSON can still break stringify.
            described = fallback;
        }
        return new Error(described);
    }

    private assertSessionMatchesBoundInstance(): void {
        const bound = this._boundInstanceId;
        const forSession = this._sessionInstanceId;

        if (bound === undefined || forSession === undefined) {
            this._logger.debug("Instance binding not asserted; identity unknown on one side.", {
                boundInstanceId: bound,
                sessionInstanceId: forSession,
            });
            return;
        }

        if (bound !== forSession) {
            throw new StaleInstanceError(
                `Refusing to send a request for instance #${bound} using a session minted for instance #${forSession}.`,
                "The connection was replaced while this request was in flight. Retry the operation; " +
                    "a fresh session will be established for the correct instance.",
            );
        }
    }

    // public async request(config:AxiosRequestConfig):Promise<AxiosResponse<any,any>>{

    //     for(var prop in this._defaultHeaders){
    //         if(typeof this._defaultHeaders[prop] !='undefined' && this._defaultHeaders[prop])
    //             config.headers[prop] = this._defaultHeaders[prop];
    //     }
    //     config.headers["Cookie"] = await this.getCookieString();
    //     return this.httpClient.request(config);
    // }


    isValidXmlString(xmlString) {
        try {
          const parser = new DOMParser();
          const xmlDoc = parser.parseFromString(xmlString, "application/xml");
      
          // Check for parsing errors
          const parserError = xmlDoc.getElementsByTagName("parsererror");
          if (parserError.length > 0) {
            // XML is not well-formed, contains parsing errors
            return false;
          }
      
          // If no parsererror element is found, the XML is well-formed
          return true;
        } catch (e) {
          // An unexpected error occurred during parsing
          return false;
        }
      }

    private async doRequest<T>(request: HTTPRequest): Promise<HttpResponse<T>> {
        let response:HttpResponse<T> = null;
       const {config} = await this.getRequestConfig(request);
       this._logger.debug("Retrieved Configuration", {config:config});
       //const { auth, path, params, fields, json, headers: baseHeaders, ...rest } = opts;
        // let opts = {
        //     auth: this._session,
        //     path: url,
        //     rest: { method: request.method }
        // }
        
        const resp = await makeRequest(config);
        let responseBodyString: string | null = null;
        if (!resp.ok) {
           
            try {
                responseBodyString = await resp.text();
            } catch (e) {
                responseBodyString = null;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                this._logger.error("Error parsing response body.", {error:e});
            }
            this._logger.error("Error during request.", { error: resp, request: request });
            this._logger.error("Response Details:", { body: responseBodyString, status: resp.status });
            throw new Error("Error during request. Status: " + resp.status + " Body: " + (responseBodyString !== null ? responseBodyString : "[no response body]"));
        }else{
            try{
                responseBodyString = await resp.text();
            }catch(e){
                responseBodyString = null;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                this._logger.error("Error parsing response body.", {error:e});
            }
        }
        // let responseBodyReader = resp.body.getReader();
        // let responseBody = await responseBodyReader.read();
       
      
       

        if(responseBodyString){

            //const xml = await ( parseXml)(responseBodyString);
            //const answer = xml['xml']['@_answer'];

            let data = null;
            try{
                
                data = JSON.parse(responseBodyString);
                
            }catch(ex){
                this._logger.error("Error parsing response body.", {error:ex, responseBodyString: responseBodyString});
                data = responseBodyString;
            }
            response = new HttpResponse<T>(data);
            response.data = data;
            response.body = responseBodyString;
        }else{
            response = new HttpResponse<T>(null);
           
        }
       
        response.status = resp.status;
        response.statusText = resp.statusText;
        response.headers = {};
        response.cookies = [];
        resp.headers.forEach((value, key) => {
            if(key === "set-cookie"){
                response.cookies.push(value);
            }else{
                response.headers[key] = value;
            }
        });
        //response.headers = resp.headers;


        return response;
    }


    public async post<T>(request: HTTPRequest) : Promise<IHttpResponse<T>> {
        request.method = "POST";
        // let {config} = await this.getRequestConfig(request);
        // this._logger.debug("Retrieved Configuration", {config:config, url:url});
        const response:IHttpResponse<T> = null;
       try{
        const response = await this.doRequest<T>(request);
         this._logger.debug("Http SN POST Response Received", response);
         
        try{
            if(!((response.data) instanceof String) ){
                const rpObj: T | null = response.data;
                response.bodyObject = response.data;
            }
        }catch(ex){
            this._logger.error("Error setting response.bodyObject.", {error:ex, response: response, request: request});
        }
        
        return response;
       }catch(ex){

        this._logger.error("Error during POST request.", {error:ex, response: response, request: request});
        throw this.toThrowable(ex);
       }
    }

    public async put<T>(request: HTTPRequest) : Promise<IHttpResponse<T>> {
        request.method = "PUT";
        const response:IHttpResponse<T> = null;
        try{
         const response = await this.doRequest<T>(request);
            this._logger.debug("Http PUT Response Received", response);
            try{
                if(!((response.data) instanceof String) ){
                    const rpObj: T | null = response.data;
                    response.bodyObject = response.data;
                }
            }catch(ex){
                //console.log(ex);
            }
            
            return response;
       }catch(ex){
        this._logger.error("Error during PUT request.", {error:ex, response: response, request: request});
        throw this.toThrowable(ex);
       }
    }

    public async get<T>(request: HTTPRequest) : Promise<IHttpResponse<T>> {
        request.method = "GET";
        const response:IHttpResponse<T> = null;
        try{
         const response = await this.doRequest<T>(request);
          this._logger.debug("Http SN GET Response Received", response);

        try{
            if(!((response.data) instanceof String) ){
                const rpObj: T | null = response.data;
                response.bodyObject = response.data;
            }
        }catch(ex){
            this._logger.error("Error setting response.bodyObject.", {error:ex, response: response, request: request});
        }

        return response;
       }catch(ex){
            this._logger.error("Error during GET request.", {error:ex, response: response, request: request});
            throw this.toThrowable(ex);
       }
    }

    public async delete<T>(request: HTTPRequest) : Promise<IHttpResponse<T>> {
        request.method = "DELETE";
        const response:IHttpResponse<T> = null;
        try{
         const response = await this.doRequest<T>(request);

        try{
            if(!((response.data) instanceof String) ){
                const rpObj: T | null = response.data;
                response.bodyObject = response.data;            }
        }catch(ex){
            this._logger.error("Error setting response.bodyObject.", {error:ex, response: response, request: request});
        }

        return response;
       }catch(ex){
            this._logger.error("Error during DELETE request.", {error:ex, response: response, request: request});
            throw this.toThrowable(ex);
       }
    }

    private async getRequestConfig(request: HTTPRequest):Promise<{ config: any }>{

        // Before the session is bound into the request. makeRequest derives the
        // destination host from auth.instanceUrl, so a mismatch here does not send a
        // bad cookie to the right host — it sends a valid session to the wrong one.
        this.assertSessionMatchesBoundInstance();

        const config = {
            auth: this._session,
        } as any;

        if(request.body){
            config.body = request.body;
        }

        if(request.fields){
            config.fields = request.fields;
        }

        if(request.json){
            config.json = request.json;
        }

        config.params = request.query;
        config.headers = request.headers;

        config.path = request.path;
        config.method = request.method;

        return {config: config};
    }

    private getQueryString(queryObj:object):string{

        const params = new URLSearchParams();
      
      
        for(const prop in queryObj){
            params.set(prop, queryObj[prop]);
        }

        return params.toString();;
    }


  

}