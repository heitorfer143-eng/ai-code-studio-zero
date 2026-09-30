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

let files=JSON.parse(localStorage.getItem('zero.files')||'null')||DEFAULT;
let assets=JSON.parse(localStorage.getItem(ASSET_KEY)||'{}')||{};
let projectMemory=JSON.parse(localStorage.getItem(PROJECT_MEMORY_KEY)||'[]')||[];
let active=Object.keys(files)[0];
let busy=false;
let lastChangedFiles=[];
let chats=loadChats();
let activeChatId=localStorage.getItem(ACTIVE_CHAT_KEY)||chats[0].id;
if(!chats.some(c=>c.id===activeChatId)) activeChatId=chats[0].id;

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

function save(){localStorage.setItem('zero.files',JSON.stringify(files))}
function saveAssets(){localStorage.setItem(ASSET_KEY,JSON.stringify(assets))}
function saveProjectMemory(){
  localStorage.setItem(PROJECT_MEMORY_KEY,JSON.stringify(projectMemory.slice(-30)));
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
  const cleanName=String(name||'imagem.png').trim().replace(/^assets\//,'').replace(/[^\w.\-]/g,'-')||'imagem.png';
  const q=new URLSearchParams({prompt:String(prompt||'').trim()});
  const r=await fetch('/image?'+q.toString());
  const data=await r.json();
  if(!r.ok||!data?.url) throw new Error(data?.details||data?.error||'Falha ao gerar imagem');
  assets[cleanName]=data.url;
  saveAssets();
  renderAssets();
  return {name:cleanName,url:data.url};
}
async function manualImage(){
  const promptText=prompt('Descreva a imagem que o CodeZero deve criar:');
  if(!promptText) return;
  const name=(prompt('Nome do arquivo:','generated-image.png')||'generated-image.png').trim();
  status('🎨 Gerando imagem…');
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
  const source=assets[sourceName];
  if(!source) throw new Error('Asset não encontrado: '+sourceName);
  const payload={filename:sourceName,prompt:promptText,model:'kontext',size:'1024x1024'};
  if(String(source).startsWith('data:image/')) payload.dataUrl=source;
  else payload.sourceUrl=source;
  const r=await fetch('/image/edit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const data=await r.json();
  if(!r.ok) throw new Error(data?.details||data?.error||'Falha ao editar imagem.');
  let finalUrl=data.url||'';
  if(!finalUrl&&data.dataUrl) finalUrl=data.dataUrl;
  if(!finalUrl) throw new Error('Edição não retornou imagem.');
  const cleanTarget=String(targetName||'edited-image.png').replace(/^assets\//,'').replace(/[^\w.\-]/g,'-');
  assets[cleanTarget]=finalUrl;
  saveAssets();
  renderAssets();
  return {name:cleanTarget,url:finalUrl};
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
}
function openFile(f){
  if(files[active]!=null) files[active]=$('#editor').value;
  active=f;
  $('#editor').value=files[f]||'';
  save();
  tabs();
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
    appendMessage('ai','CodeZero online. Posso conversar, pesquisar e criar projetos Godot 4 completos em GDScript. Use “Novo Godot” para começar um jogo.');
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
async function applyFilesVisible(text){
  const re=/<<<FILE:([^>]+)>>>([\s\S]*?)<<<END_FILE>>>/g;
  const changes=[];
  let m;
  while((m=re.exec(String(text||'')))){
    const name=m[1].trim().replace(/^\/+/,''),content=m[2].replace(/^\n/,'').replace(/\n$/,'');
    if(!/^[\w.\-\/]+$/.test(name)) continue;
    changes.push({name,content});
  }
  if(!changes.length) return [];

  lastChangedFiles=changes.map(x=>x.name);
  tabs();

  // Aplica arquivo por arquivo e mostra no editor.
  for(const change of changes){
    files[change.name]=change.content;
    active=change.name;
    $('#editor').value=change.content;
    tabs();
    lines();
    status('✍️ Aplicando '+change.name+'…');

    // animação curta de aplicação visível sem atrasar demais projetos grandes
    const editor=$('#editor');
    editor.classList.add('ai-writing');
    editor.scrollTop=0;
    await new Promise(r=>setTimeout(r,Math.min(220,60+change.content.length/120)));
    editor.classList.remove('ai-writing');
  }

  save();
  run();
  setTimeout(()=>{
    lastChangedFiles=[];
    tabs();
  },4500);
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

async function send(){
  const p=$('#prompt').value.trim();
  if(!p||busy) return;
  const chat=activeChat();
  const previousHistory=chat.messages.slice(-8).map(m=>({role:m.role,content:m.content}));
  chat.messages.push({role:'user',content:p,display:p});
  if(chat.title==='Novo chat') chat.title=p.replace(/\s+/g,' ').slice(0,38)||'Novo chat';
  chat.updatedAt=Date.now();
  saveChats();
  renderChatList();
  renderMessages();

  $('#prompt').value='';
  busy=true;
  $('#send').disabled=true;
  const waiting=appendMessage('ai','Pensando…');
  try{
    status('🧠 CodeZero pensando…');
    const r=await fetch(API,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({message:p,project:projectContext(),history:previousHistory,memory:projectMemoryText()})
    });
    const raw=await r.text();
    let data=null;
    try{data=JSON.parse(raw)}catch{}
    if(!r.ok){
      const detail=data?.details||data?.error||raw||`HTTP ${r.status}`;
      throw new Error(`CodeZero ${r.status}: ${String(detail).slice(0,500)}`);
    }
    const full=extractText(data,raw);
    if(!full.trim()) throw new Error('O CodeZero respondeu vazio.');
    const generatedImages=await processImageRequests(full);
    const editedImages=await processEditImageRequests(full);
    const changed=await applyFilesVisible(full);
    if(changed.length) $('#editor').focus();
    if(changed.length) rememberProjectChange(p,changed,{projectType:data?.projectType,complexity:data?.complexity});
    const clean=(visibleReply(full)||'Projeto atualizado.')+(changed.length?'\n\n✓ '+changed.join(', '):'')+(generatedImages.length?'\n🖼️ Geradas: '+generatedImages.map(x=>'assets/'+x.name).join(', '):'')+(editedImages.length?'\n🛠️ Editadas: '+editedImages.map(x=>'assets/'+x.name).join(', '):'');
    chat.messages.push({role:'assistant',content:full,display:clean,sources:data?.sources||[]});
    chat.updatedAt=Date.now();
    saveChats();
    waiting.remove();
    renderMessages();
    renderChatList();
    if(data?.validated){
      status('✅ V10 validou '+(data.changedFiles?.length||changed.length)+' arquivo(s) • '+(data.complexity||'normal'));
    }else{
      status(data?.searched?'🌐 CodeZero pesquisou e respondeu':'✅ CodeZero respondeu');
    }
  }catch(e){
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
tabs();
lines();
run();
status('☁️ CodeZero • Railway');