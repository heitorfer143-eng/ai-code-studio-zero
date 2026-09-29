const $=s=>document.querySelector(s);
const DEFAULT={
  'index.html':'<main><h1>Olá 👋</h1><p>Seu projeto aparece aqui.</p></main>',
  'style.css':'body{font-family:system-ui;padding:30px}',
  'script.js':'console.log("Projeto iniciado")'
};
const API='/chat';
const CHAT_KEY='zero.chats.v1';
const ACTIVE_CHAT_KEY='zero.activeChat.v1';

let files=JSON.parse(localStorage.getItem('zero.files')||'null')||DEFAULT;
let active=Object.keys(files)[0];
let busy=false;
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
function tabs(){
  const n=$('#tabs');
  n.textContent='';
  Object.keys(files).forEach(f=>{
    const b=document.createElement('button');
    b.textContent=f;
    b.className=f===active?'active':'';
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
    appendMessage('ai','CodeZero online. Converse, peça alterações de código ou peça para pesquisar algo na web.');
    return;
  }
  for(const m of c.messages){
    appendMessage(m.role==='user'?'user':'ai',m.display||visibleReply(m.content||''),m.sources||[]);
  }
}
function status(t){$('#status').textContent=t}
function projectContext(){
  return Object.entries(files).map(([n,c])=>`ARQUIVO ${n}:\n${c}`).join('\n\n').slice(0,10000);
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
  return String(text||'').replace(/<<<FILE:[^>]+>>>[\s\S]*?(?:<<<END_FILE>>>|$)/g,'').trim();
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
      body:JSON.stringify({message:p,project:projectContext(),history:previousHistory})
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
    const changed=applyFiles(full);
    const clean=(visibleReply(full)||'Código atualizado.')+(changed.length?'\n\n✓ '+changed.join(', '):'');
    chat.messages.push({role:'assistant',content:full,display:clean,sources:data?.sources||[]});
    chat.updatedAt=Date.now();
    saveChats();
    waiting.remove();
    renderMessages();
    renderChatList();
    status(data?.searched?'🌐 CodeZero pesquisou e respondeu':'✅ CodeZero respondeu');
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

function create3DProject(){
  files={
    'index.html':`<main id="app"><div id="hud">CodeZero 3D</div></main>`,
    'style.css':`html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#05070b}canvas{display:block;width:100%;height:100%}#hud{position:fixed;z-index:5;left:12px;top:12px;padding:8px 10px;border-radius:10px;background:#0008;color:white;font:13px system-ui}`,
    'script.js':`import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/controls/OrbitControls.js';

const scene=new THREE.Scene();
scene.background=new THREE.Color(0x10131a);

const camera=new THREE.PerspectiveCamera(60,innerWidth/innerHeight,0.1,1000);
camera.position.set(5,4,7);

const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight);
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff,0x223344,2));
const sun=new THREE.DirectionalLight(0xffffff,3);
sun.position.set(5,8,4);
scene.add(sun);

const ground=new THREE.Mesh(
  new THREE.PlaneGeometry(30,30),
  new THREE.MeshStandardMaterial({color:0x263238,roughness:1})
);
ground.rotation.x=-Math.PI/2;
scene.add(ground);

const cube=new THREE.Mesh(
  new THREE.BoxGeometry(),
  new THREE.MeshStandardMaterial({color:0x4f8cff,roughness:.35,metalness:.15})
);
cube.position.y=.5;
scene.add(cube);

const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true;

addEventListener('resize',()=>{
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
});

renderer.setAnimationLoop(()=>{
  cube.rotation.y+=.01;
  controls.update();
  renderer.render(scene,camera);
});`
  };
  active='script.js';
  save();
  $('#editor').value=files[active];
  tabs();
  lines();
  run();
  status('🧊 Projeto 3D criado');
}

function run(){
  files[active]=$('#editor').value;
  save();
  $('#console').textContent='';
  const bridge=`<script>['log','error','warn'].forEach(k=>{let o=console[k];console[k]=(...a)=>{parent.postMessage({zero:1,k,a},'*');o(...a)}});onerror=e=>parent.postMessage({zero:1,k:'error',a:[e.message]},'*')<\/script>`;
  const js=files['script.js']||'';
  const isModule=/^\s*(import|export)\b/m.test(js);
  const safeJs=js.replaceAll('</script','<\\/script');
  const scriptTag=isModule?`<script type="module">${safeJs}<\/script>`:`<script>${safeJs}<\/script>`;
  const csp=`default-src 'none'; connect-src https://cdn.jsdelivr.net https://unpkg.com https://threejs.org https://raw.githubusercontent.com data: blob:; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; worker-src blob:;`;
  $('#preview').srcdoc=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${files['style.css']||''}</style>${bridge}${files['index.html']||''}${scriptTag}`;
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
if($('#new3D')) $('#new3D').onclick=create3DProject;

$('#editor').value=files[active];
renderChatList();
renderMessages();
tabs();
lines();
run();
status('☁️ CodeZero • Railway');