const fs=require('fs');
const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));
const t=cfg.mlAccessToken, uid=String(cfg.mlUserId);
const g=async p=>{const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Accept:'application/json',Authorization:'Bearer '+t},signal:AbortSignal.timeout(20000)});return [r.status,(await r.text()).slice(0,220).replace(/\s+/g,' ')];};
(async()=>{
  for(const p of [
    `/messages/users/${uid}`,
    `/messages/users/${uid}/packs`,
    `/messages?role=seller&tag=post_sale`,
    `/messages/packs/search?tag=post_sale`,
    `/post-purchase/v1/claims/5614083666/conversations`,
    `/post-purchase/v1/claims/5614083666/messages?role=seller`,
  ]){ const [s,x]=await g(p); console.log(s,p,'→',x); }
})();
