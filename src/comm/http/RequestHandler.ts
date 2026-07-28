
import { HTTPRequest } from './HTTPRequest';
import { IHttpResponse } from './IHttpResponse';
import { HttpResponse } from './HttpResponse';
import { IRequestHandler } from './IRequestHandler';
import { Cookie } from 'tough-cookie';
import { ICookieStore } from './ICookieStore';
import { IAuthenticationHandler } from '../../auth/IAuthenticationHandler';
import { Logger } from '../../util/Logger';
import { makeRequest } from "@servicenow/sdk-cli-core/dist/http/index.js";
import { parseXml } from '@servicenow/sdk-cli-core/dist/util/Util';
import { DOMParser } from '@xmldom/xmldom';

//axios.defaults.withCredentials = true;

export class RequestHandler implements IRequestHandler{
   
    _logger:Logger = new Logger("RequestHandler");
    //_defaultHeaders:RawAxiosRequestHeaders;
    //httpClient:AxiosInstance;
    _cookies: Cookie[];

    _cookieStore:ICookieStore;
    _authHandler:IAuthenticationHandler;

    _session: any;

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



    public setSession(session: any){
        this._session = session;
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
        throw new Error(ex);
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
        throw new Error(ex);
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
            throw new Error(ex);
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
            throw new Error(ex);
       }
    }

    private async getRequestConfig(request: HTTPRequest):Promise<{ config: any }>{
                                            
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