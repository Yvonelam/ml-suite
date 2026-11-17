const fs=require('fs'),path=require('path');
const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));
const PACK='5c9d615c-145b-4246-bd70-5b93ccfcbf3d', uid=String(cfg.mlUserId), token=cfg.mlAccessToken;
const paths=[
 `/messages/packs/${PACK}/sellers/${uid}?tag=post_sale&mark_as_read=false`,
 `/messages/packs/${PACK}/sellers/${uid}?tag=post_sale`,
 `/messages/packs/${PACK}/sellers/${uid}`,
 `/messages/packs/${PACK}`,
 `/messages/packs/${PACK}?role=seller`,
 `/messages/unread?role=seller&tag=post_sale`,
];
(async()=>{
 for(const p of paths){
  const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Accept:'application/json',Authorization:'Bearer '+token},signal:AbortSignal.timeout(25000)});
  const t=await r.text();
  console.log(r.status, p, '→', t.slice(0,150).replace(/\s+/g,' '));
 }
})();
