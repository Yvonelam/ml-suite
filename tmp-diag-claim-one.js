const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken;
async function ml(p){const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Authorization:'Bearer '+tok}});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,200);}return j;}
(async()=>{
 for(const id of ['5602839649','5605229965','5604807058']){
  const c=await ml('/post-purchase/v1/claims/'+id);
  console.log('\n### claim',id,'status='+c.status,'stage='+c.stage,'type='+c.type,'fulfilled='+c.fulfilled,'reason='+(c.reason_id||''));
  console.log(' players=',JSON.stringify((c.players||[]).map(p=>({t:p.type,uid:p.user_id,acts:(p.available_actions||[]).map(a=>a.action||a)}))).slice(0,500));
  console.log(' resolution=',JSON.stringify(c.resolution||{}).slice(0,200),'related=',JSON.stringify(c.related_entities||[]).slice(0,200));
  const m=await ml('/post-purchase/v1/claims/'+id+'/messages');
  const arr=Array.isArray(m)?m:((m&&(m.messages||m.data))||[]);
  console.log(' msgs('+arr.length+'):');
  for(const x of arr) console.log('   ',x.date_created,'|',x.sender_role,'→',x.receiver_role,'|',(x.message||'').replace(/\n/g,' ').slice(0,90));
 }
})();
