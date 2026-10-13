import worker from './src/worker.js';
import assert from 'node:assert/strict';
let key=null,products=[],events=[];
const DB={prepare(sql){let args=[];return {bind(...a){args=a;return this},async first(){if(sql.includes('SELECT value FROM settings'))return key?{value:key}:null;if(sql.includes('COUNT(*) AS n'))return {n:products.filter(p=>p.demo).length};if(sql.includes('SELECT revoked,checks')){let p=products.find(p=>p.id===args[0]&&p.token===args[1]);return p?{revoked:p.revoked,checks:p.checks}:null;}if(sql.includes('COUNT(*) issued'))return {issued:products.length,revoked:products.filter(p=>p.revoked).length,scans:products.reduce((s,p)=>s+p.checks,0)};return null},async run(){if(sql.includes('INSERT OR IGNORE INTO settings'))key??=args[0];if(sql.startsWith('INSERT INTO products'))products.push({id:args[0],name:args[1],batch:args[2],issued:args[3],token:args[4],revoked:args[5],checks:0,demo:args[6]});if(sql.startsWith('UPDATE products SET checks')){let p=products.find(p=>p.id===args[0]);p.checks++;}if(sql.startsWith('UPDATE products SET revoked')){let p=products.find(p=>p.id===args[0]);if(p)p.revoked=1;return {meta:{changes:p?1:0}};}if(sql.startsWith('INSERT INTO events'))events.push(args);return {meta:{changes:1}}},async all(){let a=products.filter(p=>sql.includes('WHERE demo=1')?p.demo:true);return {results:a.map(({demo,...r})=>r)}}}}};
const env={DB,ADMIN_PASSWORD:'test123',DEBUG:true,ASSETS:{fetch:async()=>new Response('<html>ok</html>')}};
let auth='Basic '+btoa('nanoseal:test123');
async function req(path,opts={}){let r=await worker.fetch(new Request('https://nanoseal.example'+path,opts),env);return r}
let r=await req('/api/products');console.log('first',r.status,await r.clone().text());assert.equal(r.status,200);let d=await r.json();assert.equal(d.products.length,3);let token=d.products.find(x=>!x.revoked).token;
r=await req('/api/verify?token='+encodeURIComponent(token));assert.equal((await r.json()).state,'signed');
r=await req('/api/verify?token='+encodeURIComponent('A'+token.slice(1)));assert.equal((await r.json()).state,'invalid');
r=await req('/api/qr?token='+encodeURIComponent(token));let svg=await r.text();assert.equal(r.status,200);assert(svg.includes('<svg')&&svg.includes('<rect'));
r=await req('/admin.html');assert.equal(r.status,401);
r=await req('/api/admin/issue',{method:'POST',headers:{'Authorization':auth,'Content-Type':'application/json'},body:JSON.stringify({name:'Крем тест',batch:'TEST-2026'})});assert.equal(r.status,201);let product=(await r.json()).product;
r=await req('/api/verify?token='+encodeURIComponent(product.token));assert.equal((await r.json()).state,'signed');
r=await req('/api/admin/revoke',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({id:product.id})});assert.equal(r.status,200);
r=await req('/api/verify?token='+encodeURIComponent(product.token));assert.equal((await r.json()).state,'revoked');
console.log('PASS: demo data, signed token, altered token, QR SVG, admin protection, issue, revoke');
