const fs=require('fs');
const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));
const t=cfg.mlAccessToken, uid=String(cfg.mlUserId);
const g=async p=>{const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Accept:'application/json',Authorization:'Bearer '+t},signal:AbortSignal.timeout(25000)});return [r.status,await r.text()];};
(async()=>{
  const [s,x]=await g('/shipments/48241037085');
  console.log('shipment',s, x.slice(0,300).replace(/\s+/g,' '));
  let o={};try{o=JSON.parse(x);}catch{}
  const cands=[o.pack_id,o.id].filter(Boolean).map(String);
  console.log('候选 pack:',cands);
  for(const p of cands){
    const [s2,x2]=await g(`/messages/packs/${p}/sellers/${uid}?tag=post_sale&mark_as_read=false`);
    console.log('thread',p,s2,x2.slice(0,300).replace(/\s+/g,' '));
  }
})();
