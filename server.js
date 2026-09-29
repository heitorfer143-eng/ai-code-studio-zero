const http=require('http');
const fs=require('fs');
const path=require('path');

const PORT=process.env.PORT||3000;
const ROOT=__dirname;
const WORKER_URL=(process.env.WORKERS_AI_URL||'https://codezero-ai.heitorfer143.workers.dev/chat').trim();
const AI_BASE_URL=(process.env.AI_BASE_URL||'').replace(/\/$/,'');
const AI_API_KEY=process.env.AI_API_KEY||'';
const AI_MODEL=process.env.AI_MODEL||'';
const LEGACY_TEXT_URL=(process.env.LEGACY_TEXT_URL||'https://text.pollinations.ai').replace(/\/$/,'');

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
function extractResponseText(value, depth=0){
  if(depth>6 || value==null) return '';
  if(typeof value==='string') return value.trim();
  if(typeof value==='number' || typeof value==='boolean') return String(value);
  if(Array.isArray(value)){
    for(const item of value){
      const t=extractResponseText(item,depth+1);
      if(t) return t;
    }
    return '';
  }
  if(typeof value==='object'){
    const keys=['response','text','output_text','content','message','answer','completion','generated_text','result','data','choices'];
    for(const key of keys){
      if(Object.prototype.hasOwnProperty.call(value,key)){
        const t=extractResponseText(value[key],depth+1);
        if(t) return t;
      }
    }
    for(const child of Object.values(value)){
      const t=extractResponseText(child,depth+1);
      if(t) return t;
    }
  }
  return '';
}
async function workerSelfTest(){
  try{
    const payload={
      message:'Responda somente com a palavra OK.',
      prompt:'Responda somente com a palavra OK.',
      query:'Responda somente com a palavra OK.',
      input:'Responda somente com a palavra OK.',
      messages:[{role:'user',content:'Responda somente com a palavra OK.'}]
    };
    const r=await fetch(WORKER_URL,{
      method:'POST',
      headers:{'content-type':'application/json','accept':'application/json'},
      body:JSON.stringify(payload)
    });
    const raw=await r.text();
    console.log('[worker-self-test]',r.status,raw.slice(0,1200));
    if(/não retornou texto|respondeu sem texto/i.test(raw)){
      const fb=await publicFallbackChat({message:'Responda somente com OK.'});
      console.log('[fallback-self-test]',String(fb.response||'').slice(0,300));
    }
  }catch(err){
    console.log('[worker-self-test-error]',String(err?.message||err));
  }
}

async function publicFallbackChat(payload){
  const message=String(payload.message||'').trim();
  const project=String(payload.project||'').slice(0,4200);
  const history=Array.isArray(payload.history)
    ? payload.history.slice(-4).map(x=>String(x?.role||'user')+': '+String(x?.content||'')).join('\n')
    : '';
  const prompt=[
    'Você é o CodeZero, uma IA especialista em programação.',
    'Responda em português do Brasil.',
    'Quando alterar arquivos, use exatamente <<<FILE:nome>>> conteúdo <<<END_FILE>>>.',
    'Seja direto, técnico e forneça código funcional.',
    history ? 'Conversa recente:\n'+history : '',
    'Pedido do usuário:\n'+message,
    project ? 'Projeto atual:\n'+project : ''
  ].filter(Boolean).join('\n\n');
  const url=LEGACY_TEXT_URL+'/'+encodeURIComponent(prompt.slice(0,6500));
  const r=await fetch(url,{
    method:'GET',
    headers:{'accept':'text/plain'}
  });
  const raw=(await r.text()).trim();
  if(!r.ok) {
    const err=new Error('Fallback AI '+r.status+': '+raw.slice(0,300));
    err.status=r.status;
    throw err;
  }
  if(!raw) throw new Error('Fallback AI respondeu vazio');
  return {response:raw,provider:'public-fallback'};
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
  const response=extractResponseText(data)||extractResponseText(raw);
  const brokenWorkerReply=/não retornou texto|respondeu sem texto/i.test(response||'');
  if(!response || brokenWorkerReply) {
    console.log('[worker-fallback]',brokenWorkerReply?'broken-worker-reply':'empty-worker-reply');
    return publicFallbackChat(payload);
  }
  return {response,provider:'workers-ai'};
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
server.listen(PORT,'0.0.0.0',()=>{console.log(`CodeZero online :${PORT} · AI ${AI_API_KEY&&AI_BASE_URL&&AI_MODEL?'provider':'Workers fallback'}`); if(!(AI_API_KEY&&AI_BASE_URL&&AI_MODEL)) workerSelfTest();});
