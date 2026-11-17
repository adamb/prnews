import { subscribe,confirm,unsubscribe,type DigestEnv } from './digest';
function result(message:string,status=200) {
 return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>El resumen de la isla</title><style>body{font:18px/1.6 system-ui;max-width:640px;margin:48px auto;padding:20px}a{color:inherit}</style><h1>El resumen de la isla</h1><p>${message}</p><a href="/">Volver / Back</a></html>`,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",'X-Robots-Tag':'noindex, nofollow'}});
}
export async function digestRoute(request:Request,env:DigestEnv):Promise<Response|undefined> {
 const url=new URL(request.url);
 if(!['/digest/subscribe','/digest/confirm','/digest/unsubscribe'].includes(url.pathname))return;
 if(request.method==='HEAD')return new Response(null,{headers:{'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'}});
 try {
  if(url.pathname==='/digest/subscribe') {
   if(request.method!=='POST')return result('Use el formulario de suscripción / Use the signup form.',405);
   if(request.headers.get('Origin') && request.headers.get('Origin')!==url.origin)return result('Solicitud no válida / Invalid request.',403);
   const reader=request.body?.getReader(); let size=0,text='';const decoder=new TextDecoder();
   if(reader)while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2048){await reader.cancel();return result('Solicitud demasiado grande / Request too large.',413);}text+=decoder.decode(value,{stream:true});}
   text+=decoder.decode();
   let data:{email?:unknown;lang?:unknown};
   try {data=request.headers.get('Content-Type')?.includes('application/json')?JSON.parse(text):Object.fromEntries(new URLSearchParams(text));}
   catch {return result('Solicitud no válida / Invalid request.',400);}
   const response=await subscribe(env,typeof data.email==='string'?data.email:'',data.lang==='en'?'en':'es');
   return result(response.message,response.status==='unavailable'?503:202);
  }
  if(url.pathname==='/digest/confirm' && request.method==='GET' && env.DIGEST_ENABLED!=='true')return result('Este enlace pertenece al boletín diario retirado; no activa alertas por palabra clave. / This link belongs to the retired daily newsletter; it does not activate keyword alerts. <a href="/alerts">Mis alertas / My alerts</a>');
  if(url.pathname==='/digest/confirm' && request.method==='GET')return result((await confirm(env,url.searchParams.get('token')??'')).message);
  if(url.pathname==='/digest/unsubscribe' && ['GET','POST'].includes(request.method))return result((await unsubscribe(env,url.searchParams.get('token')??'')).message);
  return result('Método no permitido / Method not allowed.',405);
 } catch {return result('Actualizando… Intenta de nuevo pronto. / Updating… Please try again shortly.',503);}
}
