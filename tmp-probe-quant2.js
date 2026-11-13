const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken;
async function get(p,extra){const r=await fetch('https://api.mercadolibre.com'+p,{headers:Object.assign({Authorization:'Bearer '+tok},extra||{})});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,200);}return {s:r.status,j};}
(async()=>{
 const A=675253;
 for(const p of [
  `/advertising/MLB/advertisers/${A}/product_ads/ads/search?date_from=2026-11-01&date_to=2026-11-05&metrics=CLICKS,IMPRESSIONS,COST,SALES,UNITS&limit=2`,
  `/advertising/MLB/advertisers/${A}/product_ads/ads/search?date_from=2026-11-01&date_to=2026-11-05&metrics=CLICKS,IMPRESSIONS,COST&aggregation_type=DAILY&limit=2`,
 ]){const r=await get(p,{'api-version':'2'});console.log('\n',r.s,p.slice(60,150),'\n',JSON.stringify(r.j).slice(0,700));}
 const it=await get('/items?ids=MLB5916441860&attributes=id,title,seller_sku,price,available_quantity,sold_quantity,status,permalink');
 console.log('\nitem',it.s,JSON.stringify(it.j).slice(0,400));
 const rv=await get('/reviews/item/MLB5916441860');
 console.log('\nreviews',rv.s,JSON.stringify(rv.j).slice(0,300));
})();
