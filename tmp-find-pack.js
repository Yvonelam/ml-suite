const fs=require('fs');
const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));
const t=cfg.mlAccessToken, uid=String(cfg.mlUserId);
const g=async p=>{const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Accept:'application/json',Authorization:'Bearer '+t,'api-version':'2'},signal:AbortSignal.timeout(25000)});const x=await r.text();return [r.status,x];};
(async()=>{
  for(const p of [
    `/post-purchase/v1/claims/5614083666/messages`,
    `/messages/packs?role=seller&limit=5`,
    `/messages/packs?tag=post_sale&limit=5`,
    `/post-purchase/v1/claims/5614083666`,
  ]){
    const [s,x]=await g(p); console.log(s,p,'→',x.slice(0,400).replace(/\s+/g,' '));console.log('');
  }
})();
