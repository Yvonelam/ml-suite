const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken,uid='2079199901',A=675253;
const F='clicks,prints,ctr,cost,cpc,acos,roas,cvr,sov,units_quantity,total_amount,direct_amount';
async function get(p,extra){const r=await fetch('https://api.mercadolibre.com'+p,{headers:Object.assign({Authorization:'Bearer '+tok},extra||{})});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,200);}return {s:r.status,j};}
(async()=>{
 const ids=await get(`/users/${uid}/items/search?status=active&limit=3`);
 console.log('items',ids.s,JSON.stringify(ids.j).slice(0,200));
 const id=(ids.j.results||[])[0];
 const one=await get(`/items?ids=${id}&attributes=id,title,seller_sku,price,available_quantity,sold_quantity,status,permalink,health`);
 console.log('\nitem',one.s,JSON.stringify(one.j).slice(0,600));
 const rv=await get('/reviews/item/'+id);console.log('\nreviews',rv.s,JSON.stringify(rv.j).slice(0,300));
 for(const p of [
  `/advertising/MLB/advertisers/${A}/product_ads/ads/search?date_from=2026-11-01&date_to=2026-11-05&metrics=${F}&limit=2`,
  `/advertising/MLB/advertisers/${A}/product_ads/ads/search?date_from=2026-11-01&date_to=2026-11-05&metrics=${F}&aggregation_type=DAILY&limit=2`,
 ]){const r=await get(p,{'api-version':'2'});console.log('\n',r.s,p.includes('DAILY')?'DAILY':'TOTAL','\n',JSON.stringify(r.j).slice(0,800));}
})();
