const http=require('http');
const fs=require('fs');
const path=require('path');

const PORT=process.env.PORT||3000;
const ROOT=__dirname;
const WORKER_URL=(process.env.WORKERS_AI_URL||'https://codezero-ai.heitorfer143.workers.dev/chat').trim();
const AI_BASE_URL=(process.env.AI_BASE_URL||'').replace(/\/$/,'');
const AI_API_KEY=process.env.AI_API_KEY||'';
const AI_MODEL=process.env.AI_MODEL||'';

const mime={
  '.html':'text/html; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.ico':'image/x-icon'
};

function commonHeaders(type='application/json; charset=utf-8'){
  return {
    'Content-Type':type,
    'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Cross-Origin-Resource-Policy':'same-origin'
  };
}
function sendJson(res,status,obj){
  res.writeHead(status,commonHeaders());
  res.end(JSON.stringify(obj));
}
async function readJson(req,max=2e6){
  let raw='';
  for await(const c of req){
    raw+=c;
    if(raw.length>max) throw new Error('Payload muito grande');
  }
  return JSON.parse(raw||'{}');
}
async function workerChat(payload){
  const r=await fetch(WORKER_URL,{
    method:'POST',
    headers:{'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify(payload)
  });
  const raw=await r.text();
  let data=null;
  try{data=JSON.parse(raw)}catch{}
  if(!r.ok){
    const detail=data?.details||data?.error||raw||('HTTP '+r.status);
    const err=new Error(String(detail).slice(0,500));
    err.status=r.status;
    throw err;
  }
  const response=
    data?.response||
    data?.text||
    data?.output_text||
    data?.message||
    data?.choices?.[0]?.message?.content||
    data?.result?.response||
    data?.result?.text||
    (typeof data?.result==='string'?data.result:'');
  if(!response) throw new Error('Worker respondeu sem texto');
  return {response};
}
async function providerChat(payload){
  const message=String(payload.message||'').trim();
  const messages=[
    {role:'system',content:'Você é a IA do CodeZero, especialista em programação. Responda em português do Brasil. Quando alterar arquivos, use exatamente <<<FILE:nome>>> conteúdo <<<END_FILE>>>. Forneça código funcional e completo.'},
    ...(Array.isArray(payload.history)?payload.history.slice(-6):[]),
    {role:'user',content:`${message}\n\nProjeto atual:\n${String(payload.project||'').slice(0,12000)}`}
  ];
  const r=await fetch(AI_BASE_URL+'/chat/completions',{
    method:'POST',
    headers:{'content-type':'application/json','authorization':'Bearer '+AI_API_KEY},
    body:JSON.stringify({model:AI_MODEL,messages,temperature:.2})
  });
  const raw=await r.text();
  let data=null;
  try{data=JSON.parse(raw)}catch{}
  if(!r.ok){
    const err=new Error(data?.error?.message||raw.slice(0,500)||('HTTP '+r.status));
    err.status=r.status;
    throw err;
  }
  const response=data?.choices?.[0]?.message?.content||data?.response||data?.output_text||'';
  if(!response) throw new Error('Provedor respondeu sem texto');
  return {response};
}
async function handleChat(req,res){
  try{
    const body=await readJson(req);
    const message=String(body.message||'').trim();
    if(!message) return sendJson(res,400,{error:'Mensagem vazia'});
    let result;
    if(AI_API_KEY&&AI_BASE_URL&&AI_MODEL){
      result=await providerChat(body);
    }else{
      result=await workerChat(body);
    }
    return sendJson(res,200,result);
  }catch(e){
    const status=Number(e?.status)||502;
    return sendJson(res,status,{error:'Erro da IA',details:String(e?.message||e)});
  }
}
function safeFile(urlPath){
  let decoded;
  try{decoded=decodeURIComponent(urlPath.split('?')[0]);}catch{return null;}
  if(decoded==='/') decoded='/index.html';
  const full=path.resolve(ROOT,'.'+decoded);
  const root=path.resolve(ROOT);
  if(full!==root&&!full.startsWith(root+path.sep)) return null;
  return full;
}
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){
    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'Content-Type',
      'Access-Control-Allow-Methods':'GET,POST,OPTIONS'
    });
    return res.end();
  }
  if(req.url==='/health'){
    return sendJson(res,200,{
      status:'online',
      service:'CodeZero Railway',
      ai:(AI_API_KEY&&AI_BASE_URL&&AI_MODEL)?'provider':'workers-fallback'
    });
  }
  if(req.url==='/chat'&&req.method==='POST') return handleChat(req,res);
  if(req.method!=='GET'&&req.method!=='HEAD') return sendJson(res,405,{error:'Método não permitido'});
  const file=safeFile(req.url||'/');
  if(!file) return sendJson(res,403,{error:'Forbidden'});
  fs.stat(file,(err,st)=>{
    if(err||!st.isFile()) return sendJson(res,404,{error:'Not found'});
    const type=mime[path.extname(file).toLowerCase()]||'application/octet-stream';
    res.writeHead(200,commonHeaders(type));
    if(req.method==='HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});
server.listen(PORT,'0.0.0.0',()=>console.log(`CodeZero online :${PORT} · AI ${AI_API_KEY&&AI_BASE_URL&&AI_MODEL?'provider':'Workers fallback'}`));
