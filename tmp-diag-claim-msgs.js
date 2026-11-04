process.env.HTTPS_PROXY='http://127.0.0.1:7897';
const fs=require('fs');
const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('E:/ML-suite/auth-data/configs/admin.json','utf8'));
const uid='2079199901', tok=cfg.mlAccessToken;
async function ml(path){const r=await fetch('https://api.mercadolibre.com'+path,{headers:{Authorization:'Bearer '+tok}});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,300);}return {status:r.status,body:j};}
(async()=>{
  const s=await ml(`/post-purchase/v1/claims/search?status=opened&limit=50&offset=0&seller_id=${uid}`);
  const list=(s.body&&(s.body.data||s.body.results||s.body.claims))||[];
  console.log('opened total',s.body.paging&&s.body.paging.total,'got',list.length,'status',s.status);
  for(const c of list){
    const id=String(c.id);
    const m=await ml(`/post-purchase/v1/claims/${id}/messages`);
    const arr=Array.isArray(m.body)?m.body:((m.body&&(m.body.messages||m.body.data))||[]);
    console.log('\n#',id,'type='+c.type,'stage='+c.stage,'status='+c.status,'msgs='+arr.length);
    if(arr.length){
      console.log('  raw[0]=',JSON.stringify(arr[0]).slice(0,400));
      console.log('  senders=',JSON.stringify(arr.map(x=>({s:x.sender_role||x.from,u:x.sender||x.user_id,d:(x.date_created||'').slice(0,10),t:(x.message||x.text||'').slice(0,30)}))).slice(0,900));
    }
  }
})();
