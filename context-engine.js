// CodeZero V15.8 — contexto inteligente local e gratuito.
// Índice incremental, recuperação de arquivos relevantes e compactação de conversas.
// Não usa API externa: tudo roda no navegador.

const STOP_WORDS=new Set([
  'a','o','as','os','um','uma','de','da','do','das','dos','e','ou','em','no','na','nos','nas','para','por','com','sem',
  'que','se','eu','voce','você','me','meu','minha','isso','isto','esse','essa','como','mais','menos','muito','muita',
  'the','a','an','and','or','of','to','in','on','for','with','without','this','that','it','is','are','be','my','me'
]);

const indexCache=new Map();

function text(value){return String(value==null?'':value);}
function uniq(values,limit=80){
  const out=[],seen=new Set();
  for(const raw of values){
    const value=text(raw).trim();
    if(!value||seen.has(value)) continue;
    seen.add(value);out.push(value);
    if(out.length>=limit) break;
  }
  return out;
}
function normalizeToken(value){
  return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
}
function tokensFrom(value,limit=40){
  return uniq(
    normalizeToken(value)
      .replace(/[^a-z0-9_./-]+/g,' ')
      .split(/\s+/)
      .map(x=>x.trim())
      .filter(x=>x.length>=2&&!STOP_WORDS.has(x)),
    limit
  );
}
function extension(name){
  const m=/\.([^.\/]+)$/.exec(text(name).toLowerCase());
  return m?m[1]:'';
}
function languageFromPath(name){
  const ext=extension(name);
  const map={
    js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'javascript',
    ts:'typescript',tsx:'typescript',
    py:'python',
    gd:'gdscript',godot:'godot-config',tscn:'godot-scene',tres:'godot-resource',gdshader:'godot-shader',
    html:'html',htm:'html',css:'css',scss:'scss',
    json:'json',jsonc:'json',md:'markdown',markdown:'markdown',
    java:'java',cs:'csharp',c:'c',cc:'cpp',cpp:'cpp',h:'cpp',hpp:'cpp',
    go:'go',rs:'rust',php:'php',rb:'ruby',sh:'shell',sql:'sql',
    yml:'yaml',yaml:'yaml',xml:'xml',toml:'toml'
  };
  return map[ext]||ext||'text';
}
function hashText(value){
  const s=text(value);
  let h=2166136261;
  for(let i=0;i<s.length;i++){
    h^=s.charCodeAt(i);
    h=Math.imul(h,16777619);
  }
  return (h>>>0).toString(36)+':'+s.length;
}
function takeMatches(content,re,group=1,limit=60){
  const out=[];
  let m;
  while((m=re.exec(content))&&out.length<limit){
    const value=text(m[group]).trim();
    if(value) out.push(value);
  }
  return out;
}
function extractFileIndex(name,content){
  const source=text(content);
  const lang=languageFromPath(name);
  const symbols=[],imports=[],refs=[],sections=[];

  if(['javascript','typescript'].includes(lang)){
    symbols.push(...takeMatches(source,/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g));
    symbols.push(...takeMatches(source,/(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g));
    symbols.push(...takeMatches(source,/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g));
    imports.push(...takeMatches(source,/\b(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g));
    imports.push(...takeMatches(source,/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g));
  }else if(lang==='python'){
    symbols.push(...takeMatches(source,/(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/g));
    symbols.push(...takeMatches(source,/(?:^|\n)\s*class\s+([A-Za-z_]\w*)\b/g));
    imports.push(...takeMatches(source,/(?:^|\n)\s*(?:from|import)\s+([A-Za-z0-9_\.]+)/g));
  }else if(lang==='gdscript'){
    symbols.push(...takeMatches(source,/(?:^|\n)\s*func\s+([A-Za-z_]\w*)\s*\(/g));
    symbols.push(...takeMatches(source,/(?:^|\n)\s*class_name\s+([A-Za-z_]\w*)\b/g));
    symbols.push(...takeMatches(source,/(?:^|\n)\s*signal\s+([A-Za-z_]\w*)\b/g));
    symbols.push(...takeMatches(source,/(?:^|\n)\s*(?:@\w+(?:\([^\n]*\))?\s*)*(?:var|const)\s+([A-Za-z_]\w*)\b/g));
    imports.push(...takeMatches(source,/\b(?:preload|load)\s*\(\s*["']res:\/\/([^"']+)["']\s*\)/g));
  }else if(lang==='godot-scene'){
    symbols.push(...takeMatches(source,/\[node\s+name="([^"]+)"/g));
    imports.push(...takeMatches(source,/\bpath="res:\/\/([^"]+)"/g));
  }else if(lang==='html'){
    symbols.push(...takeMatches(source,/\bid=["']([^"']+)["']/g));
    imports.push(...takeMatches(source,/(?:src|href)=["']([^"']+)["']/g));
  }else if(lang==='css'||lang==='scss'){
    symbols.push(...takeMatches(source,/(?:^|\n)\s*([.#][A-Za-z_-][\w-]*)\s*[,\{]/g));
  }

  sections.push(...takeMatches(source,/(?:^|\n)\s*\[([^\]\n]+)\]\s*$/g));
  refs.push(...takeMatches(source,/res:\/\/([^"'\)\s]+)/g));
  refs.push(...imports.filter(x=>/^(?:\.\.?\/|res:\/\/)/.test(x)));

  return {
    name,
    language:lang,
    bytes:source.length,
    lines:source?source.split('\n').length:0,
    symbols:uniq(symbols,50),
    imports:uniq(imports,40),
    refs:uniq(refs,50),
    sections:uniq(sections,30),
    hash:hashText(source)
  };
}

export function buildProjectIndex(files,{isSensitive=()=>false}={}){
  const source=files&&typeof files==='object'?files:{};
  const items=[];
  const alive=new Set();

  for(const [rawName,rawContent] of Object.entries(source)){
    const name=text(rawName).replace(/\\/g,'/').replace(/^\.\//,'');
    if(!name||isSensitive(name)) continue;
    const content=text(rawContent);
    const hash=hashText(content);
    const key=name+'|'+hash;
    alive.add(key);
    let item=indexCache.get(key);
    if(!item){
      item=extractFileIndex(name,content);
      indexCache.set(key,item);
    }
    items.push(item);
  }

  if(indexCache.size>1200){
    for(const key of [...indexCache.keys()]){
      if(!alive.has(key)) indexCache.delete(key);
      if(indexCache.size<=800) break;
    }
  }

  const totalBytes=items.reduce((n,x)=>n+x.bytes,0);
  const languages={};
  for(const item of items) languages[item.language]=(languages[item.language]||0)+1;

  return {
    version:1,
    generatedAt:Date.now(),
    files:items.sort((a,b)=>a.name.localeCompare(b.name)),
    totalFiles:items.length,
    totalBytes,
    languages
  };
}

function querySignals(query){
  const raw=text(query);
  const tokens=tokensFrom(raw,48);
  const paths=uniq(
    [...raw.matchAll(/[A-Za-z0-9_@+(). -]+\.(?:godot|gd|tscn|tres|gdshader|js|mjs|cjs|jsx|ts|tsx|py|html|css|scss|json|md|java|cs|cpp|c|h|hpp|go|rs|php|rb|sh|sql|yml|yaml|xml|toml)/gi)]
      .map(m=>m[0].trim().replace(/\\/g,'/')),
    20
  );
  return {raw:normalizeToken(raw),tokens,paths};
}
function countOccurrences(haystack,needle,max=6){
  if(!needle||needle.length<2) return 0;
  let count=0,pos=0;
  while(count<max&&(pos=haystack.indexOf(needle,pos))>=0){
    count++;pos+=needle.length;
  }
  return count;
}
function resolveRelative(from,target){
  target=text(target).trim().replace(/^res:\/\//,'');
  if(!target) return '';
  if(!/^\.\.?\//.test(target)) return target;
  const base=text(from).split('/').slice(0,-1);
  for(const part of target.split('/')){
    if(part==='.'||!part) continue;
    if(part==='..') base.pop();
    else base.push(part);
  }
  return base.join('/');
}
function rankFiles(query,files,index,activeFile=''){
  const signals=querySignals(query);
  const byName=new Map(index.files.map(x=>[x.name,x]));
  const ranked=[];

  for(const item of index.files){
    const content=normalizeToken(files[item.name]||'');
    const nameNorm=normalizeToken(item.name);
    const baseNorm=normalizeToken(item.name.split('/').pop()||item.name);
    let score=0;

    if(item.name===activeFile) score+=3;
    if(['project.godot','package.json','pyproject.toml','cargo.toml','go.mod'].includes(item.name.toLowerCase())) score+=1.5;

    for(const p of signals.paths){
      const pn=normalizeToken(p);
      if(nameNorm===pn||nameNorm.endsWith('/'+pn)) score+=45;
      else if(baseNorm===pn) score+=38;
    }

    for(const token of signals.tokens){
      if(nameNorm.includes(token)) score+=12;
      if(baseNorm.includes(token)) score+=8;
      for(const sym of item.symbols){
        const sn=normalizeToken(sym);
        if(sn===token) score+=10;
        else if(sn.includes(token)||token.includes(sn)) score+=4;
      }
      if(item.language===token) score+=3;
      score+=Math.min(4,countOccurrences(content,token,4))*1.2;
    }

    if(/\b(cena|scene|node|godot)\b/.test(signals.raw)&&item.language==='godot-scene') score+=4;
    if(/\b(script|codigo|código|funcao|função|bug|erro)\b/.test(signals.raw)&&['gdscript','javascript','typescript','python','java','csharp','cpp','go','rust'].includes(item.language)) score+=2;
    if(/\b(estilo|css|layout|interface|frontend|visual)\b/.test(signals.raw)&&['css','scss','html','javascript','typescript'].includes(item.language)) score+=3;

    ranked.push({name:item.name,score,item});
  }

  ranked.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));

  // Expande dependências dos melhores resultados para manter contexto estrutural.
  const boost=new Map();
  for(const top of ranked.slice(0,5)){
    if(top.score<=0) continue;
    for(const ref of [...top.item.refs,...top.item.imports]){
      const resolved=resolveRelative(top.name,ref);
      if(byName.has(resolved)) boost.set(resolved,(boost.get(resolved)||0)+Math.max(3,top.score*0.18));
      const direct=[...byName.keys()].find(name=>name.endsWith('/'+resolved)||name===resolved);
      if(direct) boost.set(direct,(boost.get(direct)||0)+Math.max(2,top.score*0.12));
    }
  }
  for(const row of ranked) row.score+=(boost.get(row.name)||0);
  ranked.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  return ranked;
}
function excerptContent(content,queryTokens,maxChars){
  const source=text(content);
  if(source.length<=maxChars) return source;
  const intervals=[];
  const add=(start,end)=>{
    start=Math.max(0,start);end=Math.min(source.length,end);
    if(end<=start) return;
    for(const i of intervals){
      if(start<=i[1]+120&&end>=i[0]-120){
        i[0]=Math.min(i[0],start);i[1]=Math.max(i[1],end);return;
      }
    }
    intervals.push([start,end]);
  };

  add(0,Math.min(1400,maxChars));
  for(const token of queryTokens.slice(0,10)){
    let pos=normalizeToken(source).indexOf(token);
    if(pos>=0) add(pos-650,pos+1150);
    if(intervals.reduce((n,x)=>n+x[1]-x[0],0)>=maxChars*0.75) break;
  }
  add(source.length-700,source.length);
  intervals.sort((a,b)=>a[0]-b[0]);

  let out='';
  for(const [start,end] of intervals){
    const chunk=source.slice(start,end);
    const next=(out?'\n\n... trecho omitido ...\n\n':'')+chunk;
    if(out.length+next.length>maxChars){
      out+=next.slice(0,Math.max(0,maxChars-out.length));
      break;
    }
    out+=next;
  }
  return out.slice(0,maxChars);
}

export function serializeProjectIndex(index,maxChars=12000,priorityNames=[]){
  const priority=new Set(Array.isArray(priorityNames)?priorityNames:[]);
  const all=[...(index?.files||[])].sort((a,b)=>{
    const pa=priority.has(a.name)?0:1;
    const pb=priority.has(b.name)?0:1;
    return pa-pb||a.name.localeCompare(b.name);
  });
  const out={
    totalFiles:index?.totalFiles||0,
    totalBytes:index?.totalBytes||0,
    languages:index?.languages||{},
    indexedFiles:0,
    omittedFiles:0,
    files:[]
  };
  for(const x of all){
    const detailed=priority.has(x.name);
    const item={
      name:x.name,
      language:x.language,
      lines:x.lines,
      bytes:x.bytes,
      ...(detailed?{
        symbols:(x.symbols||[]).slice(0,18),
        imports:(x.imports||[]).slice(0,12),
        refs:(x.refs||[]).slice(0,12)
      }:{})
    };
    out.files.push(item);
    out.indexedFiles=out.files.length;
    out.omittedFiles=Math.max(0,(index?.totalFiles||0)-out.indexedFiles);
    if(JSON.stringify(out).length>maxChars){
      out.files.pop();
      out.indexedFiles=out.files.length;
      out.omittedFiles=Math.max(0,(index?.totalFiles||0)-out.indexedFiles);
      break;
    }
  }
  return JSON.stringify(out);
}

export function buildSmartProjectContext({
  query='',
  files={},
  assets={},
  activeFile='',
  maxFiles=9,
  maxChars=30000,
  isSensitive=()=>false,
  redact=value=>text(value)
}={}){
  const safeFiles={};
  let hidden=0;
  for(const [name,value] of Object.entries(files||{})){
    if(isSensitive(name)){hidden++;continue;}
    safeFiles[name]=redact(value);
  }

  const index=buildProjectIndex(safeFiles,{isSensitive});
  const ranked=rankFiles(query,safeFiles,index,activeFile);
  let selected=ranked.filter(x=>x.score>0).slice(0,maxFiles).map(x=>x.name);

  if(!selected.length){
    selected=index.files
      .slice()
      .sort((a,b)=>(a.name===activeFile?-1:b.name===activeFile?1:a.bytes-b.bytes))
      .slice(0,Math.min(maxFiles,5))
      .map(x=>x.name);
  }else if(activeFile&&safeFiles[activeFile]!=null&&!selected.includes(activeFile)&&selected.length<maxFiles){
    selected.push(activeFile);
  }

  const signals=querySignals(query);
  const parts=[];
  let used=0;
  const perFile=Math.max(2200,Math.floor(maxChars/Math.max(1,selected.length)));

  for(const name of selected){
    const remaining=maxChars-used;
    if(remaining<300) break;
    const content=excerptContent(safeFiles[name],signals.tokens,Math.min(perFile,remaining-80));
    const block='ARQUIVO '+name+':\n'+content;
    if(block.length>remaining){
      parts.push(block.slice(0,remaining));
      used=maxChars;
      break;
    }
    parts.push(block);
    used+=block.length+2;
  }

  const assetNames=Object.keys(assets||{}).slice(0,120);
  if(assetNames.length&&used<maxChars-300){
    const assetsText='ASSETS DISPONÍVEIS:\n'+assetNames.map(n=>'assets/'+n).join('\n');
    parts.push(assetsText.slice(0,maxChars-used));
  }
  if(hidden&&used<maxChars-120){
    parts.push('[SEGURANÇA: '+hidden+' arquivo(s) sensível(is) omitido(s) do contexto da IA.]');
  }

  return {
    text:parts.join('\n\n').slice(0,maxChars),
    index,
    indexText:serializeProjectIndex(index,12000,selected),
    selected,
    stats:{
      selectedFiles:selected.length,
      totalFiles:index.totalFiles,
      selectedChars:Math.min(maxChars,parts.join('\n\n').length),
      indexedBytes:index.totalBytes,
      hiddenSensitive: hidden
    }
  };
}

function cleanConversationText(value,max=320){
  let s=text(value)
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g,'[ASSET_LOCAL]')
    .replace(/<<<FILE:[^>]+>>>[\s\S]*?<<<END_FILE>>>/g,m=>{
      const n=/<<<FILE:([^>]+)>>>/.exec(m)?.[1]||'arquivo';
      return '[alteração de arquivo: '+n+']';
    })
    .replace(/\s+/g,' ')
    .trim();
  if(s.length<=max) return s;
  const head=s.slice(0,Math.floor(max*0.72));
  const tail=s.slice(-Math.floor(max*0.23));
  return head+' … '+tail;
}
function conversationImportance(message){
  const s=normalizeToken(message?.content||message?.display||'');
  let score=0;
  if(/\b(decid|implement|corrig|bug|erro|falh|funcion|versao|versão|arquitet|arquivo|modelo|deploy|railway|github|segur|context|memoria|memória)\b/.test(s)) score+=4;
  if(/\b(nao|não|nunca|sempre|precisa|deve|quero|vamos|prioridade)\b/.test(s)) score+=2;
  if(/[A-Za-z0-9_.\/-]+\.(?:js|ts|gd|tscn|godot|json|html|css|py)\b/i.test(s)) score+=3;
  if(message?.role==='user') score+=1;
  return score;
}

export function summarizeOlderConversation(messages,{keepRecent=24,maxChars=6000}={}){
  const src=Array.isArray(messages)?messages:[];
  if(src.length<=keepRecent) return '';
  const older=src.slice(0,Math.max(0,src.length-keepRecent));
  if(!older.length) return '';

  const candidates=older.map((m,i)=>({
    i,
    role:m?.role==='assistant'?'IA':'Usuário',
    text:cleanConversationText(m?.content||m?.display||'',360),
    score:conversationImportance(m)
  })).filter(x=>x.text);

  const chosen=new Map();
  for(const x of candidates.slice(0,2)) chosen.set(x.i,x);
  for(const x of candidates.slice(-12)) chosen.set(x.i,x);
  for(const x of candidates.filter(x=>x.score>=4)) chosen.set(x.i,x);

  const ordered=[...chosen.values()].sort((a,b)=>a.i-b.i);
  const lines=[];
  let used=0;
  for(const x of ordered){
    const line='- '+x.role+': '+x.text;
    if(used+line.length+1>maxChars) continue;
    lines.push(line);used+=line.length+1;
  }
  if(!lines.length) return '';
  return ('RESUMO AUTOMÁTICO DE MENSAGENS ANTIGAS:\n'+lines.join('\n')).slice(0,maxChars);
}

export function buildRecentConversationContext(messages,{maxMessages=24,maxChars=14000,redact=value=>text(value)}={}){
  const src=Array.isArray(messages)?messages:[];
  const out=[];
  let used=0;
  for(let i=src.length-1;i>=0&&out.length<maxMessages;i--){
    const m=src[i];
    if(!m||!['user','assistant'].includes(m.role)) continue;
    let content=redact(m.content||m.display||'');
    content=text(content).replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g,'[ASSET_LOCAL]').trim();
    if(!content) continue;
    const remaining=maxChars-used;
    if(remaining<=0) break;
    if(content.length>remaining){
      if(out.length) break;
      content=content.slice(-remaining);
    }
    out.unshift({role:m.role,content});
    used+=content.length;
  }
  return out;
}
