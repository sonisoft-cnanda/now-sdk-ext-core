/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
/* eslint-disable @typescript-eslint/no-explicit-any */


import { Requirement } from "../../policy/PolicyTypes";

export interface HTTPRequest {
    path:string;
    headers:object | null;
    body:any | null;
    query:object | null;
    method?:string | null;

    fields?:object | null;

    json?:object | null;

    /**
     * What permission this request needs, when the HTTP verb would get it wrong.
     *
     * Leave unset almost always: GET is assumed to read, everything else to write, and
     * that is right for all but two call sites in this library — `SyslogReader` POSTs
     * to read, and `ATFTestExecutor` POSTs to run tests. Set it there.
     *
     * This can correct a wrong default but can never lower a floor rule; see
     * `policy/internal/Classify.ts`.
     */
    requires?:Requirement;

}