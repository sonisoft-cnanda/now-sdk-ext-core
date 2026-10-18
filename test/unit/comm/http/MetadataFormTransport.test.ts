import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseFormHtml } from '../../../../src/comm/http/FormHtmlParser';
import { createFormTransport } from '../../../../src/comm/http/FormRecordWriter';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
const ID = 'a'.repeat(32), SCOPE = 'b'.repeat(32);
const html = (tokens = ['page-token', 'page-token']) => `<form><input name="sys_target" value="sys_script_include"><input name="sys_uniqueValue" value="${ID}">
<input name="sys_row" value="-1"><input name="sysparm_encoded_record" value="state"><input name="sysparm_transaction_scope" value="${SCOPE}">
${tokens.map((token,i) => `<input name="sysparm_ck" ${i ? '' : 'id="ck"'} value="${token}">`).join('')}
<input name="sys_original.name" value="old"><input name="sys_script_include.name" value="old"><textarea name="sys_script_include.script">old</textarea>
<input name="unchecked" type="checkbox"><select name="auxiliary"><option value="first">First</option><option selected value="second">Second</option></select></form>`;
const load = { captureRenderedInputs: true, tokenSource: 'page' as const, sensitive: true };
let request: any;
let transport: ReturnType<typeof createFormTransport>;
beforeEach(() => {
    request = { getUserSession: jest.fn(async () => ({ userToken:'session-token',instanceUrl:'https://example.service-now.com' })),
        get: jest.fn(async () => ({status:200,data:html()})),
        post: jest.fn(async () => ({status:302,headers:{location:`/sys_script_include.do?sys_id=${ID}`},data:''})) };
    jest.spyOn(SessionManager.getInstance(),'getRequest').mockReturnValue(request);
    transport = createFormTransport(new ServiceNowInstance({alias:'unit'}));
});
afterEach(() => jest.restoreAllMocks());
describe('opt-in form transport', () => {
    it('keeps the default parser snapshot filtered and token-free', () => {
        const legacy = parseFormHtml(html(), 'sys_script_include');
        expect(legacy).not.toHaveProperty('pageToken');
        expect(legacy).not.toHaveProperty('renderedInputs');
        expect(legacy.fields).not.toHaveProperty('sys_original.name');
    });
    it('accepts equal token inputs, including one without an id', () => {
        const parsed = parseFormHtml(html(),'sys_script_include',load);
        expect(parsed.pageToken).toBe('page-token');
        expect(parsed.renderedInputs).toMatchObject({'sys_original.name':'old',auxiliary:'second'});
        expect(parsed.renderedInputs).toHaveProperty('unchecked', '');
    });
    it.each([[],[''],['one','two'],['one','']].map(tokens => ({tokens})))('refuses unavailable token inputs $tokens', ({tokens}) => {
        expect(() => parseFormHtml(html(tokens),'sys_script_include',load)).toThrow('csrf_token_unavailable');
    });
    it('keeps rendered state and uses deliberate values and its own page token', async () => {
        const snapshot = await transport.loadForm('sys_script_include','-1',load);
        await transport.submit(snapshot,'sysverb_insert_and_stay',{ postAllRenderedInputs:true,tokenSource:'page',
            fields:{name:'new'},actionValue:'sysverb_insert_and_stay',extraFields:{sysparm_goto_url:''},redirect:'manual',landing:'guarded',sensitive:true });
        expect(request.post.mock.calls[0][0]).toMatchObject({ redirect:'manual',sensitive:true,
            fields:{'sys_script_include.name':'new','sys_original.name':'old',sysparm_ck:'page-token',sysparm_goto_url:''} });
        expect(request.get).toHaveBeenCalledTimes(2);
    });
    it.each(['https://foreign.example/sys_script_include.do','/login.do','/sys_script_include_list.do',
        '/sys_script_include.do?sys_action=delete','/sys_script_include.do','/sys_script_include.do?sys_id='+'c'.repeat(32),
        '/sys_script_include.do?sys_id=-1&sys_id='+ID,'https://user:password@example.service-now.com/sys_script_include.do',
        '/sys_script_include.do?sysparm_transaction_scope=global'])('refuses unsafe landing %s before GET', async location => {
        request.post.mockResolvedValue({status:302,headers:{location},data:''});
        const snapshot = await transport.loadForm('sys_script_include','-1',load);
        await expect(transport.submit(snapshot,'sysverb_insert_and_stay',{ tokenSource:'page',landing:'guarded',sensitive:true })).rejects.toThrow();
        expect(request.get).toHaveBeenCalledTimes(1);
        expect(request.post).toHaveBeenCalledTimes(1);
    });
    it('reports CSRF interception without following it', async () => {
        request.post.mockResolvedValue({status:302,headers:{location:'/security_interceptor.do'},data:''});
        const snapshot = await transport.loadForm('sys_script_include','-1',load);
        await expect(transport.submit(snapshot,'sysverb_insert_and_stay',{tokenSource:'page',landing:'guarded',sensitive:true})).rejects.toThrow('csrf_rejected');
        expect(request.get).toHaveBeenCalledTimes(1);
    });
    it('does not invent a landing or repeat a POST without Location', async () => {
        request.post.mockResolvedValue({status:302,headers:{},data:''});
        const snapshot = await transport.loadForm('sys_script_include','-1',load);
        await transport.submit(snapshot,'sysverb_insert_and_stay',{tokenSource:'page',landing:'guarded',sensitive:true});
        expect(request.get).toHaveBeenCalledTimes(1);
        expect(request.post).toHaveBeenCalledTimes(1);
    });
    it('does not follow a second redirect and marks the landing GET manual', async () => {
        const snapshot = await transport.loadForm('sys_script_include','-1',load);
        request.get.mockResolvedValue({status:302,headers:{location:'/login.do'},data:''});
        await expect(transport.submit(snapshot,'sysverb_insert_and_stay',{tokenSource:'page',landing:'guarded',sensitive:true})).rejects.toThrow();
        expect(request.get).toHaveBeenCalledTimes(2);
        expect(request.get.mock.calls[1][0]).toMatchObject({redirect:'manual',sensitive:true});
    });
    it('removes echoed field values, token values, and multiline script fragments from messages', async () => {
        request.post.mockResolvedValue({status:200,headers:{},data:'<div class="outputmsg outputmsg_error"><span class="outputmsg_text">Rejected secret-script-line page-token session-token</span></div>'});
        const snapshot = await transport.loadForm('sys_script_include','-1',load);
        const result = await transport.submit(snapshot,'sysverb_insert_and_stay',{ fields:{script:'secret-script-line\nsecond-line'},
            tokenSource:'page',landing:'guarded',sensitive:true });
        expect(JSON.stringify(result)).not.toMatch(/secret-script-line|page-token|session-token/);
    });
    it('keeps public load and submit overrides in the update call path', async () => {
        const {FormRecordWriter}=await import('../../../../src/comm/http/FormRecordWriter');
        const writer=new FormRecordWriter(new ServiceNowInstance({alias:'overrides'}));
        const snapshot=parseFormHtml(html(),'sys_script_include');snapshot.isNewRecord=false;
        const loadOverride=jest.spyOn(writer,'loadForm').mockResolvedValue(snapshot);
        const submitOverride=jest.spyOn(writer,'submit').mockResolvedValue({sysId:ID,action:'sysverb_update',messages:[]});
        await writer.update('sys_script_include',ID,{});
        expect(loadOverride).toHaveBeenCalledTimes(1);expect(submitOverride).toHaveBeenCalledTimes(1);
    });

});
