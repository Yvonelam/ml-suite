const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken,A=675253;
const F='clicks,prints,ctr,cost,cpc,acos,roas,cvr,sov,units_quantity,total_amount,direct_amount';
async function get(p){const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Authorization:'Bearer '+tok,'api-version':'2'}});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,200);}return {s:r.status,j};}
(async()=>{
 const base=`/advertising/MLB/advertisers/${A}/product_ads/ads/search?date_from=2026-11-01&date_to=2026-11-03&metrics=${F}`;
 for(const q of ['&item_id=MLB7247932602&aggregation_type=DAILY','&item_id=MLB7247932602','&aggregation_type=DAILY&limit=2&offset=0']){
  const r=await get(base+q);
  console.log('\n',r.s,q,'\n',JSON.stringify(r.j).slice(0,600));
 }
})();
