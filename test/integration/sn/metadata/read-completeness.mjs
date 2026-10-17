// Read-only check of the response contract used by the bounded metadata reader.
import assert from 'node:assert/strict';
import {initCredentialStore} from '../../../../dist/credentials/ensureShim.js';
import {ServiceNowInstance} from '../../../../dist/sn/ServiceNowInstance.js';
import {SessionManager} from '../../../../dist/comm/http/SessionManager.js';
import {READ_ONLY} from '../../../../dist/policy/PolicyTypes.js';
import {configureLogging} from '../../../../dist/util/LogConfig.js';
import {MetadataReader} from '../../../../dist/sn/metadata/internal/MetadataReader.js';
import {MetadataFormWriter} from '../../../../dist/sn/metadata/MetadataFormWriter.js';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{auth:{type:'string'}}});assert.equal(values.auth,'dev206299');
configureLogging({file:false,console:false});assert.equal((await initCredentialStore()).active,true);
const {getCredentials}=await import('@servicenow/sdk-cli/dist/auth/index.js');
const instance=new ServiceNowInstance({alias:values.auth,credential:await getCredentials(values.auth)});
const request=await SessionManager.getInstance().getAuthenticatedRequest(instance);
const read=async(table,query,fields)=>request.get({path:`/api/now/table/${table}`,headers:null,body:null,requires:READ_ONLY,sensitive:true,
    query:{sysparm_query:query,sysparm_fields:fields,sysparm_exclude_reference_link:'true',sysparm_display_value:'false',sysparm_limit:'200'}});
const user=await read('sys_user','sys_id=javascript:gs.getUserID()','sys_id');
assert.equal(user.bodyObject?.result?.length,1);
const preferences=await read('sys_user_preference',`user=${user.bodyObject.result[0].sys_id}`,'sys_id,user,name,value');
const scope=await read('sys_scope','sys_id=21021ccd53bfcf90b6d61901a0490e91','sys_id,scope,active,sys_class_name');
const reader=new MetadataReader(request);
const complete=await reader.rows('sys_user_preference',`user=${user.bodyObject.result[0].sys_id}`,'sys_id,user,name,value');
const resolved=await new MetadataFormWriter(instance).scope(reader,{sysId:'21021ccd53bfcf90b6d61901a0490e91'});
assert.equal(complete.length,Number(preferences.headers['x-total-count']));
process.stdout.write(JSON.stringify({completeCount:complete.length,resolved,alias:values.auth,utc:new Date().toISOString(),status:preferences.status,
    preferenceCount:preferences.bodyObject?.result?.length,totalCount:preferences.headers['x-total-count'],
    scope:scope.bodyObject?.result})+'\n');
