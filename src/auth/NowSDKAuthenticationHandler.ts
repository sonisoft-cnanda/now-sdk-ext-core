/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
//import { UISession } from "@servicenow/sdk-cli-core/dist/util/UISession";
import { IRequestHandler } from "../comm/http/IRequestHandler";
import { Logger } from "../util/Logger";
import { IAuthenticationHandler } from "./IAuthenticationHandler";
//import { Creds, login } from "@servicenow/sdk-cli-core/dist/command/login";
import { ICookieStore } from "../comm/http/ICookieStore";
import { ServiceNowInstance } from "../sn/ServiceNowInstance";
import { getSafeUserSession } from "@servicenow/sdk-cli-core/dist/util/sessionToken.js";
import { StaleInstanceError } from "../exception/StaleInstanceError";
import { stripSecretsFromError } from "../util/redact";


export class NowSDKAuthenticationHandler implements IAuthenticationHandler{

    private _requestHandler:IRequestHandler;
  
    private _isLoggedIn:boolean = false;

    private _session:unknown;

    private _logger:Logger;

    private _instance:ServiceNowInstance;

    public constructor(instance:ServiceNowInstance){
        this._logger = new Logger("NowSDKAuthenticationHandler");
        this._instance = instance;
    }

    public async doLogin() : Promise<any>{
        const session:unknown =  await this.login();
        this._session = session;

        return session;
    }

    private async login() : Promise<unknown>{

        try{
            const auth = {credentials: this._instance.credential};
            const instanceAtStart = this._instance;
            const session : unknown = await getSafeUserSession(auth, this._logger);
            if(session){
                // The await above is a full network login — the widest window in the
                // system. If the instance this handler serves was swapped while it was
                // open, installing the session now would bind one instance's
                // credentials to another's handler.
                if(this._instance !== instanceAtStart){
                    throw new StaleInstanceError(
                        "The instance changed while a login was in flight; discarding the session rather than installing it.",
                        "Retry the operation. A fresh login will run against the current instance.",
                    );
                }
                this._requestHandler.setSession(session, instanceAtStart);
                this.setLoggedIn(true);
            }else{
                throw new Error("Unable to login.");
            }
           
            this._logger.debug("Login Attempt Complete.");
            return session;
        }catch(e){
            // Of every error in the codebase this is the one most likely to be carrying
            // the credential it just failed to use, and it propagates out to consumers
            // whose loggers have no redaction format of their own.
            const safe: unknown = stripSecretsFromError(e);
            this._logger.error("Error during login.", safe);
            throw safe;
        }
        return null;
    }

    public getRequestHandler():IRequestHandler{
        return this._requestHandler;
    }

    public setRequestHandler(requestHandler:IRequestHandler){
        this._requestHandler = requestHandler;
    }

    public isLoggedIn():boolean{
        return this._isLoggedIn;
    }

    public setLoggedIn(loggedIn:boolean){
        this._isLoggedIn = loggedIn;
    }

    public getToken():string{
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        return (this._session as any).getToken() as string;
    }

    public getCookies():ICookieStore{
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
        return (this._session as any).getCookies();
    }

    public getSession():unknown{
        return this._session;
    }
}