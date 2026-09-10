import { ICookieStore } from "../comm/http/ICookieStore";
import { IRequestHandler } from "../comm/http/IRequestHandler";


export interface IAuthenticationHandler{
    ensureSession?(force?: boolean): Promise<unknown>;
    pinSession?(): void;

    doLogin();

    getRequestHandler():IRequestHandler;

    setRequestHandler(requestHandler:IRequestHandler);

    isLoggedIn():Boolean;

    setLoggedIn(loggedIn:Boolean);

    getToken():string;

    getCookies():ICookieStore;

    getSession():any;
}
