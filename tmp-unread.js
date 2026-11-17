const fs=require('fs');
const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));
const t=cfg.mlAccessToken;
const g=async p=>{const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Accept:'application/json',Authorization:'Bearer '+t},signal:AbortSignal.timeout(20000)});return [r.status,(await r.text()).slice(0,400).replace(/\s+/g,' ')];};
(async()=>{
  for(const p of ['/messages/unread?role=seller','/messages/unread?role=seller&tag=post_sale','/messages/unread?role=user','/messages/unread']){
    console.log(...await g(p),'←',p);
  }
})();
