/** Anonymous, best-effort events: no retry IDs or visitor records. */
export async function invitationEventRoute(request:Request,env:{DB?:D1Database}):Promise<Response|undefined>{
 if(new URL(request.url).pathname!=='/api/invitation-event')return;
 const reply=(status:number)=>new Response(null,{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST')return reply(405);
 if(request.headers.get('Origin')!==new URL(request.url).origin)return reply(403);
 if(request.headers.get('Content-Type')!=='application/json')return reply(415);
 if(Number(request.headers.get('Content-Length')||0)>256)return reply(413);
 try{
  const reader=request.body?.getReader();if(!reader)return reply(400);
  let bytes=new Uint8Array(0);
  while(true){const {value,done}=await reader.read();if(done)break;if(bytes.length+value.length>256){await reader.cancel();return reply(413)}const next=new Uint8Array(bytes.length+value.length);next.set(bytes);next.set(value,bytes.length);bytes=next}
  let v;try{v=JSON.parse(new TextDecoder().decode(bytes))}catch{return reply(400)}
  if(!v||Object.keys(v).sort().join(',')!=='event,lang,variant'||!Number.isInteger(v.variant)||v.variant<0||v.variant>4||!['es','en'].includes(v.lang)||!['shown','clicked','dismissed'].includes(v.event))return reply(400);
  if(!env.DB)return reply(503);
  const day=new Date(Date.now()-4*3600000).toISOString().slice(0,10);
  await env.DB.prepare('INSERT INTO invitation_events(day,variant,lang,event,total) VALUES(?,?,?,?,1) ON CONFLICT(day,variant,lang,event) DO UPDATE SET total=total+1').bind(day,v.variant,v.lang,v.event).run();
  return reply(204);
 }catch{return reply(503)}
}
export async function invitationCounts(env:{DB?:D1Database}){
 try{
  if(!env.DB)return null;
  const start=await env.DB.prepare('SELECT started_at FROM invitation_counting WHERE id=1').first<{started_at:string}>();
  if(!start)return null;
  const rows=await env.DB.prepare('SELECT event,SUM(total) AS total FROM invitation_events GROUP BY event').all<{event:string;total:number}>();
  return {startedAt:start.started_at,shown:0,clicked:0,dismissed:0,...Object.fromEntries(rows.results.map(r=>[r.event,r.total]))};
 }catch{return null}
}
