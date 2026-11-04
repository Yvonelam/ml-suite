const fs=require('fs');const {ProxyAgent,setGlobalDispatcher}=require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7897'));
const cfg=JSON.parse(fs.readFileSync('auth-data/configs/admin.json','utf8'));const tok=cfg.mlAccessToken,uid='2079199901';
async function ml(p){const r=await fetch('https://api.mercadolibre.com'+p,{headers:{Authorization:'Bearer '+tok}});const t=await r.text();let j;try{j=JSON.parse(t);}catch(e){j=t.slice(0,300);}return {s:r.status,j};}
(async()=>{
 for(const u of ['2990248708','61769321','152949619']){const r=await ml('/users/'+u);console.log('user',u,r.s,r.j.nickname||JSON.stringify(r.j).slice(0,120));}
 const c=await ml('/post-purchase/v1/claims/5602839649');console.log('claim order id:',c.j.resource, c.j.resource_id, 'amount', c.j.resolution&&c.j.resolution.applied_amount);
 const r2=await ml('/orders/2000013720394409');console.log('order lookup',r2.j.error||'ok');
 // 找一下最近订单里是否有该数字前缀
 const os=await ml('/orders/search?seller='+uid+'&sort=date_desc&limit=50');
 const ids=(os.j.results||[]).map(o=>o.id);
 console.log('recent order ids sample',ids.slice(0,5),'count',ids.length,'contains?',ids.includes(2000013720394409));
})();
