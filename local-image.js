// CodeZero V15 Local AI — R$0,00
// Stable Diffusion Turbo runs entirely in the browser with WebGPU.
// Pipeline adapted from Microsoft's MIT-licensed ONNX Runtime Web SD-Turbo example.

import ort from '/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs';
import { AutoTokenizer } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

const MODEL_BASE='https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/main';
const TOKENIZER_ID='Xenova/clip-vit-base-patch16';
const CACHE_NAME='codezero-local-ai-v1';
const SIGMA=14.6146;
const GAMMA=0;
const VAE_SCALING_FACTOR=0.18215;

const MODELS={
  unet:{
    url:'unet/model.onnx',
    sizeMB:640,
    opt:{freeDimensionOverrides:{batch_size:1,num_channels:4,height:64,width:64,sequence_length:77}}
  },
  text_encoder:{
    url:'text_encoder/model.onnx',
    sizeMB:1700,
    opt:{freeDimensionOverrides:{batch_size:1}}
  },
  vae_decoder:{
    url:'vae_decoder/model.onnx',
    sizeMB:95,
    opt:{freeDimensionOverrides:{batch_size:1,num_channels_latent:4,height_latent:64,width_latent:64}}
  }
};

let tokenizer=null;
let loadPromise=null;
let ready=false;

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
    reason:!webgpu?'WebGPU não está disponível neste navegador.':!adapter?'Nenhuma GPU WebGPU compatível foi encontrada.':!fp16?'Sua GPU/navegador não oferece shader-f16, necessário para este modelo local.':'',
    downloadMB:Object.values(MODELS).reduce((a,m)=>a+m.sizeMB,0)
  };
}

async function fetchAndCache(url,onProgress){
  const cache=await caches.open(CACHE_NAME);
  let response=await cache.match(url);
  if(response) return await response.arrayBuffer();

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
    if(onProgress) onProgress(received,total);
  }
  const blob=new Blob(chunks);
  const stored=new Response(blob,{headers:{'Content-Type':'application/octet-stream'}});
  await cache.put(url,stored.clone());
  return await stored.arrayBuffer();
}

async function createSession(model,name,onStatus,index,total){
  const url=MODEL_BASE+'/'+model.url;
  emit(onStatus,'Preparando '+name+'…',Math.round((index/total)*100));
  const bytes=await fetchAndCache(url,(received,size)=>{
    const local=received/size;
    emit(onStatus,'Baixando '+name+' '+Math.round(local*100)+'%…',Math.round(((index+local)/total)*100));
  });

  const options={
    executionProviders:['webgpu'],
    enableMemPattern:false,
    enableCpuMemArena:false,
    preferredOutputLocation:name==='text_encoder'?{last_hidden_state:'gpu-buffer'}:undefined,
    extra:{session:{
      disable_prepacking:'1',
      use_device_allocator_for_initializers:'1',
      use_ort_model_bytes_directly:'1',
      use_ort_model_bytes_for_initializers:'1'
    }},
    ...model.opt
  };

  model.sess=await ort.InferenceSession.create(bytes,options);
  emit(onStatus,name+' pronto.',Math.round(((index+1)/total)*100));
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

    emit(onStatus,'Carregando tokenizer local…',1);
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
    emit(onStatus,'Modelo local pronto. R$0,00.',100);
    return true;
  })();

  try{return await loadPromise;}
  catch(e){loadPromise=null;throw e;}
}

function randnLatents(shape,noiseSigma){
  let size=1;
  for(const n of shape) size*=n;
  const data=new Float32Array(size);
  for(let i=0;i<size;i++){
    let u=Math.random(),v=Math.random();
    if(u<1e-7) u=1e-7;
    data[i]=Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)*noiseSigma;
  }
  return data;
}

function scaleModelInputs(t){
  const div=Math.sqrt(SIGMA**2+1);
  const out=new Float32Array(t.data.length);
  for(let i=0;i<out.length;i++) out[i]=t.data[i]/div;
  return new ort.Tensor('float32',out,t.dims);
}

function schedulerStep(modelOutput,sample){
  const out=new Float32Array(modelOutput.data.length);
  const sigmaHat=SIGMA*(GAMMA+1);
  for(let i=0;i<out.length;i++){
    const pred=sample.data[i]-sigmaHat*modelOutput.data[i];
    const derivative=(sample.data[i]-pred)/sigmaHat;
    const dt=-sigmaHat;
    out[i]=(sample.data[i]+derivative*dt)/VAE_SCALING_FACTOR;
  }
  return new ort.Tensor('float32',out,modelOutput.dims);
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
  canvas.width=width;
  canvas.height=height;
  canvas.getContext('2d').putImageData(new ImageData(rgba,width,height),0,0);
  return canvas.toDataURL('image/png');
}

export async function generateLocalImage(prompt,{onStatus}={}){
  if(!String(prompt||'').trim()) throw new Error('Prompt vazio.');
  await loadLocalImageModel(onStatus);

  emit(onStatus,'Interpretando prompt…',93);
  const encoded=await tokenizer(String(prompt),{
    padding:true,
    max_length:77,
    truncation:true,
    return_tensor:false
  });
  const inputIds=encoded.input_ids;
  const ids=new Int32Array(inputIds);

  const textOut=await MODELS.text_encoder.sess.run({
    input_ids:new ort.Tensor('int32',ids,[1,ids.length])
  });
  const hidden=textOut.last_hidden_state;

  emit(onStatus,'Gerando pixels localmente…',96);
  const latentShape=[1,4,64,64];
  const latent=new ort.Tensor('float32',randnLatents(latentShape,SIGMA),latentShape);
  const modelInput=scaleModelInputs(latent);

  const unetOut=await MODELS.unet.sess.run({
    sample:modelInput,
    timestep:new ort.Tensor('int64',new BigInt64Array([999n]),[1]),
    encoder_hidden_states:hidden
  });

  const newLatents=schedulerStep(unetOut.out_sample,latent);
  const decoded=await MODELS.vae_decoder.sess.run({latent_sample:newLatents});
  const dataUrl=tensorToPngDataUrl(decoded.sample);

  try{hidden.dispose?.();}catch{}
  try{modelInput.dispose?.();}catch{}
  try{unetOut.out_sample.dispose?.();}catch{}
  try{newLatents.dispose?.();}catch{}
  try{decoded.sample.dispose?.();}catch{}

  emit(onStatus,'Imagem pronta — R$0,00.',100);
  return {dataUrl,width:512,height:512,model:'SD-Turbo WebGPU Local'};
}

export async function clearLocalImageCache(){
  await caches.delete(CACHE_NAME);
  ready=false;
  loadPromise=null;
  for(const model of Object.values(MODELS)){
    try{model.sess?.release?.();}catch{}
    model.sess=null;
  }
  return true;
}
