const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken,A=675253;
const F='clicks,prints,cost,total_amount,units_quantity,acos';
async function get(p){const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Authorization:'Bearer '+tok,'api-version':'2'}});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,120);}return {s:r.status,j};}
(async()=>{
 const base=`/advertising/MLB/advertisers/${A}/product_ads/ads/search?date_from=2026-11-01&date_to=2026-11-02&metrics=${F}&aggregation_type=DAILY`;
 for(const id of ['MLB7247932602','MLB4069609105','NOPE123']){
  const r=await get(base+'&item_id='+id);
  console.log(id, r.s, JSON.stringify((r.j.results||[]).map(x=>({d:x.date,c:x.clicks,p:x.prints,cost:x.cost,amt:x.total_amount}))).slice(0,300));
 }
})();
