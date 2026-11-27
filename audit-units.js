const http=require('http'),fs=require('fs');
const dev=JSON.parse(fs.readFileSync('auth-data/dev-login.json','utf8'));
const body=Buffer.from(JSON.stringify({username:dev.username,password:dev.password}));
const sum=(a,k)=>a.reduce((s,x)=>s+(Number(x[k])||0),0);
const req=http.request({host:'127.0.0.1',port:3000,path:'/api/auth/login',method:'POST',headers:{'Content-Type':'application/json','Content-Length':body.length}},s=>{
  let d='';s.on('data',c=>d+=c);s.on('end',async()=>{
    const ck=decodeURIComponent([].concat(s.headers['set-cookie']||[]).find(v=>v.startsWith('ml_session=')).split(';')[0].slice(11));
    for(const [from,to,label] of [['2026-10-28','2026-11-27','近30天']]){
      const t0=Date.now();
      let j;
      try{
        const r=await fetch(`http://127.0.0.1:3000/api/ml/profit/orders?from=${from}&to=${to}`,{headers:{cookie:'ml_session='+ck}});
        j=await r.json();
      }catch(e){console.log(label,'FETCH FAIL',e.message,e.cause&&e.cause.code);continue;}
      if(!j.ok){console.log(label,'ERR',JSON.stringify(j).slice(0,300));continue;}
      const S=j.series||[],P=j.products||[],O=j.orders||[],T=j.totals||{};
      console.log(`\n=== ${label} ${from}~${to} 用时${Math.round((Date.now()-t0)/1000)}s ===`);
      console.log(`平台 apiTotal=${j.apiTotal} 实抓 pulled=${j.pulled} 订单行=${O.length} truncated=${j.truncated}`);
      console.log(`totals: allOrders=${T.allOrders} orders=${T.orders} cancelledOrders=${T.cancelledOrders} units=${T.units} validUnits=${T.validUnits} cancelledUnits=${T.cancelledUnits} profitCny=${T.profitCny}`);
      console.log(`products (${P.length}): Σunits=${sum(P,'units')} Σcancelled=${sum(P,'cancelledUnits')} Σorders=${sum(P,'orders')} Σprofit=${sum(P,'profitCny').toFixed(2)}`);
      console.log(`series   (${S.length}): Σunits=${sum(S,'units')} Σcancelled=${sum(S,'cancelledUnits')} Σorders=${sum(S,'orders')} Σprofit=${sum(S,'profitCny').toFixed(2)}`);
      console.log('系列: '+S.map(s=>`${s.series}=${s.units}件/${s.orders}单/${s.listingCount}L/¥${s.profitCny}`).join('  '));
      // 订单行里 series 缺省的行
      const noS=O.filter(x=>!x.series).length;
      console.log('订单行缺系列:',noS,'| 空 itemId 行:',O.filter(x=>!x.itemId).length);
    }
  });
});req.write(body);req.end();
