'use strict';
const DB_NAME='novela_db',DB_VER=1;
let _db=null;
function openDB(){
  if(_db)return Promise.resolve(_db);
  return new Promise((res,rej)=>{
    const req=indexedDB.open(DB_NAME,DB_VER);
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      const stores=[
        {name:'books',key:'id',idx:[{n:'sourceId',k:'sourceId'},{n:'updatedAt',k:'updatedAt'}]},
        {name:'chapters',key:'id',idx:[{n:'bookId',k:'bookId'},{n:'read',k:'read'}]},
        {name:'content',key:'chapterId',idx:[]},
        {name:'history',key:'id',idx:[{n:'bookId',k:'bookId'},{n:'readAt',k:'readAt'}]},
        {name:'progress',key:'bookId',idx:[]},
        {name:'settings',key:'key',idx:[]},
        {name:'categories',key:'id',idx:[]},
        {name:'extensions',key:'id',idx:[{n:'lang',k:'lang'}]},
        {name:'regexRules',key:'id',idx:[]},
        {name:'downloads',key:'chapterId',idx:[{n:'bookId',k:'bookId'}]},
      ];
      stores.forEach(({name,key,idx})=>{
        if(!db.objectStoreNames.contains(name)){
          const s=db.createObjectStore(name,{keyPath:key});
          idx.forEach(({n,k})=>s.createIndex(n,k,{unique:false}));
        }
      });
    };
    req.onsuccess=e=>{_db=e.target.result;res(_db);};
    req.onerror=e=>rej(e.target.error);
  });
}
function txGet(store,key){return openDB().then(db=>new Promise((res,rej)=>{const r=db.transaction(store,'readonly').objectStore(store).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}));}
function txPut(store,val){return openDB().then(db=>new Promise((res,rej)=>{const r=db.transaction(store,'readwrite').objectStore(store).put(val);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}));}
function txDel(store,key){return openDB().then(db=>new Promise((res,rej)=>{const r=db.transaction(store,'readwrite').objectStore(store).delete(key);r.onsuccess=()=>res();r.onerror=()=>rej(r.error);}));}
function txAll(store,idx,query){return openDB().then(db=>new Promise((res,rej)=>{const s=db.transaction(store,'readonly').objectStore(store);const t=idx?s.index(idx):s;const r=query?t.getAll(query):t.getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}));}
function txClear(store){return openDB().then(db=>new Promise((res,rej)=>{const r=db.transaction(store,'readwrite').objectStore(store).clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error);}));}
const DB={
  getBook:id=>txGet('books',id),
  getAllBooks:()=>txAll('books'),
  getBooksBySource:sid=>txAll('books','sourceId',sid),
  async saveBook(b){
    b.updatedAt=Date.now();
    if(!b.id)b.id='book_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    await txPut('books',b);return b;
  },
  async deleteBook(id){
    const chaps=await this.getChapters(id);
    for(const c of chaps){await txDel('content',c.id);await txDel('downloads',c.id);await txDel('chapters',c.id);}
    await txDel('progress',id);await txDel('books',id);
  },
  getChapters:bookId=>txAll('chapters','bookId',bookId),
  getChapter:id=>txGet('chapters',id),
  async saveChapter(c){
    if(!c.id)c.id='chap_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    return txPut('chapters',c);
  },
  async saveChapters(bookId,chapters){
    const existing=await this.getChapters(bookId);
    const map=new Map(existing.map(c=>[c.url,c]));
    for(const ch of chapters){
      const ex=map.get(ch.url);
      if(ex)await txPut('chapters',{...ex,...ch,id:ex.id,read:ex.read,bookId});
      else await this.saveChapter({...ch,bookId,read:false,downloaded:false});
    }
  },
  async markChapterRead(id,read){const c=await this.getChapter(id);if(c){c.read=read==null?true:read;await txPut('chapters',c);}},
  async markAllRead(bookId,read){const chaps=await this.getChapters(bookId);for(const c of chaps){c.read=read==null?true:read;await txPut('chapters',c);}},
  getContent:cid=>txGet('content',cid).then(r=>r?r.content:null),
  saveContent:(cid,content)=>txPut('content',{chapterId:cid,content,savedAt:Date.now()}),
  getProgress:bid=>txGet('progress',bid),
  saveProgress:(bid,data)=>txPut('progress',{bookId:bid,...data,savedAt:Date.now()}),
  async addHistory(entry){if(!entry.id)entry.id='hist_'+Date.now();entry.readAt=Date.now();return txPut('history',entry);},
  async getHistory(){const all=await txAll('history');return all.sort((a,b)=>b.readAt-a.readAt);},
  async getBookChapters(bookId){return this.getChapters(bookId);},
  clearHistory:()=>txClear('history'),
  getSetting:key=>txGet('settings',key).then(r=>r?r.value:undefined),
  setSetting:(key,value)=>txPut('settings',{key,value}),
  async getAllSettings(){const all=await txAll('settings');return Object.fromEntries(all.map(i=>[i.key,i.value]));},
  getCategories:()=>txAll('categories'),
  async saveCategory(c){if(!c.id)c.id='cat_'+Date.now();return txPut('categories',c);},
  deleteCategory:id=>txDel('categories',id),
  getAllExtensions:()=>txAll('extensions'),
  getExtensions:()=>txAll('extensions'),
  getExtension:id=>txGet('extensions',id),
  saveExtension:ext=>txPut('extensions',ext),
  deleteExtension:id=>txDel('extensions',id),
  getRegexRules:()=>txAll('regexRules'),
  async saveRegexRule(r){if(!r.id)r.id='rule_'+Date.now();return txPut('regexRules',r);},
  deleteRegexRule:id=>txDel('regexRules',id),
  async exportAll(){
    const [books,chapters,content,history,progress,settings,categories,extensions,regexRules]=await Promise.all([
      txAll('books'),txAll('chapters'),txAll('content'),txAll('history'),txAll('progress'),
      txAll('settings'),txAll('categories'),txAll('extensions'),txAll('regexRules')
    ]);
    return{version:1,exportedAt:Date.now(),books,chapters,content,history,progress,settings,categories,extensions,regexRules};
  },
  async importAll(data){
    if(!data||data.version!==1)throw new Error('Invalid backup format');
    const keys=['books','chapters','content','history','progress','settings','categories','extensions','regexRules'];
    for(const s of keys)await txClear(s);
    for(const k of keys){if(data[k])for(const item of data[k])await txPut(k,item);}
  }
};
openDB().catch(e=>console.error('DB init:',e));
window.DB=DB;
