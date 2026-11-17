const fs=require('fs');
const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));
const t=cfg.mlAccessToken, uid=String(cfg.mlUserId);
const g=async p=>{const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Accept:'application/json',Authorization:'Bearer '+t},signal:AbortSignal.timeout(25000)});return [r.status,await r.text()];};
(async()=>{
  const [s,x]=await g('/orders/2000018945227762');
  console.log('order',s);
  try{const o=JSON.parse(x);console.log('pack_id=',o.pack_id,'shipping=',JSON.stringify(o.shipping&&o.shipping.id),'buyer=',JSON.stringify(o.buyer&&o.buyer.id),'status=',o.status);}catch{console.log(x.slice(0,300));}
  // 用 order 的 pack_id 试会话
  try{
    const o=JSON.parse(x);
    if(o.pack_id){
      const [s2,x2]=await g(`/messages/packs/${o.pack_id}/sellers/${uid}?tag=post_sale&mark_as_read=false`);
      console.log('thread',s2,x2.slice(0,500).replace(/\s+/g,' '));
    }
  }catch(e){console.log('err',e.message);}
})();
