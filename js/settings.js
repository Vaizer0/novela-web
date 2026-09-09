'use strict';
const DEFAULTS={
  fontSize:16,fontFamily:'serif',lineHeight:1.8,paragraphSpacing:12,
  textAlign:'left',textIndent:0,readerBg:'default',keepScreenOn:true,
  ttsSpeed:1.0,ttsPitch:1.0,ttsVoice:'',ttsHighlightColor:'#FF6D00',
  ttsAutoScroll:true,translateMode:'off',translateProvider:'google_simple',
  translateTargetLang:'en',translateSourceLang:'auto',translateApiKey:'',
  translateApiEndpoint:'',translateModelName:'',translateBatchSize:60,
  theme:'default',gridColumns:3,displayMode:'grid',language:'en',
  autoBackupInterval:1440,autoBackupEnabled:false,incognitoMode:false,
  continuousScroll:true,mangaDefaultMode:'webtoon',autoLoadNextChapter:true,corsProxyIndex:0,
  ttsLanguage:'en-US',volumePageTurn:false,
};
class SettingsManager{
  constructor(){this._c={...DEFAULTS};this._L={};this._loaded=false;}
  async load(){
    try{
      const s=await DB.getAllSettings();
      Object.entries(s).forEach(([k,v])=>{if(k in DEFAULTS)this._c[k]=v;});
    }catch(e){console.warn('Settings load:',e);}
    this._loaded=true;this._applyAll();return this;
  }
  get(k){return this._c[k]!==undefined?this._c[k]:DEFAULTS[k];}
  async set(k,v){
    this._c[k]=v;
    try{await DB.setSetting(k,v);}catch(e){}
    this._emit(k,v);
    this.apply();
  }
  apply(){this._applyAll();}
  on(k,fn){if(!this._L[k])this._L[k]=[];this._L[k].push(fn);}
  off(k,fn){if(this._L[k])this._L[k]=this._L[k].filter(f=>f!==fn);}
  _emit(k,v){(this._L[k]||[]).forEach(f=>f(v));(this._L['*']||[]).forEach(f=>f(k,v));}
  _applyAll(){this._applyTheme();this._applyLang();this._applyTTSColor();this._applyGrid();this._applyReaderVars();}
  _applyTheme(){
    const t=this.get('theme');
    document.documentElement.dataset.theme=t;
  }
  _applyLang(){const l=this.get('language');if(window.i18n)window.i18n.setLanguage(l);}
  _applyTTSColor(){document.documentElement.style.setProperty('--tts-hl',this.get('ttsHighlightColor'));}
  _applyGrid(){document.documentElement.style.setProperty('--grid-cols',this.get('gridColumns'));}
  _applyReaderVars(){
    const r=document.documentElement;
    r.style.setProperty('--rd-size',this.get('fontSize')+'px');
    r.style.setProperty('--rd-font',this.get('fontFamily'));
    r.style.setProperty('--rd-lh',this.get('lineHeight'));
    r.style.setProperty('--rd-ps',this.get('paragraphSpacing')+'px');
    r.style.setProperty('--rd-ta',this.get('textAlign'));
  }
  getAll(){return{...this._c};}
  async reset(){this._c={...DEFAULTS};this._applyAll();if(window.showToast)showToast('Settings reset');}
}
window.Settings=new SettingsManager();
