
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
function createAuth(express, opts) {
  const base = path.join(__dirname, 'auth-data');
  const usersPath = path.join(base, 'users.json');
  const secretPath = path.join(base, 'session-secret');
  const context = new AsyncLocalStorage();
  const attempts = new Map();
  const ensure = p => fs.mkdirSync(p, { recursive: true });
  const currentUserId = () => context.getStore() || 'admin';
  const runAsUser = (id, fn) => context.run(String(id), fn);
  function userDataFile(name, id) {
    const uid = String(id || currentUserId());
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid) || path.basename(name) !== name) throw Error('非法账号数据路径');
    const dir = path.join(base, 'data', uid); ensure(dir); return path.join(dir, name);
  }
  function users() { try { const a=JSON.parse(fs.readFileSync(usersPath,'utf8')); return Array.isArray(a)?a:[]; } catch { return []; } }
  function saveUsers(a) { ensure(base); fs.writeFileSync(usersPath, JSON.stringify(a,null,2), 'utf8'); }
  function secret() { ensure(base); try{return fs.readFileSync(secretPath);}catch{const b=crypto.randomBytes(48);fs.writeFileSync(secretPath,b);return b;} }
  function hash(pw,salt) { const s=salt||crypto.randomBytes(16).toString('hex'); return {salt:s,hash:crypto.scryptSync(String(pw),s,64).toString('hex')}; }
  function equal(a,b) { const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||'')); return x.length===y.length&&crypto.timingSafeEqual(x,y); }
  function check(pw,r) { if(!r||!r.salt||!r.hash)return false; return equal(crypto.scryptSync(String(pw||''),r.salt,64).toString('hex'),r.hash); }
  function cookie(req,key) { const found=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(key+'=')); if(!found)return '';try{return decodeURIComponent(found.slice(key.length+1));}catch{return '';} }
  function sign(p) { return crypto.createHmac('sha256',secret()).update(p).digest('base64url'); }
  function token(u) { const p=Buffer.from(JSON.stringify({id:u.id,exp:Date.now()+2592000000,v:u.sessionVersion||0})).toString('base64url');return p+'.'+sign(p); }
  function sessionUser(req) {
    const a=cookie(req,'ml_session').split('.'); if(a.length!==2||!equal(sign(a[0]),a[1]))return null;
    let p;try{p=JSON.parse(Buffer.from(a[0],'base64url').toString());}catch{return null;}
    if(!p||p.exp<Date.now())return null;
    return users().find(u=>u.id===p.id&&u.status==='approved'&&Number(u.sessionVersion||0)===Number(p.v||0))||null;
  }
  function setSession(res,req,u) {
    const secure=req.secure||String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';
    res.setHeader('Set-Cookie','ml_session='+encodeURIComponent(token(u))+'; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax'+(secure?'; Secure':''));
    res.append('Set-Cookie','ml_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  }
  function clearSession(res,req) { const secure=req.secure||String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';res.setHeader('Set-Cookie','ml_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'+(secure?'; Secure':'')); }
  function limited(req) {
    const ip=String(req.headers['cf-connecting-ip']||req.ip||req.socket.remoteAddress||'unknown'), now=Date.now();
    let r=attempts.get(ip);if(!r||now>r.until)r={n:0,until:now+600000};r.n++;attempts.set(ip,r);return r.n>12;
  }
  const publicRouter=express.Router();
  publicRouter.get('/status',(req,res)=>{const a=users(),u=sessionUser(req);res.json({bootstrapRequired:!a.some(x=>x.role==='admin'&&x.status==='approved'),authenticated:!!u,user:u?{username:u.username,role:u.role}:null});});
  publicRouter.get('/me',(req,res)=>{const u=sessionUser(req);if(!u)return res.status(401).json({error:'登录已失效'});res.json({username:u.username,role:u.role});});
  publicRouter.post('/bootstrap',(req,res)=>{
    if(users().some(u=>u.role==='admin'&&u.status==='approved'))return res.status(409).json({error:'管理员已初始化'});
    if(limited(req))return res.status(429).json({error:'尝试次数过多，请稍后再试'});
    const b=req.body||{}, old=opts.readLegacyConfig()||{};
    if(!old.accessPassword||!equal(b.legacyPassword||cookie(req,'ml_auth'),old.accessPassword))return res.status(401).json({error:'旧版访问口令不正确'});
    if(String(b.username||'').trim().toLowerCase()!=='yvonelam')return res.status(400).json({error:'初始管理员账号固定为 Yvonelam'});
    const pw=String(b.password||'');if(pw.length<8)return res.status(400).json({error:'密码至少需要 8 位'});
    if(pw!==String(b.confirmPassword||''))return res.status(400).json({error:'两次输入的密码不一致'});
    const h=hash(pw),u={id:'admin',username:'Yvonelam',role:'admin',status:'approved',password:h,sessionVersion:0,createdAt:new Date().toISOString()};
    try{opts.migrateAdminConfig();saveUsers([u]);setSession(res,req,u);res.json({ok:true,role:'admin'});}catch(e){res.status(500).json({error:'管理员初始化失败：'+e.message});}
  });
  publicRouter.post('/register',(req,res)=>{
    if(!users().some(u=>u.role==='admin'&&u.status==='approved'))return res.status(409).json({error:'请先初始化管理员账号'});
    if(limited(req))return res.status(429).json({error:'提交次数过多，请稍后再试'});
    const b=req.body||{},name=String(b.username||'').trim(),pw=String(b.password||'');
    if(!/^[A-Za-z0-9._-]{3,32}$/.test(name))return res.status(400).json({error:'账号需为 3–32 位字母、数字、点、短横线或下划线'});
    if(pw.length<8)return res.status(400).json({error:'密码至少需要 8 位'});
    if(pw!==String(b.confirmPassword||''))return res.status(400).json({error:'两次输入的密码不一致'});
    const a=users();if(a.some(u=>u.username.toLowerCase()===name.toLowerCase()))return res.status(409).json({error:'这个账号名已被使用'});
    a.push({id:crypto.randomBytes(16).toString('hex'),username:name,role:'user',status:'pending',password:hash(pw),sessionVersion:0,createdAt:new Date().toISOString()});
    saveUsers(a);res.json({ok:true,message:'申请已提交，请等待管理员审批'});
  });
  publicRouter.post('/login',(req,res)=>{
    const locked=limited(req);
    const b=req.body||{},u=users().find(x=>x.username.toLowerCase()===String(b.username||'').trim().toLowerCase());
    if(!u||!check(b.password,u.password))return res.status(locked?429:401).json({error:locked?'尝试次数过多，请稍后再试':'账号或密码不正确'});
    if(u.status==='pending')return res.status(403).json({error:'账号正在等待管理员审批'});
    if(u.status!=='approved')return res.status(403).json({error:'账号当前不可用'});
    // 管理员输入正确密码后允许通过当前 IP 的登录限流，输错仍然受限。
    if(u.role==='admin'){
      const ip=String(req.headers['cf-connecting-ip']||req.ip||req.socket.remoteAddress||'unknown');
      attempts.delete(ip);
    }else if(locked)return res.status(429).json({error:'尝试次数过多，请稍后再试'});
    setSession(res,req,u);res.json({ok:true,role:u.role});
  });
  publicRouter.post('/logout',(req,res)=>{clearSession(res,req);res.json({ok:true});});
  function middleware(req,res,next) {
    if(req.path==='/api/ml/oauth/callback'||req.path.startsWith('/api/auth/'))return next();
    if(['/login.html','/auth.js','/auth.css','/admin.js','/favicon.svg','/favicon-16.png','/favicon-32.png','/apple-touch-icon.png'].includes(req.path))return next();
    const u=sessionUser(req);
    if(!u){if(req.path.startsWith('/api/'))return res.status(401).json({error:'需要登录',loginRequired:true});return res.sendFile(path.join(opts.publicDir,'login.html'));}
    if(req.path==='/admin.html'&&u.role!=='admin')return res.status(403).send('无权访问');
    req.user=u;res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');res.setHeader('Pragma','no-cache');
    return runAsUser(u.id,next);
  }
  const adminRouter=express.Router();
  adminRouter.use((req,res,next)=>req.user&&req.user.role==='admin'?next():res.status(403).json({error:'仅管理员可审批账号'}));
  adminRouter.get('/pending',(req,res)=>res.json({pending:users().filter(u=>u.status==='pending').map(u=>({id:u.id,username:u.username,createdAt:u.createdAt}))}));
  adminRouter.post('/users/:id/approve',(req,res)=>{const a=users(),u=a.find(x=>x.id===req.params.id);if(!u||u.role==='admin')return res.status(404).json({error:'账号不存在'});if(u.status!=='pending')return res.status(409).json({error:'该申请已处理'});u.status='approved';u.approvedAt=new Date().toISOString();saveUsers(a);res.json({ok:true});});
  adminRouter.post('/users/:id/reject',(req,res)=>{const a=users(),u=a.find(x=>x.id===req.params.id);if(!u||u.role==='admin')return res.status(404).json({error:'账号不存在'});if(u.status!=='pending')return res.status(409).json({error:'该申请已处理'});u.status='rejected';u.sessionVersion=Number(u.sessionVersion||0)+1;saveUsers(a);res.json({ok:true});});
  return {publicRouter,adminRouter,middleware,currentUserId,runAsUser,userDataFile,users};
}
module.exports=createAuth;

