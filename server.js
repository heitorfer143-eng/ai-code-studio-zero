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
const FREE_GATEWAY_URL=(process.env.FREE_GATEWAY_URL||'https://api.llm7.io/v1').replace(/\/$/,'');
const FREE_GATEWAY_MODEL=process.env.FREE_GATEWAY_MODEL||'codestral-latest';
const CHAT_MODEL_CANDIDATES=(process.env.CHAT_MODEL_CANDIDATES||'gemini-3.1-flash-lite,deepseek-v4-flash:0731,codestral-latest').split(',').map(x=>x.trim()).filter(Boolean);
const CODE_MODEL_CANDIDATES=(process.env.CODE_MODEL_CANDIDATES||'deepseek-v4-flash:0731,gemini-3.1-flash-lite,codestral-latest').split(',').map(x=>x.trim()).filter(Boolean);
let ACTIVE_CHAT_MODEL=FREE_GATEWAY_MODEL;
let ACTIVE_CODE_MODEL=FREE_GATEWAY_MODEL;

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
function webIntent(message){
  const m=String(message||'').toLowerCase().trim();
  if(!m) return false;
  return /\b(pesquis|procure|busque|busca na internet|internet|web|site|sites|notícia|noticias|notícias|hoje|agora|atual|atualizado|último|ultima|última|recent|preço|cotação|quem é|o que aconteceu|documentação|docs|github|stackoverflow|wikipedia)\b/i.test(m);
}

function decodeHtml(text){
  return String(text||'')
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(parseInt(h,16)))
    .replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(parseInt(d,10)));
}
function stripHtml(html){
  return decodeHtml(String(html||'')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')
    .trim());
}
function safePublicUrl(raw){
  try{
    const u=new URL(raw);
    if(!['http:','https:'].includes(u.protocol)) return null;
    const h=u.hostname.toLowerCase();
    if(h==='localhost'||h==='127.0.0.1'||h==='0.0.0.0'||h==='::1'||h.endsWith('.local')) return null;
    if(/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
    return u.toString();
  }catch{return null;}
}
async function fetchText(url,timeout=8000){
  const safe=safePublicUrl(url);
  if(!safe) throw new Error('URL não permitida');
  const r=await fetch(safe,{headers:{'user-agent':'Mozilla/5.0 CodeZeroBot/1.0','accept':'text/html,application/xhtml+xml,text/plain'},signal:AbortSignal.timeout(timeout),redirect:'follow'});
  if(!r.ok) throw new Error('HTTP '+r.status);
  const type=(r.headers.get('content-type')||'').toLowerCase();
  if(!type.includes('text/')&&!type.includes('html')&&!type.includes('json')) throw new Error('Conteúdo não textual');
  return await r.text();
}
async function webSearch(query,limit=5){
  const q=String(query||'').trim().slice(0,300);
  if(!q) return [];
  const url='https://html.duckduckgo.com/html/?q='+encodeURIComponent(q);
  const html=await fetchText(url,10000);
  const results=[];
  const re=/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=re.exec(html))&&results.length<limit){
    let href=decodeHtml(m[1]);
    try{
      const u=new URL(href,'https://duckduckgo.com');
      if(u.hostname.endsWith('duckduckgo.com')&&u.searchParams.get('uddg')) href=decodeURIComponent(u.searchParams.get('uddg'));
    }catch{}
    href=safePublicUrl(href);
    if(!href) continue;
    const title=stripHtml(m[2]).slice(0,180);
    if(!title) continue;
    results.push({title,url:href});
  }
  return results;
}
async function researchWeb(query){
  const results=await webSearch(query,5);
  const sources=[];
  for(const item of results.slice(0,4)){
    let excerpt='';
    try{
      const html=await fetchText(item.url,7000);
      excerpt=stripHtml(html).slice(0,2600);
    }catch{}
    sources.push({title:item.title,url:item.url,excerpt});
  }
  return sources;
}
function codingIntent(message){
  const m=String(message||'').toLowerCase().trim();
  if(!m) return false;
  return /\b(cria|crie|criar|construa|construir|faz|faça|fazer|adicione|adiciona|adicionar|coloca|coloque|inserir|insira|remove|remova|tirar|corrige|corrija|corrigir|arruma|arrume|conserta|conserte|altera|altere|muda|mude|editar|edite|implemente|implementa|programa|programe|coda|code|refatora|refatore|html|css|javascript|js|script|função|funcao|arquivo|index|botão|botao|site|página|pagina|app|componente|bug|erro de código|erro no código|erro no codigo)\b/i.test(m);
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
async function gatewayCompletion(messages,model,maxTokens=1800,temperature=0.25){
  const r=await fetch(FREE_GATEWAY_URL+'/chat/completions',{
    method:'POST',
    headers:{
      'content-type':'application/json',
      'accept':'application/json',
      'authorization':'Bearer unused'
    },
    body:JSON.stringify({model,messages,temperature,max_tokens:maxTokens})
  });
  const raw=await r.text();
  let data=null;
  try{data=JSON.parse(raw)}catch{}
  if(!r.ok){
    const detail=data?.error?.message||data?.error||data?.details||raw||('HTTP '+r.status);
    const err=new Error('Gateway '+model+' '+r.status+': '+String(detail).slice(0,500));
    err.status=r.status;
    throw err;
  }
  const response=extractResponseText(data)||extractResponseText(raw);
  if(!response) throw new Error('Gateway '+model+' respondeu sem texto');
  return response;
}

async function firstWorkingModel(candidates,label){
  for(const model of candidates){
    try{
      const text=await gatewayCompletion([
        {role:'system',content:'Responda somente OK.'},
        {role:'user',content:'OK?'}
      ],model,16,0);
      if(text){
        console.log('[model-selected]',label,model,String(text).slice(0,40));
        return model;
      }
    }catch(err){
      console.log('[model-rejected]',label,model,String(err?.message||err).slice(0,180));
    }
  }
  return FREE_GATEWAY_MODEL;
}

async function selectBestModels(){
  ACTIVE_CHAT_MODEL=await firstWorkingModel(CHAT_MODEL_CANDIDATES,'chat');
  ACTIVE_CODE_MODEL=await firstWorkingModel(CODE_MODEL_CANDIDATES,'code');
  console.log('[brain-models]',JSON.stringify({chat:ACTIVE_CHAT_MODEL,code:ACTIVE_CODE_MODEL}));
}

async function freeGatewayChat(payload){
  const message=String(payload.message||'').trim();
  const wantsCode=codingIntent(message);
  const wantsWeb=webIntent(message);
  const project=wantsCode?String(payload.project||'').slice(0,18000):'';
  const history=Array.isArray(payload.history)?payload.history.slice(-10):[];
  let sources=[];
  if(wantsWeb){
    try{sources=await researchWeb(message);}
    catch(err){console.log('[web-search-error]',String(err?.message||err));}
  }
  const webContext=sources.length
    ? '\n\nPESQUISA WEB ATUAL:\n'+sources.map((x,i)=>`[${i+1}] ${x.title}\n${x.url}\n${x.excerpt}`).join('\n\n')
    : '';

  if(!wantsCode){
    const systemPrompt='Você é o CodeZero, uma IA geral forte integrada a um editor. Converse naturalmente em português do Brasil. Responda diretamente ao que foi perguntado. Não transforme conversa casual em programação. Não altere arquivos nem use marcadores <<<FILE:...>>> sem pedido explícito. Quando houver pesquisa web, use as fontes, diferencie fatos de inferências e cite [1], [2] etc.';
    const messages=[
      {role:'system',content:systemPrompt},
      ...history,
      {role:'user',content:message+webContext}
    ];
    const response=await gatewayCompletion(messages,ACTIVE_CHAT_MODEL,2200,0.35);
    return {response,provider:'brain-v8.2',model:ACTIVE_CHAT_MODEL,mode:'chat',searched:wantsWeb,sources:sources.map(({title,url})=>({title,url}))};
  }

  // Passo 1: planejar sem editar arquivos.
  const planningMessages=[
    {role:'system',content:'Você é o planejador técnico do CodeZero. Analise o pedido e o projeto. Produza um plano curto, identifique arquivos afetados, riscos, dependências e critérios de sucesso. NÃO escreva blocos <<<FILE>>> ainda.'},
    ...history.slice(-6),
    {role:'user',content:message+'\n\nPROJETO:\n'+project+webContext}
  ];
  let plan='';
  try{
    plan=await gatewayCompletion(planningMessages,ACTIVE_CODE_MODEL,900,0.15);
  }catch(err){
    console.log('[planner-error]',String(err?.message||err));
  }

  // Passo 2: executar com o plano.
  const executionMessages=[
    {role:'system',content:'Você é o executor principal do CodeZero. Implemente o pedido em português do Brasil. Para TODO arquivo criado ou alterado use exatamente <<<FILE:nome>>> conteúdo completo <<<END_FILE>>>. Preserve o que já funciona. Não entregue pseudocódigo. Corrija sintaxe e integração entre arquivos.'},
    ...history.slice(-6),
    {role:'user',content:message+'\n\nPLANO TÉCNICO:\n'+plan+'\n\nPROJETO ATUAL:\n'+project+webContext}
  ];
  let draft=await gatewayCompletion(executionMessages,ACTIVE_CODE_MODEL,3600,0.18);

  // Passo 3: revisão independente do resultado.
  const reviewMessages=[
    {role:'system',content:'Você é o revisor sênior do CodeZero. Revise a solução abaixo procurando bugs de sintaxe, variáveis inexistentes, arquivos incompletos, regressões, problemas mobile e divergência do pedido. Se houver problema, devolva a SOLUÇÃO CORRIGIDA COMPLETA usando os mesmos marcadores <<<FILE:nome>>>...<<<END_FILE>>>. Se estiver correta, devolva exatamente a solução recebida, sem comentários adicionais.'},
    {role:'user',content:'PEDIDO:\n'+message+'\n\nPROJETO ORIGINAL:\n'+project+'\n\nSOLUÇÃO GERADA:\n'+draft}
  ];
  try{
    const reviewed=await gatewayCompletion(reviewMessages,ACTIVE_CODE_MODEL,3800,0.08);
    if(reviewed&&reviewed.includes('<<<FILE:')) draft=reviewed;
  }catch(err){
    console.log('[reviewer-error]',String(err?.message||err));
  }

  return {
    response:draft,
    provider:'brain-v8.2',
    model:ACTIVE_CODE_MODEL,
    mode:'code',
    plan,
    searched:wantsWeb,
    sources:sources.map(({title,url})=>({title,url}))
  };
}
async function publicFallbackChat(payload){
  const message=String(payload.message||'').trim();
  const history=Array.isArray(payload.history)
    ? payload.history.slice(-4).map(x=>String(x?.role||'user')+': '+String(x?.content||'')).join('\n')
    : '';
  const prompt=[
    'Você é o CodeZero, uma IA especialista em programação.',
    'Responda em português do Brasil.',
    history ? 'Conversa recente:\n'+history : '',
    'Pedido do usuário:\n'+message
  ].filter(Boolean).join('\n\n');
  const url=LEGACY_TEXT_URL+'/'+encodeURIComponent(prompt.slice(0,1800));
  const r=await fetch(url,{headers:{accept:'text/plain'}});
  const raw=(await r.text()).trim();
  if(!r.ok){
    const err=new Error('Fallback AI '+r.status+': '+raw.slice(0,300));
    err.status=r.status;
    throw err;
  }
  if(!raw) throw new Error('Fallback AI respondeu vazio');
  return {response:raw,provider:'legacy-fallback'};
}

async function providerSelfTest(){
  try{
    await selectBestModels();
    const chat=await freeGatewayChat({message:'Oi, diga apenas OK.'});
    console.log('[brain-chat-self-test]',chat.model,String(chat.response||'').slice(0,120));
    const code=await freeGatewayChat({message:'Crie uma função JavaScript soma(a,b) que retorna a+b.',project:'ARQUIVO script.js:\n'});
    console.log('[brain-code-self-test]',code.model,String(code.response||'').slice(0,180));
  }catch(err){
    console.log('[brain-self-test-error]',String(err?.message||err));
  }
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
    try{
      return await freeGatewayChat(payload);
    }catch(err){
      console.log('[free-gateway-error]',String(err?.message||err));
      return publicFallbackChat(payload);
    }
  }
  return {response,provider:'workers-ai'};
}
async function providerChat(payload){
  const message=String(payload.message||'').trim();
  const wantsCode=codingIntent(message);
  const project=wantsCode?String(payload.project||'').slice(0,12000):'';
  const systemPrompt=wantsCode
    ? 'Você é o CodeZero, uma IA assistente e programadora. O usuário pediu trabalho de código. Responda em português do Brasil. Ao alterar arquivos, use exatamente <<<FILE:nome>>> conteúdo <<<END_FILE>>> e gere código funcional.'
    : 'Você é o CodeZero, uma IA geral integrada a um editor. Converse normalmente em português do Brasil. Não altere arquivos e não use marcadores <<<FILE:...>>> em conversa casual. Só programe quando o usuário pedir explicitamente.';
  const messages=[
    {role:'system',content:systemPrompt},
    ...(Array.isArray(payload.history)?payload.history.slice(-8):[]),
    {role:'user',content:message+(project?'\n\nProjeto atual:\n'+project:'')}
  ];
  const r=await fetch(AI_BASE_URL+'/chat/completions',{
    method:'POST',
    headers:{'content-type':'application/json','authorization':'Bearer '+AI_API_KEY},
    body:JSON.stringify({model:AI_MODEL,messages,temperature:0.3})
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
  return {response,mode:wantsCode?'code':'chat'};
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
      try{
        result=await freeGatewayChat(body);
      }catch(err){
        console.log('[free-gateway-error]',String(err?.message||err));
        result=await workerChat(body);
      }
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
  const pathnameSearch=(req.url||'').split('?')[0];
  if(req.method==='OPTIONS'){
    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'Content-Type',
      'Access-Control-Allow-Methods':'GET,POST,OPTIONS'
    });
    return res.end();
  }
  if(pathnameSearch==='/search'&&req.method==='GET'){
    try{
      const u=new URL(req.url,'http://localhost');
      const q=String(u.searchParams.get('q')||'').trim();
      if(!q) return sendJson(res,400,{error:'Query vazia'});
      const sources=await researchWeb(q);
      return sendJson(res,200,{ok:true,query:q,sources:sources.map(({title,url,excerpt})=>({title,url,excerpt:excerpt.slice(0,700)}))});
    }catch(e){
      return sendJson(res,502,{error:'Falha na pesquisa',details:String(e?.message||e)});
    }
  }
  if(req.url==='/health'){
    return sendJson(res,200,{
      status:'online',
      service:'CodeZero Railway',
      ai:(AI_API_KEY&&AI_BASE_URL&&AI_MODEL)?'provider':'brain-v8.2',chatModel:ACTIVE_CHAT_MODEL,codeModel:ACTIVE_CODE_MODEL
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
server.listen(PORT,'0.0.0.0',()=>{console.log(`CodeZero online :${PORT} · AI ${AI_API_KEY&&AI_BASE_URL&&AI_MODEL?'provider':'brain-v8.2'}`); if(!(AI_API_KEY&&AI_BASE_URL&&AI_MODEL)) providerSelfTest();});
