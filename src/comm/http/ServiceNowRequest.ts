import { AuthenticationHandlerFactory } from "../../auth/AuthenticationHandlerFactory";
import { IAuthenticationHandler } from "../../auth/IAuthenticationHandler";
import { ServiceNowInstance } from "../../sn/ServiceNowInstance";
import { HTTPRequest } from "./HTTPRequest";
import { IHttpResponse } from "./IHttpResponse";
import { IRequestHandler } from "./IRequestHandler";
import { RequestHandlerFactory } from "./RequestHandlerFactory";


export class ServiceNowRequest{
   
    _requestHandler:IRequestHandler;
    auth:IAuthenticationHandler;

    private _instance:ServiceNowInstance;

    public constructor(instance:ServiceNowInstance = null){
       // let self:ServiceNowRequest = this;

        if (instance) {
            this._instance = instance;
        }

        this.auth = AuthenticationHandlerFactory.createAuthHandler(this._instance);
        this._requestHandler = RequestHandlerFactory.createRequestHandler( this.auth);
        this.auth.setRequestHandler(this._requestHandler);

        // Declare which instance this handler serves, so a session minted for any
        // other instance is refused before it reaches the wire.
        if (this._instance) {
            this._requestHandler.bindInstance?.(this._instance);
        }

    }

    /** The instance this request is bound to. Fixed at construction. */
    public getInstance():ServiceNowInstance{
        return this._instance;
    }

    public async executeRequest<T>(request: HTTPRequest) : Promise<IHttpResponse<T>>{
        let httpMethod:string = request.method;
        let resp:IHttpResponse<T> = null;


        if(typeof httpMethod != "undefined" && httpMethod){
            httpMethod = httpMethod.trim().toLowerCase();

            switch(httpMethod){
                case "post":
                    resp = await this.post<T>(request);
                    break;
                case "put":
                    resp = await this.put<T>(request);
                    break;
                case "get":
                    resp = await this.get<T>(request);
                    break;
                case "delete":
                    resp = await this.delete<T>(request);
                    break;
            }

        }else{
            throw new Error("Method must be populated on HTTPRequest object in order to utlize executeRequest.");
        }

       
        return resp;

    }



    public async put<T>(request: HTTPRequest): Promise<IHttpResponse<T>>{
        if(!this.isLoggedIn())
            await this.ensureLoggedIn();

        return await this._requestHandler.put<T>(request);
    }

    public async post<T>(request: HTTPRequest): Promise<IHttpResponse<T>>{
        if(!this.isLoggedIn())
            await this.ensureLoggedIn();

        return await this._requestHandler.post<T>(request);
    }

    public async get<T>(request: HTTPRequest): Promise<IHttpResponse<T>>{
        if(!this.isLoggedIn())
            await this.ensureLoggedIn();

        return await this._requestHandler.get<T>(request);
    }

    public async delete<T>(request: HTTPRequest): Promise<IHttpResponse<T>>{
        if(!this.isLoggedIn())
            await this.ensureLoggedIn();

        return await this._requestHandler.delete<T>(request);
    }

    public async getUserSession() {
        if(this.isLoggedIn()){
            return this.auth.getSession();
        }else{
            return this.auth.doLogin();
        }
    }


    private async ensureLoggedIn(){
    

        await this.auth.doLogin();
       
               
    }

    isLoggedIn():Boolean{
        return this.getAuth().isLoggedIn();
    }

    public getAuth():IAuthenticationHandler{
        return this.auth;
    }

}