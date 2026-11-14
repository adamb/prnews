import sys,re,statistics,collections
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
NS={'content':'http://purl.org/rss/1.0/modules/content/','media':'http://search.yahoo.com/mrss/','dc':'http://purl.org/dc/elements/1.1/'}
def strip(s): return re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',s or '')).strip()
for fn in sys.argv[1:]:
    try: root=ET.parse(fn).getroot()
    except Exception as e: print(fn,'PARSE ERR',e); continue
    ch=root.find('channel'); items=ch.findall('item')
    lang=ch.findtext('language')
    dates=[]
    for it in items:
        try: dates.append(parsedate_to_datetime(it.findtext('pubDate')))
        except: pass
    dates.sort()
    span=(dates[-1]-dates[0]).total_seconds()/3600 if len(dates)>1 else 0
    descs=[it.findtext('description') or '' for it in items]
    dl=[len(strip(d)) for d in descs]
    html=sum(1 for d in descs if '<' in d)
    trunc=sum(1 for d in descs if re.search(r'(\[…\]|\[\.\.\.\]|…|\.\.\.)\s*$',strip(d)))
    ce=[it.find('content:encoded',NS) for it in items]; cel=[len(strip(c.text)) for c in ce if c is not None and c.text]
    auth=sum(1 for it in items if it.find('dc:creator',NS) is not None or it.find('author') is not None)
    cats=collections.Counter(strip(c.text) for it in items for c in it.findall('category') if c.text)
    img=collections.Counter()
    for it in items:
        if it.find('media:content',NS) is not None: img['media:content']+=1
        if it.find('media:thumbnail',NS) is not None: img['media:thumbnail']+=1
        if it.find('enclosure') is not None: img['enclosure']+=1
        if re.search(r'<img',(it.findtext('description') or '')+(ce[items.index(it)].text if ce[items.index(it)] is not None and ce[items.index(it)].text else '')): img['img-in-html']+=1
    print(f"== {fn}: items={len(items)} lang={lang} span={span:.1f}h newest={dates[-1] if dates else None} oldest={dates[0] if dates else None} rate/day~{len(items)/span*24 if span else 0:.0f}")
    print(f"   desc: nonempty={sum(1 for x in dl if x)} median_len={statistics.median(dl) if dl else 0} max={max(dl) if dl else 0} html={html} truncated={trunc}")
    print(f"   content:encoded n={len(cel)} median={statistics.median(cel) if cel else 0}; author n={auth}; images={dict(img)}")
    print(f"   categories({sum(cats.values())}): {cats.most_common(25)}")
    it=items[0] if items else None
    if it is not None:
        print('   tags:',sorted({c.tag for c in it}))
        print('   sample title:',it.findtext('title')); print('   sample link:',it.findtext('link')); print('   sample desc:',strip(it.findtext('description'))[:250])
