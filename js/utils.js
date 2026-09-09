'use strict';
const debounce=(fn,d)=>{d=d||300;let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),d);};};
const throttle=(fn,l)=>{l=l||100;let last=0;return(...a)=>{const n=Date.now();if(n-last>=l){last=n;return fn(...a);}};};
const uid=()=>Math.random().toString(36).slice(2)+Date.now().toString(36);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clamp=(v,mn,mx)=>Math.max(mn,Math.min(mx,v));
const truncate=(s,n,e)=>{e=e||'...';return s&&s.length>n?s.slice(0,n-e.length)+e:s||'';};
function formatDate(ts){
  if(!ts)return '';
  return new Date(ts).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
}
function formatRelTime(ts){
  if(!ts)return '';
  const d=Date.now()-ts,m=60000,h=3600000,dy=86400000;
  if(d<m)return 'Just now';
  if(d<h)return Math.floor(d/m)+'m ago';
  if(d<dy)return Math.floor(d/h)+'h ago';
  if(d<dy*7)return Math.floor(d/dy)+'d ago';
  return formatDate(ts);
}
function formatBytes(b){
  if(b<1024)return b+' B';
  if(b<1048576)return(b/1024).toFixed(1)+' KB';
  return(b/1048576).toFixed(1)+' MB';
}
let _tq=Promise.resolve();
function showToast(msg,type,dur){
  dur=dur||2800;
  _tq=_tq.then(()=>new Promise(res=>{
    const c=document.getElementById('toast-container');
    if(!c){res();return;}
    const t=document.createElement('div');
    t.className='toast'+(type?' toast-'+type:'');
    t.textContent=msg;
    c.appendChild(t);
    requestAnimationFrame(()=>t.classList.add('show'));
    setTimeout(()=>{t.classList.remove('show');setTimeout(()=>{t.remove();res();},300);},dur);
  }));
}
function showLoading(txt){
  const o=document.getElementById('loader-overlay');
  const tx=document.getElementById('loader-text');
  if(o)o.classList.add('show');
  if(tx)tx.textContent=txt||'Loading...';
}
function hideLoading(){const o=document.getElementById('loader-overlay');if(o)o.classList.remove('show');}
function navigate(path){window.location.hash=path.startsWith('#')?path:'#'+path;}
function getHash(){return window.location.hash.slice(1)||'library';}
function lazyLoad(ctx){
  ctx=ctx||document;
  if(!('IntersectionObserver' in window)){ctx.querySelectorAll('img[data-src]').forEach(img=>{img.src=img.dataset.src||'';});return;}
  const obs=new IntersectionObserver(entries=>{
    entries.forEach(e=>{if(e.isIntersecting){const img=e.target;img.src=img.dataset.src||'';img.removeAttribute('data-src');obs.unobserve(img);}});
  },{rootMargin:'200px'});
  ctx.querySelectorAll('img[data-src]').forEach(img=>obs.observe(img));
}
function imgFallback(img){img.onerror=null;img.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';}
function createElement(tag,attrs){
  const el=document.createElement(tag);
  if(attrs)for(const[k,v]of Object.entries(attrs)){
    if(k==='className')el.className=v;
    else if(k==='html')el.innerHTML=v;
    else if(k==='text')el.textContent=v;
    else if(k.startsWith('on'))el.addEventListener(k.slice(2).toLowerCase(),v);
    else el.setAttribute(k,v);
  }
  return el;
}
async function copyToClipboard(text){
  if(navigator.clipboard){try{await navigator.clipboard.writeText(text);return;}catch(e){}}
  const ta=document.createElement('textarea');
  ta.value=text;Object.assign(ta.style,{position:'fixed',opacity:'0',top:'0',left:'0'});
  document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
}
window.Utils={debounce,throttle,uid,sleep,clamp,truncate,formatDate,formatRelTime,formatBytes,showToast,showLoading,hideLoading,navigate,getHash,lazyLoad,imgFallback,createElement,copyToClipboard};
window.showToast=showToast;window.showLoading=showLoading;window.hideLoading=hideLoading;
window.navigate=navigate;window.getHash=getHash;window.lazyLoad=lazyLoad;window.imgFallback=imgFallback;
window.debounce=debounce;window.truncate=truncate;
