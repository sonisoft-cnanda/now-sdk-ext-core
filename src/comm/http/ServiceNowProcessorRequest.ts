import { ServiceNowRequest } from "../../comm/http/ServiceNowRequest";
import * as qs from 'qs';
import { XMLHTTP_PROCESSOR_ENDPOINT } from '../../constants/ServiceNow';
import { Parser } from 'xml2js';
import { HttpResponse } from "./HttpResponse";
import { HTTPRequest } from "./HTTPRequest";
import { IHttpResponse } from "./IHttpResponse";
import { ServiceNowInstance } from "../../sn/ServiceNowInstance";
import { Logger } from "../../util/Logger";
import { redactError } from "../../util/redact";

export class ServiceNowProcessorRequest{

    private static _logger: Logger = new Logger("ServiceNowProcessorRequest");

    _instance:ServiceNowInstance;

    public constructor(instance:ServiceNowInstance){
        this._instance = instance;
    }

    
    private _headers:object = {
        "Content-Type":"application/x-www-form-urlencoded"
    };

    public async execute(processor:string, processorMethod:string, scope:string, processorArgs:object):Promise<string>{
        let retVal:string = null;
        let resp:IHttpResponse<unknown> =  await this.doXmlHttpRequest(processor, processorMethod, scope, processorArgs);
        if(resp.status == 200){
            let data:string = resp.data as string;
            if(typeof data != 'undefined' && data && data.indexOf('answer=') != -1){
               
                let parser:Parser = new Parser();
                parser.parseString(data, function (err, result) {
                    let answer:string = result.xml.$.answer;
                    retVal = answer;
                    //console.log(answer);
                });
                
            }
        }
        return retVal;
    }

    async doXmlHttpRequest(processor:string, processorMethod:string, scope:string, processorArgs:object) : Promise<IHttpResponse<unknown>>{
        let resp:IHttpResponse<unknown> = null;

        try{
            let dataObj:{[key:string]: string} ={};
            dataObj.sysparm_processor = processor;
            dataObj.sysparm_name = processorMethod;
            dataObj.sysparm_scope = scope;

            for(var prop in processorArgs){
                dataObj[prop] = processorArgs[prop];
            }

            //let data = qs.stringify(dataObj);

            let req:ServiceNowRequest = new ServiceNowRequest(this._instance);
            let request:HTTPRequest = {method: 'POST', path: XMLHTTP_PROCESSOR_ENDPOINT, headers: this._headers, query: null, fields:dataObj, body:null};
            resp = await req.post(request);
        }catch(err){
            // Was console.log, which writes to fd 1 — the MCP server's JSON-RPC channel.
            // A single stray line there desynchronises the protocol framing.
            ServiceNowProcessorRequest._logger.error("Processor request failed", {
                error: redactError(err),
            });
        }
       

        return resp;
    }
}