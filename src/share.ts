/** Share button. The satire line never goes in the URL — only id, satire=1, and lang. */

/** Preview prefix. The on-card label stays the shorter line the button already paints. */
export const SATIRE_PREVIEW_PREFIX = {
  es: 'Una mirada satírica con IA: ',
  en: 'AI satirical take: ',
} as const;

/** Same words as lighterClientScript's open-block label. */
export const SATIRE_BLOCK_LABEL = {
  es: 'AI Satire',
  en: 'AI Satire',
} as const;

export type SharePayload = { title: string; url: string; text?: string };

/**
 * Browser copy of the payload rules. One string, so the page script and the
 * unit tests cannot drift, and the worker bundler cannot rename the functions
 * inside the page.
 */
export const shareFnsSource = `
function sharePath(base, satireOpen) {
  if (!/^\\/story\\?id=[1-9]\\d{0,8}(?:&lang=en)?$/.test(base)) return '';
  if (!satireOpen) return base;
  return base.replace(/(&lang=en)?$/, function (tail) { return '&satire=1' + tail; });
}
function sharePayload(title, url, lang, line) {
  var payload = {title: title, url: url};
  if (line) payload.text = line + ' — ' + (lang === 'en' ? 'AI satirical take' : 'una mirada satírica con IA');
  return payload;
}
function shareClipboard(payload) {
  return payload.text ? payload.text + ' ' + payload.url : payload.url;
}
function visibleSatire(article) {
  if (!article || typeof article.querySelector !== 'function') return '';
  var body = article.querySelector('.lighter-note span');
  if (!body || typeof body.textContent !== 'string') return '';
  var line = body.textContent.replace(/^\\s+|\\s+$/g, '');
  if (!line) return '';
  var ask = article.querySelector('.lighter-ask');
  if (ask && ask.getAttribute('aria-expanded') === 'false' && ask.getAttribute('data-mode') !== 'open') return '';
  return line;
}
`;

type ShareFns = {
  sharePath: (base: string, satireOpen: boolean) => string;
  sharePayload: (title: string, url: string, lang: string, line: string) => SharePayload;
  shareClipboard: (payload: SharePayload) => string;
};

let shareFns: ShareFns | undefined;
function loadShareFns(): ShareFns {
  shareFns ??= new Function(`${shareFnsSource}; return {sharePath, sharePayload, shareClipboard};`)() as ShareFns;
  return shareFns;
}

export function sharePath(base: string, satireOpen: boolean): string {
  return loadShareFns().sharePath(base, satireOpen);
}

export function sharePayload(title: string, url: string, lang: string, line: string): SharePayload {
  return loadShareFns().sharePayload(title, url, lang, line);
}

export function shareClipboard(payload: SharePayload): string {
  return loadShareFns().shareClipboard(payload);
}

/** textContent only, same rule as lighterClientScript. No cookies, no analytics. */
export const shareClientScript = `(function(){
${shareFnsSource}
 document.addEventListener('click', function(event){
  var target=event.target;
  var button=target&&target.closest?target.closest('.share-ask'):null;
  if(!button) return;
  var base=button.getAttribute('data-share-path')||'';
  var lang=button.getAttribute('data-share-lang')==='en'?'en':'es';
  var article=button.closest('article');
  var line=visibleSatire(article);
  var path=sharePath(base, !!line);
  if(!path) return;
  var heading=article?article.querySelector('h2 a, h3 a'):null;
  var title=heading&&heading.textContent?heading.textContent:document.title;
  var url=location.origin+path;
  var payload=sharePayload(title, url, lang, line);
  var parent=button.parentNode;
  var note=parent&&parent.querySelector?parent.querySelector('.share-note'):null;
  function copied(){
   if(!note) return;
   var text=lang==='en'?'Link copied':'Enlace copiado';
   var stamp=String(Date.now());
   button.setAttribute('data-share-stamp', stamp);
   note.textContent=text;
   setTimeout(function(){ if(button.getAttribute('data-share-stamp')===stamp) note.textContent=''; }, 4000);
  }
  function go(){ location.assign(url); }
  function copy(){
   var clip=navigator.clipboard;
   if(!clip||typeof clip.writeText!=='function'){ go(); return; }
   clip.writeText(shareClipboard(payload)).then(copied).catch(go);
  }
  if(typeof navigator.share==='function'){
   navigator.share(payload).catch(function(err){
    if(err&&err.name==='AbortError') return;
    copy();
   });
   return;
  }
  copy();
 });
})();`;
