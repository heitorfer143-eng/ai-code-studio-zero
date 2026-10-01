const $=s=>document.querySelector(s);
const DEFAULT={
  'index.html':'<main><h1>Olá 👋</h1><p>Seu projeto aparece aqui.</p></main>',
  'style.css':'body{font-family:system-ui;padding:30px}',
  'script.js':'console.log("Projeto iniciado")'
};
const API='/chat';
const CHAT_KEY='zero.chats.v1';
const ACTIVE_CHAT_KEY='zero.activeChat.v1';
const ASSET_KEY='zero.assets.v1';
const PROJECT_MEMORY_KEY='zero.project.memory.v1';
const CHECKPOINT_KEY='zero.checkpoints.v1';
const FREE_ONLY=true;

let files=JSON.parse(localStorage.getItem('zero.files')||'null')||DEFAULT;
let assets=JSON.parse(localStorage.getItem(ASSET_KEY)||'{}')||{};
let projectMemory=JSON.parse(localStorage.getItem(PROJECT_MEMORY_KEY)||'[]')||[];
let active=Object.keys(files)[0];
let busy=false;
let lastChangedFiles=[];
let pendingAttachments=[];
let checkpoints=JSON.parse(localStorage.getItem(CHECKPOINT_KEY)||'[]')||[];
let checkpointIndex=checkpoints.length-1;
let taskProgressTimer=null;
let devopsCsrf='';
let devopsState={github:{connected:false},railway:{connected:false}};
let authState={authenticated:false,username:'',csrf:'',persistent:false,storage:'local-ephemeral'};
let cloudSaveTimer=null;
let cloudSaving=false;
let pollenState={connected:false,serverKey:false,appKeyConfigured:false,user:null};
let mediaModels=[];
let selectedImageModel=localStorage.getItem('zero.media.model')||'';
let localImageModule=null;
let localTextModule=null;
let localImageSupport=null;
let chats=loadChats();
let activeChatId=localStorage.getItem(ACTIVE_CHAT_KEY)||chats[0].id;
if(!chats.some(c=>c.id===activeChatId)) activeChatId=chats[0].id;

async function getLocalImageModule(){
  if(localImageModule) return localImageModule;
  localImageModule=await import('./local-image.js?v=15.5.0');
  return localImageModule;
}
async function getLocalTextModule(){
  if(localTextModule) return localTextModule;
  localTextModule=await import('./local-text.js?v=15.5.1');
  return localTextModule;
}
function emergencyLocalTextReply(message,wantsCode=false){
  const text=String(message||'').trim();
  const low=text.toLowerCase();
  if(/^(oi|olá|ola|opa|eai|e aí|bom dia|boa tarde|boa noite)\b/.test(low)){
    return 'Olá! 👋 O CodeZero está no modo local de emergência. Os serviços gratuitos externos estão indisponíveis, mas o chat continua funcionando.';
  }
  if(wantsCode){
    return 'O CodeZero está no modo local de emergência. Seus arquivos continuam seguros, mas o modelo local completo não conseguiu carregar neste navegador agora. Posso manter o chat ativo e tentar novamente o modelo local na próxima mensagem.\n\nPedido recebido: '+text.slice(0,900);
  }
  return 'Estou no modo local de emergência porque os serviços gratuitos externos e o modelo local completo não responderam agora. O chat continua ativo sem API paga.\n\nSua mensagem: '+text.slice(0,1000);
}
function setLocalAiStatus(message,progress=null,error=false){
  const el=$('#localAiStatus');
  if(el){el.textContent=String(message||'');el.classList.toggle('error',!!error);}
  const bar=$('#localAiProgress');
  if(bar&&progress!=null) bar.style.width=Math.max(0,Math.min(100,Number(progress)||0))+'%';
}
async function initLocalImage(){
  try{
    const mod=await getLocalImageModule();
    localImageSupport=await mod.getLocalImageSupport();
    const badge=$('#localAiBadge');
    const info=$('#localAiInfo');
    const generate=$('#mediaGenerate');
    if(localImageSupport.supported){
      if(badge) badge.textContent='🟢 WebGPU pronto';
      if(info) info.textContent='Modelo local • download inicial ~'+localImageSupport.downloadMB+' MB (uma vez) • depois usa o cache do navegador.';
      if(generate) generate.disabled=false;
      setLocalAiStatus('Pronto.',0,false);
    }else{
      if(badge) badge.textContent='🔴 WebGPU indisponível';
      if(info) info.textContent=localImageSupport.reason;
      if(generate) generate.disabled=true;
      setLocalAiStatus(localImageSupport.reason,0,true);
    }
    return localImageSupport;
  }catch(e){
    localImageSupport={supported:false,reason:e.message};
    if($('#localAiBadge')) $('#localAiBadge').textContent='🔴 Falha ao carregar';
    if($('#mediaGenerate')) $('#mediaGenerate').disabled=true;
    setLocalAiStatus(e.message,0,true);
    return localImageSupport;
  }
}
async function generateLocalImageAsset(name,promptText){
  const support=localImageSupport||await initLocalImage();
  if(!support?.supported) throw new Error(support?.reason||'WebGPU indisponível.');
  const mod=await getLocalImageModule();
  const clean=String(name||'generated-image.png').trim().replace(/^assets\//,'').replace(/[^\w.\-]/g,'-')||'generated-image.png';
  const out=await mod.generateLocalImage(String(promptText||'').trim(),{
    onStatus:e=>setLocalAiStatus(e.message,e.progress,false)
  });
  assets[clean]=out.dataUrl;
  saveAssets();
  renderAssets();
  renderMediaSources();
  return {name:clean,url:out.dataUrl,model:out.model||'SD-Turbo WebGPU Local'};
}
function loadImageForCanvas(src){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>resolve(img);
    img.onerror=()=>reject(new Error('Não foi possível abrir a imagem localmente.'));
    img.src=src;
  });
}
async function localTransformImageAsset(sourceName,targetName,instruction){
  const source=assets[sourceName];
  if(!source) throw new Error('Asset não encontrado: '+sourceName);
  const text=String(instruction||'').toLowerCase();
  const img=await loadImageForCanvas(source);
  let width=img.naturalWidth||img.width,height=img.naturalHeight||img.height;
  const size=text.match(/(\d{2,4})\s*[x×]\s*(\d{2,4})/i);
  if(size){width=Math.max(16,Math.min(4096,Number(size[1])));height=Math.max(16,Math.min(4096,Number(size[2])));}
  const rotate90=/gire?\s*(?:em\s*)?90|rotate\s*90/.test(text);
  if(rotate90){const t=width;width=height;height=t;}
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.save();
  if(rotate90){ctx.translate(width,0);ctx.rotate(Math.PI/2);ctx.drawImage(img,0,0,height,width);}
  else if(/espelh|mirror|flip horizontal/.test(text)){ctx.translate(width,0);ctx.scale(-1,1);ctx.drawImage(img,0,0,width,height);}
  else if(/flip vertical|inverter vertical/.test(text)){ctx.translate(0,height);ctx.scale(1,-1);ctx.drawImage(img,0,0,width,height);}
  else ctx.drawImage(img,0,0,width,height);
  ctx.restore();

  const needsPixels=/preto e branco|grayscale|cinza|invert|negativ|fundo branco|white background/.test(text);
  if(needsPixels){
    const image=ctx.getImageData(0,0,width,height),d=image.data;
    for(let i=0;i<d.length;i+=4){
      if(/preto e branco|grayscale|cinza/.test(text)){const y=Math.round(.299*d[i]+.587*d[i+1]+.114*d[i+2]);d[i]=d[i+1]=d[i+2]=y;}
      if(/invert|negativ/.test(text)){d[i]=255-d[i];d[i+1]=255-d[i+1];d[i+2]=255-d[i+2];}
      if(/fundo branco|white background/.test(text)&&d[i]>242&&d[i+1]>242&&d[i+2]>242)d[i+3]=0;
    }
    ctx.putImageData(image,0,0);
  }

  const recognized=!!size||rotate90||/espelh|mirror|flip|preto e branco|grayscale|cinza|invert|negativ|fundo branco|white background/.test(text);
  if(!recognized) throw new Error('Esta edição local ainda não é generativa. Tente: redimensionar 512x512, preto e branco, espelhar, girar 90°, inverter cores ou remover fundo branco.');

  const clean=String(targetName||'edited-image.png').replace(/^assets\//,'').replace(/[^\w.\-]/g,'-');
  const out=canvas.toDataURL('image/png');
  assets[clean]=out;saveAssets();renderAssets();renderMediaSources();
  return {name:clean,url:out,model:'Editor local'};
}
async function ensureDevopsCsrf(){
  if(devopsCsrf) return devopsCsrf;
  const r=await fetch('/devops/session',{credentials:'same-origin'});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data?.csrf) throw new Error(data?.error||'Não foi possível iniciar a sessão segura.');
  devopsCsrf=data.csrf;
  if(data.github||data.railway){
    devopsState={github:data.github||{connected:false},railway:data.railway||{connected:false}};
    renderDevopsState();
  }
  return devopsCsrf;
}
async function pollenFetch(url,options={}){
  const method=String(options.method||'GET').toUpperCase();
  const opts={credentials:'same-origin',...options,headers:{...(options.headers||{})}};
  if(method!=='GET'&&method!=='HEAD'){
    await ensureDevopsCsrf();
    opts.headers['Content-Type']=opts.headers['Content-Type']||'application/json';
    opts.headers['X-CSRF-Token']=devopsCsrf;
  }
  let r=await fetch(url,opts);
  let data=await r.json().catch(()=>({}));
  if(r.status===403&&/CSRF/i.test(String(data?.error||''))&&method!=='GET'&&method!=='HEAD'){
    devopsCsrf='';
    await ensureDevopsCsrf();
    opts.headers['X-CSRF-Token']=devopsCsrf;
    r=await fetch(url,opts);
    data=await r.json().catch(()=>({}));
  }
  if(!r.ok) throw new Error(data?.details||data?.error||('HTTP '+r.status));
  return data;
}
function showMediaResult(text,error=false){
  const el=$('#mediaResult'); if(!el) return;
  el.textContent=String(text||''); el.classList.toggle('error',!!error);
}
function renderPollenState(){
  const el=$('#pollenState');
  if(!el) return;
  if(pollenState.connected) el.textContent='🟢 Conectado'+(pollenState.user?.name?' como '+pollenState.user.name:'');
  else if(pollenState.serverKey) el.textContent='🟢 Chave do servidor ativa';
  else el.textContent='⚪ Não conectado';
}
function mediaModelLabel(m){
  const edit=(m.supportedEndpoints||[]).includes('/v1/images/edits')||(m.inputModalities||[]).includes('image');
  const health=m.health?.status==='healthy'?'🟢':'';
  return (health?health+' ':'')+(m.title||m.id)+(edit?' ✏️':'');
}
function filteredMediaModels(){
  const q=String($('#mediaModelSearch')?.value||'').trim().toLowerCase();
  return mediaModels.filter(m=>!q||m.id.toLowerCase().includes(q)||String(m.title||'').toLowerCase().includes(q)||String(m.publisher||'').toLowerCase().includes(q));
}
function renderMediaModels(){
  const sel=$('#mediaModel'); if(!sel) return;
  const list=filteredMediaModels();
  sel.innerHTML='';
  for(const m of list){
    const o=document.createElement('option'); o.value=m.id; o.textContent=mediaModelLabel(m); sel.append(o);
  }
  if(selectedImageModel&&list.some(m=>m.id===selectedImageModel)) sel.value=selectedImageModel;
  else if(list.length){selectedImageModel=list[0].id; sel.value=selectedImageModel;}
  renderMediaModelInfo();
}
function renderMediaModelInfo(){
  const id=$('#mediaModel')?.value||selectedImageModel;
  const m=mediaModels.find(x=>x.id===id);
  const el=$('#mediaModelInfo'); if(!el||!m) return;
  selectedImageModel=m.id; localStorage.setItem('zero.media.model',m.id);
  const edit=(m.supportedEndpoints||[]).includes('/v1/images/edits')||(m.inputModalities||[]).includes('image');
  const price=m.pricing&&Object.keys(m.pricing).length?JSON.stringify(m.pricing):'preço não informado';
  el.textContent=(m.publisher?m.publisher+' • ':'')+(edit?'gera + edita':'gera imagem')+' • '+price;
}
function renderMediaSources(){
  const sel=$('#mediaSource'); if(!sel) return;
  const old=sel.value; sel.innerHTML='<option value="">Escolha um asset...</option>';
  for(const name of Object.keys(assets)){
    const o=document.createElement('option');o.value=name;o.textContent=name;sel.append(o);
  }
  if(old&&assets[old]) sel.value=old;
}
async function loadMediaModels(){
  if(FREE_ONLY){showMediaResult('Cloud opcional está desativado.',true);return;}
  try{
    const data=await pollenFetch('/pollen/models');
    mediaModels=Array.isArray(data.models)?data.models:[];
    renderMediaModels();
    showMediaResult(mediaModels.length+' modelo(s) de imagem carregado(s).');
  }catch(e){showMediaResult(e.message,true);}
}
async function initPollen(){
  if(FREE_ONLY){
    pollenState={connected:false,serverKey:false,appKeyConfigured:false,user:null};
    renderPollenState();
    return;
  }
  try{
    await ensureDevopsCsrf();
    const data=await pollenFetch('/pollen/status');
    if(data?.csrf) devopsCsrf=data.csrf;
    pollenState=data; renderPollenState();
  }catch(e){console.warn('pollen status',e);}
}
function openMediaStudio(){
  $('#mediaModal')?.classList.remove('hidden');
  renderMediaSources();
  initLocalImage();
  if(FREE_ONLY){
    pollenState={connected:false,serverKey:false,appKeyConfigured:false,user:null};
    renderPollenState();
  }
}
function closeMediaStudio(){$('#mediaModal')?.classList.add('hidden');}
async function connectPollenDevice(){
  if(FREE_ONLY){showMediaResult('Cloud desativado: modo R$0,00 ativo.',true);return;}
  try{
    const data=await pollenFetch('/pollen/device/start',{method:'POST',body:'{}'});
    $('#pollenDevice')?.classList.remove('hidden');
    if($('#pollenCode')) $('#pollenCode').textContent=data.userCode||'';
    if($('#pollenVerifyLink')) $('#pollenVerifyLink').href=data.verificationUri||'https://enter.pollinations.ai/device';
    showMediaResult('Abra o link, autorize e depois clique em “Já autorizei”.');
  }catch(e){showMediaResult(e.message,true);}
}
async function pollPollenDevice(){
  if(FREE_ONLY){showMediaResult('Cloud desativado: modo R$0,00 ativo.',true);return;}
  try{
    const data=await pollenFetch('/pollen/device/poll',{method:'POST',body:'{}'});
    if(data.pending){showMediaResult('Ainda aguardando autorização...');return;}
    pollenState.connected=true;pollenState.user=data.user||null;renderPollenState();
    $('#pollenDevice')?.classList.add('hidden');
    showMediaResult('🌼 Pollinations conectado.');
  }catch(e){showMediaResult(e.message,true);}
}
async function connectPollenKey(){
  if(FREE_ONLY){showMediaResult('Cloud desativado: modo R$0,00 ativo.',true);return;}
  const key=prompt('Cole sua chave Pollinations sk_.\nEla ficará somente na sessão segura do backend e NÃO será salva no navegador.');
  if(!key) return;
  try{
    const data=await pollenFetch('/pollen/connect-key',{method:'POST',body:JSON.stringify({key})});
    pollenState.connected=true;pollenState.user=data.user||null;renderPollenState();
    showMediaResult('🔑 Chave conectada à sessão com segurança.');
  }catch(e){showMediaResult(e.message,true);}
}
async function disconnectPollen(){
  if(FREE_ONLY){showMediaResult('Cloud desativado: modo R$0,00 ativo.',true);return;}
  try{
    await pollenFetch('/pollen/disconnect',{method:'POST',body:'{}'});
    pollenState.connected=false;pollenState.user=null;renderPollenState();
    showMediaResult('Pollinations desconectado.');
  }catch(e){showMediaResult(e.message,true);}
}
function bestEditModel(){
  const current=mediaModels.find(m=>m.id===selectedImageModel);
  const supports=m=>(m.supportedEndpoints||[]).includes('/v1/images/edits')||(m.inputModalities||[]).includes('image');
  if(current&&supports(current)) return current.id;
  return mediaModels.find(m=>supports(m)&&m.health?.status==='healthy')?.id
    || mediaModels.find(supports)?.id
    || selectedImageModel
    || 'black-forest-labs/flux.1-kontext-pro';
}
async function mediaGenerate(){
  const promptText=String($('#mediaPrompt')?.value||'').trim();
  const name=String($('#mediaName')?.value||'generated-image.png').trim();
  if(!promptText) return showMediaResult('Digite um prompt.',true);
  try{
    showMediaResult('Gerando localmente…');
    const out=await generateLocalImageAsset(name,promptText);
    showMediaResult('Imagem criada: assets/'+out.name+'\n'+out.model);
    status('🖼️ Imagem criada: assets/'+out.name);
  }catch(e){
    setLocalAiStatus(e.message,null,true);
    showMediaResult(e.message,true);
  }
}
async function mediaEdit(){
  const source=$('#mediaSource')?.value;
  const promptText=String($('#mediaEditPrompt')?.value||'').trim();
  const target=String($('#mediaEditName')?.value||'edited-image.png').trim();
  if(!source||!assets[source]) return showMediaResult('Escolha um asset.',true);
  if(!promptText) return showMediaResult('Digite a instrução de edição.',true);
  try{
    const out=await localTransformImageAsset(source,target,promptText);
    showMediaResult('Imagem editada: assets/'+out.name);
    status('🛠️ Imagem editada: assets/'+out.name);
  }catch(e){showMediaResult(e.message,true);}
}
function workspaceState(){
  if(files[active]!=null) files[active]=$('#editor').value;
  return {
    version:13,
    files,
    assets,
    projectMemory,
    checkpoints,
    checkpointIndex,
    chats,
    activeChatId,
    active,
    savedAt:Date.now()
  };
}
function applyWorkspaceState(state){
  if(!state||typeof state!=='object') return false;
  files=state.files&&typeof state.files==='object'?state.files:files;
  assets=state.assets&&typeof state.assets==='object'?state.assets:{};
  projectMemory=Array.isArray(state.projectMemory)?state.projectMemory:[];
  checkpoints=Array.isArray(state.checkpoints)?state.checkpoints:[];
  checkpointIndex=Number.isInteger(state.checkpointIndex)?state.checkpointIndex:checkpoints.length-1;
  chats=Array.isArray(state.chats)&&state.chats.length?state.chats:[freshChat()];
  activeChatId=state.activeChatId&&chats.some(c=>c.id===state.activeChatId)?state.activeChatId:chats[0].id;
  active=state.active&&files[state.active]!=null?state.active:Object.keys(files)[0];
  localStorage.setItem('zero.files',JSON.stringify(files));
  localStorage.setItem(ASSET_KEY,JSON.stringify(assets));
  localStorage.setItem(PROJECT_MEMORY_KEY,JSON.stringify(projectMemory));
  localStorage.setItem(CHECKPOINT_KEY,JSON.stringify(checkpoints));
  localStorage.setItem(CHAT_KEY,JSON.stringify(chats));
  localStorage.setItem(ACTIVE_CHAT_KEY,activeChatId);
  $('#editor').value=files[active]||'';
  renderChatList(); renderMessages(); renderAssets(); tabs(); renderFileTree(); lines(); run(); updateCheckpointButtons();
  return true;
}
function renderAccountState(){
  $('#accountLoggedOut')?.classList.toggle('hidden',authState.authenticated);
  $('#accountLoggedIn')?.classList.toggle('hidden',!authState.authenticated);
  if($('#accountName')) $('#accountName').textContent=authState.username||'';
  if($('#accountBtn')) $('#accountBtn').textContent=authState.authenticated?'👤 '+authState.username:'👤 Conta';
  const saveEl=$('#cloudSaveStatus');
  if(saveEl){
    saveEl.textContent=authState.authenticated?(authState.persistent?'☁ Salvo em conta':'⚠ Conta temporária'):'Local';
    saveEl.classList.toggle('warn',authState.authenticated&&!authState.persistent);
  }
  const info=$('#accountStorageInfo');
  if(info){
    info.textContent=authState.persistent
      ? 'Salvamento persistente em PostgreSQL.'
      : '⚠ O banco PostgreSQL ainda não está conectado. A conta funciona, mas o servidor pode perder dados após um novo deploy.';
  }
}
async function authFetch(url,options={}){
  const opts={credentials:'same-origin',...options,headers:{...(options.headers||{})}};
  if((opts.method||'GET').toUpperCase()!=='GET'){
    opts.headers['Content-Type']=opts.headers['Content-Type']||'application/json';
    if(authState.csrf) opts.headers['X-CSRF-Token']=authState.csrf;
  }
  const r=await fetch(url,opts);
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data?.details||data?.error||('HTTP '+r.status));
  return data;
}
function showAccountResult(text,error=false){
  const el=$('#accountResult'); if(!el) return;
  el.textContent=String(text||''); el.classList.toggle('error',!!error);
}
async function initAccount(){
  try{
    const data=await authFetch('/auth/session');
    authState={authenticated:!!data.authenticated,username:data.username||'',csrf:data.csrf||'',persistent:!!data.persistent,storage:data.storage||'local-ephemeral'};
    renderAccountState();
  }catch(e){console.warn('auth init',e);}
}
async function completeLogin(data){
  authState={authenticated:true,username:data.username||'',csrf:data.csrf||'',persistent:!!data.persistent,storage:data.storage||'local-ephemeral'};
  renderAccountState();
  const cloud=await authFetch('/account/state');
  if(cloud.state){
    const useCloud=confirm('Já existe um projeto salvo nesta conta. Carregar o salvo da conta agora?\nCancelar mantém o que está neste navegador.');
    if(useCloud){
      applyWorkspaceState(cloud.state);
      showAccountResult('Projeto salvo carregado.');
    }else{
      await saveCloudNow();
      showAccountResult('Projeto deste navegador enviado para a conta.');
    }
  }else{
    await saveCloudNow();
    showAccountResult('Conta conectada e seu projeto atual foi salvo.');
  }
}
async function registerAccount(){
  const username=String($('#accountUsername')?.value||'').trim();
  const password=String($('#accountPassword')?.value||'');
  try{
    const data=await authFetch('/auth/register',{method:'POST',body:JSON.stringify({username,password})});
    await completeLogin(data);
  }catch(e){showAccountResult(e.message,true);}
}
async function loginAccount(){
  const username=String($('#accountUsername')?.value||'').trim();
  const password=String($('#accountPassword')?.value||'');
  try{
    const data=await authFetch('/auth/login',{method:'POST',body:JSON.stringify({username,password})});
    await completeLogin(data);
  }catch(e){showAccountResult(e.message,true);}
}
async function logoutAccount(){
  try{await authFetch('/auth/logout',{method:'POST',body:'{}'});}catch{}
  authState={authenticated:false,username:'',csrf:'',persistent:false,storage:'local-ephemeral'};
  renderAccountState(); showAccountResult('Sessão encerrada.');
}
async function saveCloudNow(){
  if(!authState.authenticated||cloudSaving) return;
  cloudSaving=true;
  const saveEl=$('#cloudSaveStatus'); if(saveEl) saveEl.textContent='☁ Salvando…';
  try{
    const data=await authFetch('/account/state',{method:'POST',body:JSON.stringify({state:workspaceState()})});
    if(saveEl) saveEl.textContent=data.persistent?'☁ Salvo':'⚠ Salvo temporariamente';
  }catch(e){
    if(saveEl) saveEl.textContent='⚠ Erro ao salvar';
    console.warn('cloud save',e);
  }finally{cloudSaving=false;}
}
function scheduleCloudSave(){
  if(!authState.authenticated) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer=setTimeout(saveCloudNow,1200);
}
async function loadCloudNow(){
  if(!authState.authenticated) return;
  try{
    const data=await authFetch('/account/state');
    if(data.state){applyWorkspaceState(data.state);showAccountResult('Projeto carregado da conta.');}
    else showAccountResult('Nenhum projeto salvo ainda.');
  }catch(e){showAccountResult(e.message,true);}
}
function openAccount(){$('#accountModal')?.classList.remove('hidden');renderAccountState();}
function closeAccount(){$('#accountModal')?.classList.add('hidden');}

async function devopsFetch(url,options={}){
  const opts={credentials:'same-origin',...options,headers:{...(options.headers||{})}};
  if((opts.method||'GET').toUpperCase()!=='GET'){
    opts.headers['Content-Type']=opts.headers['Content-Type']||'application/json';
    opts.headers['X-CSRF-Token']=devopsCsrf;
  }
  const r=await fetch(url,opts);
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data?.details||data?.error||('HTTP '+r.status));
  return data;
}
function renderDevopsState(){
  const gs=$('#githubState'),rs=$('#railwayState');
  if(gs) gs.textContent=devopsState.github?.connected?'🟢 '+(devopsState.github.login||'GitHub conectado'):'⚪ Desconectado';
  if(rs) rs.textContent=devopsState.railway?.connected?'🟢 '+(devopsState.railway.identity||'Railway conectado'):'⚪ Desconectado';
}
async function initDevops(){
  try{
    const data=await devopsFetch('/devops/session');
    devopsCsrf=data.csrf||'';
    devopsState={github:data.github||{connected:false},railway:data.railway||{connected:false}};
    renderDevopsState();
  }catch(e){console.warn('devops session',e);}
}
function showDevopsResult(target,text,error=false){
  const el=$(target);
  if(!el) return;
  el.textContent=String(text||'');
  el.classList.toggle('error',!!error);
}
function openDevops(){
  $('#devopsModal')?.classList.remove('hidden');
  renderDevopsState();
  if(devopsState.github?.connected) loadGithubRepos();
  if(devopsState.railway?.connected) loadRailwayProjects();
}
function closeDevops(){$('#devopsModal')?.classList.add('hidden');}

async function connectGithub(){
  const token=prompt('Cole um token GitHub Fine-grained com acesso apenas aos repositórios necessários.\nPermissão recomendada: Contents = Read and write.\nO token NÃO será salvo no navegador.');
  if(!token) return;
  try{
    const data=await devopsFetch('/devops/github/connect',{method:'POST',body:JSON.stringify({token})});
    devopsState.github=data.github; renderDevopsState(); showDevopsResult('#githubResult','Conectado com segurança.');
    await loadGithubRepos();
  }catch(e){showDevopsResult('#githubResult',e.message,true);}
}
async function disconnectGithub(){
  try{
    await devopsFetch('/devops/github/disconnect',{method:'POST',body:'{}'});
    devopsState.github={connected:false}; renderDevopsState();
    $('#githubRepo').innerHTML='<option value="">Selecione...</option>';
    $('#githubBranch').innerHTML='<option value="main">main</option>';
    showDevopsResult('#githubResult','GitHub desconectado e token apagado da sessão.');
  }catch(e){showDevopsResult('#githubResult',e.message,true);}
}
async function loadGithubRepos(){
  try{
    const data=await devopsFetch('/devops/github/repos');
    const sel=$('#githubRepo');
    const previous=sel.value;
    sel.innerHTML='<option value="">Selecione...</option>';
    for(const r of data.repos||[]){
      const o=document.createElement('option'); o.value=r.fullName; o.textContent=(r.private?'🔒 ':'')+r.fullName; o.dataset.branch=r.defaultBranch||'main'; sel.append(o);
    }
    if(previous&&[...sel.options].some(o=>o.value===previous)) sel.value=previous;
    showDevopsResult('#githubResult',(data.repos||[]).length+' repositório(s).');
    if(sel.value) await loadGithubBranches();
  }catch(e){showDevopsResult('#githubResult',e.message,true);}
}
async function loadGithubBranches(){
  const repo=$('#githubRepo')?.value;
  if(!repo) return;
  try{
    const data=await devopsFetch('/devops/github/branches?repo='+encodeURIComponent(repo));
    const sel=$('#githubBranch'); sel.innerHTML='';
    for(const b of data.branches||[]){const o=document.createElement('option');o.value=b.name;o.textContent=b.name;sel.append(o);}
    if(!sel.options.length){const o=document.createElement('option');o.value='main';o.textContent='main';sel.append(o);}
  }catch(e){showDevopsResult('#githubResult',e.message,true);}
}
async function importGithubRepo(){
  const fullName=$('#githubRepo')?.value,branch=$('#githubBranch')?.value||'main';
  if(!fullName) return;
  if(!confirm('Substituir o projeto atual pelo conteúdo de '+fullName+' ('+branch+')? Um checkpoint será criado.')) return;
  try{
    showDevopsResult('#githubResult','Importando...');
    const data=await devopsFetch('/devops/github/import',{method:'POST',body:JSON.stringify({fullName,branch})});
    createCheckpoint('Antes de importar '+fullName);
    files=data.files||{}; assets=data.assets||{}; active=Object.keys(files)[0]||'';
    projectMemory=[]; saveProjectMemory(); save(); saveAssets(); $('#editor').value=files[active]||'';
    tabs(); renderFileTree(); renderAssets(); lines(); run(); createCheckpoint('Importado '+fullName);
    showDevopsResult('#githubResult','Importado '+Object.keys(files).length+' arquivo(s). Commit '+String(data.commitSha||'').slice(0,7));
  }catch(e){showDevopsResult('#githubResult',e.message,true);}
}
async function commitGithub(){
  const fullName=$('#githubRepo')?.value,branch=$('#githubBranch')?.value||'main';
  if(!fullName) return;
  const message=prompt('Mensagem do commit:','CodeZero: atualizar projeto');
  if(!message) return;
  if(!confirm('Enviar o snapshot atual para '+fullName+' / '+branch+'?')) return;
  try{
    showDevopsResult('#githubResult','Criando commit...');
    const data=await devopsFetch('/devops/github/commit',{method:'POST',body:JSON.stringify({fullName,branch,message,files,assets})});
    showDevopsResult('#githubResult','✅ Push concluído: '+String(data.sha||'').slice(0,10));
  }catch(e){showDevopsResult('#githubResult',e.message,true);}
}
async function createGithubBranch(){
  const fullName=$('#githubRepo')?.value,from=$('#githubBranch')?.value||'main';
  if(!fullName) return;
  const name=prompt('Nome da nova branch:','codezero/'+Date.now().toString(36));
  if(!name) return;
  try{
    await devopsFetch('/devops/github/branch',{method:'POST',body:JSON.stringify({fullName,name,from})});
    await loadGithubBranches(); $('#githubBranch').value=name;
    showDevopsResult('#githubResult','🌿 Branch criada: '+name);
  }catch(e){showDevopsResult('#githubResult',e.message,true);}
}

async function connectRailway(){
  const type=(prompt('Tipo de token Railway:\n1 = Account/OAuth token\n2 = Project token','1')==='2')?'project':'account';
  const token=prompt('Cole o token Railway. Ele ficará somente na sessão segura do backend e NÃO será salvo no navegador.');
  if(!token) return;
  try{
    const data=await devopsFetch('/devops/railway/connect',{method:'POST',body:JSON.stringify({token,type})});
    devopsState.railway=data.railway; renderDevopsState(); showDevopsResult('#railwayResult','Railway conectado.');
    await loadRailwayProjects();
  }catch(e){showDevopsResult('#railwayResult',e.message,true);}
}
async function disconnectRailway(){
  try{
    await devopsFetch('/devops/railway/disconnect',{method:'POST',body:'{}'});
    devopsState.railway={connected:false}; renderDevopsState();
    for(const id of ['#railwayProject','#railwayService','#railwayEnvironment']) $(id).innerHTML='<option value="">Selecione...</option>';
    showDevopsResult('#railwayResult','Railway desconectado e token apagado da sessão.');
  }catch(e){showDevopsResult('#railwayResult',e.message,true);}
}
async function loadRailwayProjects(){
  try{
    const data=await devopsFetch('/devops/railway/projects');
    const sel=$('#railwayProject'),old=sel.value; sel.innerHTML='<option value="">Selecione...</option>';
    for(const p of data.projects||[]){const o=document.createElement('option');o.value=p.id;o.textContent=p.name||p.id;sel.append(o);}
    if(old&&[...sel.options].some(o=>o.value===old)) sel.value=old;
    showDevopsResult('#railwayResult',(data.projects||[]).length+' projeto(s).');
    if(sel.value) await loadRailwayProject();
  }catch(e){showDevopsResult('#railwayResult',e.message,true);}
}
async function loadRailwayProject(){
  const id=$('#railwayProject')?.value;if(!id)return;
  try{
    const data=await devopsFetch('/devops/railway/project?id='+encodeURIComponent(id));
    const service=$('#railwayService'),env=$('#railwayEnvironment'); service.innerHTML=''; env.innerHTML='';
    for(const x of data.project.services||[]){const o=document.createElement('option');o.value=x.id;o.textContent=x.name||x.id;service.append(o);}
    for(const x of data.project.environments||[]){const o=document.createElement('option');o.value=x.id;o.textContent=x.name||x.id;env.append(o);}
  }catch(e){showDevopsResult('#railwayResult',e.message,true);}
}
async function deployRailway(){
  const serviceId=$('#railwayService')?.value,environmentId=$('#railwayEnvironment')?.value;
  if(!serviceId||!environmentId) return;
  if(!confirm('Iniciar deploy deste serviço no Railway?')) return;
  try{
    const data=await devopsFetch('/devops/railway/deploy',{method:'POST',body:JSON.stringify({serviceId,environmentId})});
    showDevopsResult('#railwayResult','🚀 Deploy iniciado: '+(data.deploymentId||''));
    await listRailwayDeployments();
  }catch(e){showDevopsResult('#railwayResult',e.message,true);}
}
async function listRailwayDeployments(){
  const projectId=$('#railwayProject')?.value,serviceId=$('#railwayService')?.value;
  if(!projectId||!serviceId) return;
  try{
    const data=await devopsFetch('/devops/railway/deployments?projectId='+encodeURIComponent(projectId)+'&serviceId='+encodeURIComponent(serviceId));
    const root=$('#railwayResult'); root.textContent='';
    for(const d of data.deployments||[]){
      const b=document.createElement('button'); b.className='deploymentRow'; b.textContent=(d.status||'?')+' • '+new Date(d.createdAt).toLocaleString();
      b.onclick=()=>loadRailwayLogs(d.id); root.append(b);
    }
  }catch(e){showDevopsResult('#railwayResult',e.message,true);}
}
async function loadRailwayLogs(deploymentId){
  try{
    const data=await devopsFetch('/devops/railway/logs?deploymentId='+encodeURIComponent(deploymentId));
    const text=(data.logs||[]).map(x=>'['+(x.severity||'info')+'] '+x.message).join('\n');
    showDevopsResult('#railwayResult',text||'Sem logs.');
  }catch(e){showDevopsResult('#railwayResult',e.message,true);}
}
async function linkRailwayRepo(){
  const serviceId=$('#railwayService')?.value,repo=$('#githubRepo')?.value,branch=$('#githubBranch')?.value||'main';
  if(!serviceId||!repo){showDevopsResult('#railwayResult','Selecione serviço Railway e repositório GitHub.',true);return;}
  if(!confirm('Conectar o serviço Railway a '+repo+' / '+branch+'?')) return;
  try{
    await devopsFetch('/devops/railway/connect-repo',{method:'POST',body:JSON.stringify({serviceId,repo,branch})});
    showDevopsResult('#railwayResult','🔗 Serviço conectado ao repositório.');
  }catch(e){showDevopsResult('#railwayResult',e.message,true);}
}
async function setRailwayVariables(){
  const projectId=$('#railwayProject')?.value,serviceId=$('#railwayService')?.value,environmentId=$('#railwayEnvironment')?.value;
  if(!projectId||!environmentId) return;
  const raw=prompt('Digite variáveis no formato KEY=VALUE, uma por linha.\nOs valores serão enviados direto ao backend e não serão exibidos depois.');
  if(!raw) return;
  const variables={};
  for(const line of raw.split(/\r?\n/)){const i=line.indexOf('=');if(i>0)variables[line.slice(0,i).trim()]=line.slice(i+1);}
  try{
    const data=await devopsFetch('/devops/railway/variables',{method:'POST',body:JSON.stringify({projectId,environmentId,serviceId,variables})});
    showDevopsResult('#railwayResult','🔐 Atualizadas: '+(data.updated||[]).join(', '));
  }catch(e){showDevopsResult('#railwayResult',e.message,true);}
}

function uid(){return 'c_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)}
function freshChat(){
  return {id:uid(),title:'Novo chat',messages:[],createdAt:Date.now(),updatedAt:Date.now()};
}
function loadChats(){
  try{
    const raw=JSON.parse(localStorage.getItem(CHAT_KEY)||'null');
    if(Array.isArray(raw)&&raw.length) return raw;
  }catch{}
  return [freshChat()];
}
function saveChats(){
  localStorage.setItem(CHAT_KEY,JSON.stringify(chats.slice(0,50)));
  scheduleCloudSave();
  localStorage.setItem(ACTIVE_CHAT_KEY,activeChatId);
}
function activeChat(){
  return chats.find(c=>c.id===activeChatId)||chats[0];
}
function createChat(){
  const c=freshChat();
  chats.unshift(c);
  activeChatId=c.id;
  saveChats();
  renderChatList();
  renderMessages();
  closeChatDrawer();
  $('#prompt').focus();
}
function selectChat(id){
  if(!chats.some(c=>c.id===id)) return;
  activeChatId=id;
  saveChats();
  renderChatList();
  renderMessages();
  closeChatDrawer();
}
function deleteChat(id){
  const c=chats.find(x=>x.id===id);
  if(!c) return;
  if(chats.length===1){
    chats=[freshChat()];
    activeChatId=chats[0].id;
  }else{
    chats=chats.filter(x=>x.id!==id);
    if(activeChatId===id) activeChatId=chats[0].id;
  }
  saveChats();
  renderChatList();
  renderMessages();
}
function renameChat(id){
  const c=chats.find(x=>x.id===id);
  if(!c) return;
  const name=prompt('Nome do chat:',c.title);
  if(!name) return;
  c.title=name.trim().slice(0,60)||c.title;
  c.updatedAt=Date.now();
  saveChats();
  renderChatList();
}
function renderChatList(){
  const root=$('#chatList');
  root.textContent='';
  chats.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  for(const c of chats){
    const row=document.createElement('div');
    row.className='chatRow'+(c.id===activeChatId?' active':'');
    const pick=document.createElement('button');
    pick.className='chatPick';
    pick.textContent=c.title||'Novo chat';
    pick.onclick=()=>selectChat(c.id);
    pick.ondblclick=()=>renameChat(c.id);
    const del=document.createElement('button');
    del.className='chatDelete';
    del.textContent='×';
    del.title='Excluir chat';
    del.onclick=e=>{e.stopPropagation();deleteChat(c.id)};
    row.append(pick,del);
    root.append(row);
  }
}
function openChatDrawer(){
  $('#chatSidebar').classList.add('open');
  $('#drawerShade').classList.add('show');
}
function closeChatDrawer(){
  $('#chatSidebar').classList.remove('open');
  $('#drawerShade').classList.remove('show');
}

function save(){localStorage.setItem('zero.files',JSON.stringify(files));scheduleCloudSave()}
function saveAssets(){localStorage.setItem(ASSET_KEY,JSON.stringify(assets));scheduleCloudSave()}
function saveCheckpoints(){
  checkpoints=checkpoints.slice(-20);
  checkpointIndex=Math.min(checkpointIndex,checkpoints.length-1);
  localStorage.setItem(CHECKPOINT_KEY,JSON.stringify(checkpoints));
  scheduleCloudSave();
  updateCheckpointButtons();
}
function createCheckpoint(label='Checkpoint'){
  if(files[active]!=null) files[active]=$('#editor').value;
  const snap={label,at:Date.now(),files:JSON.parse(JSON.stringify(files)),assets:JSON.parse(JSON.stringify(assets)),active};
  if(checkpointIndex<checkpoints.length-1) checkpoints=checkpoints.slice(0,checkpointIndex+1);
  checkpoints.push(snap);
  checkpointIndex=checkpoints.length-1;
  saveCheckpoints();
}
function restoreCheckpoint(index){
  const snap=checkpoints[index];
  if(!snap) return;
  files=JSON.parse(JSON.stringify(snap.files||{}));
  assets=JSON.parse(JSON.stringify(snap.assets||{}));
  active=files[snap.active]!=null?snap.active:Object.keys(files)[0];
  checkpointIndex=index;
  save();
  saveAssets();
  $('#editor').value=files[active]||'';
  tabs();
  renderFileTree();
  renderAssets();
  lines();
  run();
  saveCheckpoints();
  status('↶ '+(snap.label||'Checkpoint'));
}
function undoAI(){
  if(checkpointIndex<=0){status('⚠️ Nada anterior para desfazer');return;}
  restoreCheckpoint(checkpointIndex-1);
}
function redoAI(){
  if(checkpointIndex>=checkpoints.length-1){status('⚠️ Nada para refazer');return;}
  restoreCheckpoint(checkpointIndex+1);
}
function updateCheckpointButtons(){
  const u=$('#undoAI'),r=$('#redoAI');
  if(u) u.disabled=checkpointIndex<=0;
  if(r) r.disabled=checkpointIndex<0||checkpointIndex>=checkpoints.length-1;
}
function ensureInitialCheckpoint(){
  if(!checkpoints.length){
    checkpoints=[{label:'Estado inicial',at:Date.now(),files:JSON.parse(JSON.stringify(files)),assets:JSON.parse(JSON.stringify(assets)),active}];
    checkpointIndex=0;
    saveCheckpoints();
  }
}

function fileIcon(name){
  if(name.endsWith('.gd')) return '🟦';
  if(name.endsWith('.tscn')) return '🎬';
  if(name.endsWith('.tres')) return '🧩';
  if(name.endsWith('.gdshader')) return '✨';
  if(name==='project.godot') return '🎮';
  if(/\.(png|jpg|jpeg|webp|gif)$/i.test(name)) return '🖼️';
  return '📄';
}
function renderFileTree(filter=''){
  const root=$('#fileTree');
  if(!root) return;
  root.textContent='';
  const q=String(filter||'').toLowerCase();
  const names=Object.keys(files).filter(n=>!q||n.toLowerCase().includes(q)).sort((a,b)=>a.localeCompare(b));
  if(!names.length){
    const e=document.createElement('div'); e.className='treeEmpty'; e.textContent='Nenhum arquivo'; root.append(e); return;
  }
  for(const name of names){
    const row=document.createElement('button');
    row.className='treeFile'+(name===active?' active':'')+(lastChangedFiles.includes(name)?' changed':'');
    row.dataset.name=name;
    const depth=(name.match(/\//g)||[]).length;
    row.style.paddingLeft=(10+depth*13)+'px';
    row.textContent=fileIcon(name)+' '+name;
    row.onclick=()=>openFile(name);
    row.oncontextmenu=e=>{
      e.preventDefault();
      const action=prompt('Arquivo: '+name+'\nDigite R para renomear ou D para excluir:','R');
      if(!action) return;
      if(action.toLowerCase()==='d'){
        if(confirm('Excluir '+name+'?')){
          createCheckpoint('Antes de excluir '+name);
          delete files[name];
          active=Object.keys(files)[0]||'';
          save(); tabs(); renderFileTree(); $('#editor').value=files[active]||''; lines(); run();
        }
      }else if(action.toLowerCase()==='r'){
        const nn=prompt('Novo caminho/nome:',name);
        if(nn&&nn!==name&&/^[\w.\-\/]+$/.test(nn)){
          createCheckpoint('Antes de renomear '+name);
          files[nn]=files[name]; delete files[name]; active=nn; save(); tabs(); renderFileTree(); openFile(nn);
        }
      }
    };
    root.append(row);
  }
}
function createFileManual(){
  const name=prompt('Nome/caminho do novo arquivo:','scripts/new_script.gd');
  if(!name||!/^[\w.\-\/]+$/.test(name)||files[name]!=null) return;
  createCheckpoint('Antes de criar '+name);
  files[name]=name.endsWith('.gd')?'extends Node\n':name.endsWith('.tscn')?'[gd_scene format=3]\n':'';
  active=name; save(); tabs(); renderFileTree(); openFile(name);
}

function saveProjectMemory(){
  localStorage.setItem(PROJECT_MEMORY_KEY,JSON.stringify(projectMemory.slice(-30)));
  scheduleCloudSave();
}
function rememberProjectChange(request,changedFiles,meta={}){
  if(!Array.isArray(changedFiles)||!changedFiles.length) return;
  projectMemory.push({
    request:String(request||'').slice(0,500),
    files:changedFiles.slice(0,20),
    projectType:meta.projectType||'',
    complexity:meta.complexity||'',
    at:Date.now()
  });
  projectMemory=projectMemory.slice(-30);
  saveProjectMemory();
}
function projectMemoryText(){
  if(!projectMemory.length) return '';
  return projectMemory.slice(-12).map((m,i)=>{
    const when=new Date(m.at||Date.now()).toLocaleString();
    return `#${i+1} [${when}] ${m.request}\nArquivos: ${(m.files||[]).join(', ')}${m.projectType?'\nTipo: '+m.projectType:''}`;
  }).join('\n\n');
}

function resetProject(){
  if(!confirm('Resetar o projeto atual? Os chats serão mantidos.')) return;
  document.body.classList.toggle('godot-mode',isGodotProject());

  if(isGodotProject()){
    createGodotProject();
    status('↻ Projeto Godot resetado');
    return;
  }
  files=JSON.parse(JSON.stringify(DEFAULT));
  assets={};
  projectMemory=[];
  saveProjectMemory();
  active=Object.keys(files)[0];
  save();
  saveAssets();
  renderAssets();
  $('#editor').value=files[active]||'';
  tabs();
  lines();
  run();
  status('↻ Projeto resetado');
}
async function generateImageAsset(name,prompt){
  return await generateLocalImageAsset(name,prompt);
}
async function manualImage(){
  const promptText=prompt('Descreva a imagem que o CodeZero deve criar:');
  if(!promptText) return;
  const name=(prompt('Nome do arquivo:','generated-image.png')||'generated-image.png').trim();
  status('🎨 Gerando imagem localmente…');
  try{
    const out=await generateImageAsset(name,promptText);
    status('🖼️ Imagem criada: assets/'+out.name);
    const chat=activeChat();
    chat.messages.push({role:'assistant',content:'Imagem criada: assets/'+out.name,display:'🖼️ Imagem criada: assets/'+out.name+'\n'+out.url});
    chat.updatedAt=Date.now();
    saveChats();
    renderMessages();
  }catch(e){
    status('⚠️ '+e.message);
  }
}
function resolveAssets(text){
  let out=String(text||'');
  for(const [name,url] of Object.entries(assets)){
    out=out.split('assets/'+name).join(url);
  }
  return out;
}
async function processImageRequests(text){
  const re=/<<<IMAGE:([^|>]+)\|([\s\S]*?)>>>/g;
  const jobs=[];
  let m;
  while((m=re.exec(String(text||'')))) jobs.push({name:m[1].trim(),prompt:m[2].trim()});
  const made=[];
  for(const job of jobs){
    if(!job.prompt) continue;
    try{made.push(await generateImageAsset(job.name,job.prompt));}
    catch(e){console.error('image generation failed',job,e);}
  }
  return made;
}

function renderAssets(){
  const root=$('#assetList');
  if(!root) return;
  root.textContent='';
  const entries=Object.entries(assets);
  if(!entries.length){
    const empty=document.createElement('div');
    empty.className='assetEmpty';
    empty.textContent='Nenhuma imagem ainda';
    root.append(empty);
    return;
  }
  for(const [name,url] of entries){
    const card=document.createElement('button');
    card.className='assetCard';
    card.title='Toque para editar • segure/copiar caminho assets/'+name;
    const img=document.createElement('img');
    img.src=url;
    img.alt=name;
    const label=document.createElement('span');
    label.textContent=name;
    card.append(img,label);
    card.onclick=()=>manualEditImage(name);
    card.oncontextmenu=e=>{e.preventDefault();navigator.clipboard?.writeText('assets/'+name);status('📋 Copiado: assets/'+name);};
    root.append(card);
  }
  renderMediaSources();
}

async function importLocalImage(file){
  if(!file) return null;
  if(!String(file.type||'').startsWith('image/')) throw new Error('Selecione um arquivo de imagem.');
  if(file.size>8*1024*1024) throw new Error('Imagem maior que 8 MB.');
  const dataUrl=await new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result||''));
    reader.onerror=()=>reject(new Error('Falha ao ler a imagem.'));
    reader.readAsDataURL(file);
  });
  const name=String(file.name||'upload.png').replace(/[^\w.\-]/g,'-');
  assets[name]=dataUrl;
  saveAssets();
  renderAssets();
  return {name,url:dataUrl};
}

async function manualUploadImage(){
  const input=document.createElement('input');
  input.type='file';
  input.accept='image/*';
  input.onchange=async()=>{
    try{
      const out=await importLocalImage(input.files?.[0]);
      if(out) status('📤 Imagem adicionada: assets/'+out.name);
    }catch(e){status('⚠️ '+e.message);}
  };
  input.click();
}

async function editImageAsset(sourceName,targetName,promptText){
  return await localTransformImageAsset(sourceName,targetName,promptText);
}
async function manualEditImage(preselected=''){
  const names=Object.keys(assets);
  if(!names.length){status('⚠️ Adicione ou gere uma imagem primeiro.');return;}
  const sourceName=preselected||prompt('Asset de origem:\n'+names.join('\n'),names[0]);
  if(!sourceName||!assets[sourceName]) return;
  const targetName=prompt('Salvar imagem editada como:',sourceName.replace(/(\.[^.]+)?$/,'-editado.png'));
  if(!targetName) return;
  const instruction=prompt('O que deseja modificar na imagem?');
  if(!instruction) return;
  status('🛠️ Editando imagem…');
  try{
    const out=await editImageAsset(sourceName,targetName,instruction);
    const chat=activeChat();
    chat.messages.push({role:'assistant',content:'Imagem editada: assets/'+out.name,display:'🛠️ Imagem editada: assets/'+out.name+'\n'+out.url});
    chat.updatedAt=Date.now();
    saveChats();
    renderMessages();
    status('✅ Imagem editada: assets/'+out.name);
  }catch(e){status('⚠️ '+e.message);}
}

async function processEditImageRequests(text){
  const re=/<<<EDIT_IMAGE:([^|>]+)\|([^|>]+)\|([\s\S]*?)>>>/g;
  const jobs=[];
  let m;
  while((m=re.exec(String(text||'')))) jobs.push({source:m[1].trim().replace(/^assets\//,''),target:m[2].trim().replace(/^assets\//,''),prompt:m[3].trim()});
  const made=[];
  for(const job of jobs){
    try{made.push(await editImageAsset(job.source,job.target,job.prompt));}
    catch(e){console.error('image edit failed',job,e);}
  }
  return made;
}
function tabs(){
  const n=$('#tabs');
  n.textContent='';
  Object.keys(files).forEach(f=>{
    const b=document.createElement('button');
    b.textContent=f;
    b.className=(f===active?'active ':'')+(lastChangedFiles.includes(f)?'changed':'');
    b.onclick=()=>openFile(f);
    n.append(b);
  });
  renderFileTree($('#fileSearch')?.value||'');
}
function openFile(f){
  if(files[active]!=null) files[active]=$('#editor').value;
  active=f;
  $('#editor').value=files[f]||'';
  save();
  tabs();
  renderFileTree($('#fileSearch')?.value||'');
  lines();
}
function lines(){
  const n=$('#editor').value.split('\n').length;
  $('#lines').textContent=Array.from({length:n},(_,i)=>i+1).join('\n');
}
$('#editor').oninput=()=>{
  files[active]=$('#editor').value;
  save();
  lines();
};

function renderPendingAttachments(){
  const root=$('#attachments');
  if(!root) return;
  root.textContent='';
  for(const [i,a] of pendingAttachments.entries()){
    const chip=document.createElement('div');
    chip.className='attachmentChip';
    const icon=document.createElement('span');
    icon.textContent=a.kind==='image'?'🖼️':a.kind==='pdf'?'📄':'📎';
    const name=document.createElement('span');
    name.className='attachmentName';
    name.textContent=a.name;
    const remove=document.createElement('button');
    remove.type='button';
    remove.textContent='×';
    remove.onclick=()=>{pendingAttachments.splice(i,1);renderPendingAttachments();};
    chip.append(icon,name,remove);
    root.append(chip);
  }
}

async function extractPdfText(file){
  const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const bytes=new Uint8Array(await file.arrayBuffer());
  const doc=await pdfjs.getDocument({data:bytes}).promise;
  const maxPages=Math.min(doc.numPages,25);
  const out=[];
  for(let p=1;p<=maxPages;p++){
    const page=await doc.getPage(p);
    const content=await page.getTextContent();
    out.push('--- Página '+p+' ---\n'+content.items.map(x=>x.str).join(' '));
  }
  if(doc.numPages>maxPages) out.push('\n[PDF truncado: '+(doc.numPages-maxPages)+' página(s) não lida(s)]');
  return out.join('\n\n').slice(0,50000);
}

async function extractImageText(file){
  const mod=await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
  const Tesseract=mod.default||mod;
  const result=await Tesseract.recognize(file,'por+eng',{
    logger:m=>{
      if(m?.status==='recognizing text'&&typeof m.progress==='number'){
        status('🔎 Lendo imagem… '+Math.round(m.progress*100)+'%');
      }
    }
  });
  return String(result?.data?.text||'').trim().slice(0,24000);
}

function isTextLikeFile(file){
  const name=String(file.name||'').toLowerCase();
  const type=String(file.type||'').toLowerCase();
  return type.startsWith('text/')
    || /(json|javascript|xml|yaml|csv|markdown)/.test(type)
    || /\.(txt|md|markdown|json|jsonc|js|mjs|cjs|ts|tsx|jsx|html|css|scss|xml|yml|yaml|csv|log|ini|cfg|conf|env|gd|tscn|tres|gdshader|godot|py|java|c|cc|cpp|h|hpp|cs|go|rs|php|rb|sh|sql)$/i.test(name);
}

async function readAttachment(file){
  if(!file) return null;
  if(file.size>12*1024*1024) throw new Error(file.name+': máximo de 12 MB.');
  const base={name:file.name||'arquivo',type:file.type||'',size:file.size||0};
  if(String(file.type||'').startsWith('image/')){
    const text=await extractImageText(file);
    return {...base,kind:'image',text,note:text?'Texto extraído localmente por OCR.':'Não foi possível extrair texto legível desta imagem.'};
  }
  if(file.type==='application/pdf'||/\.pdf$/i.test(file.name||'')){
    const text=await extractPdfText(file);
    return {...base,kind:'pdf',text,note:'Texto extraído localmente do PDF.'};
  }
  if(isTextLikeFile(file)){
    const text=(await file.text()).slice(0,60000);
    return {...base,kind:'text',text,note:'Conteúdo lido diretamente do arquivo.'};
  }
  throw new Error(file.name+': formato ainda não suportado para leitura.');
}

async function addAttachmentFiles(fileList){
  const list=[...(fileList||[])].slice(0,8-pendingAttachments.length);
  for(const file of list){
    try{
      status('📎 Lendo '+file.name+'…');
      const item=await readAttachment(file);
      if(item) pendingAttachments.push(item);
    }catch(e){
      status('⚠️ '+e.message);
    }
  }
  renderPendingAttachments();
  status(pendingAttachments.length?'📎 '+pendingAttachments.length+' anexo(s) pronto(s)':'☁️ CodeZero • Railway');
}

function openAttachmentPicker(){
  const input=$('#attachmentInput');
  if(input) input.click();
}

function appendMessage(type,text='',sources=[]){
  const d=document.createElement('div');
  d.className=type;
  const body=document.createElement('div');
  body.className='messageBody';
  body.textContent=text;
  d.append(body);
  if(Array.isArray(sources)&&sources.length){
    const box=document.createElement('div');
    box.className='sources';
    const title=document.createElement('div');
    title.className='sourcesTitle';
    title.textContent='Fontes pesquisadas';
    box.append(title);
    sources.slice(0,5).forEach((s,i)=>{
      const a=document.createElement('a');
      a.href=s.url;
      a.target='_blank';
      a.rel='noopener noreferrer';
      a.textContent='['+(i+1)+'] '+(s.title||s.url);
      box.append(a);
    });
    d.append(box);
  }
  $('#messages').append(d);
  $('#messages').scrollTop=1e9;
  return d;
}
function renderMessages(){
  const root=$('#messages');
  root.textContent='';
  const c=activeChat();
  if(!c.messages.length){
    appendMessage('ai','CodeZero online. Pode conversar comigo, pedir ajuda nos estudos, pesquisar ou programar seu projeto.');
    return;
  }
  for(const m of c.messages){
    appendMessage(m.role==='user'?'user':'ai',m.display||visibleReply(m.content||''),m.sources||[]);
  }
}
function status(t){$('#status').textContent=t}
function projectContext(){
  const code=Object.entries(files).map(([n,c])=>`ARQUIVO ${n}:\n${c}`).join('\n\n');
  const assetList=Object.keys(assets).length?'\n\nASSETS GERADOS DISPONÍVEIS:\n'+Object.keys(assets).map(n=>'assets/'+n).join('\n'):'';
  return (code+assetList).slice(0,32000);
}
function parseChangesFromResponse(text){
  const out=[];
  const re=/<<<FILE:([^>]+)>>>([\s\S]*?)<<<END_FILE>>>/g;
  let m;
  while((m=re.exec(String(text||'')))){
    const name=m[1].trim().replace(/^\/+/,''),content=m[2].replace(/^\n/,'').replace(/\n$/,'');
    if(/^[\w.\-\/]+$/.test(name)) out.push({name,content,before:files[name]||''});
  }
  return out;
}
function reviewDiff(changes){
  if(!changes.length) return Promise.resolve(true);
  const modal=$('#diffModal'),list=$('#diffFiles'),before=$('#diffBefore'),after=$('#diffAfter');
  if(!modal||!list) return Promise.resolve(true);
  list.textContent='';
  let current=0;
  const show=i=>{
    current=i;
    [...list.children].forEach((b,j)=>b.classList.toggle('active',j===i));
    before.textContent=changes[i].before||'(arquivo novo)';
    after.textContent=changes[i].content;
  };
  changes.forEach((c,i)=>{
    const b=document.createElement('button'); b.textContent=c.name; b.onclick=()=>show(i); list.append(b);
  });
  show(0); modal.classList.remove('hidden');
  return new Promise(resolve=>{
    const finish=v=>{modal.classList.add('hidden'); $('#diffAccept').onclick=null; $('#diffReject').onclick=null; $('#diffClose').onclick=null; resolve(v);};
    $('#diffAccept').onclick=()=>finish(true);
    $('#diffReject').onclick=()=>finish(false);
    $('#diffClose').onclick=()=>finish(false);
  });
}
function startTaskProgress(){
  const box=$('#taskProgress'),fill=$('#taskBarFill'),pct=$('#taskProgressPct'),steps=$('#taskSteps');
  if(!box) return;
  const labels=['Analisando projeto','Planejando alterações','Programando','Validando arquivos','Revisando solução'];
  box.classList.remove('hidden');
  steps.textContent='';
  labels.forEach((x,i)=>{const d=document.createElement('div');d.className='taskStep';d.dataset.i=i;d.textContent='○ '+x;steps.append(d);});
  let i=0,progress=8;
  const tick=()=>{
    progress=Math.min(92,progress+(i<2?9:5));
    if(progress>[22,42,68,82,92][i]&&i<labels.length-1)i++;
    fill.style.width=progress+'%'; pct.textContent=progress+'%';
    [...steps.children].forEach((el,j)=>{el.classList.toggle('active',j===i);el.classList.toggle('done',j<i);el.textContent=(j<i?'✓ ':j===i?'● ':'○ ')+labels[j];});
  };
  tick();
  clearInterval(taskProgressTimer);
  taskProgressTimer=setInterval(tick,900);
}
function finishTaskProgress(ok=true){
  clearInterval(taskProgressTimer); taskProgressTimer=null;
  const box=$('#taskProgress'),fill=$('#taskBarFill'),pct=$('#taskProgressPct');
  if(!box) return;
  fill.style.width=(ok?100:0)+'%'; pct.textContent=ok?'100%':'Falhou';
  setTimeout(()=>box.classList.add('hidden'),ok?1200:2200);
}

async function applyFilesVisible(text){
  const changes=parseChangesFromResponse(text);
  if(!changes.length) return [];

  createCheckpoint('Antes da alteração da IA');
  lastChangedFiles=changes.map(x=>x.name);
  tabs();
  renderFileTree();

  for(const change of changes){
    files[change.name]=change.content;
    active=change.name;
    $('#editor').value=change.content;
    tabs();
    renderFileTree();
    lines();
    status('✍️ Aplicando '+change.name+'…');
    const editor=$('#editor');
    editor.classList.add('ai-writing');
    editor.scrollTop=0;
    await new Promise(r=>setTimeout(r,Math.min(220,60+change.content.length/120)));
    editor.classList.remove('ai-writing');
  }

  save();
  run();
  createCheckpoint('Depois da alteração da IA');
  setTimeout(()=>{lastChangedFiles=[];tabs();renderFileTree();},4500);
  return changes.map(x=>x.name);
}
function applyFiles(text){
  const re=/<<<FILE:([^>]+)>>>([\s\S]*?)<<<END_FILE>>>/g;
  let m,changed=[];
  while((m=re.exec(text))){
    const name=m[1].trim().replace(/^\/+/,''),content=m[2].replace(/^\n/,'').replace(/\n$/,'');
    if(!/^[\w.\-\/]+$/.test(name)) continue;
    files[name]=content;
    changed.push(name);
  }
  if(changed.length){
    save();
    active=changed.includes(active)?active:changed[0];
    $('#editor').value=files[active]||'';
    tabs();
    lines();
    run();
  }
  return changed;
}
function visibleReply(text){
  return String(text||'').replace(/<<<FILE:[^>]+>>>[\s\S]*?(?:<<<END_FILE>>>|$)/g,'').replace(/<<<IMAGE:[\s\S]*?>>>/g,'').replace(/<<<EDIT_IMAGE:[\s\S]*?>>>/g,'').trim();
}
function extractText(value,raw='',depth=0){
  if(depth>6||value==null) return '';
  if(typeof value==='string') return value.trim();
  if(typeof value==='number'||typeof value==='boolean') return String(value);
  if(Array.isArray(value)){
    for(const item of value){const t=extractText(item,'',depth+1);if(t)return t}
    return '';
  }
  if(typeof value==='object'){
    for(const k of ['response','text','output_text','content','message','answer','completion','generated_text','result','data','choices']){
      if(Object.prototype.hasOwnProperty.call(value,k)){const t=extractText(value[k],'',depth+1);if(t)return t}
    }
    for(const child of Object.values(value)){const t=extractText(child,'',depth+1);if(t)return t}
  }
  return raw||'';
}

function likelyCodeRequest(message){
  const m=String(message||'').toLowerCase().trim();
  if(!m) return false;
  if(/^(oi|olá|ola|opa|eai|e aí|bom dia|boa tarde|boa noite|tudo bem|como vai)\b/.test(m) &&
     !/\b(código|codigo|program|godot|html|css|javascript|script|site|app|jogo|bug|arquivo)\b/.test(m)) return false;
  if(/\b(me ajuda|ajuda|explique|explica|ensine|ensina|resolva|resolve|exercício|exercicio|questão|questao|matemática|matematica|história|historia|física|fisica|química|quimica|português|portugues)\b/.test(m) &&
     !/\b(código|codigo|programação|programacao|godot|html|css|javascript|script|bug|arquivo|função|funcao)\b/.test(m)) return false;
  if(/\b(godot|gdscript|three\.?js|webgl|programa|programe|programar|coda|codar|implemente|refatora|debug|bug|erro de código|erro no código|erro no codigo)\b/.test(m)) return true;
  if(/\b(jogo|game|site|página web|pagina web|aplicativo|app|sistema|dashboard|landing page)\b/.test(m) &&
     /\b(cria|crie|criar|construa|faz|faça|fazer|monte|desenvolva)\b/.test(m)) return true;
  if(/\b(html|css|javascript|typescript|script|arquivo|função|funcao|componente|endpoint|api|backend|frontend|sql)\b/.test(m) &&
     /\b(cria|crie|faz|faça|adicione|coloca|corrige|arruma|altera|muda|edite|remove)\b/.test(m)) return true;
  return false;
}

async function send(){
  const p=$('#prompt').value.trim();
  if(!p||busy) return;
  const chat=activeChat();
  const previousHistory=chat.messages.slice(-8).map(m=>({role:m.role,content:m.content}));
  const sentAttachments=pendingAttachments.map(a=>({name:a.name,kind:a.kind}));
  chat.messages.push({role:'user',content:p,display:p+(sentAttachments.length?'\n\n📎 '+sentAttachments.map(a=>a.name).join(', '):'')});
  if(chat.title==='Novo chat') chat.title=p.replace(/\s+/g,' ').slice(0,38)||'Novo chat';
  chat.updatedAt=Date.now();
  saveChats();
  renderChatList();
  renderMessages();

  $('#prompt').value='';
  const attachmentsForRequest=pendingAttachments;
  pendingAttachments=[];
  renderPendingAttachments();
  busy=true;
  $('#send').disabled=true;
  const waiting=appendMessage('ai','Pensando…');
  const showCodingProgress=likelyCodeRequest(p);
  if(showCodingProgress) startTaskProgress();
  try{
    status('🧠 CodeZero pensando…');
    const requestPayload={message:p,project:projectContext(),history:previousHistory,memory:projectMemoryText(),attachments:attachmentsForRequest};
    let raw='';
    let data=null;
    try{
      const r=await fetch(API,{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify(requestPayload)
      });
      raw=await r.text();
      try{data=JSON.parse(raw)}catch{}
      if(!r.ok){
        const detail=data?.details||data?.error||raw||`HTTP ${r.status}`;
        throw new Error(`CodeZero ${r.status}: ${String(detail).slice(0,500)}`);
      }
    }catch(remoteError){
      console.warn('[remote-ai-unavailable]',remoteError);
      status('📱 Nuvem grátis indisponível. Ativando IA local…');
      try{
        const local=await getLocalTextModule();
        data=await local.generateLocalTextResponse({
          message:p,
          history:previousHistory,
          project:requestPayload.project,
          wantsCode:showCodingProgress,
          onStatus:(event)=>status('📱 '+String(event?.message||'IA local…').slice(0,110))
        });
      }catch(localError){
        console.warn('[local-ai-module-error]',localError);
        data={
          response:emergencyLocalTextReply(p,showCodingProgress),
          provider:'local-rules',
          model:'offline-rules-inline-v1',
          local:true,
          degraded:true
        };
        status('📱 CodeZero em modo local de emergência');
      }
      raw=JSON.stringify(data);
    }
    const full=extractText(data,raw);
    if(!full.trim()) throw new Error('O CodeZero respondeu vazio.');
    const generatedImages=await processImageRequests(full);
    const editedImages=await processEditImageRequests(full);
    const proposed=parseChangesFromResponse(full);
    let changed=[];
    if(proposed.length){
      const accepted=await reviewDiff(proposed);
      if(accepted) changed=await applyFilesVisible(full);
      else status('🚫 Alterações rejeitadas');
    }
    if(changed.length) $('#editor').focus();
    if(changed.length) rememberProjectChange(p,changed,{projectType:data?.projectType,complexity:data?.complexity});
    const clean=(visibleReply(full)||'Projeto atualizado.')+(changed.length?'\n\n✓ '+changed.join(', '):'')+(generatedImages.length?'\n🖼️ Geradas: '+generatedImages.map(x=>'assets/'+x.name).join(', '):'')+(editedImages.length?'\n🛠️ Editadas: '+editedImages.map(x=>'assets/'+x.name).join(', '):'');
    chat.messages.push({role:'assistant',content:full,display:clean,sources:data?.sources||[]});
    chat.updatedAt=Date.now();
    saveChats();
    waiting.remove();
    renderMessages();
    renderChatList();
    if(showCodingProgress) finishTaskProgress(true);
    if(data?.provider==='local-webgpu'){
      status('📱 CodeZero respondeu com IA local WebGPU');
    }else if(data?.provider==='local-rules'){
      status('📱 CodeZero em modo local mínimo');
    }else if(data?.validated){
      status('✅ V10 validou '+(data.changedFiles?.length||changed.length)+' arquivo(s) • '+(data.complexity||'normal'));
    }else{
      status(data?.searched?'🌐 CodeZero pesquisou e respondeu':'✅ CodeZero respondeu');
    }
  }catch(e){
    if(showCodingProgress) finishTaskProgress(false);
    console.error(e);
    waiting.remove();
    const msg='Erro da IA: '+e.message;
    chat.messages.push({role:'assistant',content:msg,display:msg});
    chat.updatedAt=Date.now();
    saveChats();
    renderMessages();
    status('⚠️ '+e.message.slice(0,80));
  }finally{
    busy=false;
    $('#send').disabled=false;
  }
}

function isGodotProject(){
  return Object.prototype.hasOwnProperty.call(files,'project.godot');
}

function createGodotProject(){
  files={
    'project.godot':`; Engine configuration file.
; Edit with Godot 4.x.

config_version=5

[application]

config/name="CodeZero Godot"
run/main_scene="res://main.tscn"

[display]

window/size/viewport_width=1280
window/size/viewport_height=720
window/size/window_width_override=960
window/size/window_height_override=540
window/stretch/mode="canvas_items"

[input]

move_left={
"deadzone": 0.5,
"events": [Object(InputEventKey,"physical_keycode":65)]
}
move_right={
"deadzone": 0.5,
"events": [Object(InputEventKey,"physical_keycode":68)]
}
move_forward={
"deadzone": 0.5,
"events": [Object(InputEventKey,"physical_keycode":87)]
}
move_back={
"deadzone": 0.5,
"events": [Object(InputEventKey,"physical_keycode":83)]
}

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`,
    'main.tscn':`[gd_scene load_steps=4 format=3]

[ext_resource path="res://player.gd" type="Script" id="1"]

[sub_resource type="BoxMesh" id="BoxMesh_ground"]
size = Vector3(20, 0.2, 20)

[sub_resource type="BoxShape3D" id="BoxShape_ground"]
size = Vector3(20, 0.2, 20)

[node name="Main" type="Node3D"]

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
rotation_degrees = Vector3(-55, -30, 0)
shadow_enabled = true

[node name="Ground" type="StaticBody3D" parent="."]

[node name="MeshInstance3D" type="MeshInstance3D" parent="Ground"]
mesh = SubResource("BoxMesh_ground")

[node name="CollisionShape3D" type="CollisionShape3D" parent="Ground"]
shape = SubResource("BoxShape_ground")

[node name="Player" type="CharacterBody3D" parent="."]
script = ExtResource("1")
position = Vector3(0, 1, 0)

[node name="Camera3D" type="Camera3D" parent="Player"]
position = Vector3(0, 2.2, 5)
current = true
`,
    'player.gd':`extends CharacterBody3D

@export var speed: float = 5.0
@export var gravity: float = 18.0

func _physics_process(delta: float) -> void:
    if not is_on_floor():
        velocity.y -= gravity * delta

    var input_dir := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
    var direction := Vector3(input_dir.x, 0.0, input_dir.y).normalized()

    if direction != Vector3.ZERO:
        velocity.x = direction.x * speed
        velocity.z = direction.z * speed
    else:
        velocity.x = move_toward(velocity.x, 0.0, speed)
        velocity.z = move_toward(velocity.z, 0.0, speed)

    move_and_slide()
`
  };
  assets={};
  projectMemory=[];
  saveProjectMemory();
  active='player.gd';
  save();
  saveAssets();
  renderAssets();
  $('#editor').value=files[active];
  tabs();
  lines();
  run();
  status('🎮 Projeto Godot criado');
}

function create3DProject(){
  createGodotProject();
}

async function collectImportedProject(fileList){
  const importedFiles={},importedAssets={};
  const list=[...(fileList||[])];
  const textExt=/\.(godot|gd|tscn|tres|gdshader|txt|md|json|cfg|ini|csv|xml|yml|yaml|shader|html|css|js|mjs|cjs|ts|tsx|jsx|py|java|cs|cpp|c|h|hpp|go|rs|php|rb|sh|sql)$/i;
  const imageExt=/\.(png|jpg|jpeg|webp|gif)$/i;
  const {unzipSync,strFromU8}=await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');

  const addBytes=(rawName,bytes)=>{
    const name=String(rawName||'').replace(/^\.\//,'').replace(/\\/g,'/').replace(/^\/+/,'');
    if(!name||name.endsWith('/')) return;
    if(textExt.test(name)&&bytes.length<2*1024*1024){
      importedFiles[name]=strFromU8(bytes);
      return;
    }
    if(imageExt.test(name)&&bytes.length<8*1024*1024){
      const ext=name.split('.').pop().toLowerCase();
      const mime=ext==='jpg'||ext==='jpeg'?'image/jpeg':ext==='webp'?'image/webp':ext==='gif'?'image/gif':'image/png';
      let binary='';
      for(let i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]);
      importedAssets[name.replace(/^assets\//,'')]='data:'+mime+';base64,'+btoa(binary);
    }
  };

  for(const file of list){
    const name=file.webkitRelativePath||file.name||'arquivo';
    if(/\.zip$/i.test(name)||file.type==='application/zip'){
      const data=new Uint8Array(await file.arrayBuffer());
      const entries=unzipSync(data);
      for(const [entryName,bytes] of Object.entries(entries)) addBytes(entryName,bytes);
      continue;
    }
    if(textExt.test(name)){
      if(file.size<=2*1024*1024) importedFiles[name]=await file.text();
      continue;
    }
    if(imageExt.test(name)||String(file.type||'').startsWith('image/')){
      if(file.size<=8*1024*1024){
        const dataUrl=await new Promise((resolve,reject)=>{
          const reader=new FileReader();
          reader.onload=()=>resolve(String(reader.result||''));
          reader.onerror=()=>reject(new Error('Falha ao ler '+name));
          reader.readAsDataURL(file);
        });
        importedAssets[name.replace(/^assets\//,'')]=dataUrl;
      }
    }
  }
  return {importedFiles,importedAssets};
}

function installGodotWorkspace(newFiles,newAssets,label='Projeto Godot'){
  createCheckpoint('Antes de importar/converter projeto');
  files={...newFiles};
  assets={...newAssets};
  projectMemory=[];
  saveProjectMemory();
  active=Object.keys(files).find(n=>n.endsWith('.gd'))||Object.keys(files).find(n=>n.endsWith('.tscn'))||'project.godot';
  save();
  saveAssets();
  $('#editor').value=files[active]||'';
  tabs();
  renderFileTree();
  renderAssets();
  lines();
  run();
  createCheckpoint(label);
  document.body.classList.add('godot-mode');
}

async function convertImportedProjectToGodot(importedFiles,importedAssets){
  const sourceNames=Object.keys(importedFiles);
  if(!sourceNames.length) throw new Error('Nenhum arquivo de código/texto reconhecido para converter.');

  const sourceProject=[
    ...Object.entries(importedFiles).map(([name,content])=>`ARQUIVO ${name}:\n${String(content).slice(0,12000)}`),
    ...Object.keys(importedAssets).map(name=>`ARQUIVO assets/${name}:\n[BINARY_ASSET_DISPONIVEL]`)
  ].join('\n\n').slice(0,30000);

  const prompt=[
    'CONVERSÃO AUTOMÁTICA PARA GODOT 4.',
    'Converta integralmente o projeto importado para um projeto Godot 4 funcional dentro do CodeZero.',
    'Não gere ZIP, não explique como exportar e não devolva HTML/Three.js como solução final.',
    'Crie obrigatoriamente project.godot, pelo menos uma cena .tscn e os scripts .gd necessários.',
    'Preserve a ideia, jogabilidade, controles e sistemas existentes sempre que possível.',
    'Use os assets listados em assets/ quando forem úteis.',
    'Todos os arquivos finais devem ser entregues em blocos <<<FILE:nome>>>...<<<END_FILE>>>.'
  ].join(' ');

  startTaskProgress();
  status('🎮 Convertendo projeto para Godot 4…');
  try{
    const r=await fetch(API,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({message:prompt,project:sourceProject,history:[],memory:'Conversão automática de projeto importado para Godot 4.',attachments:[]})
    });
    const raw=await r.text();
    let data=null; try{data=JSON.parse(raw)}catch{}
    if(!r.ok){
      const detail=data?.details||data?.error||raw||('HTTP '+r.status);
      throw new Error(String(detail).slice(0,500));
    }
    const full=extractText(data,raw);
    const changes=parseChangesFromResponse(full);
    if(!changes.length) throw new Error('A IA não retornou arquivos Godot.');
    const godotFiles={};
    for(const change of changes) godotFiles[change.name]=change.content;
    if(!godotFiles['project.godot']) throw new Error('A conversão não gerou project.godot.');

    installGodotWorkspace(godotFiles,importedAssets,'Convertido automaticamente para Godot');

    const chat=activeChat();
    chat.messages.push({
      role:'assistant',
      content:'Projeto convertido automaticamente para Godot 4.',
      display:'🎮 Projeto convertido para Godot 4 e aberto no workspace.\n✓ '+Object.keys(godotFiles).join(', ')
    });
    chat.updatedAt=Date.now();
    saveChats();
    renderMessages();
    renderChatList();
    finishTaskProgress(true);
    status('✅ Convertido para Godot: '+Object.keys(godotFiles).length+' arquivo(s)');
  }catch(e){
    finishTaskProgress(false);
    throw e;
  }
}

async function importProjectFiles(fileList){
  if(!fileList||!fileList.length) return;
  try{
    status('📥 Lendo projeto…');
    const {importedFiles,importedAssets}=await collectImportedProject(fileList);
    if(!Object.keys(importedFiles).length&&!Object.keys(importedAssets).length) throw new Error('Nenhum arquivo compatível encontrado.');

    if(importedFiles['project.godot']){
      installGodotWorkspace(importedFiles,importedAssets,'Projeto Godot importado');
      status('✅ Projeto Godot aberto diretamente no workspace');
      return;
    }

    await convertImportedProjectToGodot(importedFiles,importedAssets);
  }catch(e){
    status('⚠️ Falha ao importar/converter: '+e.message);
    const chat=activeChat();
    chat.messages.push({role:'assistant',content:'Erro ao importar projeto: '+e.message,display:'⚠️ Não consegui converter o projeto: '+e.message});
    chat.updatedAt=Date.now();
    saveChats();
    renderMessages();
  }
}

async function exportGodotZip(){
  if(!isGodotProject()){
    status('⚠️ Este projeto não é Godot.');
    return;
  }
  try{
    status('📦 Preparando ZIP Godot…');
    const {zipSync,strToU8}=await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');
    const entries={};
    for(const [name,content] of Object.entries(files)) entries[name]=strToU8(String(content));
    for(const [name,url] of Object.entries(assets)){
      if(String(url).startsWith('data:')){
        const [meta,b64]=String(url).split(',');
        const bin=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
        entries['assets/'+name]=bin;
      }
    }
    const zipped=zipSync(entries,{level:6});
    const blob=new Blob([zipped],{type:'application/zip'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='CodeZero-Godot-Project.zip';
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1500);
    status('✅ Projeto Godot exportado');
  }catch(e){
    status('⚠️ Falha ao exportar: '+e.message);
  }
}

function run(){
  files[active]=$('#editor').value;
  save();
  $('#console').textContent='';

  if(isGodotProject()){
    const gd=Object.keys(files).filter(n=>n.endsWith('.gd')).length;
    const scenes=Object.keys(files).filter(n=>n.endsWith('.tscn')).length;
    const resources=Object.keys(files).filter(n=>n.endsWith('.tres')||n.endsWith('.gdshader')).length;
    const html=`
      <style>
        body{margin:0;background:#12151d;color:#eef4ff;font-family:system-ui;padding:22px}
        .godot{max-width:700px;margin:auto}
        .badge{display:inline-block;padding:5px 9px;border-radius:999px;background:#478cbf;color:white;font-size:12px}
        .card{margin-top:15px;padding:15px;border:1px solid #34425a;border-radius:12px;background:#191f2a}
        code{color:#8bd5ff}
      </style>
      <div class="godot">
        <span class="badge">Godot 4 Project</span>
        <h2>🎮 Projeto pronto para abrir no Godot</h2>
        <div class="card">
          <b>${Object.keys(files).length} arquivos</b><br>
          ${scenes} cena(s) • ${gd} script(s) GDScript • ${resources} recurso(s)/shader(s)
        </div>
        <p>Edite <code>project.godot</code>, <code>.tscn</code> e <code>.gd</code> nas abas. Use <b>Baixar Godot ZIP</b> para abrir no editor Godot.</p>
        <p>O CodeZero não finge executar o engine Godot dentro deste iframe; ele gera um projeto Godot real.</p>
      </div>`;
    $('#preview').srcdoc=html;
    $('#console').textContent='Godot project mode\nMain scene: '+(/run\/main_scene="([^"]+)"/.exec(files['project.godot']||'')?.[1]||'não definida')+'\n';
    return;
  }

  const bridge=`<script>['log','error','warn'].forEach(k=>{let o=console[k];console[k]=(...a)=>{parent.postMessage({zero:1,k,a},'*');o(...a)}});onerror=e=>parent.postMessage({zero:1,k:'error',a:[e.message]},'*')<\/script>`;
  const js=resolveAssets(files['script.js']||'');
  const isModule=/^\s*(import|export)\b/m.test(js);
  const safeJs=js.replaceAll('</script','<\\/script');
  const scriptTag=isModule?`<script type="module">${safeJs}<\/script>`:`<script>${safeJs}<\/script>`;
  const csp=`default-src 'none'; connect-src https://cdn.jsdelivr.net https://unpkg.com https://threejs.org https://raw.githubusercontent.com data: blob:; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; worker-src blob:;`;
  $('#preview').srcdoc=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${resolveAssets(files['style.css']||'')}</style>${bridge}${resolveAssets(files['index.html']||'')}${scriptTag}`;
}

window.onmessage=e=>{
  if(e.data?.zero) $('#console').textContent+=`${e.data.k}: ${e.data.a.join(' ')}\n`;
};

$('#send').onclick=send;
if($('#mediaStudioBtn')) $('#mediaStudioBtn').onclick=openMediaStudio;
if($('#mediaClose')) $('#mediaClose').onclick=closeMediaStudio;
if($('#pollenConnect')) $('#pollenConnect').onclick=connectPollenDevice;
if($('#pollenKey')) $('#pollenKey').onclick=connectPollenKey;
if($('#pollenDisconnect')) $('#pollenDisconnect').onclick=disconnectPollen;
if($('#pollenRefresh')) $('#pollenRefresh').onclick=loadMediaModels;
if($('#pollenPoll')) $('#pollenPoll').onclick=pollPollenDevice;
if($('#mediaModelSearch')) $('#mediaModelSearch').oninput=renderMediaModels;
if($('#mediaModel')) $('#mediaModel').onchange=renderMediaModelInfo;
if($('#mediaGenerate')) $('#mediaGenerate').onclick=mediaGenerate;
if($('#mediaEdit')) $('#mediaEdit').onclick=mediaEdit;
if($('#accountBtn')) $('#accountBtn').onclick=openAccount;
if($('#accountClose')) $('#accountClose').onclick=closeAccount;
if($('#accountRegister')) $('#accountRegister').onclick=registerAccount;
if($('#accountLogin')) $('#accountLogin').onclick=loginAccount;
if($('#accountLogout')) $('#accountLogout').onclick=logoutAccount;
if($('#accountSaveNow')) $('#accountSaveNow').onclick=saveCloudNow;
if($('#accountLoad')) $('#accountLoad').onclick=loadCloudNow;
if($('#devopsBtn')) $('#devopsBtn').onclick=openDevops;
if($('#devopsClose')) $('#devopsClose').onclick=closeDevops;
if($('#githubConnect')) $('#githubConnect').onclick=connectGithub;
if($('#githubDisconnect')) $('#githubDisconnect').onclick=disconnectGithub;
if($('#githubRefresh')) $('#githubRefresh').onclick=loadGithubRepos;
if($('#githubRepo')) $('#githubRepo').onchange=loadGithubBranches;
if($('#githubImport')) $('#githubImport').onclick=importGithubRepo;
if($('#githubNewBranch')) $('#githubNewBranch').onclick=createGithubBranch;
if($('#githubCommit')) $('#githubCommit').onclick=commitGithub;
if($('#railwayConnect')) $('#railwayConnect').onclick=connectRailway;
if($('#railwayDisconnect')) $('#railwayDisconnect').onclick=disconnectRailway;
if($('#railwayRefresh')) $('#railwayRefresh').onclick=loadRailwayProjects;
if($('#railwayProject')) $('#railwayProject').onchange=loadRailwayProject;
if($('#railwayDeploy')) $('#railwayDeploy').onclick=deployRailway;
if($('#railwayDeployments')) $('#railwayDeployments').onclick=listRailwayDeployments;
if($('#railwayLinkRepo')) $('#railwayLinkRepo').onclick=linkRailwayRepo;
if($('#railwayVars')) $('#railwayVars').onclick=setRailwayVariables;
if($('#undoAI')) $('#undoAI').onclick=undoAI;
if($('#redoAI')) $('#redoAI').onclick=redoAI;
if($('#newFile')) $('#newFile').onclick=createFileManual;
if($('#fileSearch')) $('#fileSearch').oninput=e=>renderFileTree(e.target.value);
if($('#importGodot')) $('#importGodot').onclick=()=>$('#zipInput')?.click();
if($('#zipInput')) $('#zipInput').onchange=e=>{importProjectFiles(e.target.files);e.target.value='';};
if($('#attachBtn')) $('#attachBtn').onclick=openAttachmentPicker;
if($('#attachmentInput')) $('#attachmentInput').onchange=e=>{addAttachmentFiles(e.target.files);e.target.value='';};
const composer=$('.composer');
if(composer){
  composer.addEventListener('dragover',e=>{e.preventDefault();composer.classList.add('dragover');});
  composer.addEventListener('dragleave',()=>composer.classList.remove('dragover'));
  composer.addEventListener('drop',e=>{e.preventDefault();composer.classList.remove('dragover');addAttachmentFiles(e.dataTransfer?.files);});
}
$('#prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};
$('#run').onclick=run;
$('#theme').onclick=()=>document.body.classList.toggle('light');
$('#chatToggle').onclick=()=>{if($('#chatSidebar').classList.contains('open'))closeChatDrawer();else openChatDrawer()};
$('#drawerShade').onclick=closeChatDrawer;
$('#newChat').onclick=createChat;
if($('#new3D')) $('#new3D').onclick=createGodotProject;
if($('#exportGodot')) $('#exportGodot').onclick=exportGodotZip;
if($('#resetProject')) $('#resetProject').onclick=resetProject;
if($('#imageTool')) $('#imageTool').onclick=manualImage;
if($('#uploadImage')) $('#uploadImage').onclick=manualUploadImage;
if($('#editImageTool')) $('#editImageTool').onclick=()=>manualEditImage();

$('#editor').value=files[active];
renderChatList();
renderMessages();
renderAssets();
ensureInitialCheckpoint();
tabs();
renderFileTree();
lines();
run();
status('☁️ CodeZero • Railway');
(async()=>{
  await initDevops();
  await initAccount();
  await initPollen();
  await initLocalImage();
})();