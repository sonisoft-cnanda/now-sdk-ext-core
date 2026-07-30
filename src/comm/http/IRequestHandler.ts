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
     */
    bindInstance(instance: IServiceNowInstance);

}