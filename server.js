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
const IMAGE_BASE_URL=(process.env.IMAGE_BASE_URL||'https://gen.pollinations.ai').replace(/\/$/,'');
const IMAGE_MODEL=process.env.IMAGE_MODEL||'flux';
const IMAGE_EDIT_MODEL=process.env.IMAGE_EDIT_MODEL||'kontext';
const POLLINATIONS_KEY=process.env.POLLINATIONS_KEY||'';
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
function parseDataImage(dataUrl){
  const m=String(dataUrl||'').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if(!m) throw new Error('Imagem inválida.');
  const buffer=Buffer.from(m[2],'base64');
  if(!buffer.length) throw new Error('Imagem vazia.');
  if(buffer.length>8*1024*1024) throw new Error('Imagem maior que 8 MB.');
  return {mime:m[1],buffer};
}
async function editImageAuthenticated(dataUrl,prompt,filename='image.png',model=IMAGE_EDIT_MODEL,size='1024x1024'){
  if(!POLLINATIONS_KEY) throw new Error('POLLINATIONS_KEY não configurada.');
  const parsed=parseDataImage(dataUrl);
  const form=new FormData();
  form.append('image',new Blob([parsed.buffer],{type:parsed.mime}),filename);
  form.append('prompt',prompt);
  form.append('model',model);
  form.append('size',size);
  const r=await fetch(IMAGE_BASE_URL+'/v1/images/edits',{method:'POST',headers:{authorization:'Bearer '+POLLINATIONS_KEY},body:form});
  const raw=await r.text();
  let data=null;
  try{data=JSON.parse(raw)}catch{}
  if(!r.ok) throw new Error(data?.error?.message||data?.error||raw||('HTTP '+r.status));
  const item=data?.data?.[0];
  if(item?.url) return {url:item.url};
  if(item?.b64_json) return {dataUrl:'data:image/png;base64,'+item.b64_json};
  throw new Error('Edição não retornou imagem.');
}
function editImageReferenceUrl(sourceUrl,prompt,model=IMAGE_EDIT_MODEL){
  if(!/^https?:\/\//i.test(sourceUrl)) throw new Error('Para edição sem chave, a imagem precisa ter URL pública.');
  return IMAGE_BASE_URL+'/image/'+encodeURIComponent(prompt)+'?model='+encodeURIComponent(model)+'&image='+encodeURIComponent(sourceUrl)+'&nologo=true&seed='+Date.now();
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
function imageIntent(message){
  const m=String(message||'').toLowerCase();
  return /\b(gera|gere|gerar|cria|crie|criar|faça|fazer|imagem|image|foto|picture|ilustração|ilustracao|textura|texture|background|fundo|sprite|ícone|icone|thumbnail|banner|logo)\b/i.test(m) && /\b(imagem|image|foto|picture|ilustração|ilustracao|textura|texture|background|fundo|sprite|ícone|icone|thumbnail|banner|logo)\b/i.test(m);
}
function godotIntent(message){
  const m=String(message||'').toLowerCase();
  return /\b(godot|gdscript|project\.godot|\.tscn|\.tres|\.gdshader|node3d|characterbody3d|camera3d|meshinstance3d|rigidbody3d|area3d|animationplayer|navigationagent3d|multiplayerpeer|enetmultiplayerpeer)\b/i.test(m);
}
function threeDIntent(message){
  const m=String(message||'').toLowerCase();
  return /\b(3d|three\.?js|webgl|babylon|gltf|glb|modelo 3d|jogo 3d|game 3d|terreno|terrain|first person|primeira pessoa|third person|terceira pessoa|orbitcontrols|raycast|shader|scene|câmera 3d|camera 3d)\b/i.test(m);
}
function codingIntent(message){
  const m=String(message||'').toLowerCase().trim();
  if(!m) return false;
  if(godotIntent(m)||threeDIntent(m)) return true;
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
async function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function gatewayCompletion(messages,model,maxTokens=1800,temperature=0.25){
  let lastError=null;
  for(let attempt=0;attempt<4;attempt++){
    if(attempt>0) await sleep(900+attempt*700);
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
    if(r.ok){
      const response=extractResponseText(data)||extractResponseText(raw);
      if(response) return response;
      lastError=new Error('Gateway '+model+' respondeu sem texto');
      continue;
    }
    const detail=data?.error?.message||data?.error||data?.details||raw||('HTTP '+r.status);
    lastError=new Error('Gateway '+model+' '+r.status+': '+String(detail).slice(0,500));
    lastError.status=r.status;
    if(r.status!==429) throw lastError;
    console.log('[gateway-retry]',model,'attempt',attempt+1);
  }
  throw lastError||new Error('Gateway indisponível');
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
  ACTIVE_CHAT_MODEL=FREE_GATEWAY_MODEL;
  ACTIVE_CODE_MODEL=FREE_GATEWAY_MODEL;
  console.log('[brain-models]',JSON.stringify({chat:ACTIVE_CHAT_MODEL,code:ACTIVE_CODE_MODEL,mode:'anonymous-stable'}));
}

function parseFileBlocks(text){
  const files={};
  const re=/<<<FILE:([^>]+)>>>([\s\S]*?)<<<END_FILE>>>/g;
  let m;
  while((m=re.exec(String(text||'')))){
    const name=m[1].trim().replace(/^\/+/, '');
    if(!/^[\w.\-\/]+$/.test(name)) continue;
    files[name]=m[2].replace(/^\n/,'').replace(/\n$/,'');
  }
  return files;
}

function balancedPairs(text,open,close){
  let depth=0,quote=null,escaped=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quote){
      if(escaped){escaped=false;continue;}
      if(ch==='\\\\'){escaped=true;continue;}
      if(ch===quote) quote=null;
      continue;
    }
    if(ch==='"'||ch==="'"||ch==='`'){quote=ch;continue;}
    if(ch===open) depth++;
    if(ch===close) depth--;
    if(depth<0) return false;
  }
  return depth===0 && !quote;
}

function validateGodotFiles(files){
  const errors=[];
  for(const [name,content] of Object.entries(files)){
    if(name==='project.godot'){
      if(!/^\s*\[application\]/m.test(content)) errors.push('project.godot: falta seção [application].');
      if(!/^\s*\[display\]/m.test(content)&&!/^\s*\[rendering\]/m.test(content)) errors.push('project.godot: configuração mínima incompleta.');
    }
    if(name.endsWith('.gd')){
      const lines=String(content).split('\n');
      for(let i=0;i<lines.length;i++){
        if(/^\s*func\s+\w+\s*\([^)]*\)\s*$/.test(lines[i])) errors.push(name+': linha '+(i+1)+' parece função sem dois-pontos.');
      }
      if(/\bextends\s*$/.test(content)) errors.push(name+': extends incompleto.');
    }
    if(name.endsWith('.tscn')){
      if(!/^\s*\[gd_scene\b/m.test(content)) errors.push(name+': cena sem cabeçalho [gd_scene].');
      if(!/^\s*\[node\b/m.test(content)) errors.push(name+': cena sem nodes.');
    }
    if(name.endsWith('.gdshader')){
      if(!/\bshader_type\b/.test(content)) errors.push(name+': shader sem shader_type.');
    }
  }
  return errors;
}

function validateGeneratedFiles(files){
  const errors=[];
  if(!Object.keys(files).length) errors.push('Nenhum bloco de arquivo foi entregue.');
  for(const [name,content] of Object.entries(files)){
    if(!String(content).trim()) errors.push(name+': arquivo vazio.');
    if(name.endsWith('.js')){
      if(!balancedPairs(content,'{','}')) errors.push(name+': chaves desbalanceadas.');
      if(!balancedPairs(content,'(',')')) errors.push(name+': parênteses desbalanceados.');
      if(!/^\s*(import|export)\b/m.test(content)){ try{ new Function(content); }catch(err){ errors.push(name+': JavaScript inválido: '+String(err.message||err)); } }
    }
    if(name.endsWith('.css')&&!balancedPairs(content,'{','}')) errors.push(name+': CSS desbalanceado.');
    if(name.endsWith('.html')){
      if(!/<[a-z][\s\S]*>/i.test(content)) errors.push(name+': HTML inválido.');
      const a=(content.match(/<script\b/gi)||[]).length,b=(content.match(/<\/script>/gi)||[]).length;
      if(a!==b) errors.push(name+': tags script desbalanceadas.');
    }
  }
  errors.push(...validateGodotFiles(files));
  return errors;
}

function parseProjectSnapshot(project){
  const out={};
  const text=String(project||'');
  const re=/^ARQUIVO\s+([^:]+):\n/gm;
  const matches=[...text.matchAll(re)];
  for(let i=0;i<matches.length;i++){
    const name=matches[i][1].trim();
    const start=matches[i].index+matches[i][0].length;
    const end=i+1<matches.length?matches[i+1].index:text.length;
    out[name]=text.slice(start,end).replace(/\n\n$/,'').trimEnd();
  }
  return out;
}

function buildProjectMap(project){
  const files=parseProjectSnapshot(project);
  const names=Object.keys(files);
  const scenes=[];
  const scripts=[];
  const resources=[];
  const refs=[];
  for(const [name,content] of Object.entries(files)){
    if(name.endsWith('.tscn')) scenes.push(name);
    if(name.endsWith('.gd')) scripts.push(name);
    if(name.endsWith('.tres')||name.endsWith('.gdshader')) resources.push(name);
    for(const m of String(content).matchAll(/res:\/\/([^"')\s]+)/g)){
      refs.push({from:name,to:m[1]});
    }
  }
  const mainScene=/run\/main_scene="res:\/\/([^"]+)"/.exec(files['project.godot']||'')?.[1]||'';
  return {files:names,scenes,scripts,resources,refs,mainScene};
}

function validateProjectReferences(generatedFiles,project){
  const original=parseProjectSnapshot(project);
  const combined={...original,...generatedFiles};
  const names=new Set(Object.keys(combined));
  const errors=[];
  for(const [name,content] of Object.entries(generatedFiles)){
    for(const m of String(content).matchAll(/res:\/\/([^"')\s]+)/g)){
      const target=m[1];
      if(!names.has(target) && !target.endsWith('.import')) errors.push(name+': referência ausente res://'+target);
    }
  }
  const pg=generatedFiles['project.godot']||original['project.godot']||'';
  const main=/run\/main_scene="res:\/\/([^"]+)"/.exec(pg)?.[1]||'';
  if(main&&!names.has(main)) errors.push('project.godot: main_scene aponta para arquivo inexistente res://'+main);
  return errors;
}

function taskComplexity(message,project){
  const m=String(message||'').toLowerCase();
  const files=projectFileNames(project).length;
  let score=0;
  if(files>=6) score++;
  if(files>=12) score++;
  if(/\b(multiplayer|servidor|save|salvamento|inventário|inventario|combate|boss|procedural|geração|geracao|navigation|shader|state machine|máquina de estados|maquina de estados|sistema completo|projeto completo)\b/i.test(m)) score+=2;
  if(/\b(3d|godot|gdscript|tscn|física|fisica|colisão|colisao|animação|animacao)\b/i.test(m)) score++;
  if(String(message||'').length>450) score++;
  return score>=4?'high':score>=2?'medium':'low';
}

function projectFileNames(project){
  return [...String(project||'').matchAll(/^ARQUIVO\s+([^:]+):/gm)].map(m=>m[1].trim());
}
async function freeGatewayChat(payload){
  const message=String(payload.message||'').trim();
  const wantsCode=codingIntent(message);
  const wantsGodot=godotIntent(message)||/ARQUIVO project\.godot:/m.test(String(payload.project||''));
  const wants3D=threeDIntent(message);
  const wantsWeb=webIntent(message);
  const project=wantsCode?String(payload.project||'').slice(0,32000):'';
  const memory=String(payload.memory||'').slice(0,6000);
  const history=Array.isArray(payload.history)?payload.history.slice(-12):[];
  const complexity=taskComplexity(message,project);
  const projectMap=buildProjectMap(project);
  const projectMapText=JSON.stringify(projectMap,null,2).slice(0,8000);

  let sources=[];
  if(wantsWeb){
    try{sources=await researchWeb(message);}
    catch(err){console.log('[web-search-error]',String(err?.message||err));}
  }
  const webContext=sources.length
    ? '\n\nPESQUISA WEB ATUAL:\n'+sources.map((x,i)=>`[${i+1}] ${x.title}\n${x.url}\n${x.excerpt}`).join('\n\n')
    : '';

  if(!wantsCode){
    const systemPrompt=[
      'Você é o CodeZero V10, uma IA geral e técnica integrada a um editor.',
      'Converse naturalmente em português do Brasil e responda diretamente.',
      'Não transforme conversa casual em programação.',
      'Quando houver pesquisa web, use as fontes e cite [1], [2] etc.',
      'Quando o usuário perguntar sobre Godot, priorize Godot 4.x e GDScript atuais.',
      'Se não souber algo, diga o que falta em vez de inventar.'
    ].join(' ');
    const messages=[
      {role:'system',content:systemPrompt},
      ...history,
      {role:'user',content:message+(memory?'\n\nMEMÓRIA DO PROJETO:\n'+memory:'')+webContext}
    ];
    const response=await gatewayCompletion(messages,ACTIVE_CHAT_MODEL,2600,0.3);
    return {response,provider:'brain-v10',model:ACTIVE_CHAT_MODEL,mode:'chat',complexity,searched:wantsWeb,sources:sources.map(({title,url})=>({title,url}))};
  }

  // Passo 1: especificação + plano.
  const planningMessages=[
    {role:'system',content:[
      'Você é o arquiteto sênior do CodeZero V10.',
      'Converta o pedido em requisitos verificáveis, riscos, arquivos afetados e plano.',
      'Liste critérios de aceitação concretos antes do plano.',
      'Nunca escreva blocos <<<FILE>>> nesta etapa.',
      'Para Godot use Godot 4.x, GDScript atual, caminhos res://, cenas .tscn, recursos .tres/.gdshader e Input Map coerente.',
      'Em Godot 3D pense em árvore de cena, física, colisões, câmera, sinais, animação, navegação, performance e mobile quando relevante.',
      'Não converta projeto Godot para Three.js.'
    ].join(' ')},
    ...history.slice(-8),
    {role:'user',content:
      'PEDIDO:\n'+message+
      '\n\nCOMPLEXIDADE DETECTADA: '+complexity+
      '\n\nMAPA DO PROJETO:\n'+projectMapText+
      (memory?'\n\nMEMÓRIA DO PROJETO:\n'+memory:'')+
      '\n\nPROJETO ATUAL:\n'+project+
      webContext
    }
  ];
  let plan='';
  try{
    plan=await gatewayCompletion(planningMessages,ACTIVE_CODE_MODEL,1500,0.12);
  }catch(err){
    console.log('[planner-error]',String(err?.message||err));
    plan='Implemente o pedido exatamente, preservando o projeto atual e validando todas as referências.';
  }

  // Passo 2: execução.
  const knownFiles=projectFileNames(project);
  const executionMessages=[
    {role:'system',content:[
      'Você é o executor principal do CodeZero V10.',
      'Implemente EXATAMENTE os requisitos e critérios de aceitação do plano.',
      'Para TODO arquivo criado ou alterado use <<<FILE:nome>>> conteúdo COMPLETO <<<END_FILE>>>.',
      'Nunca use pseudocódigo, TODOs, placeholders ou trechos parciais.',
      'Preserve comportamento existente que não foi pedido para mudar.',
      'Não invente APIs, nós, sinais, métodos ou arquivos.',
      'Para Godot, gere projeto real de Godot 4.x com GDScript, .tscn e recursos compatíveis; use res:// e Input Map corretamente.',
      'Quando alterar uma cena, confira NodePath, nomes dos nós, scripts anexados e ext_resource.',
      'Se o pedido for grande, prefira arquitetura modular em vários arquivos.',
      'Só use <<<IMAGE:...>>> ou <<<EDIT_IMAGE:...>>> quando o usuário pedir explicitamente imagem.',
      'Não diga que algo está pronto sem entregar os arquivos necessários.',
      'Arquivos conhecidos: '+knownFiles.join(', ')
    ].join(' ')},
    ...history.slice(-8),
    {role:'user',content:
      'PEDIDO ORIGINAL:\n'+message+
      '\n\nESPECIFICAÇÃO E PLANO:\n'+plan+
      '\n\nMAPA DO PROJETO:\n'+projectMapText+
      (memory?'\n\nMEMÓRIA DO PROJETO:\n'+memory:'')+
      '\n\nPROJETO ATUAL:\n'+project+
      webContext
    }
  ];
  let draft=await gatewayCompletion(executionMessages,ACTIVE_CODE_MODEL,complexity==='high'?5200:4200,0.08);

  // Passo 3: validação determinística + reparos.
  let files=parseFileBlocks(draft);
  let validationErrors=[
    ...validateGeneratedFiles(files),
    ...validateProjectReferences(files,project)
  ];
  const maxRepairs=complexity==='high'?3:2;
  for(let repair=0;repair<maxRepairs && validationErrors.length;repair++){
    console.log('[v10-validation-failed]',validationErrors);
    const repairMessages=[
      {role:'system',content:[
        'Você é o reparador técnico do CodeZero V10.',
        'Corrija TODOS os erros detectados sem remover funcionalidades corretas.',
        'Devolva a solução COMPLETA novamente usando <<<FILE:nome>>>...<<<END_FILE>>>.',
        'Em Godot, trate referências res://, NodePath, Input Map, scripts e cenas como dependências reais.'
      ].join(' ')},
      {role:'user',content:
        'PEDIDO ORIGINAL:\n'+message+
        '\n\nPLANO:\n'+plan+
        '\n\nPROJETO ORIGINAL:\n'+project+
        '\n\nSOLUÇÃO ATUAL:\n'+draft+
        '\n\nERROS DETECTADOS:\n- '+validationErrors.join('\n- ')
      }
    ];
    draft=await gatewayCompletion(repairMessages,ACTIVE_CODE_MODEL,4800,0.04);
    files=parseFileBlocks(draft);
    validationErrors=[
      ...validateGeneratedFiles(files),
      ...validateProjectReferences(files,project)
    ];
  }

  // Passo 4: revisão semântica.
  const reviewMessages=[
    {role:'system',content:[
      'Você é o revisor sênior e adversarial do CodeZero V10.',
      'Compare pedido, critérios de aceitação, projeto original e solução.',
      'Procure funcionalidades faltando, regressões, referências quebradas e código que parece correto mas não funciona.',
      'Para Godot, confira sintaxe Godot 4, hierarquia de nós, scripts, sinais, Input Map, res://, colisões, câmera, física e recursos.',
      'Se houver problema, devolva a SOLUÇÃO CORRIGIDA COMPLETA com <<<FILE:nome>>>...<<<END_FILE>>>.',
      'Se estiver correta, devolva exatamente os blocos de arquivo da solução, sem texto extra.'
    ].join(' ')},
    {role:'user',content:
      'PEDIDO:\n'+message+
      '\n\nCRITÉRIOS/PLANO:\n'+plan+
      '\n\nPROJETO ORIGINAL:\n'+project+
      '\n\nSOLUÇÃO CANDIDATA:\n'+draft
    }
  ];
  try{
    const reviewed=await gatewayCompletion(reviewMessages,ACTIVE_CODE_MODEL,complexity==='high'?5200:4400,0.02);
    const reviewedFiles=parseFileBlocks(reviewed);
    const reviewedErrors=[
      ...validateGeneratedFiles(reviewedFiles),
      ...validateProjectReferences(reviewedFiles,project)
    ];
    if(Object.keys(reviewedFiles).length && !reviewedErrors.length){
      draft=reviewed;
      files=reviewedFiles;
      validationErrors=[];
    }
  }catch(err){
    console.log('[v10-reviewer-error]',String(err?.message||err));
  }

  // Passo 5: juiz adicional somente em tarefas complexas.
  if(complexity==='high' && !validationErrors.length){
    try{
      const judge=await gatewayCompletion([
        {role:'system',content:'Você é o juiz final do CodeZero V10. Responda apenas PASS ou uma lista curta começando com FAIL: explicando requisitos não atendidos. Não escreva código.'},
        {role:'user',content:'PEDIDO:\n'+message+'\n\nCRITÉRIOS/PLANO:\n'+plan+'\n\nSOLUÇÃO:\n'+draft}
      ],ACTIVE_CODE_MODEL,500,0);
      if(/^FAIL:/i.test(judge)){
        const finalRepair=await gatewayCompletion([
          {role:'system',content:'Você é o reparador final. Corrija integralmente os problemas apontados pelo juiz e devolva TODOS os arquivos alterados em <<<FILE:nome>>>...<<<END_FILE>>>.'},
          {role:'user',content:'PEDIDO:\n'+message+'\n\nPROJETO:\n'+project+'\n\nSOLUÇÃO:\n'+draft+'\n\nJUIZ:\n'+judge}
        ],ACTIVE_CODE_MODEL,5200,0.02);
        const finalFiles=parseFileBlocks(finalRepair);
        const finalErrors=[...validateGeneratedFiles(finalFiles),...validateProjectReferences(finalFiles,project)];
        if(Object.keys(finalFiles).length&&!finalErrors.length){
          draft=finalRepair;
          files=finalFiles;
          validationErrors=[];
        }else{
          validationErrors.push(...finalErrors);
        }
      }
    }catch(err){
      console.log('[v10-judge-error]',String(err?.message||err));
    }
  }

  if(validationErrors.length){
    throw new Error('Não consegui validar a alteração com segurança: '+validationErrors.join(' | '));
  }

  return {
    response:draft,
    provider:'brain-v10',
    model:ACTIVE_CODE_MODEL,
    mode:'code',
    complexity,
    plan,
    validated:true,
    projectType:wantsGodot?'godot':(wants3D?'3d':'web'),
    changedFiles:Object.keys(files),
    projectMap,
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
    const chat=await gatewayCompletion([
      {role:'system',content:'Responda somente OK.'},
      {role:'user',content:'OK?'}
    ],ACTIVE_CHAT_MODEL,16,0);
    console.log('[brain-self-test]',ACTIVE_CHAT_MODEL,String(chat||'').slice(0,80));
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
  if(pathnameSearch==='/image/edit'&&req.method==='POST'){
    try{
      const body=await readJson(req,12*1024*1024);
      const prompt=String(body.prompt||'').trim().slice(0,1600);
      const filename=String(body.filename||'image.png').trim().slice(0,120);
      const model=String(body.model||IMAGE_EDIT_MODEL).trim().slice(0,120);
      const size=String(body.size||'1024x1024').trim().slice(0,32);
      const dataUrl=String(body.dataUrl||'');
      const sourceUrl=String(body.sourceUrl||'');
      if(!prompt) return sendJson(res,400,{error:'Prompt de edição vazio'});
      if(POLLINATIONS_KEY&&dataUrl){
        const out=await editImageAuthenticated(dataUrl,prompt,filename,model,size);
        return sendJson(res,200,{ok:true,...out,model,mode:'authenticated-edit'});
      }
      if(sourceUrl){
        const url=editImageReferenceUrl(sourceUrl,prompt,model);
        return sendJson(res,200,{ok:true,url,model,mode:'reference-edit'});
      }
      return sendJson(res,409,{error:'Para editar uma imagem enviada do celular, configure POLLINATIONS_KEY no Railway. Imagens geradas pelo CodeZero podem ser editadas sem isso.'});
    }catch(e){
      return sendJson(res,500,{error:'Falha ao editar imagem',details:String(e?.message||e)});
    }
  }
  if(pathnameSearch==='/image'&&req.method==='GET'){
    try{
      const u=new URL(req.url,'http://localhost');
      const prompt=String(u.searchParams.get('prompt')||'').trim().slice(0,1200);
      const model=String(u.searchParams.get('model')||IMAGE_MODEL).trim().slice(0,120);
      if(!prompt) return sendJson(res,400,{error:'Prompt de imagem vazio'});
      const imageUrl=IMAGE_BASE_URL+'/image/'+encodeURIComponent(prompt)+'?model='+encodeURIComponent(model)+'&nologo=true';
      return sendJson(res,200,{ok:true,prompt,model,url:imageUrl});
    }catch(e){
      return sendJson(res,500,{error:'Falha ao preparar imagem',details:String(e?.message||e)});
    }
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
      ai:(AI_API_KEY&&AI_BASE_URL&&AI_MODEL)?'provider':'brain-v8.3-agent',chatModel:ACTIVE_CHAT_MODEL,codeModel:ACTIVE_CODE_MODEL,imageModel:IMAGE_MODEL,imageEditModel:IMAGE_EDIT_MODEL,image:true,imageEdit:true,imageEditAuth:Boolean(POLLINATIONS_KEY)
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
server.listen(PORT,'0.0.0.0',()=>{console.log(`CodeZero online :${PORT} · AI ${AI_API_KEY&&AI_BASE_URL&&AI_MODEL?'provider':'brain-v8.3-agent'}`); if(!(AI_API_KEY&&AI_BASE_URL&&AI_MODEL)) providerSelfTest();});
