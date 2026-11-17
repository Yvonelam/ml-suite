const fs=require('fs');
const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));
const t=cfg.mlAccessToken, uid=String(cfg.mlUserId);
const post=async (pack,body)=>{const r=await fetch(`https://api.mercadolibre.com/messages/packs/${pack}/sellers/${uid}?tag=post_sale`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});return [r.status,(await r.text()).slice(0,200).replace(/\s+/g,' ')];};
(async()=>{
  const pack='999999999999';   // 不存在的 pack：字段校验在解析 pack 之前，只验 body 契约，不会真发任何消息
  console.log('缺 to      →', ...await post(pack,{from:{user_id:uid},text:'x'}));
  console.log('带 from+to →', ...await post(pack,{from:{user_id:uid},to:{user_id:'812322067'},text:'x'}));
})();
