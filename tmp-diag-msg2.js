const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken,uid='2079199901';
async function ml(p){const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Authorization:'Bearer '+tok}});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,300);}return {s:r.status,j};}
(async()=>{
 for(const p of ['/orders/2000013720394409','/packs/2000013720394409','/orders/search?seller='+uid+'&sort=date_desc&limit=5']){
  const r=await ml(p);console.log('\nGET',p,'→',r.s,JSON.stringify(r.j).slice(0,500));
 }
})();
