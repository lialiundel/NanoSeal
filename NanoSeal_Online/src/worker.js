import QRCode from '../vendor/QRCode/index.js';
import QRErrorCorrectLevel from '../vendor/QRCode/QRErrorCorrectLevel.js';

const encoder=new TextEncoder();const decoder=new TextDecoder();
const json=(obj,status=200,extra={})=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra}});
const b64=b=>{let x='';for(const v of new Uint8Array(b))x+=String.fromCharCode(v);return btoa(x).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')};
const unb64=s=>{let t=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));return Uint8Array.from(t,c=>c.charCodeAt(0))};
const canonical=o=>JSON.stringify(Object.fromEntries(Object.keys(o).sort().map(k=>[k,o[k]])));
const keyAlgo={name:'ECDSA',namedCurve:'P-256'};
async function ensureKey(env,usage='sign'){
 let row=await env.DB.prepare("SELECT value FROM settings WHERE name='signing_key'").first();
 if(!row){let pair=await crypto.subtle.generateKey(keyAlgo,true,['sign','verify']);let raw=await crypto.subtle.exportKey('jwk',pair.privateKey);await env.DB.prepare("INSERT OR IGNORE INTO settings(name,value) VALUES('signing_key',?)").bind(JSON.stringify(raw)).run();row=await env.DB.prepare("SELECT value FROM settings WHERE name='signing_key'").first();}
 let jwk=JSON.parse(row.value);if(usage==='verify'){const {d,...publicJwk}=jwk;jwk={...publicJwk,key_ops:['verify']};}else jwk={...jwk,key_ops:['sign']};return crypto.subtle.importKey('jwk',jwk,keyAlgo,true,[usage]);
}
async function sign(env,object){let bytes=encoder.encode(canonical(object));let key=await ensureKey(env);let sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,bytes);return b64(bytes)+'.'+b64(sig)}
async function validate(env,token){try{if(!token||token.length>6000||token.split('.').length!==2)return null;let [a,b]=token.split('.'),data=unb64(a),sig=unb64(b),obj=JSON.parse(decoder.decode(data));if(!obj||typeof obj!=='object'||!['id','name','batch','issued','version'].every(k=>k in obj)||canonical(obj)!==decoder.decode(data))return null;let key=await ensureKey(env,'verify');if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,sig,data))return null;return obj}catch{return null}}
async function issue(env,name,batch,demo=0,revoked=0){let id='NS-'+b64(crypto.getRandomValues(new Uint8Array(6))).replace(/[-_]/g,'').slice(0,9).toUpperCase(),issued=new Date().toISOString().slice(0,10);let object={version:1,id,name,batch,issued};let token=await sign(env,object);await env.DB.prepare('INSERT INTO products(id,name,batch,issued,token,revoked,checks,demo) VALUES(?,?,?,?,?,?,0,?)').bind(id,name,batch,issued,token,revoked,demo).run();return {...object,token,revoked,checks:0}}
async function seed(env){let n=await env.DB.prepare('SELECT COUNT(*) AS n FROM products WHERE demo=1').first();if(n.n===0){for(const [name,batch,revoked] of [['NanoSkin • Сыворотка Balance','NS-B-1026',0],['NanoSkin • Крем Glow','NS-G-1026',0],['NanoSkin • Маска Pure','NS-P-1026',1]])await issue(env,name,batch,1,revoked)}}
function auth(req,env){let a=req.headers.get('authorization')||'';if(!a.startsWith('Basic '))return false;try{let [user,...pass]=atob(a.slice(6)).split(':');return user==='nanoseal'&&pass.join(':')===env.ADMIN_PASSWORD&&Boolean(env.ADMIN_PASSWORD)}catch{return false}}
const unauthorized=()=>new Response('Требуется вход в кабинет производителя.',{status:401,headers:{'WWW-Authenticate':'Basic realm="NanoSeal Producer", charset="UTF-8"','cache-control':'no-store'}});
const safeText=s=>String(s??'').trim();
export default {async fetch(req,env){try{
 const url=new URL(req.url),p=url.pathname,admin=auth(req,env);
 if(p==='/admin.html'&&!admin)return unauthorized();
 if(p==='/admin.html')return env.ASSETS.fetch(req);
 if(!p.startsWith('/api/'))return env.ASSETS.fetch(req);
 if(!env.DB)return json({error:'База данных D1 не подключена. Проверьте настройки Cloudflare.'},503);
 if(p.startsWith('/api/admin/')&&!admin)return unauthorized();
 if(p==='/api/health')return json({ok:true});
 if(p==='/api/products'&&req.method==='GET'){await seed(env);let rs=await env.DB.prepare('SELECT id,name,batch,issued,token,revoked,checks FROM products WHERE demo=1 ORDER BY rowid DESC').all();return json({products:rs.results})}
 if(p==='/api/admin/products'&&req.method==='GET'){let rs=await env.DB.prepare('SELECT id,name,batch,issued,token,revoked,checks FROM products ORDER BY rowid DESC LIMIT 500').all();return json({products:rs.results})}
 if(p==='/api/stats'&&req.method==='GET'){await seed(env);let s=await env.DB.prepare('SELECT COUNT(*) issued, SUM(CASE WHEN revoked=1 THEN 1 ELSE 0 END) revoked, COALESCE(SUM(checks),0) scans FROM products').first();return json({...s,method:'ECDSA P-256 / SHA-256'})}
 if(p==='/api/verify'&&req.method==='GET'){
  let token=url.searchParams.get('token')||'',data=await validate(env,token);
  if(!data)return json({state:'invalid',signature:false,message:'Подпись не подтверждена. Код мог быть изменён.'});
  let row=await env.DB.prepare('SELECT revoked,checks FROM products WHERE id=? AND token=?').bind(data.id,token).first();
  let state=row?(row.revoked?'revoked':'signed'):'unknown';let count=row?row.checks+1:0;
  if(row)await env.DB.prepare('UPDATE products SET checks=checks+1 WHERE id=?').bind(data.id).run();
  await env.DB.prepare('INSERT INTO events(product_id,ts,status) VALUES(?,?,?)').bind(data.id,new Date().toISOString(),state).run();
  return json({state,signature:true,product:data,checks:count,message:{signed:'Подпись подтверждена, код зарегистрирован. Теперь проверьте защитную наклейку.',revoked:'Подпись верна, но код отозван производителем.',unknown:'Подпись верна, но код не найден в текущем реестре.'}[state]});
 }
 if(p==='/api/qr'&&req.method==='GET'){
  let token=url.searchParams.get('token')||'',data=await validate(env,token);if(!data)return json({error:'Неверный токен'},400);
  let base=url.searchParams.get('base')||new URL('/?v=',url.origin).href;
  let target;try{let u=new URL(base);if(!['http:','https:'].includes(u.protocol)||u.origin!==url.origin)throw Error();u.searchParams.set('v',token);target=u.href}catch{return json({error:'QR должен вести на этот сайт.'},400)}
  let qr=new QRCode(-1,QRErrorCorrectLevel.M);qr.addData(target);qr.make();let size=qr.getModuleCount(),rects=[];for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(qr.isDark(y,x))rects.push(`<rect x="${x+3}" y="${y+3}" width="1" height="1"/>`);let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size+6} ${size+6}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><g fill="black">${rects.join('')}</g></svg>`;return new Response(svg,{headers:{'content-type':'image/svg+xml; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
 }
 if(p==='/api/public-key'&&req.method==='GET'){let key=await ensureKey(env,'verify'),jwk=await crypto.subtle.exportKey('jwk',key);return json({public_key:{kty:jwk.kty,crv:jwk.crv,x:jwk.x,y:jwk.y},algorithm:'ECDSA-P256/SHA256'})}
 if(p==='/api/admin/issue'&&req.method==='POST'){
  let data=await req.json(),name=safeText(data.name),batch=safeText(data.batch);
  if(name.length<2||name.length>100||batch.length<2||batch.length>45)return json({error:'Укажите название (2–100 символов) и партию (2–45 символов).'},400);
  return json({product:await issue(env,name,batch)},201);
 }
 if(p==='/api/admin/revoke'&&req.method==='POST'){
  let data=await req.json(),id=safeText(data.id);let r=await env.DB.prepare('UPDATE products SET revoked=1 WHERE id=?').bind(id).run();return json({ok:r.meta.changes>0});
 }
 return json({error:'Маршрут не найден'},404);
 }catch(e){return json({error:'Не удалось выполнить операцию. Проверьте подключение и повторите попытку.',detail:env.DEBUG?' '+e.message:undefined},500)}}};
