/** Relative timestamps ("hace 12 min" / "12 min ago") for stories published within the last week.
 * Older stories keep an absolute date. The server renders this once for first paint and a tiny
 * inline script re-evaluates it every minute, so a cached or long-open page never claims a story
 * is fresher than it is. `relativeClientScript` is the same rule written as a string for the
 * browser; a test evaluates both against the same inputs so they cannot drift apart. */
export const WEEK_MS = 7 * 86400000;

/** Null when the story is a week old or more (callers show an absolute date instead). */
export function relativeTime(then: number, now: number, lang: 'es' | 'en'): string | null {
 const diff = now - then;
 if (diff >= WEEK_MS) return null;
 const minutes = Math.floor(Math.max(0, diff) / 60000);
 if (minutes < 1) return lang === 'en' ? 'just now' : 'ahora';
 const [n, unit] = minutes < 60 ? [minutes, 'min'] : minutes < 1440 ? [Math.floor(minutes / 60), 'h'] : [Math.floor(minutes / 1440), 'd'];
 return lang === 'en' ? `${n} ${unit} ago` : `hace ${n} ${unit}`;
}

/** Updates every `<time data-rel="<epoch ms>">` in place, once now and then every minute. */
export const relativeClientScript = `(function(){var en=document.documentElement.lang==='en',W=${WEEK_MS};
function f(t,now){var d=now-t;if(d>=W)return null;var m=Math.floor(Math.max(0,d)/6e4);if(m<1)return en?'just now':'ahora';var n,u;if(m<60){n=m;u='min'}else if(m<1440){n=Math.floor(m/60);u='h'}else{n=Math.floor(m/1440);u='d'}return en?n+' '+u+' ago':'hace '+n+' '+u}
function tick(){var now=Date.now();document.querySelectorAll('time[data-rel]').forEach(function(e){var s=f(+e.getAttribute('data-rel'),now);if(s&&e.textContent!==s)e.textContent=s})}
tick();setInterval(tick,60000);document.addEventListener('visibilitychange',function(){if(!document.hidden)tick()})})()`;
