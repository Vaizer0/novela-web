'use strict';
const I18N = {
  en: {
    app_name:'NoveLA',title_library:'Library',title_finder:'Finder',
    title_extensions:'Extensions',title_settings:'Settings',title_history:'History',
    no_books_in_library:'No books in your library',chapters:'chapters',
    chapter:'Chapter',loading:'Loading...',error_loading:'Error loading content',
    error_network:'Network error. Try again.',added_to_library:'Added to library',
    removed_from_library:'Removed from library',no_chapters_found:'No chapters found',
    no_results_found:'No results found',search_hint:'Search...',download:'Download',
    downloading:'Downloading...',downloaded:'Downloaded',resume:'Resume',
    read_now:'Read Now',read:'Read',mark_read:'Mark as read',
    mark_unread:'Mark as unread',source:'Source',language:'Language',
    settings_reader:'Reader',settings_tts:'Text-to-Speech',
    settings_translation:'Translation',settings_backup:'Backup & Restore',
    settings_appearance:'Appearance',font_size:'Font Size',font_family:'Font Family',
    line_height:'Line Height',paragraph_spacing:'Paragraph Spacing',
    text_align:'Text Align',tts_speed:'Speed',tts_pitch:'Pitch',tts_voice:'Voice',
    translate_mode:'Translation Mode',translate_provider:'Provider',
    translate_target:'Target Language',translate_api_key:'API Key',
    backup_create:'Create Backup',backup_restore:'Restore Backup',
    theme:'Theme',grid_columns:'Grid Columns',incognito_mode:'Incognito Mode',
    history_clear:'Clear History',cancel:'Cancel',ok:'OK',save:'Save',
    close:'Close',back:'Back',refresh:'Refresh',retry:'Retry',
    error:'Error',success:'Success',novel:'Novel',manga:'Manga',page:'Page',of:'of',
    play:'Play',pause:'Pause',stop:'Stop',next:'Next',previous:'Previous',
    translating:'Translating...',no_history:'No reading history yet',
    unread:'Unread',all:'All',completed:'Completed',ongoing:'Ongoing',
    new_chapters:'new chapters',install:'Install',uninstall:'Uninstall',
    update:'Update',delete_:'Delete',browse_sources:'Browse Sources',
    mark_all_read:'Mark all as read',share:'Share',open_browser:'Open in Browser',
    copy_link:'Copy Link',auto_scroll:'Auto Scroll',parallel_mode:'Parallel Mode',
    migration:'Migration',categories:'Categories',add_category:'Add Category',
    filter:'Filter',sort_by:'Sort by',sort_az:'A-Z',sort_za:'Z-A',
    sort_updated:'Last Updated',sort_added:'Date Added',plan_to_read:'Plan to Read',
    incognito_hint:'Reading in incognito mode',regex_rules:'Regex Rules',
    add_rule:'Add Rule',test_rule:'Test Rule',sleep_timer:'Sleep Timer',
    ext_search:'Search extensions...',
  },
  ru:{app_name:'NoveLA',title_library:'\u0411\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0430',title_finder:'\u041f\u043e\u0438\u0441\u043a',title_settings:'\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438',no_books_in_library:'\u0411\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0430 \u043f\u0443\u0441\u0442\u0430',chapters:'\u0433\u043b\u0430\u0432',loading:'\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430...',cancel:'\u041e\u0442\u043c\u0435\u043d\u0430',ok:'\u041e\u041a',save:'\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c',close:'\u0417\u0430\u043a\u0440\u044b\u0442\u044c',back:'\u041d\u0430\u0437\u0430\u0434'},
  zh:{app_name:'NoveLA',title_library:'\u4e66\u5e93',title_finder:'\u641c\u7d22',title_settings:'\u8bbe\u7f6e',no_books_in_library:'\u4e66\u5e93\u4e3a\u7a7a',chapters:'\u7ae0',loading:'\u52a0\u8f7d\u4e2d...',cancel:'\u53d6\u6d88',ok:'\u786e\u5b9a',save:'\u4fdd\u5b58',close:'\u5173\u95ed',back:'\u8fd4\u56de'},
  ja:{app_name:'NoveLA',title_library:'\u30e9\u30a4\u30d6\u30e9\u30ea',title_finder:'\u63a2\u3059',title_settings:'\u8a2d\u5b9a',no_books_in_library:'\u30e9\u30a4\u30d6\u30e9\u30ea\u304c\u7a7a\u3067\u3059',chapters:'\u7ae0',loading:'\u8aad\u307f\u8fbc\u307f\u4e2d...',cancel:'\u30ad\u30e3\u30f3\u30bb\u30eb',ok:'OK',save:'\u4fdd\u5b58',close:'\u9589\u3058\u308b',back:'\u623b\u308b'},
  ko:{app_name:'NoveLA',title_library:'\ub77c\uc774\ube0c\ub7ec\ub9ac',chapters:'\ud654',loading:'\ub85c\ub529 \uc911...',cancel:'\ucde8\uc18c',ok:'\ud655\uc778',save:'\uc800\uc7a5',close:'\ub2eb\uae30',back:'\ub4a4\ub85c'},
  ar:{app_name:'NoveLA',title_library:'\u0627\u0644\u0645\u0643\u062a\u0628\u0629',title_finder:'\u0627\u0644\u0628\u062d\u062b',chapters:'\u0641\u0635\u0648\u0644',loading:'\u062c\u0627\u0631 \u0627\u0644\u062a\u062d\u0645\u064a\u0644...',cancel:'\u0625\u0644\u063a\u0627\u0621',ok:'\u0645\u0648\u0627\u0641\u0642',save:'\u062d\u0641\u0638',close:'\u0625\u063a\u0644\u0627\u0642',back:'\u0631\u062c\u0648\u0639'},
};
const RTL = new Set(['ar','fa','he','ur']);
class I18nManager {
  constructor(){this.lang='en';}
  setLanguage(code){
    this.lang=I18N[code]?code:'en';
    document.documentElement.setAttribute('dir',RTL.has(this.lang)?'rtl':'ltr');
    document.documentElement.setAttribute('lang',this.lang);
    document.dispatchEvent(new CustomEvent('novela:langchange',{detail:{lang:this.lang}}));
    this._updateDOM();
  }
  t(key,params={}){
    const s=(I18N[this.lang]||{})[key]||I18N.en[key]||key;
    return String(s).replace(/\{(\w+)\}/g,(_,k)=>params[k]!=null?String(params[k]):`{${k}}`);
  }
  _updateDOM(){
    document.querySelectorAll('[data-i18n]').forEach(el=>{
      if(el.dataset.i18n)el.textContent=this.t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el=>{
      if(el.dataset.i18nPh)el.placeholder=this.t(el.dataset.i18nPh);
    });
  }
}
window.i18n=new I18nManager();
