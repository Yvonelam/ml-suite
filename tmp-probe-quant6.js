const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken,A=675253;
const F='clicks,prints,ctr,cost,cpc,acos,roas,cvr,sov,units_quantity,total_amount,direct_amount';
async function get(p){const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Authorization:'Bearer '+tok,'api-version':'2'}});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,150);}return {s:r.status,j};}
(async()=>{
 const r=await get(`/advertising/MLB/advertisers/${A}/product_ads/ads/search?date_from=2026-11-01&date_to=2026-11-05&metrics=${F}&limit=2`);
 const it=(r.j.results||[])[0]||{};
 console.log('item-level keys:',Object.keys(it).join(','));
 console.log('metrics sample:',JSON.stringify({item:it.item_id,cost:it.cost,clicks:it.clicks,prints:it.prints,amount:it.total_amount,units:it.units_quantity,acos:it.acos,metrics:it.metrics}).slice(0,400));
 const rv=await fetch('https://api.mercadolibre.com/reviews/item/MLB4069609105',{headers:{Authorization:'Bearer '+tok}});
 const rj=await rv.json();
 console.log('\nreviews keys:',Object.keys(rj).join(','),'| paging',JSON.stringify(rj.paging),'| rating_average',rj.rating_average, '| total',rj.total);
})();
