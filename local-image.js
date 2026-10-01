// CodeZero V15.1 Local AI — R$0,00
// Tiny-SD q4f16 runs entirely in the browser with WebGPU.
// First download is ~707 MB, then files stay cached by the browser.

import ort from '/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs';
import { AutoTokenizer } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

const MODEL_BASE='https://huggingface.co/cursedhelm/aderpy-deepdreamer-onnx/resolve/main/tiny-sd-web-q4f16';
const TOKENIZER_ID='Xenova/clip-vit-base-patch16';
const CACHE_NAME='codezero-tiny-sd-q4f16-v1';
const DOWNLOAD_MB=707;
const VAE_SCALING_FACTOR=0.18215;
const STEPS=12;

const MODELS={
  text_encoder:{url:'text_encoder/model.onnx',sess:null},
  unet:{url:'unet/model.onnx',sess:null},
  vae_decoder:{url:'vae_decoder/model.onnx',sess:null}
};

let tokenizer=null;
let loadPromise=null;
let ready=false;
let unetTimestepType=null;
let textIdType=null;

function emit(cb,message,progress=null){
  if(typeof cb==='function') cb({message,progress});
}

export async function getLocalImageSupport(){
  const webgpu=!!navigator.gpu;
  let adapter=null;
  let fp16=false;
  if(webgpu){
    try{
      adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
      fp16=!!adapter?.features?.has('shader-f16');
    }catch{}
  }
  return {
    supported:webgpu&&!!adapter&&fp16,
    webgpu,
    adapter:!!adapter,
    fp16,
    reason:!webgpu
      ?'WebGPU não está disponível neste navegador.'
      :!adapter
        ?'Nenhuma GPU WebGPU compatível foi encontrada.'
        :!fp16
          ?'Sua GPU/navegador não oferece shader-f16, necessário para o Tiny-SD q4f16.'
          :'',
    downloadMB:DOWNLOAD_MB,
    model:'Tiny-SD q4f16'
  };
}

async function fetchAndCache(url,onProgress){
  const cache=await caches.open(CACHE_NAME);
  const cached=await cache.match(url);
  if(cached) return await cached.arrayBuffer();

  const network=await fetch(url,{mode:'cors'});
  if(!network.ok) throw new Error('Falha ao baixar '+url.split('/').slice(-2).join('/')+' ('+network.status+')');

  const total=Number(network.headers.get('content-length')||0);
  if(!network.body||!total){
    await cache.put(url,network.clone());
    return await network.arrayBuffer();
  }

  const reader=network.body.getReader();
  const chunks=[];
  let received=0;
  while(true){
    const {done,value}=await reader.read();
    if(done) break;
    chunks.push(value);
    received+=value.byteLength;
    onProgress?.(received,total);
  }
  const blob=new Blob(chunks);
  const stored=new Response(blob,{headers:{'Content-Type':'application/octet-stream'}});
  await cache.put(url,stored.clone());
  return await stored.arrayBuffer();
}

async function createSession(model,name,onStatus,index,total){
  const url=MODEL_BASE+'/'+model.url;
  emit(onStatus,'Preparando '+name+'…',Math.round(index/total*88));
  const bytes=await fetchAndCache(url,(received,size)=>{
    const local=received/size;
    emit(onStatus,'Baixando '+name+' '+Math.round(local*100)+'%…',Math.round(((index+local)/total)*88));
  });

  model.sess=await ort.InferenceSession.create(bytes,{
    executionProviders:['webgpu'],
    enableMemPattern:false,
    enableCpuMemArena:false,
    extra:{session:{
      disable_prepacking:'1',
      use_device_allocator_for_initializers:'1',
      use_ort_model_bytes_directly:'1',
      use_ort_model_bytes_for_initializers:'1'
    }}
  });
  emit(onStatus,name+' pronto.',Math.round((index+1)/total*88));
}

export async function loadLocalImageModel(onStatus){
  if(ready) return true;
  if(loadPromise) return loadPromise;

  loadPromise=(async()=>{
    const support=await getLocalImageSupport();
    if(!support.supported) throw new Error(support.reason);

    ort.env.wasm.wasmPaths='/node_modules/onnxruntime-web/dist/';
    ort.env.wasm.numThreads=1;
    ort.env.wasm.simd=true;

    emit(onStatus,'Carregando tokenizer…',1);
    if(!tokenizer){
      tokenizer=await AutoTokenizer.from_pretrained(TOKENIZER_ID);
      tokenizer.pad_token_id=0;
    }

    const entries=Object.entries(MODELS);
    for(let i=0;i<entries.length;i++){
      const [name,model]=entries[i];
      if(!model.sess) await createSession(model,name,onStatus,i,entries.length);
    }

    ready=true;
    emit(onStatus,'Tiny-SD local pronto — R$0,00.',90);
    return true;
  })();

  try{return await loadPromise;}
  catch(e){loadPromise=null;throw e;}
}

function randnLatents(shape){
  let size=1;
  for(const n of shape) size*=n;
  const data=new Float32Array(size);
  for(let i=0;i<size;i++){
    let u=Math.random(),v=Math.random();
    if(u<1e-7) u=1e-7;
    data[i]=Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  }
  return data;
}

function buildAlphas(){
  const out=new Float64Array(1000);
  let prod=1;
  const a=Math.sqrt(0.00085);
  const b=Math.sqrt(0.012);
  for(let i=0;i<1000;i++){
    const x=a+(b-a)*(i/999);
    prod*=1-x*x;
    out[i]=prod;
  }
  return out;
}
const ALPHAS=buildAlphas();

function makeTimesteps(steps=STEPS){
  const arr=[];
  for(let i=0;i<steps;i++) arr.push(Math.round(999-i*(999/(steps-1))));
  return arr;
}

function ddimStep(eps,sample,t,prevT){
  const alphaT=ALPHAS[Math.max(0,t)];
  const alphaPrev=prevT>=0?ALPHAS[prevT]:1;
  const sqrtAlphaT=Math.sqrt(alphaT);
  const sqrtOneMinusT=Math.sqrt(Math.max(0,1-alphaT));
  const sqrtAlphaPrev=Math.sqrt(alphaPrev);
  const sqrtOneMinusPrev=Math.sqrt(Math.max(0,1-alphaPrev));

  const src=sample.data,noise=eps.data,out=new Float32Array(src.length);
  for(let i=0;i<src.length;i++){
    const predOriginal=(src[i]-sqrtOneMinusT*noise[i])/sqrtAlphaT;
    out[i]=sqrtAlphaPrev*predOriginal+sqrtOneMinusPrev*noise[i];
  }
  return new ort.Tensor('float32',out,sample.dims);
}

async function encodePrompt(prompt){
  const encoded=await tokenizer(String(prompt),{
    padding:'max_length',
    max_length:77,
    truncation:true,
    return_tensor:false
  });
  const input=encoded.input_ids;
  const flat=Array.isArray(input[0])?input[0]:input;

  async function run(type){
    if(type==='int64'){
      const ids=new BigInt64Array(flat.map(x=>BigInt(x)));
      return await MODELS.text_encoder.sess.run({input_ids:new ort.Tensor('int64',ids,[1,flat.length])});
    }
    const ids=new Int32Array(flat);
    return await MODELS.text_encoder.sess.run({input_ids:new ort.Tensor('int32',ids,[1,flat.length])});
  }

  if(textIdType) return await run(textIdType);
  try{
    const out=await run('int32');textIdType='int32';return out;
  }catch{
    const out=await run('int64');textIdType='int64';return out;
  }
}

async function runUnet(sample,t,hidden){
  async function run(type){
    const timestep=type==='float32'
      ?new ort.Tensor('float32',new Float32Array([t]),[1])
      :new ort.Tensor('int64',new BigInt64Array([BigInt(t)]),[1]);
    return await MODELS.unet.sess.run({
      sample,
      timestep,
      encoder_hidden_states:hidden
    });
  }
  if(unetTimestepType) return await run(unetTimestepType);
  try{
    const out=await run('float32');unetTimestepType='float32';return out;
  }catch{
    const out=await run('int64');unetTimestepType='int64';return out;
  }
}

function tensorToPngDataUrl(tensor){
  const dims=tensor.dims;
  const height=Number(dims[dims.length-2]||512);
  const width=Number(dims[dims.length-1]||512);
  const plane=width*height;
  const src=tensor.data;
  const rgba=new Uint8ClampedArray(plane*4);
  for(let i=0;i<plane;i++){
    const r=Math.max(0,Math.min(1,src[i]/2+0.5));
    const g=Math.max(0,Math.min(1,src[plane+i]/2+0.5));
    const b=Math.max(0,Math.min(1,src[plane*2+i]/2+0.5));
    const p=i*4;
    rgba[p]=Math.round(r*255);
    rgba[p+1]=Math.round(g*255);
    rgba[p+2]=Math.round(b*255);
    rgba[p+3]=255;
  }
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  canvas.getContext('2d').putImageData(new ImageData(rgba,width,height),0,0);
  return canvas.toDataURL('image/png');
}

export async function generateLocalImage(prompt,{onStatus}={}){
  if(!String(prompt||'').trim()) throw new Error('Prompt vazio.');
  await loadLocalImageModel(onStatus);

  emit(onStatus,'Interpretando prompt…',91);
  const textOut=await encodePrompt(prompt);
  const hidden=textOut.last_hidden_state||Object.values(textOut)[0];

  const latentShape=[1,4,64,64];
  let latents=new ort.Tensor('float32',randnLatents(latentShape),latentShape);
  const timesteps=makeTimesteps(STEPS);

  for(let i=0;i<timesteps.length;i++){
    const t=timesteps[i];
    const prev=i+1<timesteps.length?timesteps[i+1]:-1;
    emit(onStatus,'Gerando imagem '+(i+1)+'/'+timesteps.length+'…',92+Math.round((i/timesteps.length)*6));
    const out=await runUnet(latents,t,hidden);
    const eps=out.out_sample||Object.values(out)[0];
    const next=ddimStep(eps,latents,t,prev);
    try{latents.dispose?.();}catch{}
    try{eps.dispose?.();}catch{}
    latents=next;
  }

  emit(onStatus,'Decodificando…',99);
  const scaled=new Float32Array(latents.data.length);
  for(let i=0;i<scaled.length;i++) scaled[i]=latents.data[i]/VAE_SCALING_FACTOR;
  const latentForVae=new ort.Tensor('float32',scaled,latents.dims);
  const decoded=await MODELS.vae_decoder.sess.run({latent_sample:latentForVae});
  const imageTensor=decoded.sample||Object.values(decoded)[0];
  const dataUrl=tensorToPngDataUrl(imageTensor);

  try{hidden.dispose?.();}catch{}
  try{latents.dispose?.();}catch{}
  try{latentForVae.dispose?.();}catch{}
  try{imageTensor.dispose?.();}catch{}

  emit(onStatus,'Imagem pronta — R$0,00.',100);
  return {dataUrl,width:512,height:512,model:'Tiny-SD q4f16 WebGPU Local'};
}

export async function clearLocalImageCache(){
  await caches.delete(CACHE_NAME);
  ready=false;loadPromise=null;unetTimestepType=null;textIdType=null;
  for(const model of Object.values(MODELS)){
    try{model.sess?.release?.();}catch{}
    model.sess=null;
  }
  return true;
}
