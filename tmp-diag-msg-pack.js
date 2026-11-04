const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken,uid='2079199901';
async function ml(p){const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Authorization:'Bearer '+tok}});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,300);}return {s:r.status,j};}
(async()=>{
 const o=await ml('/orders/2000013720394409');
 console.log('order',o.s, JSON.stringify({id:o.j.id,pack:o.j.pack_id,buyer:o.j.buyer&&o.j.buyer.id,ship:o.j.shipping&&o.j.shipping.id,status:o.j.status,tags:o.j.tags}).slice(0,400));
 const pack=o.j.pack_id||o.j.id;
 for(const p of [
  `/messages/packs/${pack}/sellers/${uid}`,
  `/messages/packs/${pack}/sellers/${uid}?tag=post_sale`,
  `/messages/packs/${pack}/sellers/${uid}?tag=post_purchase`,
  `/messages/packs/${pack}/users/${uid}`,
 ]){
  const r=await ml(p); console.log('\nGET',p,'→',r.s, JSON.stringify(r.j).slice(0,600));
 }
})();
