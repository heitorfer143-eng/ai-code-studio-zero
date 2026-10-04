// CodeZero V15.9 — executor de runtime web isolado no navegador.
// Não executa código do usuário no servidor.
// O iframe não recebe allow-same-origin e usa CSP sem rede.

function text(value){return String(value==null?'':value);}
function safeMessage(value,max=700){
  return text(value).replace(/[\r\n\0]+/g,' ').trim().slice(0,max);
}
function hasUnsupportedImports(js){
  const source=text(js);
  return /(?:^|[;\n])\s*import\s+(?:[^('"\n][^\n]*?\s+from\s+)?['"][^'"]+['"]/m.test(source)
    || /\bimport\s*\(/.test(source);
}
function hasScriptSrc(html){
  return /<script\b[^>]*\bsrc\s*=/i.test(text(html));
}
function needsNetwork(html,js){
  const source=text(html)+'\n'+text(js);
  return /\b(fetch|WebSocket|EventSource|XMLHttpRequest)\s*\(/.test(source)
    || /\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\b/.test(source);
}

export async function runSandboxRuntimeTest({
  html='',
  css='',
  js='',
  timeoutMs=1500
}={}){
  const started=performance.now();
  const sourceHtml=text(html);
  const sourceCss=text(css);
  const sourceJs=text(js);

  if(!sourceHtml.trim()&&!sourceJs.trim()){
    return {
      status:'skipped',
      reason:'Projeto sem HTML/JavaScript executável no preview.',
      diagnostics:[],
      durationMs:0
    };
  }
  if(hasScriptSrc(sourceHtml)){
    return {
      status:'skipped',
      reason:'Preview carrega scripts por src; o runner V15.9 não resolve arquivos externos/relativos dentro da sandbox.',
      diagnostics:[],
      durationMs:0
    };
  }
  if(needsNetwork(sourceHtml,sourceJs)){
    return {
      status:'skipped',
      reason:'Projeto usa rede; o teste V15.9 bloqueia acesso externo por segurança e evita falsos erros.',
      diagnostics:[],
      durationMs:0
    };
  }
  if(hasUnsupportedImports(sourceJs)){
    return {
      status:'skipped',
      reason:'JavaScript usa imports de módulos; o runner isolado não resolve módulos externos/relativos nesta versão.',
      diagnostics:[],
      durationMs:0
    };
  }

  const id='cz_agent_'+(globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2));
  const diagnostics=[];
  const iframe=document.createElement('iframe');
  iframe.setAttribute('sandbox','allow-scripts');
  iframe.setAttribute('aria-hidden','true');
  iframe.tabIndex=-1;
  Object.assign(iframe.style,{
    position:'fixed',
    width:'1px',
    height:'1px',
    opacity:'0',
    pointerEvents:'none',
    left:'-10000px',
    top:'-10000px',
    border:'0'
  });

  const cleanHtml=sourceHtml.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi,'');
  const safeJs=sourceJs.replaceAll('</script','<\\/script');
  const isModule=/^\s*export\b/m.test(sourceJs);
  const scriptTag=sourceJs.trim()
    ? (isModule
      ? '<script type="module">'+safeJs+'<\/script>'
      : '<script>'+safeJs+'<\/script>')
    : '';

  const bridge=`
<script>
(()=>{
  const ID=${JSON.stringify(id)};
  const send=(kind,message,file='',line=0,column=0)=>{
    try{
      parent.postMessage({
        codezeroAgentRuntime:ID,
        kind,
        message:String(message||'').slice(0,700),
        file:String(file||'').slice(0,220),
        line:Number(line)||0,
        column:Number(column)||0
      },'*');
    }catch{}
  };
  const oldError=console.error.bind(console);
  console.error=(...args)=>{
    send('console-error',args.map(x=>{
      try{return typeof x==='string'?x:JSON.stringify(x)}
      catch{return String(x)}
    }).join(' '));
    oldError(...args);
  };
  addEventListener('error',event=>{
    send('error',event.message||'Runtime error',event.filename||'',event.lineno||0,event.colno||0);
  });
  addEventListener('unhandledrejection',event=>{
    const reason=event.reason;
    send('unhandledrejection',reason?.stack||reason?.message||String(reason||'Promise rejeitada'));
  });
  addEventListener('securitypolicyviolation',event=>{
    // CSP é intencionalmente rígida; registra como aviso, não como falha automática.
    send('csp-warning','Recurso bloqueado no teste: '+(event.blockedURI||event.violatedDirective||''));
  });
  queueMicrotask(()=>send('ready','runner-ready'));
})();
<\/script>`;

  const csp=[
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');

  iframe.srcdoc='<!doctype html><meta charset="utf-8">'+
    '<meta http-equiv="Content-Security-Policy" content="'+csp.replace(/"/g,'&quot;')+'">'+
    '<style>'+sourceCss.replaceAll('</style','<\\/style')+'</style>'+
    bridge+cleanHtml+scriptTag;

  const seen=new Set();
  const listener=event=>{
    const data=event.data;
    if(!data||data.codezeroAgentRuntime!==id) return;
    if(data.kind==='ready'||data.kind==='csp-warning') return;
    const item={
      kind:safeMessage(data.kind,40)||'error',
      message:safeMessage(data.message),
      file:safeMessage(data.file,220),
      line:Math.max(0,Number(data.line)||0),
      column:Math.max(0,Number(data.column)||0)
    };
    const key=[item.kind,item.message,item.file,item.line,item.column].join('|');
    if(!item.message||seen.has(key)) return;
    seen.add(key);
    diagnostics.push(item);
  };

  window.addEventListener('message',listener);
  document.body.appendChild(iframe);

  try{
    await new Promise(resolve=>setTimeout(resolve,Math.max(500,Math.min(3500,Number(timeoutMs)||1500))));
  }finally{
    window.removeEventListener('message',listener);
    iframe.remove();
  }

  const errors=diagnostics.filter(d=>d.kind!=='csp-warning');
  return {
    status:errors.length?'failed':'passed',
    diagnostics:errors.slice(0,20),
    durationMs:Math.round(performance.now()-started)
  };
}
