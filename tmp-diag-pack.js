const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken;
async function get(p){const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Authorization:'Bearer '+tok}});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,200);}return {s:r.status,j};}
(async()=>{
 for(const p of [
  '/messages/packs/2000019147507672/sellers/2079199901?tag=post_sale&mark_as_read=false',
  '/marketplace/messages/packs/2000019147507672?tag=post_sale',
 ]){
  const r=await get(p);
  console.log('\nGET',p,'→',r.s);
  if(r.j&&r.j.messages){console.log(' total',r.j.paging&&r.j.paging.total,'conv',JSON.stringify(r.j.conversation_status||{}).slice(0,200));
    for(const m of r.j.messages)console.log('  ',m.message_date&&m.message_date.created,'|',m.from&&m.from.user_id,'|',String(m.text||'').replace(/\n/g,' ').slice(0,80),'| read=',m.message_date&&m.message_date.read);
  } else console.log(JSON.stringify(r.j).slice(0,500));
 }
})();
