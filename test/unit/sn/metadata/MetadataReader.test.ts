import {describe,expect,it,jest} from '@jest/globals';
import {MetadataReader} from '../../../../src/sn/metadata/internal/MetadataReader';
const row=(n:number)=>({sys_id:n.toString(16).padStart(32,'0'),name:'fixture'});
function response(rows: unknown[],total: string=''+rows.length) {return {status:200,headers:{'x-total-count':total},bodyObject:{result:rows}};}
describe('complete metadata reads',()=>{
    it('pages until the complete declared result is read',async()=>{
        const get=jest.fn<any>().mockResolvedValueOnce(response(Array.from({length:200},(_,i)=>row(i)),'201')).mockResolvedValueOnce(response([row(200)],'201'));
        const rows=await new MetadataReader({get} as any).rows('sys_scope','scope=x_test','sys_id,name');
        expect(rows).toHaveLength(201);
        expect(get.mock.calls[1][0].query.sysparm_offset).toBe('200');
        expect(get.mock.calls.every(([r])=>r.sensitive===true&&r.path.startsWith('/api/now/table/'))).toBe(true);
        // A long query's second page is refused unless the Link header is suppressed; paging needs only X-Total-Count.
        expect(get.mock.calls.every(([r])=>r.query.sysparm_suppress_pagination_header==='true')).toBe(true);
    });
    it('refuses a later page the instance refused, rather than returning the first',async()=>{
        const get=jest.fn<any>().mockResolvedValueOnce(response(Array.from({length:200},(_,i)=>row(i)),'227')).mockResolvedValueOnce({status:400,headers:{},bodyObject:{error:{message:'Pagination not supported'}}});
        await expect(new MetadataReader({get} as any).rows('sys_security_acl_role','x=y','sys_id,name')).rejects.toMatchObject({code:'evidence_unavailable'});
    });
    it.each(['short','missing-count','changed-count','duplicate','incomplete-fields'])('refuses %s evidence',async kind=>{
        let first:any=response([row(1)],'2');
        if(kind==='missing-count')first.headers={};
        if(kind==='duplicate')first=response([row(1),row(1)]);
        if(kind==='incomplete-fields')first=response([{sys_id:row(1).sys_id}]);
        const get=jest.fn<any>().mockResolvedValue(first);
        if(kind==='changed-count')get.mockReset().mockResolvedValueOnce(response(Array.from({length:200},(_,i)=>row(i)),'201')).mockResolvedValueOnce(response([row(200)],'202'));
        await expect(new MetadataReader({get} as any).rows('sys_scope','scope=x_test','sys_id,name')).rejects.toMatchObject({code:'evidence_unavailable'});
    });
    it('reads an optional field the instance omitted as empty, and still requires the others',async()=>{
        const get=jest.fn<any>().mockResolvedValue(response([{sys_id:row(1).sys_id,name:'fixture'},{sys_id:row(2).sys_id,name:'fixture','role.name':'itil'}]));
        const rows=await new MetadataReader({get} as any).rows('sys_security_acl_role','x=y','sys_id,name,role.name',['role.name']);
        expect(rows.map(r=>r['role.name'])).toEqual(['','itil']);
        for(const optional of [['other.name'],['name']])
            await expect(new MetadataReader({get} as any).rows('sys_security_acl_role','x=y','sys_id,name,role.name',optional)).rejects.toMatchObject({code:'evidence_unavailable'});
        const nulled=jest.fn<any>().mockResolvedValue(response([{sys_id:row(1).sys_id,name:'fixture','role.name':null}]));
        await expect(new MetadataReader({get:nulled} as any).rows('sys_security_acl_role','x=y','sys_id,name,role.name',['role.name'])).rejects.toMatchObject({code:'evidence_unavailable'});
    });
    it('refuses an exact read whose returned ID does not match',async()=>{
        const get=jest.fn<any>().mockResolvedValue(response([row(2)]));
        await expect(new MetadataReader({get} as any).exact('sys_scope',row(1).sys_id,'name')).rejects.toMatchObject({code:'evidence_unavailable'});
    });
});
