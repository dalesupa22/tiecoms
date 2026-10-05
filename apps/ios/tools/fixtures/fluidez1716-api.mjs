// Read-only synthetic mobile fixture. No database, provider, real account or message sending.
import http from 'node:http';
import {writeFileSync} from 'node:fs';
const port = Number(process.env.PORT ?? 3196), now = new Date().toISOString();
const me = {id:'qa-me',name:'Danny QA',email:'fluidez@synthetic.test',kind:'human',primaryOrgId:'qa-org'};
const lorena = {id:'qa-lorena',name:'Lorena',kind:'human',orgId:'qa-org'};
const conv = {id:'qa-dm',kind:'direct',memberIds:[me.id,lorena.id],lastMessageSeq:2,lastEventSeq:1,lastReadSeq:0,unread:2,canPost:true,historyFromSeq:0,lastMessageAt:now,lastMessagePreview:'Revisa las tareas de hoy'};
const bootstrap = {contract:'2026-09-28',serverTime:now,me,features:{mail:true,calls:true},organizations:[{id:'qa-org',name:'Chaggu QA',myRole:'owner'}],workspaces:[],conversations:[conv],people:[{...me,orgId:'qa-org'},lorena]};
const issues = [['mine','Mi tarea pendiente','open',me.id],['lorena-done','Lorena completada','done',lorena.id],['lorena-cancel','Lorena cancelada','cancelled',lorena.id],['lorena-pending','Lorena pendiente','waiting',lorena.id]].map(([id,title,status,ownerId])=>({id,title,status,ownerId,assigneeIds:[ownerId],conversationId:conv.id,createdBy:me.id,createdAt:now,updatedAt:now,statusSince:now,closedAt:status==='done'?now:null}));
const messages = [1,2].map(seq=>({id:`m-${seq}`,conversationId:conv.id,seq,authorId:lorena.id,kind:'text',body:seq===1?'Hola Danny, aquí están las tareas.':'Revisa las tareas de hoy',createdAt:now}));
const stats = {messagePOSTs:0};
function json(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost'), path=url.pathname; req.resume(); stats[path]=(stats[path]??0)+1;
 if(path==='/__stats')return json(res,200,stats);
 if(path==='/api/v1/auth/login'||path==='/api/v1/auth/refresh')return json(res,200,{accessToken:'synthetic-local-only',refreshToken:'synthetic-local-only',accessExpiresAt:new Date(Date.now()+3600000).toISOString(),sessionId:'fixture',user:me});
 if(path==='/api/v1/bootstrap')return json(res,200,bootstrap);
 if(path==='/api/v1/issues')return json(res,200,{issues,nextOffset:null});
 if(path===`/api/v1/conversations/${conv.id}/messages`){if(req.method!=='GET'){stats.messagePOSTs++;return json(res,405,{error:{code:'read_only_fixture',message:'Read only'}});}return json(res,200,{messages,hasMore:false,lastEventSeq:1});}
 if(path===`/api/v1/conversations/${conv.id}/read`)return json(res,200,{lastReadSeq:2});
 if(path.endsWith('/events'))return json(res,200,{events:[],resetRequired:false,lastEventSeq:1});
 if(path==='/api/v1/gg/side/pending')return json(res,200,{['c:'+conv.id]:2});
 if(path==='/api/v1/gg/side')return json(res,200,{session:1,messages:[{id:'gg-first',role:'assistant',body:'Hola, soy gg. Este es un historial sintético.',createdAt:now}],pending:2});
 if(path.startsWith('/api/v1/'))return json(res,200,{items:[],issues:[],topics:[],events:[],pins:[],userIds:[],accounts:[],reminders:[]});
 return json(res,404,{error:{code:'not_found',message:'fixture'}});
}).listen(port,'127.0.0.1',()=>{
 const fixture={apiUrl:`http://127.0.0.1:${port}`,email:me.email,password:'local-fixture-only',dmId:conv.id,fail:0};
 if(process.env.FIXTURE_OUT)writeFileSync(process.env.FIXTURE_OUT,JSON.stringify(fixture));
 console.log(JSON.stringify({fixture:'fluidez1716',port}));
});
