

export interface IServiceNowInstance{
    isDefault():boolean;

    getHost():string;

    getUserName():string;

    getAlias():string;

    //todo: Do we store the password in Secrets or the entire SN Instance? Can we store the entire array of SN Instances in secrets?
    getPassword():string;

    get credential():unknown;

    /** Stable, process-local identity used to bind a session to the instance it was minted for. */
    getInstanceId():number;
}