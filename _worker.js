// Cloudflare Pages "advanced mode" worker: API + media + auth. Bindings: BUCKET (R2), DB (D1, optional).
// Secrets: ADMIN_PASSWORD, SESSION_SECRET. Optional var: MEDIA_BASE.
const enc=new TextEncoder(),IDX='meta/index.json',ID=/^[a-f0-9]{12}$/,KEY=/^m\/[a-f0-9]{12}\.[a-z0-9]{1,5}$/;
const J=(o,s=200,h={})=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json','cache-control':'no-store',...h}});
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const hash=async s=>b64(await crypto.subtle.digest('SHA-256',enc.encode(s)));
const sign=async(env,d)=>b64(await crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',enc.encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']),enc.encode(d)));
const same=(a,b)=>{if(a.length!==b.length)return false;let r=0;for(let i=0;i<a.length;i++)r|=a.charCodeAt(i)^b.charCodeAt(i);return !r};
const authed=async(req,env)=>{const m=(req.headers.get('cookie')||'').match(/(?:^|; )sess=(\d+)\.([\w-]+)/);return !!(m&&env.SESSION_SECRET&&+m[1]>Date.now()&&same(m[2],await sign(env,m[1])))};
const rid=()=>crypto.randomUUID().replace(/-/g,'').slice(0,12);
const kind=h=>{const t=h.httpMetadata?.contentType||'';return t.startsWith('video')?'video':t.startsWith('audio')?'audio':'image'};
const clean=o=>({t:String(o.t||'').slice(0,120),c:String(o.c||'').slice(0,2000),k:String(o.k||'').trim().slice(0,40),g:(Array.isArray(o.g)?o.g:[]).map(x=>String(x).trim().toLowerCase().slice(0,30)).filter(Boolean).slice(0,15)});
// Read-modify-write the post index; retries if another write happened meanwhile.
async function mutate(env,fn){for(let i=0;i<4;i++){const o=await env.BUCKET.get(IDX),l=o?await o.json():[],r=await fn(l);
 if(await env.BUCKET.put(IDX,JSON.stringify(l),{httpMetadata:{contentType:'application/json'},onlyIf:o?{etagMatches:o.etag}:undefined}))return r}throw Error('Busy, try again')}
async function media(req,env,key){if(!KEY.test(key))return new Response('Not found',{status:404});
 const o=await env.BUCKET.get(key,{range:req.headers});if(!o)return new Response('Not found',{status:404});
 const h=new Headers();o.writeHttpMetadata(h);h.set('etag',o.httpEtag);h.set('accept-ranges','bytes');h.set('cache-control','public, max-age=31536000, immutable');
 let st=200;if(o.range&&req.headers.has('range')){const{offset=0,length=o.size-offset}=o.range;h.set('content-range',`bytes ${offset}-${offset+length-1}/${o.size}`);h.set('content-length',length);st=206}else h.set('content-length',o.size);
 return new Response(o.body,{status:st,headers:h})}
async function admin(req,env,p,M){let m;
 if(p==='/api/admin/me')return J({ok:true});
 if(p==='/api/admin/up/start'&&M==='POST'){const b=await req.json(),t=String(b.type||'');
  if(!/^(image|video|audio)\//.test(t))return J({error:'Only photo, video, GIF or audio files'},400);
  const ext=(String(b.name||'').split('.').pop()||'bin').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,5)||'bin',key=`m/${rid()}.${ext}`;
  const mp=await env.BUCKET.createMultipartUpload(key,{httpMetadata:{contentType:t}});return J({key,uploadId:mp.uploadId})}
 if(p==='/api/admin/up/part'&&M==='PUT'){const q=new URL(req.url).searchParams,key=q.get('key');if(!KEY.test(key))return J({error:'Bad key'},400);
  const x=await env.BUCKET.resumeMultipartUpload(key,q.get('uploadId')).uploadPart(+q.get('n'),await req.arrayBuffer());return J({partNumber:x.partNumber,etag:x.etag})}
 if(p==='/api/admin/up/done'&&M==='POST'){const b=await req.json();if(!KEY.test(b.key))return J({error:'Bad key'},400);
  await env.BUCKET.resumeMultipartUpload(b.key,b.uploadId).complete(b.parts);return J({ok:1})}
 if(p==='/api/admin/post'&&M==='POST'){const b=await req.json(),h=KEY.test(b.key)&&await env.BUCKET.head(b.key);if(!h)return J({error:'Upload missing'},400);
  const post={id:rid(),...clean(b),m:b.key,y:kind(h),s:h.size,d:new Date().toISOString()};await mutate(env,l=>{l.unshift(post)});return J(post)}
 if(m=p.match(/^\/api\/admin\/post\/([a-f0-9]{12})$/)){
  if(M==='PUT'){const b=await req.json();let old=null;
   const r=await mutate(env,async l=>{const x=l.find(y=>y.id===m[1]);if(!x)return null;Object.assign(x,clean(b));
    if(b.key&&b.key!==x.m){const h=KEY.test(b.key)&&await env.BUCKET.head(b.key);if(!h)throw Error('Upload missing');old=x.m;x.m=b.key;x.y=kind(h);x.s=h.size}return x});
   if(!r)return J({error:'Not found'},404);if(old)await env.BUCKET.delete(old);return J(r)}
  if(M==='DELETE'){let gone;await mutate(env,l=>{const i=l.findIndex(y=>y.id===m[1]);if(i>=0)gone=l.splice(i,1)[0]});
   if(!gone)return J({error:'Not found'},404);await env.BUCKET.delete(gone.m);
   if(env.DB)await env.DB.batch([env.DB.prepare('DELETE FROM stats WHERE id=?').bind(gone.id),env.DB.prepare('DELETE FROM votes WHERE id=?').bind(gone.id)]);return J({ok:1})}}
 if(p==='/api/admin/stats'){const o=await env.BUCKET.get(IDX),l=o?await o.json():[],t={image:0,video:0,audio:0};let bytes=0;for(const x of l){t[x.y]++;bytes+=x.s||0}
  const r={posts:l.length,...t,bytes};if(env.DB){const s=await env.DB.prepare('SELECT COALESCE(SUM(likes),0) l,COALESCE(SUM(views),0) v FROM stats').first();r.likes=s.l;r.views=s.v}return J(r)}
 return J({error:'Not found'},404)}
export default{async fetch(req,env){const u=new URL(req.url),p=u.pathname,M=req.method;let m;
 try{
  if(p.startsWith('/media/'))return await media(req,env,decodeURIComponent(p.slice(7)));
  if(p==='/api/config')return J({mediaBase:env.MEDIA_BASE||'',likes:!!env.DB});
  if(p==='/api/posts'){const o=await env.BUCKET.get(IDX);return new Response(o?o.body:'[]',{headers:{'content-type':'application/json','cache-control':'public, max-age=30'}})}
  if(p==='/api/stats'){if(!env.DB)return J({});const ids=(u.searchParams.get('ids')||'').split(',').filter(x=>ID.test(x)).slice(0,40);if(!ids.length)return J({});
   const{results}=await env.DB.prepare(`SELECT id,likes,views FROM stats WHERE id IN (${ids.map(()=>'?').join()})`).bind(...ids).all();const o={};for(const r of results)o[r.id]=[r.likes,r.views];return J(o,200,{'cache-control':'public, max-age=20'})}
  if(m=p.match(/^\/api\/(like|view)\/([a-f0-9]{12})$/)){if(M!=='POST'||!env.DB)return J({ok:false});const id=m[2];
   if(m[1]==='view'){await env.DB.prepare('INSERT INTO stats(id,views) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET views=views+1').bind(id).run();return J({ok:true})}
   const b=await req.json().catch(()=>({})),v=await hash((req.headers.get('cf-connecting-ip')||'')+env.SESSION_SECRET);
   if(b.on){const r=await env.DB.prepare('INSERT OR IGNORE INTO votes(id,v) VALUES(?,?)').bind(id,v).run();if(r.meta.changes)await env.DB.prepare('INSERT INTO stats(id,likes) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET likes=likes+1').bind(id).run()}
   else{const r=await env.DB.prepare('DELETE FROM votes WHERE id=? AND v=?').bind(id,v).run();if(r.meta.changes)await env.DB.prepare('UPDATE stats SET likes=MAX(likes-1,0) WHERE id=?').bind(id).run()}
   const row=await env.DB.prepare('SELECT likes FROM stats WHERE id=?').bind(id).first();return J({likes:row?row.likes:0})}
  if(p==='/api/login'&&M==='POST'){const b=await req.json().catch(()=>({}));
   if(!env.ADMIN_PASSWORD||!env.SESSION_SECRET)return J({error:'Add ADMIN_PASSWORD and SESSION_SECRET in Cloudflare settings, then redeploy'},500);
   if(!same(await hash(String(b.password||'')),await hash(env.ADMIN_PASSWORD))){await new Promise(r=>setTimeout(r,1000));return J({error:'Wrong password'},401)}
   const exp=String(Date.now()+12*36e5);return J({ok:true},200,{'set-cookie':`sess=${exp}.${await sign(env,exp)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`})}
  if(p==='/api/logout')return J({ok:true},200,{'set-cookie':'sess=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
  if(p.startsWith('/api/admin/')){if(!(await authed(req,env)))return J({error:'Please sign in'},401);
   if(M!=='GET'&&req.headers.get('x-req')!=='1')return J({error:'Bad request'},403);return await admin(req,env,p,M)}
  if(p.startsWith('/p/'))return env.ASSETS.fetch(new Request(new URL('/',u),req));
  return env.ASSETS.fetch(req);
 }catch(e){return J({error:e.message||'Server error'},500)}}};
