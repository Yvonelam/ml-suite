const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken;
(async()=>{
 const r=await fetch('https://api.mercadolibre.com/items/MLB4633031723',{headers:{Authorization:'Bearer '+tok}});
 const j=await r.json();
 console.log(r.status,'seller_sku=',JSON.stringify(j.seller_sku),'| catalog_product_id=',j.catalog_product_id,'| user_product_id=',j.user_product_id,'| attributes with SKU:',(j.attributes||[]).filter(a=>/SKU|SELLER/i.test(a.id+'' +a.name)).map(a=>a.id+'='+a.value_name).join(','));
})();
