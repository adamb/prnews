"""Build idempotent SQL from user-supplied URLs/dates; titles derived from slugs.
No article text or images were retrievable. Times interpreted as Puerto Rico AST.
"""
import datetime, json, pathlib, re
base=pathlib.Path(__file__).parent
now=int(datetime.datetime.now().timestamp()*1000)
proper=['Puerto Rico','Puerto Rican','Palmas Athletic Club','UBS','NVIDIA','Jensen Huang','Casa Julia','CUD','PRABIA','EcoExploratorio','Evertec','Cardona','AI','Hospitri','Salvation Army','Red Kettle','Christmas','PRE18','Aerostar','Mayaguez','Claro','Brightforce','FASE1','Demo Day','Toyota Open','Fundacion CAP','Roost','Santurce','Kind Sun','Ecostore','San Juan','USDA','PRIDCO','Vega Baja','Domrep','GDP','Red Cross','Google','Liberty','IRS','Amgen','UPR','Rio Piedras','INSEC','Best Lawyers','INVID','Alertia','Maderera Donestevez','Carolina','Casa Pueblo','El Conquistador','MAPR']
def title(slug):
 t=re.sub(r'\b(\d+)-(\d+)([mk])\b',r'$\1.\2\3',slug).replace('-',' ')
 t=re.sub(r'(?<![\w$.])\b(\d+)([mk])\b',r'$\1\2',t)
 t=t.replace('puerto ricos', 'Puerto Rico’s').replace('amgens','Amgen’s').replace('google org','Google.org')
 for p in proper:t=re.sub(r'\b'+re.escape(p)+r'\b',p,t,flags=re.I)
 t=re.sub(r'^analysis ', 'Analysis: ',t)
 return t[0].upper()+t[1:]
def quote(s):return "'"+str(s).replace("'","''")+"'"
rows=[]
for line in (base/'nimb-2026-11-14.tsv').read_text().splitlines():
 dt,section,slug=line.split('|');day,clock=dt.split()
 time=int(datetime.datetime.fromisoformat(f'2026-11-{day}T{clock}:00-04:00').timestamp()*1000)
 item=dict(url=f'https://newsismybusiness.com/{slug}/',source='nimb',title=title(slug),summary='',image='',time=time,observed=False,section=section,reason='manual-import',titleOrigin='url-slug')
 rows.append('INSERT OR IGNORE INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES('+','.join(map(quote,[item['url'],'nimb',json.dumps(item),now,now,time]))+');')
assert len(rows)==49
pathlib.Path('/tmp/nimb-import.sql').write_text('\n'.join(rows))
print('Prepared',len(rows),'articles with archive capture via existing triggers')
