import { IServiceNowInstance } from "./IServiceNowInstance";
import type { CredentialProvider } from "../auth/CredentialProvider";

/**
 * Monotonic source of instance identity.
 *
 * A ServiceNowInstance is immutable once constructed — every field is private with
 * only a getter — so object identity *is* the generation, and a construction ordinal
 * captures it exactly. Deliberately not a hash of the credential: identity must not
 * require touching credential material.
 *
 * This is what lets a session be tied to the instance it was minted for. A consumer
 * that refreshes a connection (now-sdk-ext-mcp evicts on a 30-minute TTL) constructs
 * a new ServiceNowInstance, which takes a new id, which no longer matches the id
 * recorded against a cached session.
 */
let nextInstanceId = 1;

export interface ServiceNowSettingsInstance {
    host?:string;
    username?:string;
    alias?:string;
    isDefault?:boolean;
    password?:string;
    credential?:unknown;
    credentialProvider?: CredentialProvider;
}

export class ServiceNowInstance implements IServiceNowInstance{
    private _isDefault:boolean;
    private _host:string;
    private _username:string;
    private _alias:string;

    private _password:string;
    
    private _credential:unknown;
    public readonly credentialProvider: CredentialProvider | undefined;

    private readonly _instanceId:number = nextInstanceId++;

    constructor(snInstanceSettingsObj?:ServiceNowSettingsInstance | null){
        this.credentialProvider = snInstanceSettingsObj?.credentialProvider;
        if(typeof snInstanceSettingsObj != 'undefined' && snInstanceSettingsObj != null){
            if(snInstanceSettingsObj.host){
                this._host = snInstanceSettingsObj.host;
            }
            if(snInstanceSettingsObj.alias){
                this._alias = snInstanceSettingsObj.alias;
            }
            if(snInstanceSettingsObj.username){
                this._username = snInstanceSettingsObj.username;
            }
            if(snInstanceSettingsObj.isDefault){
                this._isDefault = snInstanceSettingsObj.isDefault;
            }
            if(snInstanceSettingsObj.password){
                this._password = snInstanceSettingsObj.password;
            }

            if(snInstanceSettingsObj.credential){
                this._credential = snInstanceSettingsObj.credential;
            }

        }
    }

    isDefault():boolean{
        return this._isDefault;
    }

    getHost():string{
        return this._host;
    }

    getUserName():string{
        return this._username;
    }

    getAlias():string{
        return this._alias;
    }

    //todo: Do we store the password in Secrets or the entire SN Instance? Can we store the entire array of SN Instances in secrets?
    getPassword():string{
        return this._password;
    }

    public get credential():unknown{
        return this._credential;
    }

    /**
     * Stable identity for this instance object, unique within the process.
     *
     * Used to tie a session to the instance it was minted for, so a request can
     * never be dispatched with another instance's credentials. Not persisted and
     * not meaningful across processes.
     */
    getInstanceId():number{
        return this._instanceId;
    }
}
