const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken;
async function get(p){const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Authorization:'Bearer '+tok}});const t=await r.text();return {s:r.status,t};}
(async()=>{
 for(const p of ['/messages/unread?role=seller&tag=post_sale','/messages/unread?role=seller','/messages/unread?tag=post_sale']){
  const r=await get(p);console.log('\nGET',p,'→',r.s,'\n',r.t.slice(0,800));
 }
})();
