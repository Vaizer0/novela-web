'use strict';
const PROXIES=[
  'https://api.allorigins.win/raw?url=',
  'https://corsproxy.io/?',
  'https://thingproxy.freeboard.io/fetch/',
  'https://api.codetabs.com/v1/proxy/?quest=',
];
let _pi=0;
async function fetchProxy(url,opts){
  opts=opts||{};
  const n=PROXIES.length;
  for(let i=0;i<n;i++){
    const idx=(_pi+i)%n;
    try{
      const ctrl=new AbortController();
      const timer=setTimeout(()=>ctrl.abort(),18000);
      const r=await fetch(PROXIES[idx]+encodeURIComponent(url),{
        ...opts,signal:ctrl.signal,
        headers:{'X-Requested-With':'XMLHttpRequest',...(opts.headers||{})},
      });
      clearTimeout(timer);
      if(!r.ok)throw new Error('HTTP '+r.status);
      _pi=idx;return r;
    }catch(e){if(i===n-1)throw e;}
  }
}
async function fetchText(url,opts){return(await fetchProxy(url,opts)).text();}
async function fetchJson(url,opts){return(await fetchProxy(url,opts)).json();}
async function fetchDom(url,opts){
  const html=await fetchText(url,opts);
  return new DOMParser().parseFromString(html,'text/html');
}
function extractText(src,sel){
  let doc=typeof src==='string'?new DOMParser().parseFromString(src,'text/html'):src;
  const t=sel?doc.querySelector(sel):doc.body;
  if(!t)return '';
  t.querySelectorAll('script,style,nav,header,footer,aside').forEach(e=>e.remove());
  return(t.innerText||t.textContent||'').replace(/\n{3,}/g,'\n\n').trim();
}
async function applyRegexRules(text,rules){
  rules=rules||[];let r=text;
  for(const rule of rules){
    if(!rule.enabled)continue;
    try{
      const re=new RegExp(rule.pattern,rule.flags||'g');
      r=r.replace(re,rule.replacement||'');
    }catch(e){console.warn('Regex rule error:',rule.pattern,e);}
  }
  return r;
}
function parseHtml(html){return new DOMParser().parseFromString(html,'text/html');}
function absoluteUrl(base,rel){
  try{return new URL(rel,base).href;}catch(e){return rel;}
}
async function directFetch(url,opts){
  opts=opts||{};
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),15000);
  try{
    const r=await fetch(url,{...opts,signal:ctrl.signal});
    clearTimeout(timer);return r;
  }catch(e){clearTimeout(timer);throw e;}
}
window.Scraper={fetchProxy,fetchText,fetchJson,fetchDom,extractText,applyRegexRules,parseHtml,absoluteUrl,directFetch,PROXIES,getProxyIdx:()=>_pi};
window.fetchText=fetchText;
window.fetchJson=fetchJson;
window.fetchDom=fetchDom;
