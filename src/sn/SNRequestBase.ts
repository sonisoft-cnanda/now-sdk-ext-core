import { ServiceNowRequest } from "../comm/http/ServiceNowRequest";
import { Logger } from "../util/Logger";
import { ServiceNowInstance } from "./ServiceNowInstance";


export abstract class SNRequestBase{
    private _snInstance: ServiceNowInstance;
   

    private _req: ServiceNowRequest;
  

    _logger:Logger = new Logger("ATFTestExecutor");

    public constructor(instance:ServiceNowInstance){
        this._snInstance = instance;
        this._req  = new ServiceNowRequest(this._snInstance);
    }

    public get request (): ServiceNowRequest {
        return this._req;
    }
    public set request ( value: ServiceNowRequest ) {
        this._req = value;
    }

    public get snInstance (): ServiceNowInstance {
        return this._snInstance;
    }

    /**
     * Swapping the instance rebuilds the bound request.
     *
     * Without this, the setter changed `_snInstance` while `_req` kept serving the
     * previous instance — and because that handler's bound id and its session id
     * both stayed pointed at the old instance, they still MATCHED each other. So
     * RequestHandler's dispatch guard saw nothing wrong and requests silently kept
     * going to the old instance: exactly the class of bug this guard exists to
     * close, reachable through a public setter on exported API.
     *
     * Rebuilding discards the old session deliberately. A session minted for the
     * previous instance must never be reused, so the next call re-authenticates.
     */
    public set snInstance ( value: ServiceNowInstance ) {
        const changed = this._snInstance?.getInstanceId?.() !== value?.getInstanceId?.();
        this._snInstance = value;
        if (changed) {
            this._req = new ServiceNowRequest(value);
        }
    }

}