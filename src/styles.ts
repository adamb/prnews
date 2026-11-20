import { FONT_PATH } from './font';

/** Front-end stylesheet, inlined in every page (one request, nothing blocks first paint).
 * Design tokens live in :root; `light-dark()` resolves from `color-scheme`, which follows the
 * visitor's system theme unless the header toggle stored an explicit choice on <html data-theme>.
 * Dark is the fallback palette for browsers without light-dark(). Section accents take their hue
 * from `--h` (set per section in markup) and their lightness here, per theme, so every accent
 * clears text contrast on the page and card backgrounds. */
export const css = `
@font-face{font-family:Fraunces;src:url(${FONT_PATH}) format("woff2");font-weight:600 800;font-style:normal;font-display:swap}
@font-face{font-family:"Fraunces Fallback";src:local(Georgia),local("Times New Roman");size-adjust:104%;ascent-override:93%;descent-override:24%;line-gap-override:0%}
:root{color-scheme:light dark;--serif:Fraunces,"Fraunces Fallback",Georgia,"Times New Roman",serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--bg:#0e1311;--panel:#151c19;--ink:#ece9e1;--muted:#a1aea6;--line:#27312c;--soft:#1a231f;--accent:#8fd9b3;--alert:#ff9d8f;--on-alert:#2a0d09;--shadow:0 12px 32px #0007;
--sec:hsl(var(--h,160) 62% 72%);--ph-bg:hsl(var(--h,160) 22% 20%);--ph-ink:hsl(var(--h,160) 45% 80%)}
@supports (color:light-dark(#000,#fff)){:root{--bg:light-dark(#faf8f3,#0e1311);--panel:light-dark(#fff,#151c19);--ink:light-dark(#1b2420,#ece9e1);--muted:light-dark(#5a6760,#a1aea6);--line:light-dark(#ddd7ca,#27312c);--soft:light-dark(#efeadf,#1a231f);--accent:light-dark(#166149,#8fd9b3);--alert:light-dark(#b3261e,#ff9d8f);--on-alert:light-dark(#fff,#2a0d09);--shadow:light-dark(0 12px 32px #2a241a26,0 12px 32px #0007);
--sec:light-dark(hsl(var(--h,160) 55% 30%),hsl(var(--h,160) 62% 72%));--ph-bg:light-dark(hsl(var(--h,160) 30% 88%),hsl(var(--h,160) 22% 20%));--ph-ink:light-dark(hsl(var(--h,160) 42% 26%),hsl(var(--h,160) 45% 80%))}}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:56px}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px;border-radius:2px}
img{display:block;max-width:100%;object-fit:cover}
img[hidden]{display:none}
button{font:inherit;color:var(--ink)}
.wrap{max-width:1240px;margin:0 auto;padding:0 18px}
@media(min-width:700px){.wrap{padding:0 28px}}
.skip{position:absolute;left:-9999px}.skip:focus{left:12px;top:12px;background:var(--panel);padding:8px 12px;z-index:50}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* Masthead */
.masthead{position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;padding-block:14px}
.brand{font:700 clamp(1.65rem,1.2rem + 1.9vw,2.6rem)/1 var(--serif);letter-spacing:-.025em;white-space:nowrap}
.brand b{color:var(--accent);font-weight:700}
.brand:hover{text-decoration:none}
.tagline{display:none;margin-top:6px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.mast-tools{display:flex;align-items:center;gap:6px;min-width:0}
.mast-tools .alerts-link{display:none;font-size:13px;font-weight:600;padding:8px 10px;color:var(--muted)}
.mast-tools .alerts-link:hover{color:var(--ink)}
.languages{display:flex;padding:3px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:12px;font-weight:700}
.languages a{padding:5px 10px;border-radius:999px;color:var(--muted);transition:background-color .2s,color .2s}
.languages a[aria-current=true]{background:var(--accent);color:var(--bg)}
.languages a:hover{text-decoration:none;color:var(--ink)}.languages a[aria-current=true]:hover{color:var(--bg)}
.mast-tools button,.search-open{display:inline-grid;place-items:center;height:36px;min-width:36px;padding:0 10px;border:1px solid var(--line);border-radius:999px;background:var(--panel);cursor:pointer;font-size:12px;font-weight:700;transition:border-color .2s,background-color .2s}
.mast-tools button:hover,.search-open:hover{border-color:var(--muted)}
#theme{width:40px;height:40px;min-width:40px;min-height:40px;padding:0;flex:0 0 40px}
#theme:focus-visible{border-radius:999px}
.header-search{margin:0}
.header-search>div{display:flex;align-items:center;border:1px solid var(--line);border-radius:999px;background:var(--panel);overflow:hidden}
.header-search input{width:0;min-width:0;flex:1;border:0;background:transparent;color:var(--ink);padding:9px 4px 9px 16px;font:inherit;font-size:14px}
.header-search input:focus{outline:none}
.header-search button{display:grid;place-items:center;flex:0 0 40px;height:38px;min-width:0;padding:0;border:0;border-radius:0;background:transparent}
.header-search>div:focus-within{outline:3px solid var(--accent);outline-offset:2px}
/* Phones: search collapses to an icon; focusing it opens a full-width field over the header row. */
@media(max-width:899px){
.header-search{order:-1}
.header-search>div{position:absolute;left:18px;right:18px;top:50%;transform:translateY(-50%);opacity:0;pointer-events:none;transition:opacity .15s;z-index:30;box-shadow:var(--shadow)}
.header-search:focus-within>div{opacity:1;pointer-events:auto}
.header-search input{width:100%}
.search-open{display:inline-grid}
}
@media(min-width:700px) and (max-width:899px){.header-search>div{left:28px;right:28px}}
@media(min-width:900px){.search-open{display:none}.header-search{width:260px;position:relative}.header-search input{width:100%}.mast-tools{gap:10px}.mast-tools .alerts-link{display:inline-block}.tagline{display:block}}

/* Section navigation */
.nav{position:sticky;top:0;z-index:20;background:var(--bg);border-block:1px solid var(--line)}
.navrow{display:flex;align-items:stretch;gap:8px}
.tabs{display:flex;flex-wrap:wrap;gap:0 22px;flex:1;min-width:0}
.tabs a{padding:12px 0;font-size:13px;font-weight:600;white-space:nowrap;border-bottom:3px solid transparent;margin-bottom:-1px;transition:color .2s,border-color .2s}
.tabs a:hover{text-decoration:none;color:var(--accent)}
.tabs a[aria-current=page]{border-bottom-color:var(--accent);color:var(--accent)}
.more-nav{position:relative;align-self:center;font-size:13px;font-weight:600}
.more-nav summary{cursor:pointer;padding:12px 4px;color:var(--accent);list-style:none;white-space:nowrap}
.more-nav summary::-webkit-details-marker{display:none}
.more-nav summary::after{content:"";display:inline-block;margin-left:7px;width:6px;height:6px;border:solid currentColor;border-width:0 2px 2px 0;transform:translateY(-3px) rotate(45deg);transition:transform .2s}
.more-nav[open] summary::after{transform:translateY(1px) rotate(-135deg)}
.more-nav>div{position:absolute;right:0;top:100%;width:260px;max-width:85vw;z-index:25;background:var(--panel);border:1px solid var(--line);border-radius:6px;box-shadow:var(--shadow);padding:8px 6px;margin-top:1px}
.more-nav>div a{display:block;padding:9px 12px;border-radius:4px;overflow-wrap:anywhere}
.more-nav>div a:hover{background:var(--soft);text-decoration:none}
.more-nav>div a[aria-current=page]{color:var(--accent)}
.more-nav>div a.narrow-only{display:none}
.more-nav>div a.alerts-sheet{color:var(--accent);font-weight:700}
@media(min-width:900px){.more-nav>div a.alerts-sheet{display:none}}
/* Narrow screens: the bar collapses to Portada plus one Sections trigger; every section lives in the
full-width sheet that opens under the bar, so nothing wraps into a second line or runs off-screen. */
@media(max-width:768px){
.tabs{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;gap:0 18px}
.tabs::-webkit-scrollbar{display:none}
.tabs a:not(:first-child){display:none}
.more-nav>div a.narrow-only{display:block}
.more-nav{position:static}
.more-nav>div{left:0;right:0;width:auto;max-width:none;border-radius:0;border-inline:0;padding:10px 12px 14px;display:grid;grid-template-columns:1fr 1fr;gap:2px 8px}
}
@media(max-width:480px){.tabs{gap:0 16px}.tabs a{font-size:12.5px}.masthead{gap:8px}.brand{font-size:1.5rem}.mast-tools{gap:4px}.languages{padding:2px;font-size:11.5px}.languages a{padding:5px 7px}.mast-tools button,.search-open{min-width:34px;height:34px;padding:0 8px}}

@media(max-width:360px){.wrap{padding:0 14px}.masthead{gap:4px}.brand{font-size:1.3rem}.mast-tools{gap:3px}.languages{font-size:11px}.languages a{padding:5px 5px}.mast-tools button,.search-open{min-width:30px;height:30px;padding:0 6px}.header-search>div{left:14px;right:14px}}
/* The 40px theme button is the tallest masthead control. Below 360px the .wrap shorthand clears the masthead's block padding, so put enough back for the focus ring. At 320px and 361–364px the row is already full; a slightly smaller logo gap keeps the button on screen. */
@media(max-width:360px){.masthead{padding-block:8px}}
@media(max-width:321px){.masthead{gap:2px}}
@media(min-width:361px) and (max-width:364px){.masthead{gap:4px}}

/* Última hora ticker */
.ticker{border-bottom:1px solid var(--line);background:var(--panel);font-size:13px}
.ticker .wrap{display:flex;align-items:stretch;min-width:0}
.ticker-label{flex:none;display:flex;align-items:center;gap:8px;padding:0 12px;margin-right:14px;background:var(--alert);color:var(--on-alert);font:700 11px/1 var(--sans);letter-spacing:.12em;text-transform:uppercase}
.ticker-label::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 2s ease-in-out infinite}
.ticker-view{flex:1;min-width:0;overflow:hidden;white-space:nowrap;-webkit-mask-image:linear-gradient(90deg,transparent,#000 14px,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(90deg,transparent,#000 14px,#000 calc(100% - 28px),transparent)}
.ticker-track{display:inline-flex;animation:tick var(--d,90s) linear infinite;will-change:transform}
.ticker-track:hover,.ticker-track:focus-within,.ticker.paused .ticker-track{animation-play-state:paused}
.ticker-pause{flex:none;align-self:center;display:grid;place-items:center;width:30px;height:30px;margin-left:8px;padding:0;border:1px solid var(--line);border-radius:999px;background:var(--bg);color:var(--muted);cursor:pointer}
.ticker-pause:hover{color:var(--ink);border-color:var(--muted)}
.ticker.paused .ticker-pause{color:var(--accent);border-color:var(--accent)}
.tk{display:inline-flex;margin:0;padding:0;list-style:none}
.tk li{padding:9px 28px 9px 0}
.tk time{margin-right:8px;font-size:12px;color:var(--muted)}
.tk a{font-weight:600}
@keyframes tick{to{transform:translateX(-50%)}}
@keyframes pulse{50%{opacity:.35}}
@media(prefers-reduced-motion:reduce){.ticker-track{animation:none}.ticker-view{overflow-x:auto;-webkit-mask-image:none;mask-image:none}.tk[aria-hidden=true]{display:none}.ticker-label::before{animation:none}}

/* Page furniture */
main{padding-top:24px;padding-bottom:20px}
.dateline{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 24px;padding:0 0 4px}
.eyebrow{margin:0;color:var(--accent);font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
h1{font:700 clamp(1.7rem,1.25rem + 1.9vw,2.6rem)/1.08 var(--serif);letter-spacing:-.02em;margin:6px 0 10px;text-wrap:balance}
.dateline h1{font-size:clamp(1.35rem,1.1rem + 1vw,1.9rem);margin:4px 0 0}
h2{font:700 1.5rem/1.2 var(--serif);letter-spacing:-.012em;margin:0}
h3{font:700 1.15rem/1.25 var(--serif);letter-spacing:-.01em;margin:8px 0}
.intro{color:var(--muted);margin:0 0 22px;max-width:62ch}
.deck{display:none;color:var(--muted);margin:6px 0 0;font-size:.95rem}
@media(min-width:760px){.deck{display:block}}
mark{background:color-mix(in srgb,var(--accent) 22%,transparent);color:inherit;border-radius:2px;padding:0 1px}
.list{max-width:none}
.prose{max-width:720px}.prose p{color:var(--muted)}
.notice{font-size:13px;background:var(--soft);padding:13px 17px;margin:24px 0;color:var(--accent);border-left:3px solid var(--accent)}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin:0;font-size:13px}
.filters>label{display:flex;align-items:center;gap:8px;color:var(--muted);font-weight:600}
.filters select{max-width:100%;padding:8px 12px;font:inherit;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:999px}
.filters button,.pagination a{display:inline-block;padding:8px 16px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:13px;font-weight:600;cursor:pointer;transition:border-color .2s,background-color .2s}
.filters button:hover,.pagination a:hover{border-color:var(--muted);text-decoration:none}
.source-chip{margin:12px 0 4px;padding:10px 14px;max-width:100%;background:var(--soft);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;font-size:15px;font-weight:600;line-height:1.45;overflow-wrap:anywhere}
.source-chip strong{font-weight:800}
.source-chip a{color:var(--accent);font-weight:700;white-space:nowrap}
.source-chip a:hover,.source-chip a:focus-visible{text-decoration:underline;text-underline-offset:3px}
.list>.filters{padding:4px 0 18px}
input{font:inherit;padding:6px;background:var(--panel);color:var(--ink);border:1px solid var(--line)}
.pagination{display:flex;gap:12px;margin:36px 0 10px}
.pagination a{color:var(--accent)}

/* Cards */
.card{position:relative;min-width:0;display:flex;flex-direction:column;gap:10px}
.card-body{min-width:0;display:flex;flex-direction:column;gap:7px}
.picture{position:relative;display:block;aspect-ratio:3/2;overflow:hidden;background:var(--ph-bg);border-radius:3px;isolation:isolate}
.picture>img,.picture>.ph{position:absolute;inset:0;width:100%;height:100%}
.picture>img{transition:transform .6s cubic-bezier(.2,.7,.2,1),opacity .3s}
.card:hover .picture>img{transform:scale(1.035)}
.ph{display:grid;place-items:center;background:var(--ph-bg);color:var(--ph-ink)}
.ph b{font:700 clamp(1.1rem,3.6vw,1.9rem)/1 var(--serif);letter-spacing:.05em}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;margin:0;font-size:12px;color:var(--muted)}
.meta .src{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink)}
.meta .src a{color:inherit;text-decoration:none}
.meta .src a:hover,.meta .src a:focus-visible{text-decoration:underline;text-underline-offset:3px}
.meta .when::before{content:"·";margin-right:8px}
.card h2,.card h3{margin:0;font-family:var(--serif);font-weight:700;letter-spacing:-.012em;line-height:1.2;text-wrap:balance;overflow-wrap:break-word;word-break:normal}
.card h2 a,.card h3 a{background:linear-gradient(currentColor,currentColor) 0 100%/0 1px no-repeat;transition:background-size .35s ease}
.card h2 a:hover,.card h3 a:hover{text-decoration:none}
.card:hover h2 a,.card:hover h3 a,.card h2 a:focus-visible,.card h3 a:focus-visible{background-size:100% 1px}
.excerpt,.reddit-summary{margin:0;color:var(--muted);font-size:.95rem;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.reddit-summary{display:block;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.language{font-size:11px;color:var(--muted)}
.also{margin:0;font-size:12px;color:var(--muted)}
.also span{font-weight:700;letter-spacing:.04em;text-transform:uppercase;font-size:11px;margin-right:4px}
.also a{color:var(--ink);font-weight:600;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;text-decoration-color:var(--line)}
.also a:hover{text-decoration-color:currentColor}
.card h3{font-size:1.1rem}
.card.lead h3{font-size:clamp(1.4rem,1.1rem + 1.1vw,1.85rem);line-height:1.12}
.card.hero h2{font-size:clamp(1.75rem,1.15rem + 2.7vw,3rem);line-height:1.05;letter-spacing:-.02em}
.card.hero .excerpt{font-size:1.05rem;-webkit-line-clamp:4}
.card.hero .picture{aspect-ratio:16/9}
.card.lead .picture{aspect-ratio:3/2}
.card.brief{padding-top:12px;border-top:1px solid var(--line)}
.card.brief h3{font-size:1.02rem}
/* Horizontal cards: side stories, medium stories on phones, and every tile on phones. */
.card.side,.card.mid,.card.tile{display:grid;grid-template-columns:minmax(0,1fr) 108px;grid-template-areas:"body pic";align-items:start;gap:14px}
.card.side .picture,.card.mid .picture,.card.tile .picture{grid-area:pic;aspect-ratio:1/1}
.card.side .card-body,.card.mid .card-body,.card.tile .card-body{grid-area:body}
.card.side .excerpt,.card.tile .excerpt{display:none}
.card.side h3,.card.mid h3,.card.tile h3{font-size:1.05rem}
@media(min-width:640px){
.card.tile{display:flex;align-items:stretch;grid-template-columns:none}
.card.tile .picture{aspect-ratio:3/2}
.card.tile .excerpt{display:-webkit-box}
.card.tile .reddit-summary{display:block}
}
@media(min-width:760px){.card.side .excerpt{display:-webkit-box;-webkit-line-clamp:2}}

/* Monogram-only cards (no usable thumbnail) take far less room than a photo would: a small tile beside
   the headline. Photos keep their full ratios. Leads and heroes are text-first too; a full-bleed
   monogram is an empty block, not a picture. */
.card.noimg .picture{aspect-ratio:5/2}
.card.noimg .ph b{font-size:clamp(1rem,2.6vw,1.4rem)}
.card.side.noimg,.card.mid.noimg,.card.tile.noimg{grid-template-columns:minmax(0,1fr) 64px}
.card.side.noimg .picture,.card.mid.noimg .picture,.card.tile.noimg .picture{aspect-ratio:1/1}
.card.side.noimg .ph b,.card.mid.noimg .ph b,.card.tile.noimg .ph b{font-size:.8rem;letter-spacing:.03em}
@media(min-width:900px){.card.side.noimg{grid-template-columns:minmax(0,1fr) 72px}}
@media(min-width:640px){.card.tile.noimg .picture{aspect-ratio:5/2}.card.tile.noimg .ph b{font-size:1.2rem}}
@container (min-width:620px){.g-mid .card.mid.noimg .picture{aspect-ratio:5/2}.g-mid .card.mid.noimg .ph b{font-size:1.2rem;letter-spacing:.05em}}
/* Front page: hero */
.lede{display:grid;gap:22px;margin:18px 0 6px}
.lede-side{display:grid;align-content:start}
.lede-side .card{padding:16px 0;border-top:1px solid var(--line)}
.lede-side .card:first-child{padding-top:0;border-top:0}
@media(min-width:900px){
.lede{grid-template-columns:minmax(0,1.85fr) minmax(0,1fr);gap:44px;margin-top:22px}
.lede-side .card{padding:18px 0}
.lede-side .card:first-child{padding-top:0}
.card.side{grid-template-columns:minmax(0,1fr) 120px}
}

/* Front page: rail + sections */
.front{display:grid;gap:8px;grid-template-areas:"rail" "sections"}
.rail{grid-area:rail;margin-top:32px;border-top:3px solid var(--ink);padding-top:12px}
.sections{grid-area:sections;min-width:0}
.rail-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.rail-head span{font-size:12px;color:var(--muted)}
.rail ol{list-style:none;margin:6px 0 0;padding:0}
.rail li{display:grid;grid-template-columns:3.2rem minmax(0,1fr);gap:8px;align-items:start;padding:14px 0;border-bottom:1px solid var(--line)}
.rail li:last-child{border-bottom:0}
.rail .num{font:700 3rem/.85 var(--serif);color:var(--accent);letter-spacing:-.04em;text-align:left;font-variant-numeric:lining-nums}
.rail li a.rank-title{display:block;font:700 1.02rem/1.25 var(--serif);letter-spacing:-.008em;text-wrap:balance;margin-bottom:5px}
.rail li a.rank-title:hover{text-decoration:none;color:var(--accent)}
@media(min-width:1100px){
.front.has-rail{grid-template-columns:minmax(0,1fr) 300px;grid-template-areas:"sections rail";column-gap:48px;align-items:start}
.has-rail .rail{position:sticky;top:64px;margin-top:44px}
}
.sec{margin-top:40px;container-type:inline-size}
.sec-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;border-top:3px solid var(--sec);padding-top:12px;margin-bottom:18px}
.sec-head h2{font-size:1.45rem}
.sec-head h2 a:hover{text-decoration:none;color:var(--sec)}
.sec-head .count{font:700 12px var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--sec)}
.sec-head .more{margin-left:auto;font-size:13px;font-weight:600;color:var(--sec);white-space:nowrap}
.sec-head .more:hover{text-decoration:underline}
.sec-grid{display:grid;gap:20px;grid-template-areas:"lead" "mid" "brief"}
.g-lead{grid-area:lead}.g-mid{grid-area:mid;display:grid;gap:18px;align-content:start}.g-brief{grid-area:brief;display:grid;gap:12px;align-content:start}
/* A nowrap Reddit excerpt's min-content is the full line. These grid items must be allowed to shrink so the ellipsis clips inside the column instead of widening the page. */
.sec-grid>*,.g-lead,.g-mid,.lede>*,.tiles>*{min-width:0}
.g-mid:empty,.g-brief:empty{display:none}
@container (min-width:620px){
.sec-grid{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);column-gap:28px;grid-template-areas:"lead mid" "brief brief"}
.g-mid .card.mid{display:flex;align-items:stretch;grid-template-columns:none}
.g-mid .card.mid .picture{aspect-ratio:3/2}
.g-brief{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 28px}
}
@container (min-width:900px){
.sec-grid{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr) minmax(0,.95fr);grid-template-areas:"lead mid brief";column-gap:0}
.g-lead{padding-right:26px}
.g-mid{padding-inline:26px;border-left:1px solid var(--line)}
.g-brief{grid-template-columns:1fr;padding-left:26px;border-left:1px solid var(--line);gap:14px}
}
.tiles{display:grid;gap:22px 28px;grid-template-columns:minmax(0,1fr)}
@media(min-width:640px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(min-width:1000px){.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}.tiles>.lead{grid-column:span 2}}
.tiles>.card.tile{padding-bottom:22px;border-bottom:1px solid var(--line)}
.tiles>.card.lead:not(.noimg) .picture{aspect-ratio:16/9}
/* .tiles > .card.lead .picture was 16/9 for every first card, including noimg, and it beat the
   short monogram banner. An imageless section lead (and an imageless hero) is a headline with
   the same small source mark as other text cards. The rule is not inside a min-width query, so
   phones get it too. A real photo still uses 16/9 here and 3/2 or 16/9 on the front page. */
.card.lead.noimg,.card.hero.noimg{display:grid;grid-template-columns:minmax(0,1fr) 64px;grid-template-areas:"body pic";align-items:start;gap:14px}
.card.lead.noimg .picture,.card.hero.noimg .picture{grid-area:pic;aspect-ratio:1/1}
.card.lead.noimg .card-body,.card.hero.noimg .card-body{grid-area:body}
.card.lead.noimg .ph b,.card.hero.noimg .ph b{font-size:.8rem;letter-spacing:.03em}
.page-head{border-top:3px solid var(--sec);padding-top:14px;margin:0 0 6px}
.page-head .eyebrow{color:var(--sec)}
.page-head .count-line{margin:0 0 14px;color:var(--muted);font-size:14px}
.empty{padding:40px 0;color:var(--muted)}

/* Lighter-take (satire) control stays available on every eligible story, quietly */
.lighter{font-size:.85rem;overflow-wrap:anywhere}
.lighter summary{cursor:pointer;padding:.6rem 0;min-height:44px}.lighter summary:focus-visible{outline:2px solid currentColor}.lighter .opened,.lighter[open] .closed{display:none}.lighter[open] .opened{display:inline}
.lighter-ask{display:inline-flex;align-items:center;max-width:100%;min-height:34px;margin:2px 0 0;padding:5px 13px;text-align:left;white-space:normal;line-height:1.3;font:600 12px/1.3 var(--sans);color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:999px;cursor:pointer;transition:color .2s,border-color .2s,background-color .2s}
.lighter-ask:hover:not(:disabled){color:var(--ink);border-color:var(--muted);background:var(--soft)}
.lighter-ask:disabled{cursor:default;opacity:.7}
.card.brief .lighter-ask,.card.mid .lighter-ask{min-height:28px;padding:3px 0;border:0;font-size:11.5px}
.card.brief .lighter-ask:hover:not(:disabled),.card.mid .lighter-ask:hover:not(:disabled){background:transparent;text-decoration:underline;text-underline-offset:3px}
.share-ask{display:inline-flex;align-items:center;max-width:100%;min-height:34px;margin:2px 0 0;padding:5px 13px;text-align:left;white-space:normal;line-height:1.3;font:600 12px/1.3 var(--sans);color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:999px;cursor:pointer;transition:color .2s,border-color .2s,background-color .2s}
.share-ask:hover{color:var(--ink);border-color:var(--muted);background:var(--soft)}
.share-ask:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.card.brief .share-ask,.card.mid .share-ask{min-height:28px;padding:3px 0;border:0;font-size:11.5px}
.card.brief .share-ask:hover,.card.mid .share-ask:hover{background:transparent;text-decoration:underline;text-underline-offset:3px}
.card .lighter,.card .share{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;max-width:100%}
.share-note{margin:0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.share-note:empty,.card p.share-note:empty,.card p.lighter-note:empty{display:none}
.lighter-note{margin:0 0 .4rem;overflow-wrap:anywhere}.lighter-note small{display:block;color:var(--muted)}
/* The card excerpt clamp also matched this note, so the label, the break, and one satire line were
   all that remained. Excerpts stay clamped; the note never is. */
.card p.lighter-note{display:block;overflow:visible;white-space:normal;-webkit-line-clamp:unset;-webkit-box-orient:unset}
.card p.share-note{display:block;overflow:visible;white-space:normal;-webkit-line-clamp:unset;-webkit-box-orient:unset}
.card .lighter-note,.card .share-note{flex-basis:100%}
.lighter-note:empty{display:none}
.lighter-stats{margin:28px 0}.lighter-stats p,.lighter-stats h3,.lighter-stats a{overflow-wrap:anywhere}.lighter-stats .take{color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:10px 12px;margin:8px 0}.lighter-stats summary{cursor:pointer;min-height:44px;padding:8px 0}
@media(max-width:390px){.lighter-stats .source{flex-direction:column;align-items:flex-start;gap:6px}.lighter-stats{margin:20px 0}}

/* Context glossary. This block is separate from .lighter and from .compare.
   Comparison owns the report styles below; satire keeps .lighter-ask. */
.explainer{font-size:.85rem;margin:6px 0 0;overflow-wrap:anywhere}
.explainer summary{display:inline-flex;align-items:center;max-width:100%;min-height:44px;padding:5px 13px;text-align:left;white-space:normal;line-height:1.3;font:600 12px/1.3 var(--sans);color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:999px;cursor:pointer;list-style:none}
.explainer summary::-webkit-details-marker{display:none}
.explainer summary:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.explainer summary:hover{color:var(--ink);border-color:var(--muted);background:var(--soft)}
.explainer-body{margin:.45rem 0 .2rem;padding:.65rem .75rem;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink)}
.explainer-banner,.explainer-checked,.explainer-more{margin:.2rem 0;color:var(--muted);font-size:.78rem;line-height:1.45}
.explainer-entry{margin:.75rem 0 0}
.explainer-entry h4{margin:0 0 .25rem;font:700 .95rem/1.3 var(--sans);color:var(--ink)}
.explainer-entry p,.explainer-body p{display:block;overflow:visible;white-space:normal;-webkit-line-clamp:unset;margin:.3rem 0;color:var(--ink);font-size:.85rem;line-height:1.45}
.explainer-banner,.explainer-checked,.explainer-more{color:var(--muted)}
.explainer-sources{margin:.35rem 0 0;padding-left:1.1rem}
.explainer-sources a{color:inherit}
.card.brief .explainer summary,.card.mid .explainer summary{min-height:44px}
@media(max-width:390px){.explainer summary{width:100%;box-sizing:border-box}}

/* Supporting pages: sources, stats, hall of fame, archive, signup */
.source{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid var(--line);padding:20px 0}
.source p{margin:4px 0;color:var(--muted);font-size:14px}
.source>div,.source>span{min-width:0;overflow-wrap:anywhere}
.source h2{font-size:1.3rem}
.source-stories{color:var(--accent);font-weight:700}
.source-stories:hover,.source-stories:focus-visible{text-decoration:underline;text-underline-offset:3px}
@media(max-width:700px){.source{flex-direction:column;gap:8px}}
main button:not(.lighter-ask):not(.share-ask):not(.ticker-pause){padding:8px 16px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-weight:600;cursor:pointer}
main button:not(.lighter-ask):not(.share-ask):not(.ticker-pause):hover{border-color:var(--muted)}
.archive-list>div{border-bottom:1px solid var(--line);padding:24px 0}.archive-list .card.tile{display:flex;align-items:stretch;max-width:380px}.archive-list .card.tile .picture{aspect-ratio:3/2}.archive-list .card.tile .excerpt{display:block;overflow:visible}
.digest-unavailable{font-size:14px;color:var(--muted);background:var(--soft);border:1px solid var(--line);border-radius:4px;padding:10px 12px;margin:6px 0 0}
.signup-form{display:flex;flex-wrap:wrap;align-items:end;gap:12px}.signup-form label{display:grid;gap:6px;flex:1;min-width:180px}.signup-form input{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);padding:12px;border-radius:4px}.signup-form p{flex-basis:100%;font-size:13px;color:var(--muted)}
.signup-form button{padding:11px 18px;border:1px solid var(--line);border-radius:999px;background:var(--panel);cursor:pointer}
@media(max-width:480px){.signup-form button{width:100%}.dateline .filters{flex:1 1 100%;flex-wrap:nowrap;min-width:0;max-width:100%}.dateline .filters>label{flex:1 1 0;min-width:0}.dateline .filters select{flex:1 1 0;width:0;min-width:0}.list>.filters>label{width:100%}}

/* Footer */
footer{margin-top:56px;border-top:1px solid var(--line);padding:28px 0 36px;font-size:12px;color:var(--muted)}
footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px}
footer a{overflow-wrap:anywhere}
footer .links{display:flex;flex-wrap:wrap;gap:6px 18px}
footer a:hover{color:var(--ink)}
.digest-footer{padding-bottom:20px}.digest-footer>div{width:100%;max-width:650px}
.digest-footer h2{font-size:1.15rem}.digest-footer p{font-size:14px;margin:6px 0 0}

@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important;scroll-behavior:auto!important}.card:hover .picture>img{transform:none}}

/* Outlet report. Source hue is --h on the row; --row is the ink used for rules and bars.
   Heat washes stay a mix of that ink so the number, in --ink, keeps its contrast. */
.compare{margin:4px 0 28px}
.compare-kicker{margin:0 0 8px;font:700 13px/1 var(--sans);color:var(--accent)}
.compare-mast h1{max-width:16ch;margin-bottom:12px}
.compare-deck{max-width:62ch;margin:0 0 16px;font-size:1.08rem;line-height:1.45;color:var(--ink)}
.compare-facts{display:flex;flex-wrap:wrap;gap:8px 22px;margin:0;padding:0;list-style:none}
.compare-facts li{border-top:2px solid var(--line);padding-top:6px;font-size:13px;color:var(--muted)}
.compare h2{margin:34px 0 8px}
.compare-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 16px}
.compare-head h2{margin:0}
.compare-note{max-width:68ch;margin:8px 0 14px;color:var(--muted);font-size:14.5px;line-height:1.5}
.compare-mode{display:flex;flex-wrap:wrap;gap:8px}
/* Checked text is --bg. This beats main button:not(.lighter-ask):not(.share-ask):not(.ticker-pause), which otherwise keeps the panel background and the label disappears. */
main .compare .compare-mode button[type="button"]{min-height:44px;padding:8px 16px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--ink);font:600 13px/1 var(--sans);cursor:pointer}
main .compare .compare-mode button[type="button"]:hover,main .compare .compare-mode button[type="button"]:focus-visible,main .compare .compare-mode button[type="button"]:active{background:var(--panel);color:var(--ink);border-color:var(--muted)}
main .compare .compare-mode button[type="button"][aria-checked="true"],main .compare .compare-mode button[type="button"][aria-checked="true"]:hover,main .compare .compare-mode button[type="button"][aria-checked="true"]:focus-visible,main .compare .compare-mode button[type="button"][aria-checked="true"]:active{background:var(--ink);color:var(--bg);border-color:var(--ink)}
main .compare .compare-mode button[type="button"]:focus-visible,.compare-chart:focus-visible,.compare-open:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.compare-heat-wrap,.compare-table-wrap{overflow-x:auto;margin:0 0 8px}
.compare-heat,.compare-table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%}
.compare-heat{border-spacing:4px;font-size:13px}
.compare-heat caption,.compare-table caption{caption-side:bottom;text-align:left;color:var(--muted);font-size:13px;padding:8px 0 0;max-width:68ch}
.compare-heat th,.compare-heat td{font-weight:600}
.compare-heat thead th{font:600 11px/1.25 var(--sans);color:var(--muted);text-align:center;vertical-align:bottom;width:5.4rem;padding:0 2px 8px;white-space:normal}
.compare-heat tbody th,.compare-heat thead th:first-child,.compare-table tbody th,.compare-table thead th:first-child{text-align:left;font:700 .95rem/1.2 var(--serif);color:var(--ink);width:auto;max-width:11rem;position:sticky;left:0;background:var(--bg);z-index:1;padding-right:12px}
.compare-heat tbody tr,.compare-outlet{--row:light-dark(hsl(var(--h,160) 45% 32%),hsl(var(--h,160) 48% 70%))}
.compare-heat td{min-width:3.1rem;height:46px;text-align:center;vertical-align:middle;border-radius:3px;background:color-mix(in srgb,var(--row) calc(var(--d,0) * 46%),var(--panel));color:var(--ink)}
.compare-heat td.compare-sum{background:transparent;color:var(--muted);font-variant-numeric:tabular-nums}
.compare-heat .n-pct{display:none}
.compare[data-mode="pct"] .n-count{display:none}
.compare[data-mode="pct"] .n-pct{display:inline}
.compare-days{display:grid;grid-template-columns:1fr;gap:22px 28px;margin-top:8px}
.compare-outlet{border-top:3px solid var(--row);padding:12px 0 2px;min-width:0}
.compare-outlet header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.compare-outlet h3{margin:0;font-size:1.35rem;letter-spacing:-.02em}
.compare-outlet h3 a{color:inherit;text-decoration:none;background:linear-gradient(currentColor,currentColor) 0 100%/0 1px no-repeat}
.compare-outlet h3 a:hover,.compare-outlet h3 a:focus-visible{background-size:100% 1px}
.compare-status{margin:4px 0 0;max-width:36ch;font-size:12.5px;line-height:1.4;color:var(--muted)}
.compare-total{margin:0;text-align:right;font:700 1.7rem/1 var(--serif);font-variant-numeric:tabular-nums}
.compare-total span{display:block;margin-top:3px;font:600 11px/1.2 var(--sans);letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.compare-chart svg{display:block;width:100%;height:auto;color:var(--row)}
.compare-chart .base{stroke:var(--line);stroke-width:1}
.compare-bar.zero rect.mark,.compare-bar.miss rect.mark{fill:var(--line)}
.compare-bar.on rect.mark{stroke:var(--ink);stroke-width:1.25}
.compare-axis{display:flex;justify-content:space-between;margin-top:4px;font-size:11px;color:var(--muted)}
.compare-readout{min-height:2.7em;margin:6px 0 0;font-size:13.5px;line-height:1.35;color:var(--ink)}
.compare-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 12px;margin:10px 0 0}
.compare-meta div{min-width:0}
.compare-meta dt{margin:0;font-size:11px;color:var(--muted)}
.compare-meta dd{margin:2px 0 0;font:700 .95rem/1.2 var(--serif);color:var(--ink)}
.compare-table{border-spacing:0;font-size:13px;font-variant-numeric:tabular-nums}
.compare-table th,.compare-table td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
.compare-table .partial{font-style:italic}
.compare-table .miss{color:var(--muted)}
.compare-community{border-top:1px solid var(--line);margin-top:28px}
.compare-cross{margin:0 0 12px;padding-left:1.1rem;color:var(--muted)}
.compare-limits{max-width:68ch;margin:8px 0 16px;padding-left:1.1rem}
.compare-limits li{margin:8px 0;color:var(--muted);line-height:1.45}
.compare-caps{max-width:68ch;margin:8px 0 20px}
.compare-caps summary{cursor:pointer;min-height:44px;padding:10px 0;font-weight:700}
.compare-caps li{margin:8px 0;color:var(--muted);line-height:1.45}
.compare-invite{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:14px 24px;margin:6px 0 28px;padding:4px 0 16px;border-top:3px solid var(--accent);border-bottom:1px solid var(--line)}
.compare-invite h2{margin:10px 0 0;font-size:clamp(1.55rem,1.2rem + 1.2vw,2rem)}
.compare-invite p{margin:6px 0 0;max-width:46ch;color:var(--muted)}
.compare-invite-actions{display:flex;flex-wrap:wrap;gap:8px}
.compare-open{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:8px 18px;border-radius:999px;background:var(--ink);color:var(--bg);font-weight:700;text-decoration:none}
.compare-open:hover{text-decoration:none}
.compare-open-quiet{background:transparent;color:var(--ink);border:1px solid var(--line)}
.theme-grid{display:grid;grid-template-columns:1fr;gap:18px 28px}
.theme-card{border-top:3px solid var(--accent);padding:12px 0 2px;min-width:0}
.theme-card header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.theme-card h3{margin:0;font-size:1.35rem;letter-spacing:-.02em}
.theme-count{margin:0;text-align:right;font:700 1.7rem/1 var(--serif);font-variant-numeric:tabular-nums}
.theme-count span{display:block;margin-top:3px;font:600 11px/1.2 var(--sans);letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.theme-phrases{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0;padding:0;list-style:none}
.theme-phrases li{border:1px solid var(--line);border-radius:999px;padding:4px 10px;color:var(--muted);font-size:12px;line-height:1.3}
.theme-examples{margin:8px 0 0;padding:0;list-style:none}
.theme-example{margin:0;padding:10px 0;border-top:1px solid var(--line)}
.theme-example a{color:inherit;font:700 1.05rem/1.3 var(--serif);text-decoration:none;background:linear-gradient(currentColor,currentColor) 0 100%/0 1px no-repeat;overflow-wrap:anywhere}
.theme-example a:hover,.theme-example a:focus-visible{background-size:100% 1px}
.theme-meta,.theme-why,.theme-empty{margin:4px 0 0;font-size:13px;line-height:1.4}
.theme-meta,.theme-empty{color:var(--muted)}
.theme-why{color:var(--ink)}
.theme-example a:focus-visible,.compare-open:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
@media(min-width:760px){.compare-days{grid-template-columns:1fr 1fr}.theme-grid{grid-template-columns:1fr 1fr}}
@media(min-width:1100px){.compare-days{grid-template-columns:1fr 1fr 1fr}.compare-days-one{grid-template-columns:minmax(0,420px)}}
@media(max-width:390px){
.compare-mast h1{max-width:none}
.compare-heat td{min-width:2.75rem;height:42px;font-size:12px}
.compare-heat thead th{width:4.4rem}
.compare-meta{grid-template-columns:1fr}
.compare-total{font-size:1.45rem}
.compare-invite{align-items:stretch}
.compare-open{justify-content:center}
}
`;
