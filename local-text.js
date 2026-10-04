// CodeZero V15.8 — fallback de chat local/gratuito com resumo de contexto
// Tenta um LLM real no navegador via WebGPU. Se WebGPU/modelo falhar,
// mantém o chat vivo com um fallback offline mínimo e transparente.

const WEBLLM_URL='https://esm.run/@mlc-ai/web-llm@0.2.84';
const MODEL_F16='SmolLM2-360M-Instruct-q4f16_1-MLC';
const MODEL_F32='SmolLM2-360M-Instruct-q4f32_1-MLC';

let engine=null;
let engineModel='';
let loadPromise=null;
let lastLoadError=null;
let lastFailureAt=0;

function emit(cb,message,progress=null,error=false){
  if(typeof cb==='function') cb({message,progress,error});
}

export async function getLocalTextSupport(){
  if(!navigator.gpu){
    return {supported:false,reason:'WebGPU não está disponível neste navegador.',model:null,downloadMB:0};
  }
  try{
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter) return {supported:false,reason:'Nenhuma GPU WebGPU compatível foi encontrada.',model:null,downloadMB:0};
    const f16=adapter.features?.has?.('shader-f16')||false;
    return {
      supported:true,
      f16,
      model:f16?MODEL_F16:MODEL_F32,
      downloadMB:f16?376:580,
      cache:'browser-cache'
    };
  }catch(e){
    return {supported:false,reason:String(e?.message||e||'Falha ao detectar WebGPU.'),model:null,downloadMB:0};
  }
}

async function loadEngine(onStatus){
  const support=await getLocalTextSupport();
  if(!support.supported) throw new Error(support.reason);
  if(engine&&engineModel===support.model) return {engine,support};
  if(loadPromise) return await loadPromise;

  // Evita repetir imediatamente um carregamento que acabou de falhar.
  if(lastLoadError&&Date.now()-lastFailureAt<120000) throw lastLoadError;

  loadPromise=(async()=>{
    emit(onStatus,'Preparando IA local…',1,false);
    const webllm=await import(WEBLLM_URL);
    emit(onStatus,'Carregando modelo local (primeira vez pode baixar ~'+support.downloadMB+' MB)…',3,false);

    const created=await webllm.CreateMLCEngine(support.model,{
      initProgressCallback:(report)=>{
        const p=Math.round(Math.max(0,Math.min(1,Number(report?.progress)||0))*100);
        emit(onStatus,String(report?.text||'Carregando IA local…'),p,false);
      }
    });

    engine=created;
    engineModel=support.model;
    lastLoadError=null;
    emit(onStatus,'IA local pronta.',100,false);
    return {engine,support};
  })();

  try{
    return await loadPromise;
  }catch(e){
    lastLoadError=e instanceof Error?e:new Error(String(e));
    lastFailureAt=Date.now();
    engine=null;
    engineModel='';
    throw lastLoadError;
  }finally{
    loadPromise=null;
  }
}

function cleanHistory(history,maxMessages=12,maxChars=6000){
  const src=Array.isArray(history)?history:[];
  const out=[];
  let used=0;
  for(let i=src.length-1;i>=0&&out.length<maxMessages;i--){
    const role=src[i]?.role==='assistant'?'assistant':src[i]?.role==='user'?'user':null;
    if(!role) continue;
    let content=String(src[i]?.content||'').trim();
    if(!content) continue;
    const remaining=maxChars-used;
    if(remaining<=0) break;
    if(content.length>remaining){
      if(out.length) break;
      content=content.slice(-remaining);
    }
    out.unshift({role,content});
    used+=content.length;
  }
  return out;
}

function offlineReply(message,wantsCode,reason=''){
  const m=String(message||'').trim();
  const low=m.toLowerCase();

  if(/^(oi|olá|ola|opa|eae|e aí|eai|bom dia|boa tarde|boa noite)\b/.test(low)){
    return 'Olá! 👋 Estou respondendo pelo modo local do CodeZero. Os gateways gratuitos externos estão indisponíveis agora, mas o chat continua funcionando sem custo.';
  }

  if(/quem (é|e) você|o que você (é|e)/.test(low)){
    return 'Sou o CodeZero. Neste momento estou no modo local de emergência: tento usar um modelo WebGPU no seu próprio navegador e, se ele não conseguir carregar, mantenho um modo offline mínimo para o chat não cair.';
  }

  if(wantsCode){
    return [
      'Estou no modo local mínimo porque o modelo WebGPU não conseguiu iniciar neste dispositivo agora.',
      'Seus arquivos e o projeto continuam intactos. O CodeZero não vai devolver erro 503 só porque os serviços gratuitos externos ficaram sem cota.',
      'Para gerar ou refatorar código com IA completa, deixe o modelo local terminar o primeiro carregamento quando o navegador suportar WebGPU, ou tente novamente quando um gateway gratuito voltar.',
      '',
      'Pedido recebido: '+m.slice(0,700)
    ].join('\n');
  }

  return [
    'O CodeZero entrou no modo local mínimo porque as IAs gratuitas externas falharam e o modelo WebGPU local não pôde ser usado agora.',
    'O chat continua ativo e gratuito; nenhuma API paga foi acionada.',
    reason?'Motivo local resumido: '+String(reason).slice(0,160):'',
    '',
    'Sua mensagem: '+m.slice(0,900)
  ].filter(Boolean).join('\n');
}

export async function generateLocalTextResponse({
  message,
  history=[],
  conversationSummary='',
  project='',
  wantsCode=false,
  onStatus
}={}){
  const prompt=String(message||'').trim();
  if(!prompt){
    return {response:'Mensagem vazia.',provider:'local-rules',model:'offline-rules-v1',local:true};
  }

  try{
    const {engine:localEngine,support}=await loadEngine(onStatus);
    const summary=String(conversationSummary||'').trim().slice(0,4200);
    const system=(wantsCode
      ? 'Você é o CodeZero, uma IA de programação rodando localmente no navegador. Responda em português do Brasil. Seja direto e preserve o projeto existente. Se precisar propor alterações de arquivos, use exatamente <<<FILE:nome>>> conteúdo <<<END_FILE>>>. Nunca diga que executou algo que não executou.'
      : 'Você é o CodeZero, uma IA geral rodando localmente no navegador. Responda em português do Brasil, de forma útil, clara e objetiva. Não programe a menos que o usuário peça código.')
      +(summary?' Contexto antigo resumido da conversa: '+summary:'');

    const messages=[
      {role:'system',content:system},
      ...cleanHistory(history),
      {
        role:'user',
        content:prompt+(wantsCode&&project?'\n\nCONTEXTO DO PROJETO:\n'+String(project).slice(0,6500):'')
      }
    ];

    emit(onStatus,'Gerando resposta local…',100,false);
    const result=await localEngine.chat.completions.create({
      messages,
      temperature:wantsCode?0.2:0.5,
      max_tokens:wantsCode?900:600
    });
    const response=String(result?.choices?.[0]?.message?.content||'').trim();
    if(!response) throw new Error('O modelo local respondeu vazio.');

    return {
      response,
      provider:'local-webgpu',
      model:support.model,
      local:true,
      cached:true
    };
  }catch(e){
    console.warn('[codezero-local-text-fallback]',e);
    emit(onStatus,'Modelo local indisponível; usando modo offline mínimo.',100,true);
    return {
      response:offlineReply(prompt,!!wantsCode,String(e?.message||e||'')),
      provider:'local-rules',
      model:'offline-rules-v1',
      local:true,
      degraded:true
    };
  }
}

export async function resetLocalTextModel(){
  try{await engine?.unload?.();}catch{}
  engine=null;
  engineModel='';
  loadPromise=null;
  lastLoadError=null;
  lastFailureAt=0;
  return true;
}
