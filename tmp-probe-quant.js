const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken,uid='2079199901';
async function get(p,extra){const r=await fetch('https://api.mercadolibre.com'+p,{headers:Object.assign({Authorization:'Bearer '+tok},extra||{})});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,200);}return {s:r.status,j};}
(async()=>{
 // 1. 广告主账户
 const adv=await get('/advertising/advertisers?product_id=PADS',{'api-version':'1'});
 console.log('adv',adv.s,JSON.stringify(adv.j).slice(0,200));
 const site=adv.j&&(adv.j.site_id|| (adv.j.advertisers&&adv.j.advertisers[0]&&adv.j.advertisers[0].site_id))||'MLB';
 // 2. 广告（按商品、按天）
 for(const p of [
  `/advertising/MLB/advertisers/${uid}/product_ads/ads/search?date_from=2026-11-01&date_to=2026-11-05&metrics=CLICKS,IMPRESSIONS,COST,SALES,UNITS&limit=3`,
  `/advertising/MLB/advertisers/${uid}/product_ads/ads/search?date_from=2026-11-01&date_to=2026-11-05&metrics=CLICKS,IMPRESSIONS,COST&aggregation_type=DAILY&limit=3`,
 ]){const r=await get(p,{'api-version':'2'});console.log('\nGET',p.slice(0,120),'→',r.s,JSON.stringify(r.j).slice(0,600));}
 // 3. 访问量
 for(const p of [
  '/visits/items?ids=MLB5916441860',
  '/items/MLB5916441860/visits?date_from=2026-11-01&date_to=2026-11-05',
 ]){const r=await get(p);console.log('\nGET',p,'→',r.s,JSON.stringify(r.j).slice(0,500));}
})();
