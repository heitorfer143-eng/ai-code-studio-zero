const http = require('http');
const PORT = process.env.PORT || 3000;
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Content-Type':'application/json; charset=utf-8'};
const send=(res,status,obj)=>{res.writeHead(status,cors);res.end(JSON.stringify(obj))};
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,cors);return res.end()}
  if(req.url==='/'||req.url==='/health') return send(res,200,{status:'online',service:'CodeZero Railway API',ai:process.env.AI_API_KEY?'configured':'awaiting-provider'});
  if(req.url!=='/chat'||req.method!=='POST') return send(res,404,{error:'Use POST /chat'});
  try{
    let raw=''; for await(const c of req){raw+=c;if(raw.length>2e6)throw new Error('Payload muito grande')}
    const body=JSON.parse(raw||'{}'); const message=String(body.message||'').trim();
    if(!message)return send(res,400,{error:'Mensagem vazia'});
    if(!process.env.AI_API_KEY||!process.env.AI_BASE_URL||!process.env.AI_MODEL)return send(res,503,{error:'Backend Railway online; provedor de IA ainda não configurado.'});
    const messages=[{role:'system',content:'Você é a IA do CodeZero, especialista em programação. Responda em português do Brasil. Quando alterar arquivos, use exatamente <<<FILE:nome>>> conteúdo <<<END_FILE>>>. Forneça código funcional e completo.'},...(Array.isArray(body.history)?body.history.slice(-6):[]),{role:'user',content:`${message}\n\nProjeto atual:\n${String(body.project||'').slice(0,12000)}`}];
    const r=await fetch(process.env.AI_BASE_URL.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+process.env.AI_API_KEY},body:JSON.stringify({model:process.env.AI_MODEL,messages,temperature:.2})});
    const text=await r.text(); let data; try{data=JSON.parse(text)}catch{data=null}
    if(!r.ok) return send(res,r.status,{error:'Erro do provedor de IA',details:data?.error?.message||text.slice(0,500)});
    const response=data?.choices?.[0]?.message?.content||data?.response||data?.output_text||'';
    if(!response)return send(res,502,{error:'Provedor respondeu sem texto',details:data});
    return send(res,200,{response});
  }catch(e){return send(res,500,{error:'Erro no backend',details:String(e?.message||e)})}
});
server.listen(PORT,'0.0.0.0',()=>console.log(`CodeZero API online :${PORT}`));
