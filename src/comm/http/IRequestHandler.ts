import { HTTPRequest } from "./HTTPRequest";
import { IHttpResponse } from "./IHttpResponse";
import { Cookie } from 'tough-cookie';
import { IServiceNowInstance } from "../../sn/IServiceNowInstance";

export interface IRequestHandler{
    post<T>(request: HTTPRequest) : Promise<IHttpResponse<T>> ;
    
    put<T>(request: HTTPRequest) : Promise<IHttpResponse<T>> ;

    get<T>(request: HTTPRequest) : Promise<IHttpResponse<T>> ;

    delete<T>(request: HTTPRequest) : Promise<IHttpResponse<T>> ;


    /**
     * Records the session to use for outgoing requests, together with the instance
     * it was minted for.
     *
     * `instance` is optional so existing callers keep compiling, but omitting it
     * disables the cross-instance guard for this handler — pass it wherever the
     * owning instance is known.
     */
    setSession(session: any, instance?: IServiceNowInstance);

    /**
     * Declares which instance this handler serves. Set once, at construction.
     * A session recorded for any other instance will be refused at dispatch.
     *
     * Optional so that adding it is not a breaking change for anyone implementing
     * this interface outside the repo. A handler that does not implement it simply
     * has no bound identity, and the dispatch guard stays permissive — the same
     * behaviour as a handler built without an instance.
     */
    bindInstance?(instance: IServiceNowInstance);

}