const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken;
(async()=>{
 for(const p of ['/users/me','/messages/packs/search?seller_id=2079199901','/messages/packs/2000013720394409/sellers/2079199901']){
  const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Authorization:'Bearer '+tok}});const t=await r.text();
  console.log('\n',p,r.status,t.slice(0,300));
 }
})();
