"""Build idempotent SQL for the 2026-11-19 News is my Business sitemap table.

The sitemap supplied URLs and publication dates only (All in One SEO RSS sitemap,
50 rows, generated 2026-11-19 12:31 PM AST). No excerpts or images were in that
table, and the article pages were not fetched. Times are Puerto Rico AST (UTC-4),
the same reading as scripts/imports/nimb-2026-11-14.py.

Of those 50 URLs, the site homepage is not an article, and 20 slugs are already
in the November 14 file. This file is the other 29, all inside the 14-day window
ending at sitemap generation. INSERT OR IGNORE keeps source id nimb and does not
rewrite a URL that is already stored. The live feed stays unregistered.
"""
import datetime, json, pathlib, re
base = pathlib.Path(__file__).parent
as_of = datetime.datetime.fromisoformat('2026-11-19T16:31:00+00:00')
window_start = as_of - datetime.timedelta(days=14)
now = int(datetime.datetime.now().timestamp() * 1000)
proper = ['Antillean Adventist University', 'Nydia Suarez Marin', 'Green Energy Trust', 'Ports Authority', 'Albizu University', 'Las Piedras', 'Puerto Rico', 'NaviMarket', 'T5 Media', 'PAC Tech', 'ATH Movil', 'Gura Coop', 'Barceloneta', 'Burlington', 'Mayaguez', 'Telecinco', 'Microsoft', 'Humacao', 'San Juan', 'Aerostar', 'Keralty', 'Eximia', 'Porsche', 'Gurabo', 'AbbVie', 'Sears', 'Byond', 'CUD', 'UPR', 'BBB', 'AI']
expected = {
 'abbvie-plans-217m-expansion-at-barceloneta-plant': 'AbbVie plans $217m expansion at Barceloneta plant',
 'puerto-rico-bill-seeks-tax-breaks-for-nonprofit-conventions': 'Puerto Rico bill seeks tax breaks for nonprofit conventions',
 'pac-tech-to-invest-12-7m-in-las-piedras-expansion': 'PAC Tech to invest $12.7m in Las Piedras expansion',
 'analysis-ai-startups-face-growing-trademark-risks': 'Analysis: AI startups face growing trademark risks',
 'travel-with-sears-rebrands-as-byond-invests-nearly-500k': 'Travel with Sears rebrands as Byond invests nearly $500k',
 'puerto-rico-employers-face-dec-15-bonus-deadline': 'Puerto Rico employers face Dec. 15 bonus deadline',
 'new-flights-to-puerto-rico-could-generate-31-4m': 'New flights to Puerto Rico could generate $31.4m',
 'puerto-rico-bill-would-offer-tax-breaks-for-vacant-homes': 'Puerto Rico bill would offer tax breaks for vacant homes',
 'burlington-sues-mayaguez-mall-landlord-over-1m-dispute': 'Burlington sues Mayaguez mall landlord over $1m dispute',
 'ports-authority-creates-committee-to-review-bay-operations': 'Ports Authority creates committee to review bay operations',
 'analysis-microsoft-outage-exposes-business-vulnerabilities': 'Analysis: Microsoft outage exposes business vulnerabilities',
 'telecinco-rebrands-as-t5-media-expands-advertising-reach': 'Telecinco rebrands as T5 Media expands advertising reach',
 'keralty-albizu-university-plan-mental-health-center': 'Keralty Albizu University plan mental health center',
 'cud-green-energy-trust-partner-to-cut-business-costs': 'CUD Green Energy Trust partner to cut business costs',
 'puerto-rico-consumer-confidence-hits-record-low-amid-oil-shock': 'Puerto Rico consumer confidence hits record low amid oil shock',
 'aerostar-gets-bbb-rating-on-193m-airport-expansion': 'Aerostar gets BBB rating on $193m airport expansion',
 'puerto-rico-senate-passes-bill-to-broaden-loan-reviews-for-young-founders': 'Puerto Rico senate passes bill to broaden loan reviews for young founders',
 'analysis-we-plan-for-the-exit-we-imagine-not-the-one-that-comes': 'Analysis: We plan for the exit we imagine not the one that comes',
 'upr-humacao-launches-2-8m-student-research-initiative': 'UPR Humacao launches $2.8m student research initiative',
 'ath-movil-navimarket-draws-8k-shoppers-to-san-juan': 'ATH Movil NaviMarket draws 8k shoppers to San Juan',
 'puerto-rico-film-industry-establishes-new-academy': 'Puerto Rico film industry establishes new academy',
 'puerto-rico-rd-expenditures-dropped-8-3-in-fiscal-2025': 'Puerto Rico R&D expenditures dropped 8.3% in fiscal 2025',
 'puerto-rico-telecom-chief-says-digital-overhaul-stalled': 'Puerto Rico telecom chief says digital overhaul stalled',
 'ai-software-maker-eximia-plans-san-juan-office': 'AI software maker Eximia plans San Juan office',
 'nydia-suarez-marin-leaves-legacy-in-communications-satire': 'Nydia Suarez Marin leaves legacy in communications satire',
 'analysis-your-ai-made-logo-could-be-your-weakest-asset': 'Analysis: Your AI made logo could be your weakest asset',
 'gura-coop-to-invest-3m-in-new-gurabo-branch': 'Gura Coop to invest $3m in new Gurabo branch',
 'antillean-adventist-university-gets-3m-federal-grant': 'Antillean Adventist University gets $3m federal grant',
 'porsche-launches-mobile-maintenance-service-in-puerto-rico': 'Porsche launches mobile maintenance service in Puerto Rico',
}
def title(slug):
 t = re.sub(r'\b(\d+)-(\d+)([mk])\b', r'$\1.\2\3', slug).replace('-', ' ')
 t = re.sub(r'(?<![\w$.])\b(\d+)([mk])\b', r'$\1\2', t)
 t = t.replace('$8k shoppers', '8k shoppers')
 for p in proper:
  t = re.sub(r'\b' + re.escape(p) + r'\b', p, t, flags=re.I)
 t = t.replace('Puerto Rico rd expenditures dropped 8 3', 'Puerto Rico R&D expenditures dropped 8.3%')
 t = t.replace('dec 15', 'Dec. 15')
 t = re.sub(r'^analysis ', 'Analysis: ', t)
 if t.startswith('Analysis: '):
  t = 'Analysis: ' + t[10].upper() + t[11:]
 else:
  t = t[0].upper() + t[1:]
 return t
def quote(s):
 return "'" + str(s).replace("'", "''") + "'"
previous = {line.split('|')[2] for line in (base / 'nimb-2026-11-14.tsv').read_text().splitlines() if line.strip()}
rows = []
seen = set()
for line in (base / 'nimb-2026-11-19.tsv').read_text().splitlines():
 if not line.strip():
  continue
 dt, section, slug = line.split('|')
 day, clock = dt.split()
 when = datetime.datetime.fromisoformat(f'2026-11-{day}T{clock}:00-04:00')
 if not (window_start <= when <= as_of):
  raise SystemExit(f'outside 14-day window: {slug}')
 if slug in previous or slug in seen or slug == '':
  raise SystemExit(f'duplicate or already imported: {slug}')
 seen.add(slug)
 made = title(slug)
 if expected.get(slug) != made:
  raise SystemExit(f'title mismatch for {slug}: {made}')
 time = int(when.timestamp() * 1000)
 item = dict(url=f'https://newsismybusiness.com/{slug}/', source='nimb', title=made, summary='', image='', time=time, observed=False, section=section, reason='manual-import', titleOrigin='url-slug')
 rows.append('INSERT OR IGNORE INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(' + ','.join(map(quote, [item['url'], 'nimb', json.dumps(item, ensure_ascii=False), now, now, time])) + ');')
if len(rows) != 29 or seen != set(expected):
 raise SystemExit(f'expected 29 new articles, got {len(rows)}')
path = pathlib.Path('/tmp/nimb-import-2026-11-19.sql')
path.write_text('\n'.join(rows) + '\n')
print(f'Prepared {len(rows)} articles in {path} with archive capture via existing triggers')
