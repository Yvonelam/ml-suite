const fs=require('fs');
const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('daily-search-config.json','utf8'));
(async()=>{
  for(const p of ['/users/me','/messages/unread?role=seller&tag=post_sale']){
    const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Accept:'application/json',Authorization:'Bearer '+cfg.mlAccessToken},signal:AbortSignal.timeout(20000)});
    console.log(r.status,p,'→',(await r.text()).slice(0,120).replace(/\s+/g,' '));
  }
  console.log('refresh_token 存在=',!!cfg.mlRefreshToken,'appId=',!!cfg.mlAppId,'secret=',!!cfg.mlSecret);
})();
