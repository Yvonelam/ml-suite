/* =========================================================
   ML Suite
   单页应用：概览 + 关键词排名 + 箱唛裁切
   ========================================================= */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// API 地址：同域时优先用相对路径；file:// 预览时回退 127.0.0.1
// 用 127.0.0.1 而非 localhost：系统代理（Clash）默认放行 127.0.0.1，
// 走 localhost 时请求可能被代理拦截，导致 "Failed to fetch"
const API_BASE = (location.protocol === 'file:' || location.hostname === '')
  ? 'http://127.0.0.1:3000'
  : '';

const ROWS_PER_PAGE = 50;
const CURRENCY_SYMBOLS = { ARS: '$', BRL: 'R$', MXN: '$', CNY: '¥' };

/* =========================================================
   1. 开屏 + 路由
   ========================================================= */
let spT;
let splashNetworkControl = null;
function initSplashNetwork() {
  const canvas = $('#splashNetwork');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
  const sites = $$('#sites span');
  let width = 0, height = 0, dpr = 1, frame = 0, running = false, nodes = [];
  const readColor = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const palette = [readColor('--sp-network-cyan', '#8adfff'), readColor('--sp-network-violet', '#c3a6ff'), readColor('--sp-network-pink', '#ff9bd8')];
  const anchors = [[.17,.34],[.83,.34],[.56,.78]];
  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width || window.innerWidth); height = Math.max(1, rect.height || window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(68, Math.max(34, Math.round(width * height / 22000)));
    nodes = Array.from({ length: count }, (_, i) => ({ x: Math.random()*width, y: Math.random()*height, vx:(Math.random()-.5)*.22, vy:(Math.random()-.5)*.22, r:Math.random()*1.15+.45, group:i%3 }));
  }
  function paint() {
    if (!running) return;
    ctx.clearRect(0, 0, width, height);
    for (const node of nodes) {
      if (!reducedMotion) {
        node.x += node.vx; node.y += node.vy;
        if (node.x < 0 || node.x > width) node.vx *= -1;
        if (node.y < 0 || node.y > height) node.vy *= -1;
      }
    }
    const maxDistance = Math.min(150, Math.max(105, width * .13));
    const activeCount=sites.filter(s=>s.classList.contains('on')).length;
    for (let i=0;i<nodes.length;i++) {
      const a=nodes[i];
      for (let j=i+1;j<nodes.length;j++) {
        const b=nodes[j], dx=a.x-b.x, dy=a.y-b.y, distance=Math.hypot(dx,dy);
        if (distance >= maxDistance) continue;
        ctx.globalAlpha=(1-distance/maxDistance)*(.09+activeCount*.035);
        ctx.strokeStyle=palette[(a.group+b.group)%palette.length]; ctx.lineWidth=.7;
        ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
      }
    }
    for (const node of nodes) {
      ctx.globalAlpha=.26;ctx.fillStyle=palette[node.group];ctx.beginPath();ctx.arc(node.x,node.y,node.r,0,Math.PI*2);ctx.fill();
    }
    sites.forEach((site,i)=>{
      const [px,py]=anchors[i]||[.5,.5],x=width*px,y=height*py;
      const ok=site.classList.contains('on'),bad=site.classList.contains('bad');
      const color=bad?readColor('--sp-failure','#ff8291'):ok?readColor('--sp-success','#70e6c1'):palette[i%palette.length];
      const pulse=reducedMotion?1:(Math.sin(performance.now()/620+i*1.7)+1)/2;
      const radius=(ok||bad?62:36)+pulse*13;
      const glow=ctx.createRadialGradient(x,y,1,x,y,radius);
      glow.addColorStop(0,color);glow.addColorStop(1,'rgba(0,0,0,0)');
      ctx.globalAlpha=ok ? .16 : bad ? .12 : .055;ctx.fillStyle=glow;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();
      if(ok||bad){ctx.globalAlpha=.28;ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.arc(x,y,radius*.72,0,Math.PI*2);ctx.stroke();}
    });
    ctx.globalAlpha=1;
    if (!reducedMotion) frame=requestAnimationFrame(paint);
  }
  window.addEventListener('resize', resize, { passive:true });
  return {
    start(){ if(running)return; running=true; resize(); paint(); },
    stop(){ running=false; cancelAnimationFrame(frame); }
  };
}
function splash() {
  const sp = $('#splash');
  sp.classList.remove('leave');
  if (!splashNetworkControl) splashNetworkControl = initSplashNetwork();
  splashNetworkControl?.start();
  const sites = $$('#sites span'), bar = $('#bar'), tx = $('#stxt');
  const defaults = ['墨西哥 MLM', '巴西 MLB', '阿根廷 MLA'];
  sites.forEach((s, i) => { s.classList.remove('on', 'bad'); s.textContent = defaults[i]; s.title = ''; });
  bar.style.width = '0';
  tx.textContent = '正在初始化本地环境…';
  clearTimeout(spT);

  // ===== 真实站点连接自检 =====
  const checks = [
    { code: 'MLM', name: '墨西哥站点 MLM', el: sites[0], base: defaults[0] },
    { code: 'MLB', name: '巴西站点 MLB', el: sites[1], base: defaults[1] },
    { code: 'MLA', name: '阿根廷站点 MLA', el: sites[2], base: defaults[2] }
  ];
  const t0 = performance.now();
  let done = 0, failed = 0;

  const finish = () => {
    bar.style.width = '100%';
    if (failed === 0) {
      tx.textContent = '自检完成，准备就绪';
    } else if (failed === checks.length) {
      tx.textContent = '所有站点连接失败，请检查本地服务器与代理';
    } else {
      tx.textContent = `准备就绪（${failed} 个站点连接异常）`;
    }
    spT = setTimeout(hideSplash, 900);
  };

  bar.style.width = '12%';
  checks.forEach(({ code, name, el, base }, i) => {
    // 错开一点启动，让动画有节奏
    setTimeout(async () => {
      tx.textContent = '正在连接 ' + name + ' …';
      const start = performance.now();
      let ok = false, ms = 0;
      try {
        const r = await fetch(`${API_BASE}/api/test?site=${code}`, { signal: AbortSignal.timeout(12000) });
        const d = await r.json();
        ok = !!(d && d.success);
        ms = Math.round(performance.now() - start);
      } catch (e) { ok = false; }
      done++;
      if (ok) {
        el.classList.add('on');
        el.textContent = `${base} · ${ms}ms`;
        el.title = `${name} 连接正常，响应 ${ms} ms`;
      } else {
        failed++;
        el.classList.add('bad');
        el.textContent = `${base} · 失败`;
        el.title = `${name} 连接失败，请检查代理/网络`;
      }
      bar.style.width = (12 + done * 29) + '%';
      if (done === checks.length) {
        // 保证开屏至少展示约 2.4 秒，避免一闪而过
        const wait = Math.max(0, 2400 - (performance.now() - t0));
        setTimeout(finish, wait);
      }
    }, 350 + i * 120);
  });
}
function hideSplash() {
  clearTimeout(spT);
  splashNetworkControl?.stop();
  $('#splash').classList.add('leave');
  document.body.classList.add('ready');
  setTimeout(() => { if (currentView === 'hub') drawChart(); }, 600);
}
$('#skip').onclick = hideSplash;
$('#replay').onclick = splash;

const TT = { hub: '概览', ads: '广告投放', orders: '订单管理', questions: '商品问答', claims: '退货与投诉', rank: '关键词排名', box: '箱唛裁切', profit: '产品利润', warehouse: '平台仓库存' };
let currentView = 'hub';
let profitItems = [];
let warehouseRows = [];
let warehouseLoading = false;

function go(v, push = true) {
  currentView = v;
  if (v === 'hub') setTimeout(() => { drawChart(); loadOrderSummary(); loadSales(); loadListings(); loadAds(); loadHubProfitEstimate(); }, 60);
  if (v === 'ads') { loadAds(); loadAdsHourly(); }
  if (v === 'orders') loadOrders();
  if (v === 'questions') { loadQuestions(); loadQuestionAutoReply(); }
  if (v === 'claims') loadClaims();
  if (v === 'profit') { loadProfitListings(); loadProfitOrders(); }
  if (v === 'warehouse') loadWarehouseStock();
  $$('.view').forEach(e => e.classList.toggle('on', e.id === 'v-' + v));
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.go === v));
  $('#ct').textContent = TT[v];
  if (push && history.replaceState) history.replaceState(null, '', '#' + v);
  scrollTo(0, 0);
}

function profitCalc(x) {
  const rate=Number(x.fxRate)||0, cost=(Number(x.cost?.costCny)||0)*rate, freight=(Number(x.cost?.freightCny)||0)*rate;
  if (!rate || x.fee==null || x.shipping==null || x.cost?.costCny==='' || x.cost?.costCny==null || x.cost?.freightCny==='' || x.cost?.freightCny==null) return null;
  return Number(x.price||0)-Number(x.fee||0)-Number(x.shipping)-cost-freight-(Number(x.cost?.otherFee)||0);
}
function renderProfitListings() {
  const q=($('#profitSearch')?.value||'').trim().toLowerCase(), rows=$('#profitRows'); if(!rows)return;
  const list=profitItems.filter(x=>!q||x.title.toLowerCase().includes(q)||x.id.toLowerCase().includes(q));
  rows.innerHTML=list.length?list.map(x=>'<tr><td><div class="profit-product">'+(x.thumbnail?'<img src="'+escHtml(x.thumbnail)+'" alt="">':'<span class="profit-thumb">ML</span>')+'<div><a target="_blank" rel="noopener" href="'+escHtml(x.permalink)+'">'+escHtml(x.title)+'</a><small>'+escHtml(x.id)+' · '+escHtml(x.site)+'</small></div></div></td><td><input class="profit-input" type="number" min="0" step="0.01" data-field="costCny" data-id="'+escHtml(x.id)+'" value="'+escHtml(x.cost?.costCny??'')+'" placeholder="0.00"></td><td><input class="profit-input" type="number" min="0" step="0.01" data-field="freightCny" data-id="'+escHtml(x.id)+'" value="'+escHtml(x.cost?.freightCny??'')+'" placeholder="0.00"></td></tr>').join(''):'<tr><td colspan="3" class="empty">'+(profitItems.length?'没有匹配的商品':'当前账户没有读取到在售 Listing')+'</td></tr>';
  const costCnt=$('#profitCostCnt');if(costCnt){costCnt.textContent=String(profitItems.length);costCnt.hidden=!profitItems.length;}
  $('#profitStatus').textContent=profitItems.length?'已加载 '+profitItems.length+' 个在售 Listing。请填写人民币产品成本与头程，并保存到当前账户。':'暂时没有可显示的 Listing。';
}
async function loadProfitListings(refresh=false) {
  const status=$('#profitStatus');if(!status)return;status.textContent='正在同步当前账户的在售 Listing…';
  try { const d=await mlGet('/api/ml/profit/listings'+(refresh?'?refresh=1':''));profitItems=d.items||[];const rates=profitItems.filter(x=>x.fxCnyPer100),quote=rates.map(x=>x.fxPublishedAt).filter(Boolean).sort().at(-1);$('#profitFxNote').textContent=rates.length?'汇率：中国银行现汇卖出价（无现汇牌价时用中行折算价，人民币/100当地币）'+(quote?' · 牌价 '+quote:''):'中国银行暂无在售币种牌价，相关利润待核对。';renderProfitListings(); }
  catch(e){profitItems=[];status.textContent=e.message;$('#profitRows').innerHTML='<tr><td colspan="3" class="empty">'+escHtml(e.message)+'</td></tr>';}
}
function renderWarehouseStock(){
  const q=($('#warehouseSearch')?.value||'').trim().toLowerCase(),tbody=$('#warehouseRows');if(!tbody)return;
  const rows=warehouseRows.filter(x=>!q||x.title.toLowerCase().includes(q)||x.id.toLowerCase().includes(q));
  tbody.innerHTML=rows.length?rows.map(x=>{
    const detail=x.variations.flatMap(v=>v.detail.map(d=>({status:d.status,quantity:d.quantity,label:v.label}))).filter(d=>Number(d.quantity)>0);
    const notes=[];if(x.missingInventoryId)notes.push('缺少库存编号');for(const e of x.errors)if(!notes.includes(e))notes.push(e);
    const state=detail.map(d=>'<span class="warehouse-state">'+escHtml(d.status)+' '+escHtml(d.quantity)+(d.label?' · '+escHtml(d.label):'')+'</span>').join('');
    return '<tr><td><div class="profit-product">'+(x.thumbnail?'<img src="'+escHtml(x.thumbnail)+'" alt="">':'<span class="profit-thumb">ML</span>')+'<div><a target="_blank" rel="noopener" href="'+escHtml(x.permalink)+'">'+escHtml(x.title||('Listing '+x.id))+'</a><small>'+escHtml(x.id)+'</small></div></div></td><td class="warehouse-number">'+(x.available==null?'<span class="warehouse-unknown">待确认</span>':escHtml(x.available))+'</td><td class="warehouse-number">'+(x.notAvailable==null?'—':escHtml(x.notAvailable))+'</td><td>'+(state||'—')+(notes.length?'<small class="warehouse-error">'+notes.map(escHtml).join(' · ')+'</small>':'')+'</td></tr>';
  }).join(''):'<tr><td colspan="4" class="empty">'+(warehouseRows.length?'没有匹配的 Listing':'当前账户没有检测到平台仓 Listing')+'</td></tr>';
}
async function loadWarehouseStock(refresh=false){
  const status=$('#warehouseUpdated'),body=$('#warehouseRows'),button=$('#warehouseRefresh');if(!status||!body)return;
  if(warehouseLoading)return;warehouseLoading=true;
  if(button&&refresh){button.disabled=true;button.textContent='正在刷新…';}
  status.textContent='正在同步平台仓库存…';
  try{
    const d=await mlGet('/api/ml/warehouse-stock'+(refresh?'?refresh=1':''));if(!d.ok)throw Error(d.message||'库存读取失败');
    warehouseRows=d.rows||[];const s=d.summary||{};
    $('#warehouseListingCount').textContent=String(s.listings??warehouseRows.length);$('#warehouseAvailable').textContent=String(s.available??0);$('#warehouseConfirmed').textContent=String(s.confirmed??0);$('#warehouseUnknown').textContent=String(s.unknown??0);
    renderWarehouseStock();const date=new Date(d.updatedAt||Date.now());status.textContent='最近更新：'+date.toLocaleString('zh-CN')+(d.cached?' · 缓存数据':'')+(d.truncated?' · Listing 超过接口单次统计范围，结果可能不完整':'');
  }catch(e){body.innerHTML='<tr><td colspan="5" class="empty">'+escHtml(e.message)+'</td></tr>';status.textContent='库存同步失败：'+e.message;}
  finally{warehouseLoading=false;if(button&&refresh){button.disabled=false;button.textContent='立即刷新';}}
}
function setProfitOrderRange(range,run=true){
  const today=brToday(),from=range==='7'?addDays(today,-6):range==='30'?addDays(today,-29):today;
  $('#profitOrderFrom').value=from;$('#profitOrderTo').value=today;
  $('#profitOrderRange')?.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.range===range));
  if(run&&range!=='custom')loadProfitOrders();
}
// 订单利润表的币种是**固定搭配**，不做切换 —— 跟着实际核对习惯走：
//   订单收入 / 平台佣金 / 尾程运费 → 平台原币（巴西站 = 巴币 R$），跟美客多后台一一对得上
//   成本与头程 / 订单利润        → 人民币，因为成本是按人民币采购价填的，利润也想直接看赚了多少人民币
// 两者不能直接相减（币种不同），所以每格都挂了 title：鼠标一停就能看到另一币种的数值。
let lastProfitOrderData = null;

// 平台原币的展示名（巴西站 BRL → 巴币）
function profitLocalCode() {
  return (lastProfitOrderData && lastProfitOrderData.orders && lastProfitOrderData.orders[0] && lastProfitOrderData.orders[0].currency) || 'BRL';
}
function profitLocalLabel() {
  const c = profitLocalCode();
  return c === 'BRL' ? '巴币' : c;
}
function applyProfitHeaders() {
  const c = profitLocalLabel();
  const set = (id, text) => { const el = $('#' + id); if (el) el.textContent = text; };
  set('poThRev', '订单收入（' + c + '）');
  set('poThFee', '平台佣金（' + c + '）');
  set('poThShip', '尾程运费（' + c + '）');
  set('poThTax', '税费（' + c + '）');
  set('poThCost', '成本与头程（人民币）');
  set('poThProfit', '订单利润（人民币）');
}

function renderProfitOrders(data){
  const rows=$('#profitOrderRows'),summary=$('#profitOrderSummary');if(!rows||!summary)return;
  lastProfitOrderData=data;
  const items=data.orders||[],totals=data.totals||{},lcur=profitLocalCode();
  applyProfitHeaders();
  // 利润合计固定按人民币（成本和利润列都是人民币口径），且**只含有效单**
  const profitSum = Number(totals.profitCny || 0);
  const afterAds=totals.profitAfterAdsCny,ads=data.ads||{};
  const profitSumLocal = items.filter(x=>!x.cancelled&&x.profit!==null).reduce((s,x)=>s+(Number(x.profit)||0),0);
  const deadOrders=Number(totals.cancelledOrders||0),deadUnits=Number(totals.cancelledUnits||0);
  summary.hidden=false;
  // 「单数 / 件数」必须跟美客多后台对得上 —— 后台用的是**含取消单**口径，
  // 所以这里主数字给全量，副标题拆出有效 / 取消，不再只报「有效订单」让你没法核对。
  summary.innerHTML=
     '<div class="profit-order-stat"><small>全部订单</small><b>'+fmt(totals.allOrders||0)+'</b><small class="sub">'+(deadOrders?('取消 / 退款 '+fmt(deadOrders)+' 单'):'无取消单')+'</small></div>'
    +'<div class="profit-order-stat"><small>售出件数</small><b>'+fmt(totals.units||0)+'</b><small class="sub">有效 '+fmt(totals.validUnits||0)+' 件'+(deadUnits?(' · 取消 '+fmt(deadUnits)+' 件'):'')+'</small></div>'
    +'<div class="profit-order-stat"><small>可算商品行</small><b>'+fmt(totals.matched||0)+' / '+fmt(totals.validLines||0)+'</b><small class="sub">'+((totals.unmatched||0)?('待核对 '+fmt(totals.unmatched)+' 行'):'全部核算完成')+'</small></div>'
    +'<div class="profit-order-stat" title="折合 '+money(profitSumLocal,lcur)+'"><small>订单利润合计（人民币）</small><b class="'+(profitSum<0?'negative':'')+'">'+money(profitSum,'CNY')+'</b><small class="sub">有效 '+fmt(totals.profitUnits||0)+' 件计入</small></div>'
    +'<div class="profit-order-stat"><small>当前期间广告总额（'+escHtml(ads.currency||lcur)+'）</small><b class="'+(!ads.available?'pending':'')+'">'+(ads.available?money(ads.costLocal,ads.currency||lcur):'待读取')+'</b><small class="sub">'+(ads.available?'折合 '+money(ads.costCny,'CNY')+(ads.fxCnyPer100?' · 中行牌价 '+Number(ads.fxCnyPer100).toFixed(2)+'/100 '+escHtml(ads.currency):'')+(ads.fxPublishedAt?' · '+escHtml(ads.fxPublishedAt):''):escHtml(ads.error||'广告数据暂不可用'))+'</small></div>'
    +'<div class="profit-order-stat"><small>扣除广告费后净利润（人民币）</small><b class="'+(afterAds!==null&&afterAds!==undefined&&Number(afterAds)<0?'negative':'')+'">'+(ads.available?money(afterAds,'CNY'):'—')+'</b><small class="sub">订单利润减去当前期间广告总额</small></div>'
    +'<div class="profit-order-stat"><small>广告前利润率</small><b>'+(totals.margin==null?'—':Number(totals.margin).toFixed(2)+'%')+'</b><small class="sub">订单利润 ÷ 收入</small></div>';
  renderProfitProducts(data);
  if(!items.length){rows.innerHTML='<tr><td colspan="9" class="empty">所选日期范围内没有订单</td></tr>';return;}
  rows.innerHTML=items.map(x=>{
    const date=x.date?new Date(x.date).toLocaleString('zh-CN',{timeZone:'America/Sao_Paulo',hour12:false}):'—',
          complete=x.profit!==null,miss=(x.missing||[]).join('、'),dead=!!x.cancelled;
    // 前四列：平台原币（巴币）；成本与利润：人民币
    const rev=x.revenue,fee=x.saleFee,ship=x.shipping,tax=x.tax,
          cost=x.costCny,profit=x.profitCny;
    // 税费独立成列：运费列只显示运费本身，税单独一格，列名与内容对得上
    const taxAssumed=!!x.taxAssumed;
    const shipCell=ship===null?'待核对':money(ship,lcur);
    const taxCell=tax===null||tax===undefined?'待核对':money(tax,lcur);
    const cls=complete&&Number(profit)<0?'negative':'positive';
    // 每格挂 title 显示另一币种，币种不同也能互相核对
    const revT=x.revenueCny===null?'':'折合 '+money(x.revenueCny,'CNY');
    const feeT=x.saleFeeCny===null?'':'折合 '+money(x.saleFeeCny,'CNY');
    const shipT=x.shippingCny===null?'':'折合 '+money(x.shippingCny,'CNY');
    const taxT=x.taxCny===null||x.taxCny===undefined?'':(taxAssumed?'平台未代扣，按订单收入 8% 估算 · ':'')+'折合 '+money(x.taxCny,'CNY');
    const costT=x.cost===null?'':'折合 '+money(x.cost,lcur);
    const profitT=x.profit===null?'':'折合 '+money(x.profit,lcur);
    // 取消 / 退款单：列出收入与平台佣金（让你看清这单丢了多少钱），运费/成本/利润一律不给假数
    const badge=dead?'<span class="po-badge off">已取消</span>':'';
    const detail=!dead&&x.statusDetail&&/cancel|refund/i.test(x.statusDetail)?'<span class="po-badge off">'+escHtml(x.statusDetail)+'</span>':'';
    return '<tr'+(dead?' class="dead"':'')+'><td>'+escHtml(date)+badge+detail+'<small>订单 '+escHtml(x.orderId)+'</small></td>'
      +'<td><span class="profit-order-title" title="'+escHtml(x.title)+'">'+escHtml(x.title)+'</span><small>'+escHtml(x.itemId)+'</small></td>'
      +'<td>'+fmt(x.qty)+(Number(x.qty)>1?'<small>单笔多件</small>':'')+'</td>'
      +'<td title="'+escHtml(revT)+'">'+money(rev,lcur)+'</td>'
      +'<td'+(feeT?' title="'+escHtml(feeT)+'"':'')+'>'+(fee===null?'—':money(fee,lcur))+'</td>'
      +'<td'+(shipT?' title="'+escHtml(shipT)+'"':'')+'>'+(dead?'—':shipCell)+'</td>'
      +'<td'+(taxT?' title="'+escHtml(taxT)+'"':'')+'>'+(dead?'—':taxCell)+'</td>'
      +'<td'+(costT?' title="'+escHtml(costT)+'"':'')+'>'+(dead?'—':(cost===null?'待核对':money(cost,'CNY')))+'</td>'
      +'<td class="'+(dead?'pending':(complete?cls:'pending'))+'"'+(profitT?' title="'+escHtml(profitT)+'"':'')+'>'
        +(dead?'<span class="po-badge off">已取消</span>':(complete?money(profit,'CNY'):'待核对'))
        +((!dead&&miss)?'<small title="'+escHtml(miss)+'">'+escHtml(miss)+'</small>':'')+'</td></tr>';
  }).join('');
}

// 产品出单统计：按 Listing 聚合，带主图。件数口径跟上面汇总一致（有效件数 / 取消件数分开）。
function renderProfitProducts(data){
  const box=$('#profitProducts');if(!box)return;
  const list=(data.products||[]).slice();
  if(!list.length){box.hidden=true;box.innerHTML='';return;}
  const lcur=profitLocalCode();
  const validUnits=list.reduce((s,p)=>s+(Number(p.units)||0),0);
  const deadUnits=list.reduce((s,p)=>s+(Number(p.cancelledUnits)||0),0);
  const cards=list.map(p=>{
    const thumb=String(p.thumbnail||'').replace(/^http:\/\//i,'https://');
    const profit=Number(p.profitCny)||0,cls=profit<0?'negative':'';
    const img=thumb
      ?'<img class="pp-img" src="'+escHtml(thumb)+'" alt="" loading="lazy" referrerpolicy="no-referrer">'
      :'<span class="pp-img pp-img-ph">'+escHtml(String(p.title||p.itemId||'?').slice(0,1).toUpperCase())+'</span>';
    const pending=(Number(p.lines)||0)-(Number(p.computed)||0)-(Number(p.cancelledLines)||0);
    const body='<div class="pp-body">'
      +'<div class="pp-title" title="'+escHtml(p.title)+'">'+escHtml(p.title||p.itemId||'（未知商品）')+'</div>'
      +'<div class="pp-id">'+escHtml(p.itemId||'—')+'</div>'
      +'<div class="pp-metrics"><span class="pp-units"><b>'+fmt(p.units||0)+'</b> 件</span><span class="pp-orders">'+fmt(p.orders||0)+' 单</span>'
        +((Number(p.cancelledUnits)||0)?'<span class="pp-dead" title="该 Listing 在所选区间有取消 / 退款件数，不计入利润">取消 '+fmt(p.cancelledUnits)+' 件</span>':'')+'</div>'
      +'<div class="pp-money"><span title="折合 '+money(p.revenueCny,'CNY')+'">收入 '+money(p.revenue,lcur)+'</span>'
        +'<span class="pp-profit '+cls+'">利润 '+money(profit,'CNY')+'</span></div>'
      +'<div class="pp-metrics"><span class="pp-margin">利润率 '+(p.margin==null?'—':Number(p.margin).toFixed(2)+'%')+'</span>'
        +(pending>0?'<span class="pp-warn">'+fmt(pending)+' 行待核对</span>':'')+'</div>'
      +'</div>';
    return p.permalink
      ?'<a class="pp-card" href="'+escHtml(p.permalink)+'" target="_blank" rel="noreferrer">'+img+body+'</a>'
      :'<div class="pp-card">'+img+body+'</div>';
  }).join('');
  box.hidden=false;
  box.innerHTML='<div class="pp-head"><h3>产品出单统计<span class="pp-count">'+fmt(list.length)+' 个产品</span></h3>'
    +'<p>按 Listing 汇总所选区间：有效 <b>'+fmt(validUnits)+'</b> 件'+(deadUnits?(' · 取消 / 退款 <b>'+fmt(deadUnits)+'</b> 件'):'')
    +' · Listing 利润保持原口径；广告总额只从页面总利润中扣除，不分摊到商品 · 点卡片可打开该 Listing</p></div>'
    +'<div class="pp-grid">'+cards+'</div>';
}
async function loadProfitOrders(refresh=false){
  const status=$('#profitOrderStatus'),from=$('#profitOrderFrom')?.value,to=$('#profitOrderTo')?.value;if(!status||!from||!to)return;
  if(from>to){status.textContent='开始日期不能晚于结束日期。';return;}
  status.textContent='正在读取订单并匹配 Listing 成本…';$('#profitOrderApply').disabled=true;
  try{const d=await mlGet('/api/ml/profit/orders?from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to)+(refresh?'&refresh=1':''));renderProfitOrders(d);
    // 状态行必须把「平台共多少单 / 实际抓到多少单」摆出来，否则少抓了也看不出来（原来 779 单只显示 465 单就是这个坑）
    const T=d.totals||{};
    status.textContent='订单范围：'+d.range.from+' 至 '+d.range.to
      +' · 平台共 '+fmt(d.apiTotal||0)+' 单，实抓 '+(d.pulled===d.apiTotal?'全部 '+fmt(d.pulled||0)+' 单 ✓':fmt(d.pulled||0)+' 单（差 '+fmt((d.apiTotal||0)-(d.pulled||0))+' 单）')
      +' · 有效 '+fmt(T.orders||0)+' 单 / '+fmt(T.validUnits||0)+' 件'
      +((T.cancelledOrders)?' · 取消/退款 '+fmt(T.cancelledOrders)+' 单（'+fmt(T.cancelledUnits||0)+' 件，已列在表里并置灰，不计利润）':'')
      +' · 共售出 '+fmt(T.units||0)+' 件'
      +(d.ads?.available?' · 已读取当前期间广告总额 '+money(d.ads.costLocal,d.ads.currency||'BRL')+'（折合 '+money(d.ads.costCny,'CNY')+'）': ' · 广告费未计入净利润：'+(d.ads?.error||'广告数据读取失败'))
      +' · 已计算 '+fmt(T.matched||0)+' / '+fmt(T.validLines||0)+' 行'
      +((T.unmatched||0)?' · '+fmt(T.unmatched)+' 行待核对，请查看各行原因':'')
      +(d.cached?' · 缓存数据':' · 已更新');}
  catch(e){$('#profitOrderSummary').hidden=true;$('#profitOrderRows').innerHTML='<tr><td colspan="9" class="empty">'+escHtml(e.message)+'</td></tr>';status.textContent='订单读取失败：'+e.message;}
  finally{$('#profitOrderApply').disabled=false;}
}
/* ---- 税费估算税率：输入框按百分比显示，存到服务器按小数 ---- */
function showTaxRateState(text, bad) {
  const el = $('#profitTaxRateState'); if (!el) return;
  el.textContent = text || '';
  el.style.color = bad ? 'var(--bad)' : 'var(--ok)';
  el.classList.add('show');
  clearTimeout(showTaxRateState._t);
  showTaxRateState._t = setTimeout(() => el.classList.remove('show'), 2600);
}
async function loadProfitTaxRate() {
  try {
    const d = await mlGet('/api/ml/profit/settings');
    const pct = Number(d?.taxRate);
    if (Number.isFinite(pct)) $('#profitTaxRate').value = String(Math.round(pct * 1000) / 10);
  } catch { /* 读不到就用页面默认值 8 */ }
}
function bindProfitTaxRate() {
  loadProfitTaxRate();
  $('#profitTaxRateSave')?.addEventListener('click', async e => {
    const btn = e.currentTarget, input = $('#profitTaxRate'); if (!btn || !input) return;
    const raw = Number(input.value);
    if (!Number.isFinite(raw) || raw < 0 || raw >= 100) { showTaxRateState('税率需为 0 ~ 99 之间的数字', true); return; }
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await fetch('/api/ml/profit/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taxRate: raw / 100 }) });
      const d = await r.json(); if (!r.ok) throw Error(d.error || '保存失败');
      showTaxRateState('已保存 · 税率 ' + (Math.round(raw * 10) / 10) + '%');
      await loadProfitOrders(true);   // 用新税率重算
    } catch (err) { showTaxRateState('保存失败：' + err.message, true); }
    finally { btn.disabled = false; btn.textContent = '保存并重算'; }
  });
}
function bindProfitEvents(){
  $('#profitRefresh')?.addEventListener('click',async e=>{const b=e.currentTarget;if(b.disabled)return;b.disabled=true;b.textContent='正在刷新…';try{await loadProfitListings(true);}finally{b.disabled=false;b.textContent='刷新商品/运费';}});$('#profitSearch')?.addEventListener('input',renderProfitListings);
  applyProfitHeaders();   // 表头按平台币种命名，先对齐再加载数据
  bindProfitTaxRate();    // 税费估算税率：加载 + 保存后重算
  setProfitOrderRange('today',false);
  $('#profitOrderRange')?.addEventListener('click',e=>{const b=e.target.closest('button[data-range]');if(!b)return;if(b.dataset.range==='custom'){ $('#profitOrderRange').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));$('#profitOrderFrom').focus();return;}setProfitOrderRange(b.dataset.range,true);});
  $('#profitOrderFrom')?.addEventListener('change',()=>$('#profitOrderRange')?.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.range==='custom')));
  $('#profitOrderTo')?.addEventListener('change',()=>$('#profitOrderRange')?.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.range==='custom')));
  $('#profitOrderApply')?.addEventListener('click',()=>loadProfitOrders(true));
  $('#profitSave')?.addEventListener('click',async e=>{
    const button=e.currentTarget;if(button.disabled||!profitItems.length)return;
    button.disabled=true;button.textContent='正在保存…';
    try{
      $('#profitRows')?.querySelectorAll('.profit-input').forEach(input=>{const x=profitItems.find(v=>v.id===input.dataset.id);if(!x)return;x.cost=x.cost||{};x.cost[input.dataset.field]=input.value===''?'':Number(input.value);});
      const payload={items:profitItems.map(x=>({id:x.id,costCny:x.cost?.costCny??'',freightCny:x.cost?.freightCny??'',otherFee:x.cost?.otherFee??''}))};
      const r=await fetch('/api/ml/profit/items',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok)throw Error(d.error||'保存失败');
      $('#profitStatus').textContent='已保存 '+d.saved+' 个 Listing 的产品成本与头程到当前账户。';
      if(typeof toast==='function')toast('费用数据已保存');
    }catch(err){$('#profitStatus').textContent='保存失败：'+err.message;}
    finally{button.disabled=false;button.textContent='保存成本与头程';}
  });
  $('#profitCalculate')?.addEventListener('click',async(e)=>{
    const button=e.currentTarget;button.disabled=true;button.textContent='正在计算…';
    renderProfitListings();
    const calculated=profitItems.map(x=>({item:x,profit:profitCalc(x),fx:Number(x.fxRate)||0})).filter(x=>x.profit!=null&&x.fx);
    const totalCny=calculated.reduce((sum,x)=>sum+x.profit/x.fx,0),margin=calculated.length?calculated.reduce((sum,x)=>sum+(x.profit/x.fx)/(Number(x.item.price)/x.fx)*100,0)/calculated.length:0;
    const result=$('#profitResult');result.hidden=false;
    result.innerHTML='<div class="profit-result-card"><small>成功计算</small><b>'+calculated.length+' / '+profitItems.length+' 个 Listing</b></div><div class="profit-result-card"><small>预估总利润（折合人民币）</small><b class="'+(totalCny<0?'negative':'')+'">'+(calculated.length?escHtml(money(totalCny,'CNY')):'—')+'</b></div><div class="profit-result-card"><small>平均 Listing 利润率</small><b>'+(calculated.length?margin.toFixed(1)+'%':'—')+'</b></div><p>未计入结果的 Listing 缺少成本、头程、汇率、平台费或运费数据；请补齐后再次计算。</p>';
    $('#profitStatus').textContent='Listing 预估已计算；正在更新所选日期的订单利润。';
    await loadProfitOrders(true);
    button.disabled=false;button.textContent='计算利润';
    if(typeof toast==='function')toast('Listing 与订单利润已更新，金额按人民币显示');
  });
  $('#profitRows')?.addEventListener('change',async e=>{const input=e.target.closest('.profit-input');if(!input)return;const x=profitItems.find(v=>v.id===input.dataset.id);if(!x)return;const field=input.dataset.field,val=input.value===''?'':Number(input.value);if(val!==''&&(!Number.isFinite(val)||val<0)){input.value='';return;}
    x.cost=x.cost||{costCny:'',freightCny:'',otherFee:''};x.cost[field]=val;renderProfitListings();
    try{const r=await fetch('/api/ml/profit/items/'+encodeURIComponent(x.id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(x.cost)});const d=await r.json();if(!r.ok)throw Error(d.error||'保存失败');$('#profitStatus').textContent='该 Listing 的产品成本与头程已保存到当前账户。';}
    catch(err){$('#profitStatus').textContent=err.message;}
  });
}

$('#warehouseRefresh')?.addEventListener('click',()=>loadWarehouseStock(true));
$('#warehouseSearch')?.addEventListener('input',renderWarehouseStock);
setInterval(()=>{if(currentView==='warehouse')loadWarehouseStock();},300000);

document.addEventListener('click', e => {
  const t = e.target.closest('[data-go]');
  if (t) go(t.dataset.go);
});

function initRouting() {
  const hash = location.hash.replace(/^#/, '');
  if (TT[hash]) go(hash, false);
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace(/^#/, '');
    if (TT[h]) go(h, false);
  });
}

/* =========================================================
   2. 概览页：图表 + 实时热搜 + 站点状态
   ========================================================= */
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }

function sparklines() {
  $$('.spk').forEach(e => {
    const v = (e.dataset.v || '0').split(',').map(Number);
    if (!v.length || v.every(x => !x)) { e.innerHTML = ''; return; }
    const mx = Math.max(...v), mn = Math.min(...v), w = 96, h = 28;
    e.innerHTML = `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" points="${v.map((a, i) => `${(i * w / (v.length - 1)).toFixed(1)},${(h - 2 - (a - mn) / ((mx - mn) || 1) * (h - 4)).toFixed(1)}`).join(' ')}"/></svg>`;
  });
}

function rnd(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

function drawChart() {
  const k = +$('#cp .on').dataset.p, n = k;
  const r = rnd(k * 97 + 3);
  const base = k === 12 ? 900 : k === 30 ? 60 : 70;
  const up = k === 12 ? 3.2 : k === 30 ? 1.9 : 1.5;
  const v = [...Array(n)].map((_, i) => Math.round(base * (1 + (up - 1) * i / (n - 1)) * (.9 + r() * .2)));
  const W = 800, H = 260, L = 44, R = 16, T = 18, B = 30;
  const mx = Math.max(...v) * 1.12;
  const x = i => L + i * (W - L - R) / (n - 1);
  const y = a => H - B - a / mx * (H - T - B);
  let d = `M${x(0)} ${y(v[0])}`;
  for (let i = 1; i < n; i++) { const c = (x(i - 1) + x(i)) / 2; d += `C${c} ${y(v[i - 1])} ${c} ${y(v[i])} ${x(i)} ${y(v[i])}`; }
  const lab = i => k === 12 ? (i + 1) + '月' : k === 7 ? ['一', '二', '三', '四', '五', '六', '日'][i] : (i + 1) + '日';
  const step = k === 30 ? 5 : 1;
  let g = '';
  for (let j = 0; j <= 4; j++) { const a = mx / 1.12 * j / 4, yy = y(a); g += `<line class="gl2" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="tx" x="${L - 8}" y="${yy + 4}" text-anchor="end">${Math.round(a)}</text>`; }
  for (let i = 0; i < n; i += step) g += `<text class="tx" x="${x(i)}" y="${H - 8}" text-anchor="middle">${lab(i)}</text>`;
  $('#cs').innerHTML = `<defs><linearGradient id="lg" x1="0" x2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#3b82f6"/></linearGradient><linearGradient id="ag" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity=".35"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>${g}<path class="ar2" d="${d}L${x(n - 1)} ${H - B}L${x(0)} ${H - B}Z"/><path class="ln" pathLength="1" d="${d}"/><circle class="ep" cx="${x(n - 1)}" cy="${y(v[n - 1])}" r="6"/><circle class="ed" cx="${x(n - 1)}" cy="${y(v[n - 1])}" r="5"/><line class="cx" id="cx" y1="${T}" y2="${H - B}"/><circle class="hd" id="hd" r="5"/>`;

  const s = v.reduce((a, b) => a + b, 0);
  const h = Math.max(1, Math.floor(n / 3));
  const gr = (v.slice(-h).reduce((a, b) => a + b, 0) / v.slice(0, h).reduce((a, b) => a + b, 0) - 1) * 100;
  countUp($('#kg'), gr, e => '+' + e.toFixed(1) + '%');
  countUp($('#kt'), s, e => fmt(Math.round(e)));

  const svg = $('#cs'), tip = $('#tip'), cx = $('#cx'), hd = $('#hd');
  svg.onmousemove = e => {
    const rc = svg.getBoundingClientRect(), px = (e.clientX - rc.left) / rc.width * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - L) / ((W - L - R) / (n - 1)))));
    cx.setAttribute('x1', x(i)); cx.setAttribute('x2', x(i)); cx.style.opacity = 1;
    hd.setAttribute('cx', x(i)); hd.setAttribute('cy', y(v[i])); hd.style.opacity = 1;
    tip.innerHTML = `<span>${k === 12 ? (i + 1) + ' 月' : k === 7 ? '周' + lab(i) : (i + 1) + ' 日'}</span><b>${fmt(v[i])} 件</b>`;
    tip.style.left = x(i) / W * 100 + '%'; tip.style.top = y(v[i]) / H * rc.height + 'px'; tip.style.opacity = 1;
  };
  svg.onmouseleave = () => { cx.style.opacity = 0; hd.style.opacity = 0; tip.style.opacity = 0; };
}

function countUp(el, to, fmtf, ms = 1500) {
  cancelAnimationFrame(el._r);
  const t0 = performance.now();
  (function f(t) {
    const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtf(to * e);
    if (p < 1) el._r = requestAnimationFrame(f);
  })(t0);
}

$$('#cp button').forEach(b => b.onclick = () => { $$('#cp button').forEach(x => x.classList.toggle('on', x === b)); drawChart(); });

// 实时热搜词（真实数据：大麦数据 MCP）
// 热度口径 = 该关键词 Top100 商品的「近30天销量合计」，归一化到 0-100（后端算好的）。
// 接口只回缓存、过期由后端后台异步刷新，所以下面这个 60 秒轮询很便宜、不扣积分。
let LV = [];
let lvLoadedAt = 0;

function lvRender() {
  $('#rl').innerHTML = LV.map((d, i) =>
    `<div class="rw" data-i="${i}"><span class="rn"></span><div class="nm"><b>${escHtml(d.k)}</b><small>${escHtml(d.z)}</small></div><div class="vol"><span></span><i></i></div><b class="dl"></b></div>`
  ).join('');
}
function lvPaint(flash) {
  if (!LV.length) return;
  const s = [...LV].sort((a, b) => b.v - a.v), mx = s[0].v || 1;
  s.forEach((d, r) => {
    const el = $(`#rl [data-i="${LV.indexOf(d)}"]`);
    if (!el) return;
    el.style.transform = `translateY(${r * 52}px)`;
    el.querySelector('.rn').textContent = r + 1;
    el.querySelector('.vol span').textContent = Math.round(d.v);
    el.querySelector('.vol i').style.width = Math.max(4, d.v / mx * 100) + '%';
    const ch = d.b - r, dl = el.querySelector('.dl');
    dl.textContent = ch > 0 ? '▲ ' + ch : ch < 0 ? '▼ ' + (-ch) : '—';
    dl.className = 'dl' + (ch < 0 ? ' dn' : ch === 0 ? ' fl' : '');
    if (flash && d.p !== r) { el.classList.remove('gu', 'rd'); void el.offsetWidth; el.classList.add(r < d.p ? 'gu' : 'rd'); }
    d.p = r;
  });
}
function lvNote(text) { const el = $('#lvsrc'); if (el) el.textContent = text; }

async function loadHotKeywords(force) {
  try {
    const r = await fetch(`${API_BASE}/api/dm/hot-keywords${force ? '?force=1' : ''}`, { signal: AbortSignal.timeout(28000) });
    const d = await r.json();
    if (!d || !d.ok) return;
    if (!d.items || !d.items.length) {
      if (!LV.length) {
        $('#rl').innerHTML = '<div class="rw" style="transform:none"><span class="rn">…</span>'
          + '<div class="nm"><b>正在从大麦数据抓取真实数据…</b><small>首次约需 1-2 分钟</small></div></div>';
      }
      lvNote('首次抓取中，请稍候…');
      return;
    }
    const prev = new Map(LV.map(x => [x.k, x.v]));
    LV = d.items.map((it, i) => ({
      k: it.keyword, z: it.label || '', v: it.heat, o: it.heat, b: i, p: i,
      sales: it.sales30d, listings: it.listings,
    }));
    lvRender();
    lvPaint(true);
    lvLoadedAt = d.updatedAt;
    $('#lvt').textContent = '更新于 ' + fmtDate(d.updatedAt) + '（巴西时间）';
    lvNote(`数据来源：大麦数据 MCP · 每 ${d.ttlHours} 小时刷新（每次约 ${d.cost} 积分）`);
    if (prev.size && [...prev].some(([k, v]) => { const n = LV.find(x => x.k === k); return n && n.v !== v; })) {
      toast('📈 热搜词已更新（大麦数据真实数据）');
    }
  } catch (e) { /* 网络失败保留旧数据 */ }
}

$('#lvb').onclick = () => {
  const b = $('#lvb');
  b.disabled = true; b.textContent = '刷新中…';
  lvNote('正在向大麦数据请求…');
  Promise.resolve(loadHotKeywords(true)).finally(() => {
    setTimeout(() => { b.disabled = false; b.textContent = '刷新'; }, 1500);
  });
};

// 首屏 + 每 5 分钟轻量轮询一次（只读后端缓存，不扣积分；真正的大麦抓取由后端按 24 小时周期自己跑）
loadHotKeywords(false);
setInterval(() => {
  if (!document.hidden && $('#v-hub').classList.contains('on')) loadHotKeywords(false);
}, 300000);

// 站点状态检测
async function checkSite(code) {
  const start = performance.now();
  try {
    const r = await fetch(`${API_BASE}/api/test?site=${code}`, { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    const ms = Math.round(performance.now() - start);
    const ok = d.success;
    $(`#lat-${code}`).textContent = ok ? `响应 ${ms} ms` : d.message;
    const st = $(`#status-${code}`);
    st.innerHTML = ok ? '<i></i>正常' : '<i class="off"></i>异常';
    st.className = 'st' + (ok ? '' : ' dn');
  } catch (e) {
    $(`#lat-${code}`).textContent = '检测失败';
    const st = $(`#status-${code}`);
    st.innerHTML = '<i class="off"></i>异常';
    st.className = 'st dn';
  }
}

/* =========================================================
   3. 关键词排名
   ========================================================= */
let currentResults = [], currentPage = 1, currentKeyword = '', currentFilter = '';
let currentBatchResults = [], currentBatchKeyword = '';
let autoSaveTimer = null, suppressAutoSave = true;

function switchRankTab(mode) {
  // 只管排名页自己的页签：产品利润页也用了 .tabs，全局选中会互相抢
  $$('#v-rank .tabs button').forEach(b => b.classList.toggle('on', b.dataset.m === mode));
  $('#rank-single').style.display = mode === 's' ? 'block' : 'none';
  $('#rank-batch').style.display = mode === 'b' ? 'block' : 'none';
  $('#rank-cfg').style.display = mode === 'cfg' ? 'block' : 'none';
}
$$('#v-rank .tabs button').forEach(b => b.onclick = () => switchRankTab(b.dataset.m));
/* ---- 产品利润页：子页签（按订单计算利润 / Listing 成本与头程） ---- */
function switchProfitTab(p) {
  $$('#profitSubTabs button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  const o = $('#profitPanelOrders'), c = $('#profitPanelCosts');
  if (o) o.hidden = p !== 'orders';
  if (c) c.hidden = p !== 'costs';
}
$$('#profitSubTabs button').forEach(b => b.onclick = () => switchProfitTab(b.dataset.p));
/* ---- 美术风格切换：点侧边栏 Logo 弹菜单，选择后立即生效并记住 ----
   主题层是四张可选样式表：theme-mist（柔雾玻璃，最底层材质）/ theme-color（彩色毛玻璃）/
   theme-gold（典藏金）/ theme-motion（动态玻璃）。后三张都建立在 mist 之上。
   全关 = 经典深色；只开 mist = 柔雾玻璃；mist+color = 彩色毛玻璃；
   mist+gold = 典藏金；mist+color+motion = 动态玻璃（沿用毛玻璃的配色材质，只把背景换成循环视频）。 */
const THEMES = { classic: '经典深色', mist: '柔雾玻璃', glass: '彩色毛玻璃', gold: '典藏金', motion: '动态玻璃' };

/* 背景视频只在「动态玻璃」下播放：
   - data-src 而不是 src，没选这套皮肤就一个字节都不下载
   - 系统开了「减少动态效果」就只停在首帧
   - 切到别的皮肤立刻暂停，别让它在背后空转解码 13 秒的 1280×672 */
let bgVideoToken = 0;
function syncBgVideo(t) {
  const v = document.getElementById('bgVideo');
  if (!v) return;
  // 快速来回切主题时，上一个还没等到缓冲的定时器会继续跑，得让它认得出自己已过期
  const token = ++bgVideoToken;
  const alive = () => token === bgVideoToken;
  const play = () => { if (!alive()) return; const p = v.play(); if (p && p.catch) p.catch(() => { }); };
  const stop = () => { try { v.pause(); } catch (e) { } };
  if (t !== 'motion') { stop(); return; }
  if (!v.getAttribute('src')) {
    const src = v.getAttribute('data-src');
    if (src) { v.setAttribute('src', src); v.load(); }
  }
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { stop(); return; }
  /* 起播门坎：这 414KB 是通过隧道边播边下的。
     一挂上 src 就 play()，会得到「播几帧 → 缓冲 → 再播几帧」的观感，
     看起来就是掉帧。先等它缓冲到「整段可播」（readyState≥4）再开始；
     等待期间看到的是 poster，静止一瞬好过抖一整段。
     最多等 5 秒 —— 网速实在不行就先播着，别一直定在海报上。 */
  const start = () => {
    if (!alive()) return;
    v.removeEventListener('canplaythrough', start);
    play();
  };
  if (v.readyState >= 4) { play(); return; }
  v.addEventListener('canplaythrough', start, { once: true });
  setTimeout(start, 5000);
}
document.addEventListener('visibilitychange', () => {
  const v = document.getElementById('bgVideo');
  if (!v || !v.getAttribute('src')) return;
  if (document.hidden) { try { v.pause(); } catch (e) { } }
  else if (document.documentElement.dataset.theme === 'motion') syncBgVideo('motion');
});

function applyTheme(t) {
  if (!THEMES[t]) t = 'glass';
  const mist = $('#themeMist'), color = $('#themeColor'), gold = $('#themeGold'), motion = $('#themeMotion');
  if (mist) mist.disabled = (t === 'classic');
  if (color) color.disabled = (t !== 'glass' && t !== 'motion');
  if (gold) gold.disabled = (t !== 'gold');
  if (motion) motion.disabled = (t !== 'motion');
  document.documentElement.dataset.theme = t;
  $$('.theme-item').forEach(b => {
    const on = b.dataset.t === t;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  try { localStorage.setItem('mlsuiteTheme', t); } catch (e) { }
  syncBgVideo(t);
  if (typeof toast === 'function') toast('已切换到「' + THEMES[t] + '」');
}
function bindThemeMenu() {
  let t = 'glass';
  try { const s = localStorage.getItem('mlsuiteTheme'); if (THEMES[s]) t = s; } catch (e) { }
  applyTheme(t);
  const brand = $('#brandLogo'), menu = $('#themeMenu');
  if (!brand || !menu) return;
  const toggle = () => { menu.hidden = !menu.hidden; brand.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true'); };
  brand.addEventListener('click', e => { e.stopPropagation(); toggle(); });
  brand.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('#themeMenu')) { menu.hidden = true; brand.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { menu.hidden = true; brand.setAttribute('aria-expanded', 'false'); } });
  $$('.theme-item').forEach(b => b.addEventListener('click', () => { applyTheme(b.dataset.t); menu.hidden = true; brand.setAttribute('aria-expanded', 'false'); }));
}
bindThemeMenu();

function showProg(pct) {
  const pr = $('#prog');
  if (pct == null) { pr.style.display = 'none'; pr.firstElementChild.style.width = '0'; }
  else { pr.style.display = 'block'; pr.firstElementChild.style.width = Math.min(100, pct) + '%'; }
}
function showRankError(msg) {
  const el = $('#rankError');
  if (!msg) el.style.display = 'none';
  else { el.textContent = msg; el.style.display = 'block'; }
}
function escHtml(t) { if (!t) return ''; const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function priceStr(r) { const sym = r.currencySymbol || CURRENCY_SYMBOLS[r.currency] || ''; const s = r.priceDisplay || (r.price > 0 ? r.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'); return sym + ' ' + s; }
function rankClass(n) { return n === 1 ? 't1' : n <= 3 ? 't3' : n <= 10 ? 't10' : ''; }

// 单关键词搜索
async function doSearch() {
  const keyword = $('#kw').value.trim();
  const site = $('#site').value;
  const pages = +$('#pg').value;
  const filter = $('#filter').value.trim();
  if (!keyword) { $('#kw').focus(); return; }
  currentKeyword = keyword; currentFilter = filter.toLowerCase();
  showRankError(null);
  $('#singleRes').style.display = 'none';
  showProg(10);
  $('#go').disabled = true;
  try {
    const params = new URLSearchParams({ keyword, site, pages, productFilter: filter });
    const r = await fetch(`${API_BASE}/api/search?${params}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '搜索失败');
    currentResults = d.results || []; currentPage = 1;
    renderSingleResults(d);
  } catch (e) {
    showRankError('搜索失败：' + e.message);
  } finally { showProg(null); $('#go').disabled = false; }
}
$('#go').onclick = doSearch;
$('#kw').addEventListener('keypress', e => { if (e.key === 'Enter') doSearch(); });
$('#filter').addEventListener('keypress', e => { if (e.key === 'Enter') doSearch(); });
$('#testConn').onclick = async () => {
  const btn = $('#testConn'); btn.disabled = true; btn.textContent = '检测中…';
  await checkSite($('#site').value);
  btn.disabled = false; btn.textContent = '测试连接';
};

function renderSingleResults(data) {
  $('#singleRes').style.display = 'block';
  $('#singleSum').innerHTML = `
    <div><b>${fmt(data.totalResults)}</b><span>总结果数</span></div>
    <div><b>${data.pagesSearched}</b><span>已搜索页数</span></div>
    <div><b>${data.resultsCount}</b><span>已获取商品</span></div>
    ${data.matchedCount !== null ? `<div><b style="color:var(--warn)">${data.matchedCount}</b><span>匹配商品</span></div>` : ''}`;

  const ms = $('#matchedSection');
  if (data.matchedProducts) {
    ms.style.display = 'block';
    if (data.matchedProducts.length) {
      ms.innerHTML = `<h4>🎯 匹配的产品（共 ${data.matchedProducts.length} 个）</h4>` + data.matchedProducts.map(p => `
        <div class="matched-item"><span class="rank">第${p.page}页 第${p.rankInPage}位</span><span class="title">${escHtml(p.title)}</span><span>${priceStr(p)}</span><a href="${p.link}" target="_blank">查看 →</a></div>`).join('');
    } else {
      ms.innerHTML = `<h4>🎯 未找到匹配产品</h4><div class="empty">在前 ${data.pagesSearched} 页中未找到包含 "${escHtml(currentFilter)}" 的产品</div>`;
    }
  } else ms.style.display = 'none';

  updateSingleInfo(); renderSingleTable();
}
function updateSingleInfo() {
  const total = currentResults.length;
  const start = total ? (currentPage - 1) * ROWS_PER_PAGE + 1 : 0;
  const end = Math.min(currentPage * ROWS_PER_PAGE, total);
  $('#singleInfo').textContent = `共 ${total} 个商品 · 显示 ${start}-${end}`;
}
function renderSingleTable() {
  const tbody = $('#singleTable tbody');
  const start = (currentPage - 1) * ROWS_PER_PAGE;
  const rows = currentResults.slice(start, start + ROWS_PER_PAGE);
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无数据</td></tr>'; $('#singlePagination').innerHTML = ''; return; }
  tbody.innerHTML = rows.map(r => {
    const isMatch = currentFilter && r.title.toLowerCase().includes(currentFilter);
    return `<tr class="${isMatch ? 'hit' : ''}"><td><span class="rk ${rankClass(r.overallRank)}">${r.overallRank}</span></td><td><span class="page-badge">P${r.page}</span></td><td>${r.rankInPage}</td><td><a href="${r.link}" target="_blank">${escHtml(r.title)}</a></td><td>${priceStr(r)}</td><td>${escHtml(r.seller)}</td><td><a href="${r.link}" target="_blank">🔗</a></td></tr>`;
  }).join('');
  renderPagination($('#singlePagination'), Math.ceil(currentResults.length / ROWS_PER_PAGE), currentPage, p => { currentPage = p; renderSingleTable(); updateSingleInfo(); });
}
function renderPagination(el, total, cur, cb) {
  if (total <= 1) { el.innerHTML = ''; return; }
  let h = `<button ${cur === 1 ? 'disabled' : ''}>‹</button>`;
  const max = 7; let s = Math.max(1, cur - 3), e = Math.min(total, s + max - 1);
  if (e - s < max - 1) s = Math.max(1, e - max + 1);
  if (s > 1) h += `<button>1</button>${s > 2 ? '<span>…</span>' : ''}`;
  for (let i = s; i <= e; i++) h += `<button class="${i === cur ? 'on' : ''}">${i}</button>`;
  if (e < total) h += `${e < total - 1 ? '<span>…</span>' : ''}<button>${total}</button>`;
  h += `<button ${cur === total ? 'disabled' : ''}>›</button>`;
  el.innerHTML = h;
  const btns = el.querySelectorAll('button');
  btns.forEach((b, idx) => {
    b.onclick = () => {
      let np = cur;
      if (idx === 0) np = cur - 1;
      else if (idx === btns.length - 1) np = cur + 1;
      else np = +b.textContent;
      cb(np);
    };
  });
}
$('#singleExport').onclick = () => {
  if (!currentResults.length) return toast('暂无数据可导出', 'err');
  const headers = ['总排名', '页码', '页内位次', '产品标题', '价格', '币种', '卖家', '商品链接', '商品ID'];
  const rows = currentResults.map(r => [r.overallRank, r.page, r.rankInPage, `"${r.title.replace(/"/g, '""')}"`, r.priceDisplay || r.price, r.currency, `"${(r.seller || '').replace(/"/g, '""')}"`, r.link, r.id]);
  downloadCSV('美客多搜索_' + currentKeyword + '_' + brToday() + '.csv', headers, rows);
};

// 批量搜索
function updateBatchCount() {
  const c = $('#bt').value.split('\n').map(t => t.trim()).filter(t => t).length;
  $('#bt-count').textContent = c;
}
$('#bt').addEventListener('input', updateBatchCount);
$('#bclear').onclick = () => { $('#bt').value = ''; updateBatchCount(); };

async function doBatchSearch() {
  const keyword = $('#bkw').value.trim();
  const site = $('#bsite').value;
  const pages = +$('#bpg').value;
  const titles = $('#bt').value.trim();
  if (!keyword) { $('#bkw').focus(); return; }
  const list = titles.split('\n').map(t => t.trim()).filter(t => t);
  if (!list.length) { toast('请至少输入一个产品标题', 'err'); return; }
  if (list.length > 100) { toast('最多 100 个产品标题', 'err'); return; }
  currentBatchKeyword = keyword;
  showRankError(null);
  $('#batchRes').style.display = 'none';
  showProg(10); $('#bgo').disabled = true;
  try {
    const params = new URLSearchParams({ keyword, site, pages, titles });
    const r = await fetch(`${API_BASE}/api/batch-search?${params}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '批量搜索失败');
    currentBatchResults = d.results || [];
    renderBatchResults(d);
  } catch (e) {
    showRankError('批量搜索失败：' + e.message);
  } finally { showProg(null); $('#bgo').disabled = false; }
}
$('#bgo').onclick = doBatchSearch;
$('#bkw').addEventListener('keypress', e => { if (e.key === 'Enter') doBatchSearch(); });

function renderBatchResults(data) {
  $('#batchRes').style.display = 'block';
  $('#batchSum').innerHTML = `
    <div><b>${data.productCount}</b><span>产品总数</span></div>
    <div><b style="color:var(--ok)">${data.foundCount}</b><span>已找到</span></div>
    <div><b style="color:var(--bad)">${data.notFoundCount}</b><span>未找到</span></div>
    <div><b>${data.pagesSearched}</b><span>搜索页数</span></div>`;
  $('#batchInfo').textContent = `关键词：${data.keyword} · 站点：${data.siteName} · 共搜索 ${data.totalItems} 个商品`;
  $('#batchTable tbody').innerHTML = data.results.map(r => {
    if (!r.found) return `<tr><td>${r.index}</td><td><span class="tag bad">未找到</span></td><td>-</td><td>-</td><td>-</td><td>${escHtml(r.searchTitle)}</td><td style="color:var(--mut)">未在前 ${data.pagesSearched} 页匹配到</td><td>-</td><td>-</td></tr>`;
    const badge = r.matchCount > 1 ? `<span class="tag" style="background:#3b1417;color:#f87171">${r.matchCount} 个匹配</span>` : '';
    return `<tr><td>${r.index}</td><td><span class="tag">已找到</span></td><td><span class="page-badge">P${r.page}</span></td><td><span class="rk ${rankClass(r.rankInPage)}">${r.rankInPage}</span></td><td><span class="rk ${rankClass(r.overallRank)}">${r.overallRank}</span></td><td>${escHtml(r.searchTitle)}</td><td><a href="${r.link}" target="_blank">${escHtml(r.matchedTitle)}</a>${badge}</td><td>${priceStr(r)}</td><td><a href="${r.link}" target="_blank">🔗</a></td></tr>`;
  }).join('');
}
$('#batchExport').onclick = () => {
  if (!currentBatchResults.length) return toast('暂无数据可导出', 'err');
  const headers = ['序号', '状态', '页码', '页内位次', '总排名', '搜索的产品标题', '匹配的实际标题', '价格', '币种', '卖家', '匹配数', '商品链接'];
  const rows = currentBatchResults.map(r => [r.index, r.found ? '已找到' : '未找到', r.page || '', r.rankInPage || '', r.overallRank || '', `"${r.searchTitle.replace(/"/g, '""')}"`, `"${(r.matchedTitle || '').replace(/"/g, '""')}"`, r.priceDisplay || '', r.currency, `"${(r.seller || '').replace(/"/g, '""')}"`, r.matchCount, r.link || '']);
  downloadCSV('美客多批量搜索_' + currentBatchKeyword + '_' + brToday() + '.csv', headers, rows);
};

function downloadCSV(name, headers, rows) {
  const csv = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/* =========================================================
   4. 定时报告配置
   ========================================================= */
function buildTimeOptions() {
  const hh = $('#cfgScheduleHour'), mm = $('#cfgScheduleMinute');
  for (let i = 0; i < 24; i++) hh.innerHTML += `<option value="${i}">${String(i).padStart(2, '0')}</option>`;
  [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].forEach(m => mm.innerHTML += `<option value="${m}">${String(m).padStart(2, '0')}</option>`);
}
buildTimeOptions();

async function loadConfig() {
  try {
    const r = await fetch(`${API_BASE}/api/config`);
    const c = await r.json();
    $('#cfgKeyword').value = c.keyword || '';
    $('#cfgPages').value = c.pages || 5;
    $('#cfgEmail').value = c.email || '';
    $('#cfgSmtpHost').value = c.smtpHost || 'smtp.qq.com';
    $('#cfgSmtpPort').value = c.smtpPort || 465;
    $('#cfgSmtpUser').value = c.smtpUser || '';
    $('#cfgSmtpPass').value = '';
    $('#cfgSmtpPass').placeholder = c.smtpPassSet ? '已设置，留空则不修改' : '请输入 SMTP 授权码';
    $('#cfgScheduleHour').value = c.scheduleHour ?? 14;
    $('#cfgScheduleMinute').value = c.scheduleMinute ?? 0;
    $('#cfgScheduleEnabled').checked = !!c.scheduleEnabled;
    if (c.productTitles && c.productTitles.length) $('#cfgProductTitles').value = c.productTitles.join('\n');
    const sites = c.sites || ['MLM'];
    $('#cfgSiteMLM').checked = sites.includes('MLM');
    $('#cfgSiteMLB').checked = sites.includes('MLB');
    $('#cfgSiteMLA').checked = sites.includes('MLA');
    updateCfgCount(); updateScheduleToggle(); updateOverviewConfig(c); loadReportStatus();
    setTimeout(() => { suppressAutoSave = false; }, 300);
  } catch (e) { console.error('加载配置失败', e); suppressAutoSave = false; }
}

function collectConfig() {
  const titles = $('#cfgProductTitles').value.trim();
  const sites = [];
  if ($('#cfgSiteMLM').checked) sites.push('MLM');
  if ($('#cfgSiteMLB').checked) sites.push('MLB');
  if ($('#cfgSiteMLA').checked) sites.push('MLA');
  return {
    keyword: $('#cfgKeyword').value.trim(),
    productTitles: titles.split('\n').map(t => t.trim()).filter(t => t),
    sites,
    pages: +$('#cfgPages').value,
    email: $('#cfgEmail').value.trim(),
    scheduleEnabled: $('#cfgScheduleEnabled').checked,
    scheduleHour: +$('#cfgScheduleHour').value,
    scheduleMinute: +$('#cfgScheduleMinute').value,
    smtpHost: $('#cfgSmtpHost').value.trim() || 'smtp.qq.com',
    smtpPort: +$('#cfgSmtpPort').value || 465,
    smtpUser: $('#cfgSmtpUser').value.trim(),
    smtpPass: $('#cfgSmtpPass').value.trim()
  };
}
function validateConfig(c) {
  if (!c.keyword) return '请输入搜索关键词';
  if (!c.productTitles.length) return '请输入至少一个产品标题';
  if (!c.email) return '请输入收件邮箱';
  if (!c.sites.length) return '请至少选择一个站点';
  return null;
}
async function postConfig(c) {
  return fetch(`${API_BASE}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
}
function scheduleAutoSave() {
  if (suppressAutoSave) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(autoSaveConfig, 1500);
}
async function autoSaveConfig() {
  const c = collectConfig();
  if (validateConfig(c)) return;
  try {
    const r = await postConfig(c); const d = await r.json();
    if (r.ok && d.success) {
      showCfgStatus(`✓ 已自动保存 ${brClock().slice(0, 5)}（巴西时间）`, 'autosave');
      updateOverviewConfig(c);
    }
  } catch { }
}
async function saveConfigManual() {
  const c = collectConfig(), err = validateConfig(c);
  if (err) { showCfgStatus('⚠️ ' + err, 'error'); return; }
  const btn = $('#saveConfig'); btn.disabled = true;
  try {
    const r = await postConfig(c); const d = await r.json();
    if (r.ok && d.success) { showCfgStatus('✅ 设置已保存' + (c.scheduleEnabled ? ` · 每日 ${c.scheduleHour}:${String(c.scheduleMinute).padStart(2, '0')} 北京时间` : ''), 'success'); updateOverviewConfig(c); loadReportStatus(); }
    else showCfgStatus('❌ 保存失败：' + (d.error || '未知错误'), 'error');
  } catch (e) { showCfgStatus('❌ 请求失败：' + e.message, 'error'); }
  finally { btn.disabled = false; }
}
async function sendReportNow() {
  const c = collectConfig();
  if (!c.keyword || !c.email) { showCfgStatus('请先填写关键词和邮箱并保存', 'error'); return; }
  await saveConfigManual();
  const btn = $('#sendReport'); btn.disabled = true;
  showCfgStatus('📧 正在搜索并发送邮件，请耐心等待…', 'loading');
  try {
    const r = await fetch(`${API_BASE}/api/send-report`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const d = await r.json();
    if (r.ok && d.success) showCfgStatus('✅ 报告已发送至 ' + (d.message || c.email), 'success');
    else showCfgStatus('❌ 发送失败：' + (d.error || '未知错误'), 'error');
  } catch (e) { showCfgStatus('❌ 请求失败：' + e.message, 'error'); }
  finally { btn.disabled = false; loadReportStatus(); }
}
function updateCfgCount() {
  const c = $('#cfgProductTitles').value.split('\n').map(t => t.trim()).filter(t => t).length;
  $('#cfg-count').textContent = c;
}
function updateScheduleToggle() {
  const on = $('#cfgScheduleEnabled').checked;
  $('#scheduleStatusLabel').textContent = on ? '已启用' : '未启用';
  $('#scheduleStatusLabel').style.color = on ? 'var(--ok)' : 'var(--mut)';
}
function showCfgStatus(msg, type) {
  const el = $('#cfgStatus');
  el.textContent = msg; el.className = 'config-status ' + type; el.style.display = 'block';
}
function updateOverviewConfig(c) {
  const ts = c.productTitles.length;
  $('#kpi-keywords').textContent = c.keyword || '—';
  $('#kpi-titles').textContent = ts || '—';
  $('#task-schedule').textContent = c.scheduleEnabled ? `每日 ${c.scheduleHour}:${String(c.scheduleMinute).padStart(2, '0')} 发送` : '未启用';
  const st = $('#status-schedule');
  st.innerHTML = c.scheduleEnabled ? '<i></i>已启用' : '<i class="off"></i>未启用';
  // 基于配置更新 sparkline 数据（模拟）
  const kpi = $$('.kpi');
  kpi[0].querySelector('.spk').dataset.v = [ts, ts, ts + 1, ts + 1, ts + 2, ts + 2, ts + 3, ts + 3].join(',');
  kpi[3].querySelector('.spk').dataset.v = [0, 0, Math.min(ts, 10), Math.min(ts * 2, 20), Math.min(ts * 3, 40), Math.min(ts * 4, 60), Math.min(ts * 5, 80), Math.min(ts * 6, 100)].join(',');
  sparklines();
}

/* ---------- 发报运行状态（上次/下次发送）----------
   用户反馈「设了 14:00 却早上 6 点收到」。根因是外面的兜底任务抢发，
   已停用；这里把「服务端实际认定的下次发送时间」直接摊在界面上的北京时间，
   避免再出现「我设的时间到底有没有生效」的疑问。 */
let reportRuntimeTimer = null;
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

async function loadReportStatus() {
  const panel = $('#reportRuntime'); if (!panel) return;
  try {
    const r = await fetch(`${API_BASE}/api/report/status`);
    const s = await r.json();
    renderReportRuntime(s);
  } catch (e) {
    panel.style.display = 'block';
    panel.innerHTML = '<span class="bad">无法读取发报状态（服务未响应）</span>';
  }
}
function renderReportRuntime(s) {
  const panel = $('#reportRuntime'); if (!panel || !s || !s.ok) return;
  panel.style.display = 'block';
  const pad2 = n => String(Number(n) || 0).padStart(2, '0');
  const hhmm = `${pad2(s.scheduleHour)}:${pad2(s.scheduleMinute)}`;
  const rows = [];

  rows.push(s.scheduleEnabled
    ? `调度：<b>已启用</b> · 每日 <span class="hl">${hhmm}</span> 北京时间`
    : `调度：<b>未启用</b>`);

  if (s.lastDate) {
    rows.push(`上次发送：<b>${escHtml(s.lastAt || s.lastDate)}</b> · ${s.lastError ? '<span class="bad">失败</span>' : '<span class="hl">成功</span>'}`);
  } else {
    rows.push(`上次发送：<b>暂无记录</b>`);
  }
  if (s.lastError) rows.push(`最近错误：<span class="bad">${escHtml(s.lastError)}</span>`);

  rows.push(s.scheduleEnabled && s.nextRunAt
    ? `下次发送：<span class="hl">${escHtml(s.nextRunAt)}</span> 北京时间`
    : `下次发送：<b>—</b>`);

  rows.push(`服务器当前北京时间：<b>${escHtml(s.serverNow || '')}</b>`);

  // 表单里选的时间如果跟已保存的不一致，提示还没生效
  const fh = $('#cfgScheduleHour'), fm = $('#cfgScheduleMinute');
  if (fh && fm && s.scheduleEnabled) {
    const formHHMM = `${pad2(fh.value)}:${pad2(fm.value)}`;
    if (formHHMM !== hhmm) rows.push(`<span class="bad">⚠ 表单时间是 ${formHHMM}，尚未保存生效（点「保存设置」后生效）</span>`);
  }

  panel.innerHTML = rows.join('<br>');
}
function refreshReportRuntimeSoon() {
  clearTimeout(reportRuntimeTimer);
  reportRuntimeTimer = setTimeout(loadReportStatus, 1800); // 等自动保存落库后再读
}

function bindConfigEvents() {
  ['cfgKeyword', 'cfgEmail', 'cfgSmtpHost', 'cfgSmtpPort', 'cfgSmtpUser', 'cfgSmtpPass'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('input', scheduleAutoSave); else console.warn('missing element:', id);
  });
  ['cfgPages', 'cfgScheduleHour', 'cfgScheduleMinute', 'cfgSiteMLM', 'cfgSiteMLB', 'cfgSiteMLA'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('change', scheduleAutoSave); else console.warn('missing element:', id);
  });
  // 改发报时间时，除了自动保存，稍后再拉一次运行状态，让「下次发送」立刻跟上
  ['cfgScheduleHour', 'cfgScheduleMinute'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('change', refreshReportRuntimeSoon);
  });
  const cpt = $('#cfgProductTitles'); if (cpt) cpt.addEventListener('input', () => { updateCfgCount(); scheduleAutoSave(); });
  const cse = $('#cfgScheduleEnabled'); if (cse) cse.addEventListener('change', () => { updateScheduleToggle(); scheduleAutoSave(); refreshReportRuntimeSoon(); });
  const sc = $('#saveConfig'); if (sc) sc.onclick = saveConfigManual;
  const sr = $('#sendReport'); if (sr) sr.onclick = sendReportNow;
}

/* =========================================================
   5. 箱唛裁切（纯前端）
   ========================================================= */
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const { PDFDocument } = PDFLib;
const MM2PT = 72 / 25.4;
const POOL = 2;

const boxState = {
  fileName: '', srcBytes: null, pages: [],
  mode: 'auto', gapAuto: true,
  params: { gapMm: 3, minSizeMm: 8, quality: 1.6, marginMm: 1.5, rows: 2, cols: 2 }
};

const nextTick = () => new Promise(r => setTimeout(r, 0));
function toast(msg, kind) {
  const el = $('#toast'); el.textContent = msg; el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.className = 'toast'; }, 2600);
}
function setBoxProgress(pct, text) {
  const el = $('#progress');
  if (pct == null) { el.style.display = 'none'; return; }
  el.style.display = 'grid'; $('#progress-fill').style.width = Math.round(pct * 100) + '%';
  if (text) $('#progress-text').textContent = text;
}
function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); }; }

function computeThreshold(img) {
  const { width: W, height: H, data } = img;
  const samples = [];
  const stepX = Math.max(1, Math.floor(W / 80));
  const stepY = Math.max(1, Math.floor(H / 80));
  const push = (x, y) => {
    const i = (y * W + x) * 4;
    const a = data[i + 3];
    const lum = a < 24 ? 255 : (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    samples.push(lum);
  };
  for (let x = 0; x < W; x += stepX) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y += stepY) { push(0, y); push(W - 1, y); }
  samples.sort((a, b) => a - b);
  const bg = samples[Math.floor(samples.length * 0.78)] || 255;
  return Math.max(50, Math.min(245, bg > 200 ? bg - 10 : bg - 14));
}
function buildMask(img) {
  const { width: W, height: H, data } = img;
  const thr = computeThreshold(img);
  const mw = Math.max(1, Math.ceil(W / POOL));
  const mh = Math.max(1, Math.ceil(H / POOL));
  const mask = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const y0 = y * POOL;
    for (let x = 0; x < mw; x++) {
      const x0 = x * POOL;
      let on = 0;
      for (let dy = 0; dy < POOL && !on; dy++) {
        const yy = y0 + dy; if (yy >= H) break;
        const row = yy * W;
        for (let dx = 0; dx < POOL; dx++) {
          const xx = x0 + dx; if (xx >= W) break;
          const i = (row + xx) * 4;
          if (data[i + 3] < 24) continue;
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (lum < thr) { on = 1; break; }
        }
      }
      mask[y * mw + x] = on;
    }
  }
  return { mask, maskW: mw, maskH: mh };
}
function buildIntegral(mask, W, H) {
  const S = new Uint32Array((W + 1) * (H + 1));
  const stride = W + 1;
  for (let y = 0; y < H; y++) {
    let run = 0;
    const mrow = y * W, srow = (y + 1) * stride, prow = y * stride;
    for (let x = 0; x < W; x++) { run += mask[mrow + x]; S[srow + x + 1] = S[prow + x + 1] + run; }
  }
  return S;
}
function rectSum(S, W, x0, y0, x1, y1) { const a = W + 1; return S[y1 * a + x1] - S[y0 * a + x1] - S[y1 * a + x0] + S[y0 * a + x0]; }
// GAP_TOL：一行/一列最多允许多少墨迹还算「空白」。
// 这个数只留抗锯齿噪点的余地，绝不能大 —— 箱唛自己的外框线在掩膜里是 1px，
// 一行扫过去正好留下 2px 墨；tol 一旦 ≥ 2，整条「框内空白带」就会被判成缝隙，
// 一个箱唛被切成十几块（2026-10 第 14 页切出 23 块就是栽在这）。
// 所以按「每 833px 宽度容许 1px 噪点」取，A4 横向 674px 掩膜 → tol = 1。
const GAP_TOL_PER_PX = 1 / 833;
function bestGap(S, W, r, dir, minGap) {
  let best = null;
  if (dir === 'y') {
    const len = r.y1 - r.y0; if (len < 3) return null;
    const tol = Math.max(1, Math.round((r.x1 - r.x0) * GAP_TOL_PER_PX));
    const rowSum = new Int32Array(len);
    for (let i = 0; i < len; i++) rowSum[i] = rectSum(S, W, r.x0, r.y0 + i, r.x1, r.y0 + i + 1);
    let i = 0;
    while (i < len) {
      if (rowSum[i] <= tol) { let j = i; while (j < len && rowSum[j] <= tol) j++; const gl = j - i; if (i > 0 && j < len && gl >= minGap && (!best || gl > best.len)) best = { len: gl, mid: r.y0 + Math.round((i + j) / 2) }; i = j; }
      else i++;
    }
  } else {
    const len = r.x1 - r.x0; if (len < 3) return null;
    const tol = Math.max(1, Math.round((r.y1 - r.y0) * GAP_TOL_PER_PX));
    const colSum = new Int32Array(len);
    for (let i = 0; i < len; i++) colSum[i] = rectSum(S, W, r.x0 + i, r.y0, r.x0 + i + 1, r.y1);
    let i = 0;
    while (i < len) {
      if (colSum[i] <= tol) { let j = i; while (j < len && colSum[j] <= tol) j++; const gl = j - i; if (i > 0 && j < len && gl >= minGap && (!best || gl > best.len)) best = { len: gl, mid: r.x0 + Math.round((i + j) / 2) }; i = j; }
      else i++;
    }
  }
  return best;
}
function xyCut(S, W, H, minGap) {
  const out = [], stack = [{ x0: 0, y0: 0, x1: W, y1: H, depth: 0 }];
  while (stack.length) {
    let r = stack.pop();
    // 整块空白直接扔掉，否则「被切成 1 块空白」也会混进结果
    if (rectSum(S, W, r.x0, r.y0, r.x1, r.y1) === 0) continue;
    // 每层先收紧到真正有内容的范围，再找缝。
    // 不收紧的话，区域里的大片留白会把 bestGap 的 tol（按区域宽度算）灌成大数：
    // 最后一页只有 2 个箱唛、右边半页是空白，区域 442px 宽 → tol = 2px，
    // 而箱唛自己的左右两条 1px 边框线正好每行贡献 2px 墨 → tol 判它「这行是空的」，
    // 于是一个箱唛被横着竖着切成了 23 块（实测）。收紧后 tol 按 203px 算 = 1px，
    // 两条边框线（2px）就挡住了这一刀。
    r = tighten(S, W, r);
    if (r.x1 - r.x0 < 3 || r.y1 - r.y0 < 3 || r.depth > 22) { out.push(r); continue; }
    const cy = bestGap(S, W, r, 'y', minGap), cx = bestGap(S, W, r, 'x', minGap);
    let cut = null;
    if (cy && cx) cut = cy.len >= cx.len ? { dir: 'y', mid: cy.mid } : { dir: 'x', mid: cx.mid };
    else if (cy) cut = { dir: 'y', mid: cy.mid };
    else if (cx) cut = { dir: 'x', mid: cx.mid };
    if (!cut) { out.push(r); continue; }
    if (cut.dir === 'y') { stack.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: cut.mid, depth: r.depth + 1 }); stack.push({ x0: r.x0, y0: cut.mid, x1: r.x1, y1: r.y1, depth: r.depth + 1 }); }
    else { stack.push({ x0: r.x0, y0: r.y0, x1: cut.mid, y1: r.y1, depth: r.depth + 1 }); stack.push({ x0: cut.mid, y0: r.y0, x1: r.x1, y1: r.y1, depth: r.depth + 1 }); }
  }
  return out;
}
function tighten(S, W, b) {
  let x0 = b.x0, y0 = b.y0, x1 = b.x1, y1 = b.y1;
  while (y0 < y1 - 1 && rectSum(S, W, x0, y0, x1, y0 + 1) === 0) y0++;
  while (y1 > y0 + 1 && rectSum(S, W, x0, y1 - 1, x1, y1) === 0) y1--;
  while (x0 < x1 - 1 && rectSum(S, W, x0, y0, x0 + 1, y1) === 0) x0++;
  while (x1 > x0 + 1 && rectSum(S, W, x1 - 1, y0, x1, y1) === 0) x1--;
  return { x0, y0, x1, y1 };
}
function orderBlocks(blocks) {
  if (!blocks.length) return blocks;
  const items = blocks.map(b => ({ b, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, h: b.y1 - b.y0 }));
  const tol = Math.max(4, items.reduce((s, i) => s + i.h, 0) / items.length * 0.55);
  items.sort((p, q) => p.cy - q.cy);
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.cy - last.cy) <= tol) { last.items.push(it); last.cy = (last.cy * (last.items.length - 1) + it.cy) / last.items.length; }
    else rows.push({ cy: it.cy, items: [it] });
  }
  const out = [];
  for (const row of rows) { row.items.sort((a, b) => a.b.x0 - b.b.x0); for (const it of row.items) out.push(it.b); }
  return out;
}
function splitPage(page, gapMm, minSizeMm) {
  const { mask, maskW: W, maskH: H, maskScale } = page;
  const S = buildIntegral(mask, W, H);
  const pxPerMm = (maskScale * 25.4) / 72;
  const minGap = Math.max(2, Math.round(gapMm * pxPerMm));
  const minPx = Math.max(3, Math.round(minSizeMm * pxPerMm));
  if (boxState.mode === 'trim') return [tighten(S, W, { x0: 0, y0: 0, x1: W, y1: H })];
  if (boxState.mode === 'grid') {
    const t = tighten(S, W, { x0: 0, y0: 0, x1: W, y1: H });
    const rows = boxState.params.rows, cols = boxState.params.cols;
    const cw = (t.x1 - t.x0) / cols, ch = (t.y1 - t.y0) / rows;
    const out = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cell = { x0: Math.round(t.x0 + c * cw), y0: Math.round(t.y0 + r * ch), x1: Math.round(t.x0 + (c + 1) * cw), y1: Math.round(t.y0 + (r + 1) * ch) };
      const tt = tighten(S, W, cell); if (tt.x1 - tt.x0 > 2 && tt.y1 - tt.y0 > 2) out.push(tt);
    }
    return out;
  }
  const blocks = xyCut(S, W, H, minGap).map(b => tighten(S, W, b)).filter(b => (b.x1 - b.x0) >= minPx && (b.y1 - b.y0) >= minPx);
  return orderBlocks(blocks);
}
function maskRectToPdf(page, b) {
  const s = page.maskScale;
  const [x0, y0] = page.view.convertToPdfPoint(b.x0 * s, b.y0 * s);
  const [x1, y1] = page.view.convertToPdfPoint(b.x1 * s, b.y1 * s);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), manual: false };
}
function autoDetectGapMm() {
  const cands = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12, 15, 20];
  const sample = boxState.pages.slice(0, Math.min(boxState.pages.length, 4));
  if (!sample.length) return null;
  const savedMode = boxState.mode; boxState.mode = 'auto';
  const rows = cands.map(g => {
    let total = 0, cvAcc = 0;
    for (const p of sample) {
      const blocks = splitPage(p, g, boxState.params.minSizeMm);
      total += blocks.length;
      if (blocks.length > 1) {
        const areas = blocks.map(b => (b.x1 - b.x0) * (b.y1 - b.y0));
        const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
        const sd = Math.sqrt(areas.reduce((a, b) => a + (b - mean) ** 2, 0) / areas.length);
        cvAcc += mean > 0 ? sd / mean : 1;
      } else cvAcc += 2;
    }
    return { g, n: total, cv: cvAcc / sample.length };
  });
  boxState.mode = savedMode;
  let best = null, i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].n === rows[i].n) j++;
    const len = j - i + 1, n = rows[i].n;
    if (n >= 2) {
      const cv = Math.min(...rows.slice(i, j + 1).map(r => r.cv));
      const score = len / (1 + cv);
      if (!best || score > best.score) best = { score, from: i, to: j, n };
    }
    i = j + 1;
  }
  if (!best) return null;
  return cands[Math.floor((best.from + best.to) / 2)];
}
async function analyzePdf() {
  if (!boxState.srcBytes) return;
  setBoxProgress(0.02, '正在解析 PDF…'); await nextTick();
  let pdf;
  try { pdf = await pdfjsLib.getDocument({ data: new Uint8Array(boxState.srcBytes) }).promise; }
  catch (e) { setBoxProgress(null); toast('PDF 解析失败：' + (e && e.message ? e.message : e), 'err'); return; }
  const q = boxState.params.quality;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    setBoxProgress(n / pdf.numPages * 0.92, `分析第 ${n} / ${pdf.numPages} 页…`); await nextTick();
    let page = null, view = null;
    try {
      page = await pdf.getPage(n);
      view = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: q });
      const big = document.createElement('canvas');
      big.width = Math.max(1, Math.round(vp.width)); big.height = Math.max(1, Math.round(vp.height));
      const ctx = big.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, big.width, big.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const { mask, maskW, maskH } = buildMask(ctx.getImageData(0, 0, big.width, big.height));
      const TW = 420;
      const sc = Math.min(1, TW / big.width);
      const thumb = document.createElement('canvas');
      thumb.width = Math.max(1, Math.round(big.width * sc)); thumb.height = Math.max(1, Math.round(big.height * sc));
      const tctx = thumb.getContext('2d');
      tctx.fillStyle = '#ffffff'; tctx.fillRect(0, 0, thumb.width, thumb.height);
      tctx.drawImage(big, 0, 0, thumb.width, thumb.height);
      big.width = big.height = 0;
      pages.push({ pageIndex: n - 1, num: n, view, q, maskScale: POOL / q, maskW, maskH, mask, thumb, boxes: [] });
    } catch (e) {
      console.warn('页面渲染失败', n, e);
      pages.push({ pageIndex: n - 1, num: n, view: view || { width: 595, height: 842, convertToPdfPoint: (a, b) => [a, b], convertToViewportPoint: (a, b) => [a, b] }, q, maskScale: POOL / q, maskW: 1, maskH: 1, mask: new Uint8Array(1), thumb: null, boxes: [], failed: true });
    } finally { if (page) page.cleanup(); }
  }
  try { await pdf.destroy(); } catch (e) { }
  boxState.pages = pages;
  if (boxState.mode === 'auto' && boxState.gapAuto) {
    setBoxProgress(0.96, '正在自动匹配最佳间距…'); await nextTick();
    const g = autoDetectGapMm();
    if (g != null) {
      boxState.params.gapMm = g;
      const gi = $('#p-gap'); gi.value = clampRange(gi, g);
      $('#v-gap').textContent = Number(gi.value).toFixed(1) + ' mm';
    }
  }
  recomputeAll(); renderBoxResults(); setBoxProgress(null);
}
function clampRange(input, v) { const min = +input.min, max = +input.max; const snapped = Math.round(v / (+input.step || 1)) * (+input.step || 1); return Math.min(max, Math.max(min, snapped)); }
function recomputeAll() {
  for (const page of boxState.pages) {
    if (page.failed) { page.boxes = []; continue; }
    try { const blocks = splitPage(page, boxState.params.gapMm, boxState.params.minSizeMm); page.boxes = blocks.map(b => maskRectToPdf(page, b)); }
    catch (e) { console.warn('切分失败', page.num, e); page.boxes = []; }
  }
  updateBoxStats();
}
function allBoxes() { const out = []; for (const p of boxState.pages) for (const b of p.boxes) out.push({ page: p.pageIndex, ...b }); return out; }
function updateBoxStats() {
  const boxes = allBoxes();
  const pagesWith = boxState.pages.filter(p => p.boxes.length > 0).length;
  $('#dock-text').innerHTML = `共 <b>${boxState.pages.length}</b> 页 · 识别到 <b>${boxes.length}</b> 个箱唛 · 涉及 <b>${pagesWith}</b> 页`;
  $('#btn-export').disabled = boxes.length === 0;
  let modeLabel = { auto: '自动识别', trim: '每页一个', grid: '手动网格' }[boxState.mode];
  $('#boxStats').innerHTML = `
    <div class="box-stat"><div class="k">页数</div><div class="v">${boxState.pages.length}</div></div>
    <div class="box-stat"><div class="k">识别箱唛</div><div class="v">${boxes.length}</div></div>
    <div class="box-stat"><div class="k">含有箱唛的页</div><div class="v">${pagesWith}</div></div>
    <div class="box-stat"><div class="k">当前模式</div><div class="v" style="font-size:15px">${modeLabel}</div></div>`;
}
function pdfRectToPct(page, r) {
  const v = page.view;
  const [ax, ay] = v.convertToViewportPoint(r.x, r.y);
  const [bx, by] = v.convertToViewportPoint(r.x + r.w, r.y + r.h);
  return { left: Math.min(ax, bx) / v.width * 100, top: Math.min(ay, by) / v.height * 100, w: Math.abs(bx - ax) / v.width * 100, h: Math.abs(by - ay) / v.height * 100 };
}
function renderBoxResults() {
  $('#boxResults').innerHTML = '';
  $('#boxPanel').style.display = 'block';
  $('#drop').style.display = 'none';
  $('#dock').style.display = 'flex';
  const frag = document.createDocumentFragment();
  boxState.pages.forEach(p => frag.appendChild(buildBoxCard(p)));
  $('#boxResults').appendChild(frag);
  updateBoxStats();
}
function buildBoxCard(page) {
  const card = document.createElement('div'); card.className = 'page-card';
  const head = document.createElement('div'); head.className = 'page-head';
  head.innerHTML = `<span>第 <span class="pn">${page.num}</span> 页</span><span class="cnt">${page.boxes.length} 个箱唛</span>`;
  card.appendChild(head);
  const wrap = document.createElement('div'); wrap.className = 'canvas-wrap';
  if (page.thumb) wrap.appendChild(page.thumb);
  else { const ph = document.createElement('div'); ph.style.cssText = 'padding:40px;text-align:center;color:#8d9cba;font-size:12px;'; ph.textContent = '该页渲染失败'; wrap.appendChild(ph); }
  const layer = document.createElement('div'); layer.style.cssText = 'position:absolute;inset:0;'; wrap.appendChild(layer);
  page._layer = layer; page._wrap = wrap;
  card.appendChild(wrap);
  if (page.boxes.length) {
    const tools = document.createElement('div'); tools.className = 'page-tools';
    const b1 = document.createElement('button'); b1.className = 'btn ghost'; b1.textContent = '按内容重切';
    b1.onclick = () => { recomputeBoxPage(page); renderBoxes(page); updateBoxStats(); refreshBoxHead(page); };
    const b2 = document.createElement('button'); b2.className = 'btn ghost'; b2.textContent = '清空本页';
    b2.onclick = () => { page.boxes = []; renderBoxes(page); updateBoxStats(); refreshBoxHead(page); };
    tools.appendChild(b1); tools.appendChild(b2); card.appendChild(tools);
  }
  renderBoxes(page); attachMarquee(wrap, page);
  return card;
}
function refreshBoxHead(page) {
  const card = page._wrap && page._wrap.parentElement; if (!card) return;
  const cnt = card.querySelector('.cnt'); if (cnt) cnt.textContent = page.boxes.length + ' 个箱唛';
  let tools = card.querySelector('.page-tools');
  if (!tools && page.boxes.length) {
    tools = document.createElement('div'); tools.className = 'page-tools';
    const b1 = document.createElement('button'); b1.className = 'btn ghost'; b1.textContent = '按内容重切';
    b1.onclick = () => { recomputeBoxPage(page); renderBoxes(page); updateBoxStats(); refreshBoxHead(page); };
    const b2 = document.createElement('button'); b2.className = 'btn ghost'; b2.textContent = '清空本页';
    b2.onclick = () => { page.boxes = []; renderBoxes(page); updateBoxStats(); refreshBoxHead(page); };
    tools.appendChild(b1); tools.appendChild(b2); card.appendChild(tools);
  }
}
function recomputeBoxPage(page) { const blocks = splitPage(page, boxState.params.gapMm, boxState.params.minSizeMm); page.boxes = blocks.map(b => maskRectToPdf(page, b)); }
function renderBoxes(page) {
  const layer = page._layer; if (!layer) return;
  layer.innerHTML = '';
  page.boxes.forEach((b, i) => {
    const pct = pdfRectToPct(page, b);
    const d = document.createElement('div'); d.className = 'box' + (b.manual ? ' manual' : '');
    d.style.left = pct.left + '%'; d.style.top = pct.top + '%'; d.style.width = pct.w + '%'; d.style.height = pct.h + '%';
    d.innerHTML = `<span class="no">${i + 1}</span>`;
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.title = '删除';
    del.onclick = (e) => { e.stopPropagation(); page.boxes.splice(i, 1); renderBoxes(page); updateBoxStats(); refreshBoxHead(page); };
    d.appendChild(del);
    d.addEventListener('pointerdown', e => e.stopPropagation());
    layer.appendChild(d);
  });
}
function attachMarquee(wrap, page) {
  if (!page.thumb) return;
  let start = null, rect = null;
  const toPct = (e) => { const r = wrap.getBoundingClientRect(); return { x: Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100)), y: Math.min(100, Math.max(0, (e.clientY - r.top) / r.height * 100)) }; };
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    start = toPct(e); rect = document.createElement('div'); rect.className = 'marquee'; wrap.appendChild(rect);
    wrap.setPointerCapture(e.pointerId); e.preventDefault();
  });
  wrap.addEventListener('pointermove', e => {
    if (!start || !rect) return;
    const p = toPct(e);
    rect.style.left = Math.min(start.x, p.x) + '%'; rect.style.top = Math.min(start.y, p.y) + '%';
    rect.style.width = Math.abs(p.x - start.x) + '%'; rect.style.height = Math.abs(p.y - start.y) + '%';
  });
  const finish = (e) => {
    if (!start || !rect) return;
    const p = toPct(e);
    const left = Math.min(start.x, p.x), top = Math.min(start.y, p.y);
    const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
    rect.remove(); start = null; rect = null;
    if (w < 0.8 || h < 0.8) return;
    const v = page.view;
    const [x0, y0] = v.convertToPdfPoint(left / 100 * v.width, top / 100 * v.height);
    const [x1, y1] = v.convertToPdfPoint((left + w) / 100 * v.width, (top + h) / 100 * v.height);
    page.boxes.push({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), manual: true });
    renderBoxes(page); updateBoxStats(); refreshBoxHead(page); toast('已手动添加 1 个箱唛', 'ok');
  };
  wrap.addEventListener('pointerup', finish);
  wrap.addEventListener('pointercancel', () => { if (rect) rect.remove(); start = null; rect = null; });
}
async function exportBoxPdf() {
  const items = allBoxes(); if (!items.length) { toast('没有可导出的箱唛', 'err'); return; }
  setBoxProgress(0.02, '正在生成 PDF…'); await nextTick();
  try {
    const src = await PDFDocument.load(new Uint8Array(boxState.srcBytes), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const margin = boxState.params.marginMm * MM2PT;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (i % 12 === 0) { setBoxProgress(i / items.length * 0.9, `正在生成第 ${i + 1} / ${items.length} 个…`); await nextTick(); }
      const srcPage = src.getPage(it.page);
      const mb = srcPage.getMediaBox();
      let x = it.x - margin, y = it.y - margin, x2 = it.x + it.w + margin, y2 = it.y + it.h + margin;
      x = Math.max(mb.x, Math.min(x, mb.x + mb.width)); y = Math.max(mb.y, Math.min(y, mb.y + mb.height));
      x2 = Math.max(mb.x, Math.min(x2, mb.x + mb.width)); y2 = Math.max(mb.y, Math.min(y2, mb.y + mb.height));
      const w = x2 - x, h = y2 - y; if (w < 1 || h < 1) continue;
      try { const [pg] = await out.copyPages(src, [it.page]); pg.setMediaBox(x, y, w, h); pg.setCropBox(x, y, w, h); out.addPage(pg); } catch (e) { console.warn('复制页面失败', it.page, e); }
    }
    if (out.getPageCount() === 0) { setBoxProgress(null); toast('导出失败：没有可用页面', 'err'); return; }
    out.setProducer('BoxMark Cutter'); out.setCreator('BoxMark Cutter');
    setBoxProgress(0.95, '正在写入文件…'); await nextTick();
    const bytes = await out.save();
    const base = boxState.fileName.replace(/\.pdf$/i, '') || 'boxmarks';
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${base}_箱唛单页.pdf`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setBoxProgress(null); toast(`导出成功：${out.getPageCount()} 页`, 'ok');
  } catch (e) { setBoxProgress(null); console.error(e); toast('导出失败：' + (e && e.message ? e.message : e), 'err'); }
}
function applyModeUI() {
  const mode = boxState.mode;
  $$('#boxPanel .field').forEach(el => {
    const list = (el.getAttribute('data-show') || '').split(' ');
    el.style.display = list.includes(mode) ? '' : 'none';
  });
  $$('#seg-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  const hints = { auto: '自动分析页面空白，把多个箱唛分割开', trim: '每页只保留一个箱唛，自动裁掉四周空白', grid: '按固定行列均分页面' };
  $('#mode-hint').textContent = hints[mode];
}
const debouncedRecompute = debounce(() => {
  recomputeAll();
  boxState.pages.forEach(p => { renderBoxes(p); refreshBoxHead(p); });
  updateBoxStats();
}, 140);
function bindBoxEvents() {
  const drop = $('#drop'), file = $('#file');
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { if (file.files && file.files[0]) loadBoxFile(file.files[0]); });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadBoxFile(f); });

  $$('#seg-mode button').forEach(b => b.addEventListener('click', () => {
    if (boxState.mode === b.dataset.mode) return;
    boxState.mode = b.dataset.mode; applyModeUI();
    if (boxState.pages.length) { recomputeAll(); renderBoxResults(); }
  }));

  const bindRange = (id, key, fmt, onChange) => {
    const input = $(id), label = $('v-' + id.slice(2));
    if (!input || !label) { console.warn('bindRange missing:', id, input, label); return; }
    input.addEventListener('input', () => { const v = +input.value; label.textContent = fmt(v); onChange(v); });
    label.textContent = fmt(+input.value);
  };
  bindRange('p-gap', 'gapMm', v => v.toFixed(1) + ' mm', v => { boxState.params.gapMm = v; boxState.gapAuto = false; if (boxState.pages.length) debouncedRecompute(); });
  bindRange('p-min', 'minSizeMm', v => v + ' mm', v => { boxState.params.minSizeMm = v; if (boxState.pages.length) debouncedRecompute(); });
  bindRange('p-margin', 'marginMm', v => v.toFixed(1) + ' mm', v => { boxState.params.marginMm = v; });
  bindRange('p-rows', 'rows', v => String(v), v => { boxState.params.rows = v; if (boxState.pages.length && boxState.mode === 'grid') debouncedRecompute(); });
  bindRange('p-cols', 'cols', v => String(v), v => { boxState.params.cols = v; if (boxState.pages.length && boxState.mode === 'grid') debouncedRecompute(); });

  $('#p-quality').addEventListener('change', () => {
    boxState.params.quality = +$('#p-quality').value;
    if (boxState.srcBytes) { if (boxState.pages.length) { boxState.pages = []; $('#boxResults').innerHTML = ''; } analyzePdf(); }
  });

  $('#btn-export').addEventListener('click', exportBoxPdf);
  $('#btn-clear').addEventListener('click', () => {
    boxState.fileName = ''; boxState.srcBytes = null; boxState.pages = [];
    $('#boxResults').innerHTML = ''; $('#boxStats').innerHTML = '';
    $('#boxPanel').style.display = 'none'; $('#drop').style.display = 'flex'; $('#dock').style.display = 'none';
    file.value = ''; toast('已清空');
  });

  window.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e' && $('#dock').style.display !== 'none') { e.preventDefault(); exportBoxPdf(); } });
}
async function loadBoxFile(file) {
  const name = file.name || '';
  if (!/\.pdf$/i.test(name) && file.type !== 'application/pdf') { toast('请选择 PDF 文件', 'err'); return; }
  boxState.fileName = name; boxState.gapAuto = true; boxState.params.gapMm = 3;
  $('#p-gap').value = 3; $('#v-gap').textContent = '3.0 mm';
  $('#drop').style.display = 'none'; $('#boxPanel').style.display = 'block';
  setBoxProgress(0.01, '正在读取文件…'); await nextTick();
  boxState.srcBytes = new Uint8Array(await file.arrayBuffer());
  applyModeUI(); await analyzePdf();
}

/* =========================================================
   5.5 美客多官方 API：实时订单 / 商品问答 / 退货投诉
   ========================================================= */
/* ---- 全站时间统一按「巴西时区」（America/Sao_Paulo, UTC-3）渲染 ----
   电脑系统时区保持不变。美客多后台与官方报表都是巴西时间，这样两边对得上。 */
const BR_TZ = 'America/Sao_Paulo';
let BR_FMT = null;
try {
  BR_FMT = new Intl.DateTimeFormat('en-CA', {
    timeZone: BR_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
} catch { }
// 取某时刻在巴西时区下的各部分（year/month/day/hour/minute/second）
function brParts(ts) {
  const d = ts instanceof Date ? ts : new Date(ts == null ? Date.now() : ts);
  const o = {};
  if (BR_FMT) { for (const p of BR_FMT.formatToParts(d)) o[p.type] = p.value; return o; }
  const p = n => String(n).padStart(2, '0');
  o.year = String(d.getFullYear()); o.month = p(d.getMonth() + 1); o.day = p(d.getDate());
  o.hour = p(d.getHours()); o.minute = p(d.getMinutes()); o.second = p(d.getSeconds());
  return o;
}
function timeStr(ts) {
  const o = brParts(ts);
  return o.hour + ':' + o.minute + ':' + o.second;
}
function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  const o = brParts(d);
  return o.year + '-' + o.month + '-' + o.day + ' ' + o.hour + ':' + o.minute;
}
function money(v, cur) {
  const sym = CURRENCY_SYMBOLS[cur] || cur || '';
  const n = Number(v) || 0;
  const hasCents = Math.abs(n - Math.round(n)) > 0.004;
  const s = hasCents
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(n).toLocaleString('en-US');
  return sym + ' ' + s;
}

async function mlGet(path, opts) {
  // 强制绕过浏览器 HTTP 缓存：忽略/回复等状态必须每次拿最新
  const o = Object.assign({ cache: 'no-store' }, opts || {});
  const r = await fetch(API_BASE + path, o);
  let d = null;
  try { d = await r.json(); } catch { d = null; }
  if (!r.ok) { const e = new Error((d && (d.error || d.message)) || ('HTTP ' + r.status)); e.payload = d; throw e; }
  if (d && d.ok === false) { const e = new Error(d.error || d.message || '请求失败'); e.payload = d; throw e; }
  return d;
}

function setStateEl(el, kind, text) {
  if (!el) return;
  const color = kind === 'ok' ? 'var(--ok)' : kind === 'err' ? 'var(--bad)' : kind === 'warn' ? 'var(--warn)' : 'var(--mut)';
  el.innerHTML = '<i style="background:' + color + '"></i>' + escHtml(text);
  el.style.color = kind === 'err' ? 'var(--bad)' : '';
}
function setBadge(id, n) {
  const el = $('#' + id);
  if (!el) return;
  if (n == null || n <= 0) { el.hidden = true; el.textContent = '0'; return; }
  el.hidden = false;
  el.textContent = n > 99 ? '99+' : String(n);
}
function pagerHtml(cur, pages) {
  if (pages <= 1) return '';
  return '<div class="pagination">'
    + '<button data-pg="' + (cur - 2) + '"' + (cur <= 1 ? ' disabled' : '') + '>上一页</button>'
    + '<span style="color:var(--mut);font-size:12.5px;padding:0 10px;align-self:center">第 ' + cur + ' / ' + pages + ' 页</span>'
    + '<button data-pg="' + cur + '"' + (cur >= pages ? ' disabled' : '') + '>下一页</button>'
    + '</div>';
}
function bindPager(root, onPage) {
  root.querySelectorAll('.pagination button[data-pg]').forEach(b => {
    if (b.disabled) return;
    b.onclick = () => { onPage(parseInt(b.dataset.pg, 10)); scrollTo(0, 0); };
  });
}
// 已保存 App ID + Secret，但还没完成美客多账号授权 → 直接跳授权页
async function goMlAuthorize() {
  try {
    const c = await (await fetch(API_BASE + '/api/config')).json();
    const site = c.mlSite || 'MLB';
    window.location.href = API_BASE + '/api/ml/oauth/start?site=' + encodeURIComponent(site);
  } catch (e) { openMlModal(); }
}
function toolError(stateEl, body, e, retry) {
  const p = e.payload || {};
  if (p.needAuth) {
    setStateEl(stateEl, 'warn', '待授权');
    body.innerHTML = '<div class="empty">凭证已保存，还差最后一步：<b>美客多账号授权</b><br><span style="color:var(--mut);font-size:12px">点下面按钮跳转美客多登录，同意后自动回到工作台</span><br><button class="btn y" style="margin-top:14px" data-act="auth">去授权</button><button class="btn" style="margin-top:14px;margin-left:8px" data-act="cfg2">查看凭证</button></div>';
    const a = body.querySelector('[data-act="auth"]'); if (a) a.onclick = goMlAuthorize;
    const c = body.querySelector('[data-act="cfg2"]'); if (c) c.onclick = openMlModal;
  } else if (p.needConfig || p.configured === false) {
    setStateEl(stateEl, 'warn', '未配置');
    body.innerHTML = '<div class="empty">尚未配置美客多 API 凭证<br><button class="btn y" style="margin-top:14px" data-act="cfg">去配置</button></div>';
    const b = body.querySelector('[data-act="cfg"]'); if (b) b.onclick = openMlModal;
  } else {
    setStateEl(stateEl, 'err', '异常');
    body.innerHTML = '<div class="empty">加载失败：' + escHtml(e.message) + '<br><button class="btn" style="margin-top:14px" data-act="retry">重试</button></div>';
    const b = body.querySelector('[data-act="retry"]'); if (b && retry) b.onclick = retry;
  }
}

/* ---- 概览：实时订单看板 ---- */
let mlSummaryAt = 0;
function clearSummary() {
  ['ml-today', 'ml-pending', 'ml-shipped', 'ml-cancelled'].forEach(id => { const e = $('#' + id); if (e) e.textContent = '—'; });
  const a = $('#ml-today-amt'); if (a) a.textContent = '—';
  const u = $('#mlUpdated'); if (u) u.textContent = '尚未同步';
  ['nb-q', 'nb-o', 'nb-c', 'tc-q', 'tc-o', 'tc-c'].forEach(id => setBadge(id, 0));
}
function showMlHint(t) { const e = $('#mlHint'); if (e) { e.textContent = t; e.style.display = 'block'; } }
function hideMlHint() { const e = $('#mlHint'); if (e) e.style.display = 'none'; }

async function loadOrderSummary(force) {
  if (!force && mlSummaryAt && Date.now() - mlSummaryAt < 60000) return;
  const btn = $('#ovRefresh');
  if (btn) btn.classList.add('spin');
  setStateEl($('#mlState'), 'warn', '同步中');
  try {
    const d = await mlGet('/api/ml/orders/summary');
    mlSummaryAt = Date.now();
    applySummary(d);
  } catch (e) {
    const p = e.payload || {};
    if (p.needAuth) {
      clearSummary();
      setStateEl($('#mlState'), 'warn', '待授权');
      showMlHint('App ID 和 Secret Key 已保存，还差最后一步账号授权。点右上角「API 设置」里的「开始授权」，或点这里 → ');
    } else if (p.needConfig || p.configured === false) {
      clearSummary();
      setStateEl($('#mlState'), 'warn', '未配置');
      showMlHint('尚未配置美客多 API 凭证。点击右上角「API 设置」，填入 App ID 与 Secret Key，然后一键授权即可拉取实时订单。');
    } else {
      setStateEl($('#mlState'), 'err', '异常');
      showMlHint('订单同步失败：' + e.message + '（点击「刷新」重试）');
    }
  } finally {
    setTimeout(() => { if (btn) btn.classList.remove('spin'); }, 480);
  }
}

let mlLastQ = null, mlLastC = null;
// 角标数变大 = 来了新问答 / 新售后 → 弹提示
function notifyNewItems(q, c) {
  if (mlLastQ != null && q > mlLastQ) {
    toast('🔔 新来 ' + (q - mlLastQ) + ' 条商品问答，待回复');
    if (currentView === 'questions' && !document.hidden && !hasDirtyInput('#questionBody')) loadQuestions();
  }
  // c 为 null 表示本轮没取到待处理数（接口异常），不能当成「降到 0」，否则恢复后会被误报成新售后
  if (c != null && mlLastC != null && c > mlLastC) {
    toast('🔔 新来 ' + (c - mlLastC) + ' 条售后待处理');
  }
  mlLastQ = q; mlLastC = (c == null) ? null : c;
}
function applySummary(d) {
  setStateEl($('#mlState'), 'ok', '实时');
  hideMlHint();
  const set = (id, v) => { const e = $('#' + id); if (e) e.textContent = (v == null) ? '—' : fmt(v); };
  set('ml-today', d.today);
  // 待发货 = 需要我动手发货的自发货/打面单订单；官方代发的不算
  const needShip = (d.pendingTodo != null) ? d.pendingTodo : d.pending;
  set('ml-pending', needShip);
  set('ml-shipped', d.shipped);
  set('ml-cancelled', d.cancelled);
  const amt = $('#ml-today-amt');
  if (amt) amt.textContent = d.todayAmount ? money(d.todayAmount, d.currency) : '今日暂未成交';
  const po = $('#ml-pending');
  if (po && po.parentElement) po.parentElement.classList.toggle('alert', (needShip || 0) > 0);
  const ps = $('#ml-pending-sub');
  if (ps) ps.textContent = (d.pendingTodo != null && d.pending != null)
    ? ('官方代发 ' + fmt(Math.max(0, d.pending - d.pendingTodo)) + ' 单不用管')
    : '自发货/打面单才提醒';
  const u = $('#mlUpdated');
  if (u) u.textContent = '更新于 ' + timeStr(d.updatedAt) + ' · ' + (d.site || '') + ' · ' + (d.day || '');
  const hq = $('#hubQuestionCount'); if (hq) hq.textContent = fmt(d.questionUnanswered || 0);
  setBadge('nb-q', d.questionUnanswered); setBadge('tc-q', d.questionUnanswered);
  setBadge('nb-o', needShip); setBadge('tc-o', needShip);
  // 取不到待处理数时显示「—」并隐藏角标，不再退回 claimOpen（那会把所有开启纠纷当待办，长期空提醒）
  const claimTodo = (d.claimTodo != null) ? d.claimTodo : null;
  const hc = $('#hubClaimCount'); if (hc) hc.textContent = (claimTodo == null) ? '—' : fmt(claimTodo);
  setBadge('nb-c', claimTodo); setBadge('tc-c', claimTodo);
  notifyNewItems(Number(d.questionUnanswered || 0), Number(claimTodo || 0));
}

/* ---- 概览：销售金额 · 实时流水（按巴西时区） ---- */
const salesView = { from: '', to: '', range: 'today', gran: 'order', auto: true, data: null, timer: null, at: 0 };
const hubProfitView = { key: '', at: 0, pendingKey: '', pending: null };

// 指定时区的「今天」（YYYY-MM-DD）
function brToday() {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: BR_TZ }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
// 巴西时区的时钟（HH:mm:ss）
function brClock(ts) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: BR_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ts || Date.now()));
  } catch { return timeStr(ts); }
}
// 日期加减（按 UTC 正午做算术，避开时区边界）
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function setSalesRange(r) {
  const today = brToday();
  let from = today, to = today;
  if (r === '7') from = addDays(today, -6);
  else if (r === '30') from = addDays(today, -29);
  else if (r === 'month') from = today.slice(0, 8) + '01';
  salesView.range = r; salesView.from = from; salesView.to = to;
  const f = $('#salesFrom'), t = $('#salesTo');
  if (f) f.value = from;
  if (t) t.value = to;
}
function clearSales() {
  ['sk-orders', 'sk-amount', 'sk-items', 'sk-avg', 'sk-orders-sub', 'sk-amount-sub'].forEach(id => { const e = $('#' + id); if (e) e.textContent = '—'; });
  const b = $('#salesBody'); if (b) b.innerHTML = '<div class="empty">暂无数据</div>';
}
function showSalesNote(t) { const e = $('#salesNote'); if (e) { e.textContent = t; e.style.display = 'block'; } }
function hideSalesNote() { const e = $('#salesNote'); if (e) e.style.display = 'none'; }

async function loadSales(force) {
  if (!force && salesView.at && Date.now() - salesView.at < 15000) return;
  const btn = $('#ovRefresh');
  if (btn) btn.classList.add('spin');
  setStateEl($('#salesState'), 'warn', '同步中');
  try {
    const q = '?from=' + encodeURIComponent(salesView.from) + '&to=' + encodeURIComponent(salesView.to);
    const d = await mlGet('/api/ml/sales' + q);
    salesView.at = Date.now();
    salesView.data = d;
    renderSales(d);
  } catch (e) {
    const p = e.payload || {};
    salesView.data = null;
    clearSales();
    if (p.needAuth) {
      setStateEl($('#salesState'), 'warn', '待授权');
      showSalesNote('App ID 与 Secret Key 已保存，还差最后一步账号授权。点上方「API 设置」→「开始授权」，授权完成后这里会自动变成实时销售数据。');
    } else if (p.needConfig || p.configured === false) {
      setStateEl($('#salesState'), 'warn', '未配置');
      showSalesNote('尚未配置美客多 API 凭证，无法拉取销售流水。');
    } else {
      setStateEl($('#salesState'), 'err', '异常');
      showSalesNote('销售数据拉取失败：' + e.message + '（点「刷新」重试）');
    }
  } finally {
    setTimeout(() => { if (btn) btn.classList.remove('spin'); }, 480);
  }
}

function renderHubTrend() {
  const root = $('#hubTrend'); if (!root) return;
  const rows = salesView.data?.rows || [];
  if (!rows.length) { root.innerHTML = '<div class="empty">所选期间暂无订单数据</div>'; const note=$('#hubTrendNote'); if(note)note.textContent='订单数据暂不可用或所选期间没有订单。'; return; }
  const valid = rows.filter(r => r.status !== 'cancelled' && r.status !== 'invalid');
  const singleDay = salesView.from === salesView.to;
  const keys = singleDay ? Array.from({length:24},(_,i)=>String(i).padStart(2,'0')) : (()=>{const out=[];for(let d=salesView.from;d<=salesView.to&&out.length<366;d=addDays(d,1))out.push(d);return out;})();
  const orderCounts = Object.fromEntries(keys.map(k=>[k,0]));
  for (const r of valid) { const k=singleDay?String(r.hour==null?0:r.hour).padStart(2,'0'):r.date; if (k in orderCounts) orderCounts[k]++; }
  const values=keys.map(k=>orderCounts[k]||0), max=Math.max(3,Math.ceil(Math.max(0,...values)/3)*3);
  const W=760,H=210,L=46,R=12,T=12,B=27,x=i=>L+(keys.length<2?0:i*(W-L-R)/(keys.length-1)),y=v=>H-B-(v/max)*(H-T-B);
  const path=a=>a.map((v,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1)).join(' ');
  const area=path(values)+' L '+x(keys.length-1).toFixed(1)+' '+(H-B)+' L '+x(0).toFixed(1)+' '+(H-B)+' Z';
  let grid=''; for(let j=0;j<4;j++){const val=max*j/3, yy=y(val);grid+='<line class="hub-gridline" x1="'+L+'" x2="'+(W-R)+'" y1="'+yy.toFixed(1)+'" y2="'+yy.toFixed(1)+'"/><text class="hub-axis" x="'+(L-7)+'" y="'+(yy+3)+'" text-anchor="end">'+escHtml(fmt(Math.round(val)))+'</text>'; }
  const ticks=keys.length<=5?keys.map((_,i)=>i):[0,Math.round((keys.length-1)/3),Math.round((keys.length-1)*2/3),keys.length-1];let labels='';for(const i of [...new Set(ticks)]){const label=singleDay?(keys[i]+':00'):String(keys[i]).slice(5);labels+='<text class="hub-axis" x="'+x(i)+'" y="'+(H-5)+'" text-anchor="middle">'+escHtml(label)+'</text>'; }
  root.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="订单数趋势"><defs><linearGradient id="hubSalesGradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--cyan)" stop-opacity=".28"/><stop offset="1" stop-color="var(--cyan)" stop-opacity="0"/></linearGradient></defs>'+grid+labels+'<path class="hub-sales-area" d="'+area+'"/><path class="hub-sales-line" d="'+path(values)+'"/></svg>';
  const note=$('#hubTrendNote');if(note)note.textContent=(singleDay?'单日订单按小时汇总':'订单数按日期汇总 · '+(salesView.data?.range?.from||salesView.from)+' 至 '+(salesView.data?.range?.to||salesView.to))+' · 不含已取消及无效订单'+(salesView.data?.truncated?' · 订单较多，销售接口返回部分记录':'');
}

function renderHubListings(d) {
  const root=$('#hubListingSummary');if(!root)return;const list=d.listings||[],totals=d.totals||{},cur=d.currency||'BRL';
  if(!list.length){root.innerHTML='<div class="empty">所选期间没有 Listing 出单</div>';const n=$('#hubListingCount');if(n)n.textContent='0';const q=$('#hubListingQty');if(q)q.textContent='0';return;}
  const n=$('#hubListingCount'),q=$('#hubListingQty'),period=$('#hubListingPeriod');if(n)n.textContent=fmt(totals.listings??list.length);if(q)q.textContent=fmt(totals.qty||0);if(period&&d.range)period.textContent=d.range.from===d.range.to?d.range.from:d.range.from+' 至 '+d.range.to;
  const rows=list.slice(0,5).map(x=>{const img=x.thumbnail?'<img src="'+escHtml(x.thumbnail)+'" alt="" loading="lazy" referrerpolicy="no-referrer">':'<span class="hub-thumb">ML</span>';const title=escHtml(x.title||('Listing '+x.id));const item=x.permalink?'<a href="'+escHtml(x.permalink)+'" target="_blank" rel="noreferrer" title="'+title+'">'+title+'</a>':'<span>'+title+'</span>';return '<tr><td><div class="hub-product">'+img+'<div>'+item+'<small>'+escHtml(x.id||'')+'</small></div></div></td><td>'+fmt(x.qty||0)+' 件</td><td>'+fmt(x.orders||0)+' 单</td><td>'+money(x.amount||0,cur)+'</td></tr>';}).join('');
  root.innerHTML='<div class="tw"><table class="hub-list-table"><thead><tr><th>商品 / Listing</th><th>出单件数</th><th>订单数</th><th>销售额</th></tr></thead><tbody>'+rows+'</tbody></table></div><div class="hub-table-more"><span>显示前 '+Math.min(5,list.length)+' 个 · 共 '+fmt(totals.listings??list.length)+' 个 Listing</span><a href="#profit" data-go="profit">查看成本与利润 ↗</a></div>';
}

function setHubRange(range, from, to, run=true) {
  const today=brToday();let f=from||today,t=to||today;
  if(range!=='custom'){if(range==='7')f=addDays(today,-6);else if(range==='30')f=addDays(today,-29);else f=today;t=today;}
  if(f>t){const z=f;f=t;t=z;}
  salesView.range=range;salesView.from=f;salesView.to=t;listingView.range=range;listingView.from=f;listingView.to=t;
  const af=$('#salesFrom'),at=$('#salesTo'),lf=$('#listingFrom'),lt=$('#listingTo'),hf=$('#hubFrom'),ht=$('#hubTo');if(af)af.value=f;if(at)at.value=t;if(lf)lf.value=f;if(lt)lt.value=t;if(hf)hf.value=f;if(ht)ht.value=t;
  for(const id of ['salesRange','listingRange']){const el=$('#'+id);if(el)el.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.r===range));}
  const adsSpan=(Date.parse(t+'T12:00:00Z')-Date.parse(f+'T12:00:00Z'))/86400000;let adsFrom=f;if(adsSpan>89){adsFrom=addDays(t,-89);if(run)toast('广告数据最多查询 90 天，已单独收窄广告统计范围');}
  adsView.range=range;adsView.from=adsFrom;adsView.to=t;const adf=$('#adsFrom'),adt=$('#adsTo');if(adf)adf.value=adsFrom;if(adt)adt.value=t;const ar=$('#adsRange');if(ar)ar.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.r===range));
  const pf=$('#profitOrderFrom'),pt=$('#profitOrderTo');if(pf)pf.value=f;if(pt)pt.value=t;const pr=$('#profitOrderRange');if(pr)pr.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.range===range));
  const hr=$('#hubRange');if(hr)hr.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.range===range));
  if(run)refreshOverview();
}
function bindOverviewEvents(){
  const ranges=$('#hubRange');if(ranges)ranges.querySelectorAll('button[data-range]').forEach(b=>b.addEventListener('click',()=>setHubRange(b.dataset.range)));
  $('#hubApply')?.addEventListener('click',()=>{const f=$('#hubFrom')?.value||'',t=$('#hubTo')?.value||'';if(!/^\d{4}-\d{2}-\d{2}$/.test(f)||!/^\d{4}-\d{2}-\d{2}$/.test(t)){toast('请选择完整的起止日期');return;}setHubRange('custom',f,t);});
  $('#hubFrom')?.addEventListener('change',()=>$('#hubRange')?.querySelectorAll('button').forEach(b=>b.classList.remove('on')));$('#hubTo')?.addEventListener('change',()=>$('#hubRange')?.querySelectorAll('button').forEach(b=>b.classList.remove('on')));
  setHubRange('today',null,null,false);
}
function renderSales(d) {
  setStateEl($('#salesState'), 'ok', '实时');
  hideSalesNote();
  const t = d.totals || {};
  const cur = d.currency || 'BRL';
  const set = (id, v) => { const e = $('#' + id); if (e) e.textContent = (v == null) ? '—' : v; };
  set('sk-orders', fmt(t.orders));
  set('sk-amount', money(t.amount, cur));
  set('sk-items', fmt(t.items));
  set('sk-avg', t.orders ? money(t.avg, cur) : '—');
  set('sk-orders-sub', t.cancelled ? ('另有 ' + t.cancelled + ' 单已取消') : '不含已取消订单');
  set('sk-amount-sub', (d.siteName || '') + ' · ' + cur);
  const note = $('#salesTzNote');
  if (note) note.textContent = '按' + (d.tzLabel || '巴西时间') + ' 统计 · 范围 ' + d.range.from + ' ~ ' + d.range.to
    + ' · 更新于 ' + brClock(d.updatedAt) + '（巴西时间）' + (d.cached ? ' · 缓存' : '');

  const body = $('#salesBody');
  const rows = d.rows || [];
  if (!rows.length) { body.innerHTML = '<div class="empty">该时间范围内没有订单</div>'; renderHubTrend(); return; }

  const sameDay = d.range.from === d.range.to;
  const asc = rows.slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const isVoid = r => r.status === 'cancelled' || r.status === 'invalid';
  const detail = salesView.gran === 'order';

  let trs = '';
  let head = '';
  if (detail) {
    head = '<tr><th>时间（巴西）</th><th>订单号</th><th>买家</th><th>件数</th><th class="ta-r">金额</th><th class="ta-r">累计金额</th></tr>';
    let cum = 0;
    trs = asc.map(r => {
      const voided = isVoid(r);
      if (!voided) cum += r.amount;
      const stamp = sameDay ? (r.hhmm || '-') : ((r.date || '').slice(5) + ' ' + (r.hhmm || ''));
      const stTxt = r.status === 'cancelled' ? '已取消' : (r.status === 'invalid' ? '无效' : '');
      return '<tr' + (voided ? ' class="srow-void"' : '') + '>'
        + '<td class="s-time">' + escHtml(stamp) + '</td>'
        + '<td><span class="oid">' + escHtml(r.orderId) + '</span>' + (stTxt ? '<span class="sbadge void">' + stTxt + '</span>' : '') + '</td>'
        + '<td>' + escHtml(r.buyer || '-') + '</td>'
        + '<td>' + fmt(r.qty || 1) + '</td>'
        + '<td class="ta-r">' + (voided ? '<span class="s-mut">—</span>' : money(r.amount, cur)) + '</td>'
        + '<td class="ta-r s-cum">' + money(cum, cur) + '</td>'
        + '</tr>';
    }).join('');
  } else {
    const map = new Map();
    for (const r of asc) {
      const k = salesView.gran === 'day' ? r.date : (r.date + ' ' + String(r.hour == null ? 0 : r.hour).padStart(2, '0'));
      if (!map.has(k)) map.set(k, { key: k, date: r.date, hour: r.hour, count: 0, amount: 0, cancelled: 0 });
      const g = map.get(k);
      if (isVoid(r)) g.cancelled++;
      else { g.count++; g.amount += r.amount; }
    }
    head = '<tr><th>时间（巴西）</th><th>单量</th><th class="ta-r">金额</th><th class="ta-r">累计金额</th></tr>';
    let cum = 0;
    trs = [...map.values()].sort((a, b) => a.key.localeCompare(b.key)).map(g => {
      cum += g.amount;
      const hh = String(g.hour == null ? 0 : g.hour).padStart(2, '0') + ':00';
      const label = salesView.gran === 'day' ? g.date.slice(5) : (sameDay ? hh : g.date.slice(5) + ' ' + hh);
      return '<tr>'
        + '<td class="s-time">' + escHtml(label) + '</td>'
        + '<td>' + fmt(g.count) + (g.cancelled ? ' <span class="sbadge void">+' + g.cancelled + ' 取消</span>' : '') + '</td>'
        + '<td class="ta-r">' + money(g.amount, cur) + '</td>'
        + '<td class="ta-r s-cum">' + money(cum, cur) + '</td>'
        + '</tr>';
    }).join('');
  }

  const foot = detail
    ? '<tr class="sfoot"><td colspan="3">合计（不含已取消）</td><td>' + fmt(t.items) + '</td><td class="ta-r">' + money(t.amount, cur) + '</td><td class="ta-r">' + money(t.amount, cur) + '</td></tr>'
    : '<tr class="sfoot"><td>合计</td><td>' + fmt(t.orders) + '</td><td class="ta-r">' + money(t.amount, cur) + '</td><td class="ta-r">' + money(t.amount, cur) + '</td></tr>';

  body.innerHTML = '<div class="tw"><table class="otable stable"><thead>' + head + '</thead><tbody>' + trs + '</tbody><tfoot>' + foot + '</tfoot></table></div>';

  if (d.truncated) showSalesNote('订单较多，本页仅统计最近 ' + fmt(rows.length) + ' 单（接口共 ' + fmt(d.apiTotal) + ' 单）。缩小日期范围可查看完整明细。');
  renderHubTrend();
}

function bindSalesEvents() {
  const r = $('#salesRange');
  if (r) r.querySelectorAll('button').forEach(b => b.onclick = () => {
    if (b.dataset.r === 'custom') { const f = $('#salesFrom'); if (f && f.focus) f.focus(); return; }
    r.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    setSalesRange(b.dataset.r);
    loadSales(true);
  });
  const g = $('#salesGran');
  if (g) g.querySelectorAll('button').forEach(b => b.onclick = () => {
    g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    salesView.gran = b.dataset.g;
    if (salesView.data) renderSales(salesView.data);
  });
  const ap = $('#salesApply');
  if (ap) ap.onclick = () => {
    const f = $('#salesFrom'), t = $('#salesTo');
    let from = f ? f.value : '', to = t ? t.value : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { toast('❌ 请选择完整的起止日期'); return; }
    if (from > to) { const x = from; from = to; to = x; if (f) f.value = from; if (t) t.value = to; }
    salesView.range = 'custom'; salesView.from = from; salesView.to = to;
    const rr = $('#salesRange'); if (rr) rr.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.r === 'custom'));
    loadSales(true);
  };
  // 刷新按钮已合并到「经营看板」的共用按钮（#ovRefresh），这里不再单独绑
  const au = $('#salesAuto');
  if (au) au.onchange = () => {
    salesView.auto = au.checked;
    toast(au.checked ? '已开启自动刷新（每 30 秒）' : '已暂停自动刷新');
  };
  setSalesRange('today');
}

/* 经营看板：三块（Listing 出单 / 实时订单 / 销售流水）吃的是同一份订单数据，
   所以共用一个刷新按钮、一次全刷 —— 并行发请求，比原来点三次快。 */
async function loadHubProfitEstimate(force=false) {
  const value=$('#hubProfitEstimate'),note=$('#hubProfitNote');
  if(!value||!note||!salesView.from||!salesView.to)return;
  const from=salesView.from,to=salesView.to,key=from+'|'+to;
  if(hubProfitView.pending&&hubProfitView.pendingKey===key)return hubProfitView.pending;
  if(!force&&hubProfitView.key===key&&Date.now()-hubProfitView.at<300000)return;
  value.classList.remove('negative','pending');
  value.textContent='…';note.textContent='正在核算所选期间订单利润与广告费';
  const task=(async()=>{
    try{
      const query='?summary=1&from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to)+(force?'&refresh=1':'');
      const data=await mlGet('/api/ml/profit/orders'+query);
      if(key!==salesView.from+'|'+salesView.to)return;
      const totals=data.totals||{},ads=data.ads||{},net=totals.profitAfterAdsCny;
      hubProfitView.key=key;hubProfitView.at=Date.now();
      if(!ads.available||net==null||!Number.isFinite(Number(net))){
        value.textContent='待核对';value.classList.add('pending');
        note.textContent=ads.error||'广告费用或订单利润数据暂不可用';
        return;
      }
      const amount=Number(net),matched=Number(totals.matched)||0,valid=Number(totals.validLines)||0,unmatched=Number(totals.unmatched)||0;
      value.textContent=money(amount,'CNY');
      if(amount<0)value.classList.add('negative');
      note.textContent=unmatched
        ?'已扣广告费 · '+matched+'/'+valid+' 行已核算，'+unmatched+' 行待核对'
        :'已扣平台费用、成本、头程、税费与广告费 · 人民币';
    }catch(err){
      if(key!==salesView.from+'|'+salesView.to)return;
      hubProfitView.key=key;hubProfitView.at=Date.now();
      value.textContent='待核对';value.classList.add('pending');
      const payload=err.payload||{};
      note.textContent=payload.needAuth?'请先完成美客多账号授权':payload.needConfig?'请先配置美客多 API':'利润暂不可用 · '+err.message;
    }
  })();
  hubProfitView.pendingKey=key;hubProfitView.pending=task;
  try{return await task;}finally{if(hubProfitView.pending===task){hubProfitView.pending=null;hubProfitView.pendingKey='';}}
}

async function refreshOverview() {
  await Promise.all([loadOrderSummary(true), loadSales(true), loadListings(true), loadAds(true), loadHubProfitEstimate(true)]);
}

function startSalesTimer() {
  if (salesView.timer) return;
  salesView.timer = setInterval(() => {
    if (!salesView.auto || currentView !== 'hub' || document.hidden) return;
    // 三个各自带节流（订单 60s、销售/Listing 各 15s），所以 30s 一轮不会造成重复请求
    loadOrderSummary(); loadSales(); loadListings(); loadHubProfitEstimate();
  }, 30000);
}

/* ---- 售前/售后实时性：定时轮询 ----
   美客多没有向本工具推送事件的通道，只能定时拉。此前问答/售后只在「打开页面那一刻」拉一次，
   所以 Upseller 已推送、我们页面还停在旧数据。 */
// 有未发送的输入时跳过本轮，避免把用户正在打字的内容刷掉
function hasDirtyInput(sel) {
  const ns = $$(sel + ' textarea');
  for (const t of ns) { if (t.value && t.value.trim()) return true; }
  return false;
}
function startQuestionsTimer() {
  if (questionView.timer) return;
  questionView.timer = setInterval(() => {
    if (currentView !== 'questions' || document.hidden) return;
    if (hasDirtyInput('#questionBody')) return;
    loadQuestions();
  }, 30000);
}
function startClaimsTimer() {
  if (claimView.timer) return;
  claimView.timer = setInterval(() => {
    if (currentView !== 'claims' || document.hidden) return;
    if (hasDirtyInput('#claimBody')) return;
    loadClaims();
  }, 120000);
}
// 角标全局定时刷新：不论停在哪一页，新问答/新售后都能及时提醒
// 用 force 绕过 loadOrderSummary 内的 60s 节流——否则请求本身的耗时会让轮询被节流吃掉
let summaryTimer = null;
function startSummaryTimer() {
  if (summaryTimer) return;
  summaryTimer = setInterval(() => { if (!document.hidden) loadOrderSummary(true); }, 60000);
}

/* ---- 概览：Listing 出单统计 ---- */
const listingView = { from: '', to: '', range: 'today', data: null, at: 0 };

function setListingRange(r) {
  const today = brToday();
  let from = today, to = today;
  if (r === '7') from = addDays(today, -6);
  else if (r === '30') from = addDays(today, -29);
  listingView.range = r; listingView.from = from; listingView.to = to;
  const f = $('#listingFrom'), t = $('#listingTo');
  if (f) f.value = from;
  if (t) t.value = to;
}
function clearListings() {
  const b = $('#listingBody'); if (b) b.innerHTML = '<div class="empty">暂无数据</div>';
}
function showListingNote(t) { const e = $('#listingNote'); if (e) { e.textContent = t; e.style.display = 'block'; } }
function hideListingNote() { const e = $('#listingNote'); if (e) e.style.display = 'none'; }

async function loadListings(force) {
  if (!force && listingView.at && Date.now() - listingView.at < 15000) return;
  const btn = $('#ovRefresh');
  if (btn) btn.classList.add('spin');
  setStateEl($('#listingState'), 'warn', '同步中');
  try {
    const q = '?from=' + encodeURIComponent(listingView.from) + '&to=' + encodeURIComponent(listingView.to);
    const d = await mlGet('/api/ml/listings' + q);
    listingView.at = Date.now();
    listingView.data = d;
    renderListings(d);
  } catch (e) {
    const p = e.payload || {};
    listingView.data = null;
    clearListings();
    if (p.needAuth) {
      setStateEl($('#listingState'), 'warn', '待授权');
      showListingNote('凭证已保存，还差账号授权。点上方「API 设置」→「开始授权」。');
    } else if (p.needConfig || p.configured === false) {
      setStateEl($('#listingState'), 'warn', '未配置');
      showListingNote('尚未配置美客多 API 凭证，无法统计 Listing 出单。');
    } else {
      setStateEl($('#listingState'), 'err', '异常');
      showListingNote('Listing 出单统计失败：' + e.message + '（点「刷新」重试）');
    }
  } finally {
    setTimeout(() => { if (btn) btn.classList.remove('spin'); }, 480);
  }
}

function renderListings(d) {
  setStateEl($('#listingState'), 'ok', '实时');
  hideListingNote();
  const cur = d.currency || 'BRL';
  const t = d.totals || {};
  const note = $('#listingTzNote');
  if (note) note.textContent = '按' + (d.tzLabel || '巴西时间') + ' 统计 · 范围 ' + d.range.from + ' ~ ' + d.range.to
    + ' · 更新于 ' + brClock(d.updatedAt) + '（巴西时间）' + (d.cached ? ' · 缓存' : '');

  const body = $('#listingBody');
  const list = d.listings || [];
  renderHubListings(d);
  if (!list.length) { body.innerHTML = '<div class="empty">该时间范围内没有出单</div>'; return; }

  const rows = list.map(l => {
    const img = l.thumbnail
      ? '<img class="lthumb" src="' + escHtml(l.thumbnail) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<span class="lthumb" style="display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:10px">无图</span>';
    const title = l.permalink
      ? '<a class="lti" href="' + escHtml(l.permalink) + '" target="_blank" rel="noreferrer">' + escHtml(l.title) + '</a>'
      : '<span class="lti">' + escHtml(l.title) + '</span>';
    return '<tr>'
      + '<td><div class="litem">' + img + '<div class="ltx">' + title + '<div class="lid">' + escHtml(l.id) + '</div></div></div></td>'
      + '<td class="ta-r"><span class="lqty">' + fmt(l.qty) + '</span></td>'
      + '<td class="ta-r">' + fmt(l.orders) + '</td>'
      + '<td class="ta-r"><span class="lamt">' + money(l.amount, cur) + '</span></td>'
      + '</tr>';
  }).join('');

  body.innerHTML = '<div class="tw"><table class="otable listing-table"><thead><tr>'
    + '<th>商品</th><th class="ta-r">出单数量(件)</th><th class="ta-r">订单数</th><th class="ta-r">出单金额</th>'
    + '</tr></thead><tbody>' + rows + '</tbody>'
    + '<tfoot><tr class="sfoot"><td>合计（' + fmt(t.listings) + ' 个 Listing）</td><td class="ta-r">' + fmt(t.qty) + '</td><td class="ta-r">—</td><td class="ta-r">' + money(t.amount, cur) + '</td></tr></tfoot>'
    + '</table></div>';

  if (d.truncated) showListingNote('订单较多，已统计最近 ' + fmt(d.apiTotal) + ' 单。缩小日期范围可查看完整明细。');
}

function bindListingEvents() {
  const r = $('#listingRange');
  if (r) r.querySelectorAll('button').forEach(b => b.onclick = () => {
    if (b.dataset.r === 'custom') { const f = $('#listingFrom'); if (f && f.focus) f.focus(); return; }
    r.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    setListingRange(b.dataset.r);
    loadListings(true);
  });
  const ap = $('#listingApply');
  if (ap) ap.onclick = () => {
    const f = $('#listingFrom'), t = $('#listingTo');
    let from = f ? f.value : '', to = t ? t.value : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { toast('❌ 请选择完整的起止日期'); return; }
    if (from > to) { const x = from; from = to; to = x; if (f) f.value = from; if (t) t.value = to; }
    listingView.range = 'custom'; listingView.from = from; listingView.to = to;
    const rr = $('#listingRange'); if (rr) rr.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.r === 'custom'));
    loadListings(true);
  };
  // 刷新按钮已合并到「经营看板」的共用按钮（#ovRefresh），这里不再单独绑
  setListingRange('today');
}

/* ---- 广告投放：Mercado Ads / Product Ads ---- */
// 注意：from/to 初始值必须直接给「巴西今天」，否则 #ads 直达时 initRouting 会在
// bindAdsEvents 之前就调用 loadAds，带着空 from/to 请求 → 后端 fallback 成近 7 天（按钮却是当天）
const adsView = (() => {
  const t = brToday();
  return { from: t, to: t, range: 'today', tab: 'day', auto: true, data: null, timer: null, at: 0 };
})();
const ADS_STATUS_CN = { active: '投放中', paused: '已暂停', deleted: '已删除' };

function pct(v) {
  const n = Number(v) || 0;
  return (Math.round(n * 100) / 100).toFixed(2) + '%';
}
function ratioStr(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2) + 'x'; }

function setAdsRange(r) {
  const today = brToday();
  let from = today, to = today;
  if (r === '7') from = addDays(today, -6);
  else if (r === '30') from = addDays(today, -29);
  else if (r === 'month') from = today.slice(0, 8) + '01';
  adsView.range = r; adsView.from = from; adsView.to = to;
  const f = $('#adsFrom'), t = $('#adsTo');
  if (f) f.value = from;
  if (t) t.value = to;
  // 同步范围按钮的高亮，与 HTML 默认 on 一致（不依赖 HTML 静态 class）
  const rb = $('#adsRange');
  if (rb) rb.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.r === r));
}
function clearAds() {
  renderHubAds(null);
  ['ak-cost', 'ak-amount', 'ak-amount-sub', 'ak-acos', 'ak-roas', 'ak-clicks', 'ak-clicks-sub', 'ak-units', 'ak-cpc', 'ak-ctr'].forEach(id => { const e = $('#' + id); if (e) e.textContent = '—'; });
  const b = $('#adsBody'); if (b) b.innerHTML = '<div class="empty">暂无数据</div>';
}
function showAdsTip(t) { const e = $('#adsTip'); if (e) { e.textContent = t; e.style.display = 'block'; } }
function hideAdsTip() { const e = $('#adsTip'); if (e) e.style.display = 'none'; }

async function loadAds(force) {
  if (!adsView.from || !adsView.to) setAdsRange('today');   // 自愈：范围未初始化时兜底为当天
  if (!force && adsView.at && Date.now() - adsView.at < 60000) return;
  const btn = $('#adsRefresh');
  if (btn) btn.classList.add('spin');
  setStateEl($('#adsState'), 'warn', '同步中');
  try {
    const q = '?from=' + encodeURIComponent(adsView.from) + '&to=' + encodeURIComponent(adsView.to);
    const d = await mlGet('/api/ml/ads' + q);
    adsView.at = Date.now();
    adsView.data = d;
    renderAds(d);
  } catch (e) {
    const p = e.payload || {};
    adsView.data = null;
    clearAds();
    if (p.needAuth) {
      setStateEl($('#adsState'), 'warn', '待授权');
      showAdsTip('App ID 与 Secret Key 已保存，还差最后一步账号授权。点概览页「API 设置」→「开始授权」即可拉取广告数据。');
    } else if (p.needConfig || p.configured === false) {
      setStateEl($('#adsState'), 'warn', '未配置');
      showAdsTip('尚未配置美客多 API 凭证，无法拉取广告数据。');
    } else {
      setStateEl($('#adsState'), 'err', '异常');
      showAdsTip('广告数据拉取失败：' + e.message + '（点「刷新」重试）');
    }
  } finally {
    setTimeout(() => { if (btn) btn.classList.remove('spin'); }, 480);
  }
}

function renderHubAds(d) {
  const note=$('#hubAdsNote');if(!d){const ids=['hubAdCostDetail','hubAdSales','hubAdAcos','hubAdRoas','hubAdUnits'];for(const id of ids){const e=$('#'+id);if(e)e.textContent='—';}if(note)note.textContent='请检查 API 授权或刷新重试';return;}
  const t=d.totals||{},cur=d.currency||'BRL',set=(id,v)=>{const e=$('#'+id);if(e)e.textContent=v;};set('hubAdCostDetail',money(t.cost,cur));set('hubAdSales',money(t.totalAmount,cur));set('hubAdAcos',t.totalAmount>0?pct(t.acos):'—');set('hubAdRoas',t.cost>0?ratioStr(t.roas):'—');set('hubAdUnits',fmt(t.units||0)+' 件');if(note)note.textContent='范围 '+(d.range?.from||adsView.from)+' 至 '+(d.range?.to||adsView.to)+(d.cached?' · 缓存':'');renderHubTrend();
}
function renderAds(d) {
  renderHubAds(d);
  setStateEl($('#adsState'), 'ok', '实时');
  hideAdsTip();
  const t = d.totals || {}, cur = d.currency || 'BRL';
  const set = (id, v) => { const e = $('#' + id); if (e) e.textContent = (v == null) ? '—' : v; };
  set('ak-cost', money(t.cost, cur));
  set('ak-amount', money(t.totalAmount, cur));
  set('ak-amount-sub', '直接 ' + fmt(Math.round(t.directAmount)) + ' / 间接 ' + fmt(Math.round(t.indirectAmount)));
  set('ak-acos', t.totalAmount > 0 ? pct(t.acos) : '—');
  set('ak-roas', t.cost > 0 ? ratioStr(t.roas) : '—');
  set('ak-clicks', fmt(t.clicks));
  set('ak-clicks-sub', '展示 ' + fmt(t.prints));
  set('ak-units', fmt(t.units));
  set('ak-cpc', t.clicks ? money(t.cpc, cur) : '—');
  set('ak-ctr', t.prints ? pct(t.ctr) : '—');

  const note = $('#adsNote');
  if (note) note.textContent = '广告账户 ' + (d.advertiser.name || d.advertiser.id) + '（ID ' + d.advertiser.id + '）· 按' + (d.tzLabel || '巴西时间')
    + ' 统计 · 范围 ' + d.range.from + ' ~ ' + d.range.to + ' · 共 ' + d.campaignTotal + ' 个活动（在投 ' + d.activeCampaigns + '）'
    + ' · 更新于 ' + brClock(d.updatedAt) + '（巴西时间）' + (d.cached ? ' · 缓存' : '');

  const body = $('#adsBody');
  const cur2 = cur;
  const money0 = v => money(v, cur2);
  let html = '';

  if (adsView.tab === 'campaign') {
    const list = d.campaigns || [];
    if (!list.length) { body.innerHTML = '<div class="empty">该账户下没有广告活动</div>'; afterAdsRender(d); return; }
    const rows = list.map(c => {
      const st = ADS_STATUS_CN[c.status] || c.status || '-';
      const cls = c.status === 'active' ? 'paid' : (c.status === 'paused' ? 'pending' : '');
      return '<tr>'
        + '<td><b>' + escHtml(c.name) + '</b><div style="color:var(--mut);font-size:11.5px">ID ' + escHtml(c.id) + ' · ACOS目标 ' + pct(c.acosTarget) + ' · ROAS目标 ' + ratioStr(c.roasTarget) + '</div></td>'
        + '<td><span class="obadge ' + cls + '">' + escHtml(st) + '</span></td>'
        + '<td class="ta-r">' + (c.dailyBudget ? money0(c.dailyBudget) : '—') + '</td>'
        + '<td class="ta-r">' + money0(c.cost) + '</td>'
        + '<td class="ta-r">' + money0(c.totalAmount) + '</td>'
        + '<td class="ta-r">' + (c.totalAmount > 0 ? pct(c.acos) : '—') + '</td>'
        + '<td class="ta-r">' + (c.cost > 0 ? ratioStr(c.roas) : '—') + '</td>'
        + '<td class="ta-r">' + fmt(c.clicks) + '</td>'
        + '<td class="ta-r">' + fmt(c.units) + '</td>'
        + '</tr>';
    }).join('');
    const head = '<tr><th>活动</th><th>状态</th><th class="ta-r">日预算</th><th class="ta-r">花费</th><th class="ta-r">销售额</th><th class="ta-r">ACOS</th><th class="ta-r">ROAS</th><th class="ta-r">点击</th><th class="ta-r">单量</th></tr>';
    const foot = '<tr class="sfoot"><td colspan="3">合计</td><td class="ta-r">' + money0(t.cost) + '</td><td class="ta-r">' + money0(t.totalAmount)
      + '</td><td class="ta-r">' + (t.totalAmount > 0 ? pct(t.acos) : '—') + '</td><td class="ta-r">' + (t.cost > 0 ? ratioStr(t.roas) : '—')
      + '</td><td class="ta-r">' + fmt(t.clicks) + '</td><td class="ta-r">' + fmt(t.units) + '</td></tr>';
    html = '<div class="tw"><table class="otable stable"><thead>' + head + '</thead><tbody>' + rows + '</tbody><tfoot>' + foot + '</tfoot></table></div>';
  } else {
    const list = d.daily || [];
    if (!list.length) { body.innerHTML = '<div class="empty">该时间范围内没有广告数据</div>'; afterAdsRender(d); return; }
    // 「自然单」要拿当天总出单来算，而总出单只有分时接口（/ads/hourly 的 byDay）有 —— 这里按日期补上
    const ordersByDate = {};
    ((adsHour.data && adsHour.data.byDay) || []).forEach(b => { ordersByDate[b.date] = Number(b.orders) || 0; });
    let cumCost = 0, cumAmt = 0, sumAd = 0, sumNat = 0, hasOrderData = false;
    const rows = list.map(r => {
      cumCost += Number(r.cost) || 0; cumAmt += Number(r.totalAmount) || 0;
      const adU = Number(r.units) || 0;
      const totO = ordersByDate[r.date];
      const hasO = (totO !== undefined);
      if (hasO) hasOrderData = true;
      const adN = hasO ? Math.min(adU, totO) : adU;
      const natN = hasO ? Math.max(0, totO - adN) : null;
      sumAd += adN; if (natN != null) sumNat += natN;
      const cell = (natN == null)
        ? '<span style="color:#93c5fd">' + fmt(adN) + '</span> <span style="color:var(--mut)">/ —</span>'
        : '<span style="color:#93c5fd">' + fmt(adN) + '</span> <span style="color:var(--mut)">/ ' + fmt(natN) + '</span>';
      return '<tr>'
        + '<td class="s-time">' + escHtml(r.date) + '</td>'
        + '<td class="ta-r">' + money0(r.cost) + '</td>'
        + '<td class="ta-r">' + money0(r.totalAmount) + '</td>'
        + '<td class="ta-r">' + (r.totalAmount > 0 ? pct(r.acos) : '—') + '</td>'
        + '<td class="ta-r">' + (r.cost > 0 ? ratioStr(r.roas) : '—') + '</td>'
        + '<td class="ta-r">' + fmt(r.clicks) + '</td>'
        + '<td class="ta-r">' + cell + '</td>'
        + '<td class="ta-r s-cum">' + money0(cumCost) + '</td>'
        + '<td class="ta-r s-cum">' + money0(cumAmt) + '</td>'
        + '</tr>';
    }).join('');
    const head = '<tr><th>日期（巴西）</th><th class="ta-r">花费</th><th class="ta-r">销售额</th><th class="ta-r">ACOS</th><th class="ta-r">ROAS</th><th class="ta-r">点击</th><th class="ta-r">广告单 / 自然单</th><th class="ta-r">累计花费</th><th class="ta-r">累计销售额</th></tr>';
    const foot = '<tr class="sfoot"><td>合计</td><td class="ta-r">' + money0(t.cost) + '</td><td class="ta-r">' + money0(t.totalAmount)
      + '</td><td class="ta-r">' + (t.totalAmount > 0 ? pct(t.acos) : '—') + '</td><td class="ta-r">' + (t.cost > 0 ? ratioStr(t.roas) : '—')
      + '</td><td class="ta-r">' + fmt(t.clicks) + '</td><td class="ta-r">' + (hasOrderData
        ? '<span style="color:#93c5fd">' + fmt(sumAd) + '</span> <span style="color:var(--mut)">/ ' + fmt(sumNat) + '</span>'
        : fmt(t.units))
      + '</td><td class="ta-r">' + money0(t.cost) + '</td><td class="ta-r">' + money0(t.totalAmount) + '</td></tr>';
    html = '<div class="tw"><table class="otable stable"><thead>' + head + '</thead><tbody>' + rows + '</tbody><tfoot>' + foot + '</tfoot></table></div>';
  }
  body.innerHTML = html;
  afterAdsRender(d);
}

function afterAdsRender(d) {
  const tips = [];
  if (d.campaignsTruncated) tips.push('活动较多，活动明细只展示花费最高的 ' + fmt((d.campaigns || []).length) + ' 个（账户共 ' + fmt(d.campaignTotal) + ' 个）；上方汇总与按天趋势仍是全账户口径。');
  if (d.range.to === brToday()) tips.push('当天数据美客多仍在更新（每日 10:00 GMT-3 后趋于完整），所以「今天」的花费/单量会偏小，属正常现象。');
  if (tips.length) showAdsTip(tips.join(' ')); else hideAdsTip();
}

function bindAdsEvents() {
  const r = $('#adsRange');
  if (r) r.querySelectorAll('button').forEach(b => b.onclick = () => {
    if (b.dataset.r === 'custom') { const f = $('#adsFrom'); if (f && f.focus) f.focus(); return; }
    r.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    setAdsRange(b.dataset.r);
    loadAds(true);
    loadAdsHourly(true);
  });
  const tb = $('#adsTab');
  if (tb) tb.querySelectorAll('button').forEach(b => b.onclick = () => {
    tb.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    adsView.tab = b.dataset.t;
    if (adsView.data) renderAds(adsView.data);
  });
  const ap = $('#adsApply');
  if (ap) ap.onclick = () => {
    const f = $('#adsFrom'), t = $('#adsTo');
    let from = f ? f.value : '', to = t ? t.value : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { toast('❌ 请选择完整的起止日期'); return; }
    if (from > to) { const x = from; from = to; to = x; if (f) f.value = from; if (t) t.value = to; }
    if ((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 86400000 > 89) {
      from = addDays(to, -89); if (f) f.value = from;
      toast('美客多广告指标最多回溯 90 天，已自动收窄起始日期');
    }
    adsView.range = 'custom'; adsView.from = from; adsView.to = to;
    const rr = $('#adsRange'); if (rr) rr.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.r === 'custom'));
    refreshAds();
  };
  const rf = $('#adsRefresh');
  if (rf) rf.onclick = () => refreshAds();
  const au = $('#adsAuto');
  if (au) au.onchange = () => { adsView.auto = au.checked; toast(au.checked ? '已开启自动刷新（每 5 分钟）' : '已暂停自动刷新'); };
  bindAdsHourEvents();
  setAdsRange('today');
}

// 广告分时 / 广告总览已合并进同一张「广告投放」卡，共用一个刷新按钮：一次把两块都刷掉
async function refreshAds() {
  await Promise.all([loadAds(true), loadAdsHourly(true)]);
}

function startAdsTimer() {
  if (adsView.timer) return;
  adsView.timer = setInterval(() => {
    if (adsView.auto && currentView === 'ads' && !document.hidden) refreshAds();
  }, 300000);
}

/* ---- 广告分时：按小时看花费 / 出单 ---- */
const adsHour = { view: 'hour', metric: 'orders', data: null, at: 0, key: '' };
const SRC_CN = { measured: '实测', est: '估算', progress: '进行中' };
// 24 小时汇总视图里某个小时的数据来源（跨多天时为「实测 x/y 天」）
function hourSrcLabel(h, d) {
  const m = h.measured || 0, tot = d.days || 1;
  if (m >= tot) return '实测';
  if (m > 0) return '实测 ' + m + '/' + tot + ' 天';
  return '估算';
}
function adsHourRangeKey() { return adsView.from + '|' + adsView.to; }

async function loadAdsHourly(force) {
  if (!adsView.from || !adsView.to) setAdsRange('today');   // 自愈：范围未初始化时兜底为当天
  const body = $('#adsHourBody');
  if (!force && adsHour.data && adsHour.key === adsHourRangeKey() && Date.now() - adsHour.at < 60000) return;
  const btn = $('#adsRefresh');            // 与总览共用同一个刷新按钮（已合卡）
  if (btn) btn.classList.add('spin');
  if (body) body.innerHTML = '<div class="empty">正在按小时统计订单…（首次约需数秒）</div>';
  try {
    const q = '?from=' + encodeURIComponent(adsView.from) + '&to=' + encodeURIComponent(adsView.to);
    const d = await mlGet('/api/ml/ads/hourly' + q);
    adsHour.data = d; adsHour.at = Date.now(); adsHour.key = adsHourRangeKey();
    renderAdsHour();
    // 总览的「按天趋势」要用这边的「当天出单数」来算自然单 → 到了就顺手重绘一次（只重绘，不再请求）
    if (adsView.data && adsView.tab === 'day') renderAds(adsView.data);
  } catch (e) {
    const p = e.payload || {};
    if (body) body.innerHTML = '<div class="empty">分时数据加载失败：' + escHtml(p.error || e.message) + '<br><button class="btn" id="hhRetry" style="margin-top:12px">重试</button></div>';
    const rb = $('#hhRetry'); if (rb) rb.onclick = () => loadAdsHourly(true);
  } finally {
    setTimeout(() => { if (btn) btn.classList.remove('spin'); }, 480);
  }
}

function hhKpi(label, val, sub, hl) {
  return '<div class="hh-kpi' + (hl ? ' hl' : '') + '"><span>' + escHtml(label) + '</span><b>'
    + escHtml(String(val)) + (sub ? '<small>' + escHtml(sub) + '</small>' : '') + '</b></div>';
}

function renderAdsHour() {
  const d = adsHour.data;
  if (!d || !d.ok) return;
  const cur = d.currency || 'BRL';
  const multi = (d.days || 1) > 1;

  // 视图收敛：单天只能看「按小时」；多天默认「按天」
  // （小时级广告花费只能靠分摊，多天再谈"每小时"没有意义 —— 这也是之前数据看着会变的原因之一）
  if (multi && adsHour.view === 'hour') adsHour.view = 'day';
  if (!multi && adsHour.view !== 'hour') adsHour.view = 'hour';
  const vbox = $('#adsHourView');
  if (vbox) vbox.querySelectorAll('button').forEach(b => {
    const v = b.dataset.v;
    const show = multi ? (v === 'day' || v === 'heat') : (v === 'hour');
    b.style.display = show ? '' : 'none';
    b.classList.toggle('on', v === adsHour.view);
  });
  // 「出单数量 / 花费」这个口径切换只对单天的按小时图有意义；按天图本来就同时画了出单和花费
  const mbox = $('#adsHourMetric');
  if (mbox) mbox.style.display = multi ? 'none' : '';

  const led = d.ledger || {};
  const mSlots = d.measuredSlots || 0, tSlots = d.totalSlots || (d.days * 24);
  const note = $('#adsHourNote');
  if (note) note.textContent = multi
    ? '巴西时间 GMT-3 · 区间 ' + d.range.from + ' ~ ' + d.range.to + '（' + d.days + ' 天）· 按天汇总；花费为美客多官方按天值，已存入本地账本，历史日期不再变化'
    : '巴西时间 GMT-3 · ' + d.range.from + ' · 出单为真实值；花费已实测 ' + mSlots + '/' + tSlots + ' 小时' + (mSlots < tSlots ? '（其余按当天出单占比分摊）' : '');

  const tot = d.orders || {}, ads = d.ads || {};
  const kpi = $('#adsHourKpis');
  if (kpi) {
    if (multi) {
      const days = d.byDay || [];
      const best = days.reduce((a, b) => (b.orders > (a ? a.orders : -1) ? b : a), null);
      kpi.innerHTML =
        hhKpi('区间出单总数', fmt(tot.total), ' 单 · ' + d.days + ' 天')
        + hhKpi('区间广告花费', money(ads.cost, cur), ' 美客多官方按天值')
        + hhKpi('单日最高出单', best ? best.date.slice(5) + ' · ' + fmt(best.orders) + ' 单' : '—', '', true)
        + hhKpi('已存入账本', (led.finalDays || 0) + ' / ' + d.days + ' 天', '冻结后数值不再变化');
    } else {
      const peak = d.hourly[d.peakHour] || { hour: 0, orders: 0 };
      const share = tot.total ? Math.round(peak.orders / tot.total * 100) : 0;
      kpi.innerHTML =
        hhKpi('高峰出单时段', String(peak.hour).padStart(2, '0') + ':00–' + String((peak.hour + 1) % 24).padStart(2, '0') + ':00', '', true)
        + hhKpi('该时段出单', fmt(peak.orders), ' 单 · 占全天 ' + share + '%')
        + hhKpi('全天出单总数', fmt(tot.total), ' 单' + (tot.cancelled ? '（另剔除取消 ' + tot.cancelled + '）' : ''))
        + hhKpi('当天广告花费', money(ads.cost, cur), ' 官方按天 · 实测 ' + mSlots + '/' + tSlots + ' 小时');
    }
  }

  if (!multi) drawHourChart(d);
  else if (adsHour.view === 'heat') drawHeat(d);
  else drawDayChart(d);

  const tip = $('#adsHourTip');
  if (tip) {
    const t = [d.note || ''];
    if (!d.adsAvailable) t.push('广告按天数据本次拉取失败，花费相关栏位暂为 0，可点「刷新」重试。');
    if (d.truncated) t.push('区间订单较多，仅统计前 ' + fmt(d.fetched) + ' / ' + fmt(d.apiTotal) + ' 单。');
    if (multi) t.push('多天区间只给出「每天的花费总额 + 总出单」；想看清每个小时的花费，把范围切到单天（今天 / 自定义同一天）。');
    else if (d.range.to === brToday()) t.push('当天尚未结束，末尾小时数据偏小属正常。');
    tip.textContent = t.filter(Boolean).join(' ');
    tip.style.display = 'block';
  }
}

// 多天区间：按天画「当天总出单（柱）+ 当天花费总额（线 · 右轴）」
// 不做小时级分摊 —— 多天的"每小时"只是把每天摊一遍再加起来，没有实际意义。
function drawDayChart(d) {
  const body = $('#adsHourBody'); if (!body) return;
  const cur = d.currency || 'BRL';
  const days = d.byDay || [];
  if (!days.length) { body.innerHTML = '<div class="empty">该区间暂无数据</div>'; return; }

  const orders = days.map(x => Number(x.orders) || 0);
  const costs = days.map(x => Number(x.adCost) || 0);
  const n = days.length;
  const W = 1000, H = 320, L = 58, R = 60, T = 18, B = 42;
  const pw = W - L - R, ph = H - T - B;
  const omax = Math.max(1, ...orders) * 1.18;
  const cmax = Math.max(0.0001, ...costs) * 1.18;
  const bw = pw / n;
  const yo = v => T + ph - (v / omax) * ph;
  const yc = v => T + ph - (v / cmax) * ph;
  const xc = i => L + i * bw + bw / 2;

  let g = '';
  for (let j = 0; j <= 4; j++) {
    const yy = T + ph - (ph * j / 4);
    g += '<line class="hgl" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '"/>';
    g += '<text class="hax-y" x="' + (L - 10) + '" y="' + (yy + 3.5).toFixed(1) + '">' + Math.round(omax * j / 4) + '</text>';
    g += '<text class="htx" x="' + (W - R + 10) + '" y="' + (yy + 3.5).toFixed(1) + '" style="text-anchor:start;fill:#c9b8ff">' + Math.round(cmax * j / 4).toLocaleString('en-US') + '</text>';
  }

  // 每天同样拆「广告单（实色）+ 自然单（淡色）」。
  // 注意：adUnits 是「件数」、orders 是「订单条数」，口径不同不能直接相减，所以钳到不超过当天总单。
  const adPerDay = days.map(x => Math.min(Number(x.adUnits) || 0, Number(x.orders) || 0));
  let bars = '', clips = '';
  for (let i = 0; i < n; i++) {
    const v = orders[i];
    if (v <= 0) continue;
    const x = L + i * bw + bw * 0.19, w = bw * 0.62;
    const adV = adPerDay[i];
    const totalH = (v / omax) * ph, adH = (adV / omax) * ph, yTotal = T + ph - totalH, yAd = T + ph - adH;
    const clipId = 'hbar-clip-' + i;
    clips += '<clipPath id="' + clipId + '"><rect x="' + x.toFixed(1) + '" y="' + yTotal.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + totalH.toFixed(1) + '" rx="3"/></clipPath>';
    bars += '<rect class="hb" data-i="' + i + '" x="' + x.toFixed(1) + '" y="' + yTotal.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + totalH.toFixed(1) + '" rx="3"/>';
    if (adH > 0.4) bars += '<rect class="hb-ad" data-i="' + i + '" clip-path="url(#' + clipId + ')" x="' + x.toFixed(1) + '" y="' + yAd.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + adH.toFixed(1) + '"/>';
  }
  const pts = costs.map((v, i) => xc(i).toFixed(1) + ',' + yc(v).toFixed(1)).join(' ');
  const lineArea = 'M ' + xc(0).toFixed(1) + ' ' + (T + ph) + ' L ' + pts.replace(/ /g, ' L ') + ' L ' + xc(n - 1).toFixed(1) + ' ' + (T + ph) + ' Z';
  let dots = '';
  for (let i = 0; i < n; i++) dots += '<circle class="hdot" data-i="' + i + '" cx="' + xc(i).toFixed(1) + '" cy="' + yc(costs[i]).toFixed(1) + '" r="2.4"/>';

  const step = Math.max(1, Math.ceil(n / 12));
  let xlab = '';
  for (let i = 0; i < n; i += step) {
    xlab += '<text class="htx" x="' + xc(i).toFixed(1) + '" y="' + (H - 16) + '" style="text-anchor:middle">' + days[i].date.slice(5) + '</text>';
  }

  body.innerHTML = '<div class="hchart">'
    + '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-label="按天图">'
    + '<defs><linearGradient id="hbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9ecbff" stop-opacity=".60"/><stop offset=".24" stop-color="#d9dcff" stop-opacity=".48"/><stop offset=".54" stop-color="#cbbaff" stop-opacity=".36"/><stop offset=".82" stop-color="#ffc1e8" stop-opacity=".46"/><stop offset="1" stop-color="#9678df" stop-opacity=".38"/></linearGradient><linearGradient id="hbg-ad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#6b62c8" stop-opacity=".53"/><stop offset=".52" stop-color="#9182e3" stop-opacity=".48"/><stop offset="1" stop-color="#e0a6dc" stop-opacity=".48"/></linearGradient><linearGradient id="harea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#cbb8ff" stop-opacity=".22"/><stop offset="1" stop-color="#cbb8ff" stop-opacity="0"/></linearGradient>' + clips + '</defs>'
    + g + '<path class="harea" d="' + lineArea + '"/>' + bars + '<polyline class="hline" points="' + pts + '"/>' + dots + xlab
    + '<line class="hgl" id="hhl" x1="0" x2="0" y1="' + T + '" y2="' + (T + ph) + '" style="stroke:#7dd3fc66;stroke-dasharray:3 3;opacity:0"/>'
    + '</svg><div class="htip" id="hhTip"></div></div>'
    + '<div class="leg-h"><span class="k-ad"><i></i>广告单（玻璃柱内深色段）</span><span class="k-nat"><i></i>自然单（玻璃柱余量）</span><span class="k-cost"><i></i>当天花费总额</span></div>'
    + '<div class="leg-note">每天的花费为<b>美客多官方按天值</b>，已写入本地账本、冻结后不再变化；<b>自然单 = 当天总出单 − 广告单</b>（广告单量官方只提供按天口径）。想看每个小时的明细，把范围切到<b>单天</b>。</div>';

  const svg = body.querySelector('svg'), tipEl = $('#hhTip'), hl = $('#hhl');
  svg.onmousemove = e => {
    const rc = svg.getBoundingClientRect();
    const px = (e.clientX - rc.left) / rc.width * W;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - L) / bw)));
    const day = days[i];
    hl.setAttribute('x1', xc(i)); hl.setAttribute('x2', xc(i)); hl.style.opacity = 1;
    tipEl.innerHTML = '<b>' + day.date + '</b>'
      + '<span>出单 ' + fmt(day.orders) + ' 单 · 件数 ' + fmt(day.units) + '</span><br>'
      + '<span style="color:#cbb8ff">▪ 广告单 ' + fmt(adPerDay[i]) + ' 单</span>'
      + '<span>　▪ 自然单 ' + fmt(Math.max(0, (Number(day.orders) || 0) - adPerDay[i])) + ' 单</span><br>'
      + '<span>花费 ' + money(day.adCost, cur) + (day.final ? '（已存账本 · 不再变化）' : '（进行中）') + '</span><br>'
      + '<span>广告销售额 ' + money(day.adAmount, cur) + '</span>';
    tipEl.style.left = (xc(i) / W * 100) + '%';
    tipEl.style.top = Math.min(yc(costs[i]), yo(orders[i])) / H * rc.height + 'px';
    tipEl.style.opacity = 1;
  };
  svg.onmouseleave = () => { tipEl.style.opacity = 0; hl.style.opacity = 0; };
}

// 美客多广告单只有「按天」口径（units_quantity），而分时是「按小时」。
// 这里把当天的广告单按该天的出单小时分布分摊到 24 小时。
//
// 关键：**结果必须是整数**。订单是「条」，不存在 0.5 单；
// 之前用等比切分（adUnits × 该小时单量 ÷ 当天单量）会在单量少时算出 0.5，看着像 bug。
// 改用「最大余数法」配额分配：先按占比取整，余数最大的小时依次补 1，
// 既保证 Σ(广告单) ≡ 当天广告单量，也保证每格都是整数、且不超过该小时总单（自然单不为负）。
function adSplitForDay(day) {
  const out = new Array(24).fill(0);
  const hrs = (day && day.hours) || [];
  const at = h => Number(hrs[h]) || 0;

  const tot = Math.max(0, Math.round(Number(day && day.orders) || 0));
  // adUnits 是「件数」、orders 是「订单条数」，口径不同 → 先钳到不超过当天总单
  const cap = Math.min(Math.max(0, Math.round(Number(day && day.adUnits) || 0)), tot);
  if (cap <= 0 || tot <= 0) return out;
  // 全是广告单：直接整份给出去
  if (cap >= tot) { for (let h = 0; h < 24; h++) out[h] = at(h); return out; }

  const frac = new Array(24).fill(0);
  let used = 0;
  for (let h = 0; h < 24; h++) {
    const o = at(h);
    const q = o > 0 ? cap * (o / tot) : 0;
    const f = Math.floor(q);
    out[h] = f; used += f;
    frac[h] = q - f;
  }

  // 余数大的先补；并列时「出单多的小时」优先，再并列取更早的小时 → 结果稳定可复现
  const order = [];
  for (let h = 0; h < 24; h++) order.push(h);
  order.sort((a, b) => (frac[b] - frac[a]) || (at(b) - at(a)) || (a - b));

  let left = cap - used;
  for (const h of order) {
    if (left <= 0) break;
    if (out[h] < at(h)) { out[h] += 1; left -= 1; }
  }
  return out;
}
// 跨天：把每天的分摊结果按「小时」加起来（供 24 小时汇总图用）
function adsHourAdSplit(d) {
  const out = new Array(24).fill(0);
  for (const day of (d.byDay || [])) {
    const s = adSplitForDay(day);
    for (let h = 0; h < 24; h++) out[h] += s[h];
  }
  return out;
}

function drawHourChart(d) {
  const body = $('#adsHourBody'); if (!body) return;
  const cur = d.currency || 'BRL';
  const m = adsHour.metric;
  // 只有「出单数量」才分自然/广告；花费无此区分。广告按天数据不可用时也不拆（免得把总单全涂成自然单）
  const split = (m === 'orders' && d.adsAvailable) ? adsHourAdSplit(d) : null;
  const P = d.hourly.map(h => m === 'cost' ? h.cost : h.orders);
  const S = d.hourly.map(h => m === 'cost' ? h.orders : h.cost);
  const W = 1000, H = 320, L = 58, R = 60, T = 18, B = 42;
  const pw = W - L - R, ph = H - T - B;
  const pmax = Math.max(1, ...P) * 1.18;
  const smax = Math.max(0.0001, ...S) * 1.18;
  const bw = pw / 24;
  const yp = v => T + ph - (v / pmax) * ph;
  const ys = v => T + ph - (v / smax) * ph;
  const xc = i => L + i * bw + bw / 2;
  const leftLab = v => m === 'cost' ? Math.round(v).toLocaleString('en-US') : Math.round(v);
  const rightLab = v => Math.round(v).toLocaleString('en-US');

  let g = '';
  for (let j = 0; j <= 4; j++) {
    const yy = T + ph - (ph * j / 4);
    g += '<line class="hgl" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '"/>';
    g += '<text class="hax-y" x="' + (L - 10) + '" y="' + (yy + 3.5).toFixed(1) + '">' + leftLab(pmax * j / 4) + '</text>';
    g += '<text class="htx" x="' + (W - R + 10) + '" y="' + (yy + 3.5).toFixed(1) + '" style="text-anchor:start;fill:#c9b8ff">' + rightLab(smax * j / 4) + '</text>';
  }
  let bars = '', clips = '';
  for (let i = 0; i < 24; i++) {
    const vb = P[i];
    const x = L + i * bw + bw * 0.19, w = bw * 0.62;
    const totalH = Math.max(0, (vb / pmax) * ph), yTotal = T + ph - totalH;
    if (!split) {
      bars += '<rect class="hb" data-i="' + i + '" x="' + x.toFixed(1) + '" y="' + yTotal.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + totalH.toFixed(1) + '" rx="3"/>';
      continue;
    }
    // 用完整玻璃柱承载订单总量，再将广告单色层裁切进柱体；分段不留缝。
    const adV = Math.min(split[i], vb), adH = (adV / pmax) * ph, yAd = T + ph - adH, clipId = 'hbar-clip-' + i;
    clips += '<clipPath id="' + clipId + '"><rect x="' + x.toFixed(1) + '" y="' + yTotal.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + totalH.toFixed(1) + '" rx="3"/></clipPath>';
    bars += '<rect class="hb" data-i="' + i + '" x="' + x.toFixed(1) + '" y="' + yTotal.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + totalH.toFixed(1) + '" rx="3"/>';
    if (adH > 0.4) bars += '<rect class="hb-ad" data-i="' + i + '" clip-path="url(#' + clipId + ')" x="' + x.toFixed(1) + '" y="' + yAd.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + adH.toFixed(1) + '"/>';
  }
  const pts = S.map((v, i) => xc(i).toFixed(1) + ',' + ys(v).toFixed(1)).join(' ');
  const lineArea = 'M ' + xc(0).toFixed(1) + ' ' + (T + ph) + ' L ' + pts.replace(/ /g, ' L ') + ' L ' + xc(23).toFixed(1) + ' ' + (T + ph) + ' Z';
  let dots = '';
  for (let i = 0; i < 24; i++) dots += '<circle class="hdot" data-i="' + i + '" cx="' + xc(i).toFixed(1) + '" cy="' + ys(S[i]).toFixed(1) + '" r="2.4"/>';
  let xlab = '';
  for (let i = 0; i < 24; i += 2) {
    xlab += '<text class="htx' + (i === d.peakHour ? ' hl' : '') + '" x="' + xc(i).toFixed(1) + '" y="' + (H - 16) + '" style="text-anchor:middle">' + String(i).padStart(2, '0') + '</text>';
  }
  const mLabel = m === 'cost' ? '花费' : '出单数量';
  const sLabel = m === 'cost' ? '出单数量' : '花费';

  const leg = split
    ? '<span class="k-ad"><i></i>广告单（玻璃柱内深色段）</span><span class="k-nat"><i></i>自然单（玻璃柱余量）</span><span class="k-cost"><i></i>花费</span>'
    : '<span class="k-ord"><i></i>' + mLabel + '（柱）</span><span class="k-cost"><i></i>' + sLabel + '（线 · 右轴）</span>';
  const legNote = split
    ? '<div class="leg-note">美客多广告单量只提供<b>按天</b>口径，已按当天出单时间分布拆到各小时（<b>整数</b>，加总恒等于当天广告单量，且不超过该小时订单数）；<b>自然单 = 出单 − 广告单</b>。切到「花费」即不分色。</div>'
    : '';

  body.innerHTML = '<div class="hchart">'
    + '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-label="分时图">'
    + '<defs><linearGradient id="hbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9ecbff" stop-opacity=".60"/><stop offset=".24" stop-color="#d9dcff" stop-opacity=".48"/><stop offset=".54" stop-color="#cbbaff" stop-opacity=".36"/><stop offset=".82" stop-color="#ffc1e8" stop-opacity=".46"/><stop offset="1" stop-color="#9678df" stop-opacity=".38"/></linearGradient>'
    + '<linearGradient id="hbg-ad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#6b62c8" stop-opacity=".53"/><stop offset=".52" stop-color="#9182e3" stop-opacity=".48"/><stop offset="1" stop-color="#e0a6dc" stop-opacity=".48"/></linearGradient>'
    + '<linearGradient id="harea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#cbb8ff" stop-opacity=".22"/><stop offset="1" stop-color="#cbb8ff" stop-opacity="0"/></linearGradient>' + clips + '</defs>'
    + g + '<path class="harea" d="' + lineArea + '"/>' + bars + '<polyline class="hline" points="' + pts + '"/>' + dots + xlab
    + '<line class="hgl" id="hhl" x1="0" x2="0" y1="' + T + '" y2="' + (T + ph) + '" style="stroke:#7dd3fc66;stroke-dasharray:3 3;opacity:0"/>'
    + '</svg><div class="htip" id="hhTip"></div></div>'
    + '<div class="leg-h">' + leg + '</div>' + legNote;

  const svg = body.querySelector('svg'), tipEl = $('#hhTip'), hl = $('#hhl');
  svg.onmousemove = e => {
    const rc = svg.getBoundingClientRect();
    const px = (e.clientX - rc.left) / rc.width * W;
    const i = Math.max(0, Math.min(23, Math.floor((px - L) / bw)));
    const h = d.hourly[i];
    let splitLine = '';
    if (split) {
      // split 已经是整数（最大余数法分配），这里再兜一次底，防止越界
      const adV = Math.max(0, Math.min(Math.round(split[i]), h.orders));
      const natV = Math.max(0, h.orders - adV);
      splitLine = '<br><span style="color:#cbb8ff">▪ 广告单 ' + adV + ' 单（按天总量估算）</span>'
        + '<br><span>▪ 自然单 ' + natV + ' 单</span>';
    }
    hl.setAttribute('x1', xc(i)); hl.setAttribute('x2', xc(i)); hl.style.opacity = 1;
    tipEl.innerHTML = '<b>' + String(i).padStart(2, '0') + ':00 – ' + String((i + 1) % 24).padStart(2, '0') + ':00</b>'
      + '<span>出单 ' + h.orders + ' 单</span>' + splitLine
      + '<br><span>花费 ' + money(h.cost, cur) + '（' + hourSrcLabel(h, d) + '）</span>'
      + '<br><span>销售额 ' + money(h.amount, cur) + '</span>';
    tipEl.style.left = (xc(i) / W * 100) + '%';
    tipEl.style.top = Math.min(ys(S[i]), yp(P[i])) / H * rc.height + 'px';
    tipEl.style.opacity = 1;
  };
  svg.onmouseleave = () => { tipEl.style.opacity = 0; hl.style.opacity = 0; };
}

function drawHeat(d) {
  const body = $('#adsHourBody'); if (!body) return;
  const cur = d.currency || 'BRL';
  const m = adsHour.metric;
  const days = d.byDay || [];
  const valsOf = r => (m === 'cost' ? r.hoursCost : r.hours);
  const max = Math.max(1, ...days.flatMap(valsOf));
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  let head = '<tr><th class="hrl">日期</th>';
  for (let h = 0; h < 24; h++) head += '<th>' + String(h).padStart(2, '0') + '</th>';
  head += '<th style="min-width:104px">广告单 / 自然单</th><th style="min-width:70px">合计花费</th><th style="min-width:70px">来源</th></tr>';
  const rows = days.map(r => {
    const dow = wd[new Date(r.date + 'T12:00:00Z').getUTCDay()];
    const vals = valsOf(r);
    const srcs = r.hoursSrc || [];
    const adSplit = adSplitForDay(r);
    const adN = Math.round(adSplit.reduce((s, v) => s + v, 0));
    const natN = Math.max(0, (Number(r.orders) || 0) - adN);
    let tds = '';
    for (let h = 0; h < 24; h++) {
      const v = vals[h] || 0;
      const a = v > 0 ? Math.max(0.14, Math.min(1, v / max)) : 0;
      const bg = v > 0 ? (m === 'cost' ? 'rgba(245,158,11,' + (a * 0.82).toFixed(2) + ')' : 'rgba(59,130,246,' + (a * 0.9).toFixed(2) + ')') : 'transparent';
      const txt = v <= 0 ? '' : (m === 'cost' ? Math.round(v) : v);
      const src = srcs[h] || 'est';
      const adH = adSplit[h], natH = Math.max(0, (Number(r.hours[h]) || 0) - adH);
      tds += '<td class="c' + (v > 0 ? '' : ' dim') + (src === 'measured' ? ' ms' : '') + '" style="background:' + bg + '" title="' + r.date + ' ' + String(h).padStart(2, '0') + ':00 · 出单 ' + r.hours[h] + ' 单（广告 ' + adH + ' / 自然 ' + natH + '） · 花费 ' + money(r.hoursCost[h], cur) + '（' + (SRC_CN[src] || '估算') + '）">' + txt + '</td>';
    }
    const srcN = srcs.filter(s => s === 'measured').length;
    const srcTxt = srcN >= 24 ? '全实测' : (srcN > 0 ? '实测 ' + srcN + '/24' : '估算');
    const srcCol = srcN >= 24 ? 'var(--ok)' : (srcN > 0 ? 'var(--warn)' : 'var(--mut)');
    return '<tr><td class="hrl">' + r.date.slice(5) + ' 周' + dow + '</td>' + tds
      + '<td class="hrl" style="min-width:104px;color:var(--ink)"><span style="color:#93c5fd">' + adN + '</span> / <span style="color:var(--mut)">' + natN + '</span></td>'
      + '<td class="hrl" style="min-width:70px;color:var(--ink)">' + (m === 'cost' ? money(r.adCost, cur) : (r.orders + ' 单')) + '</td>'
      + '<td class="hrl" style="min-width:70px;color:' + srcCol + '">' + srcTxt + '</td></tr>';
  }).join('');
  body.innerHTML = '<div class="heat-wrap"><table class="heat"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="heat-note">行＝日期，列＝小时（巴西时间 GMT-3）。格子越深＝该小时' + (m === 'cost' ? '花费' : '出单') + '越高；悬停可看「出单（广告 / 自然）+ 花费 + 来源」。'
    + '「广告单 / 自然单」为该日合计（<span style="color:#93c5fd">广告</span> / <span style="color:var(--mut)">自然</span>）；「合计花费」为当天官方值；「来源」＝该日 24 小时中有多少是采样实测。</div>';
}

function bindAdsHourEvents() {
  const v = $('#adsHourView');
  if (v) v.querySelectorAll('button').forEach(b => b.onclick = () => {
    v.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    adsHour.view = b.dataset.v;
    if (adsHour.data) renderAdsHour();
  });
  const m = $('#adsHourMetric');
  if (m) m.querySelectorAll('button').forEach(b => b.onclick = () => {
    m.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    adsHour.metric = b.dataset.m;
    if (adsHour.data) renderAdsHour();
  });
  // 分时 / 总览已合并进同一张「广告投放」卡，刷新按钮统一走 #adsRefresh（见 bindAdsEvents），
  // 这里不再单独绑 #adsHourRefresh（该按钮已从 DOM 移除）。
}

/* ---- 订单管理（售后） ---- */
const orderView = { state: 'todo', limit: 20, offset: 0, total: 0 };
const ORDER_QUERY = { all: '', todo: '&todo=1', pending: '&status=paid&tag=not_delivered', shipped: '&tag=delivered', cancelled: '&status=cancelled' };
// 发货方式徽章
function shipBadge(o) {
  if (o.delivery !== 'pending' && !o.needShip) return '<span class="sbadge" style="color:var(--mut)">—</span>';
  if (!o.shipLabel) return '<span class="sbadge" style="color:var(--mut)">—</span>';
  if (o.shipLabel === '官方发货') return '<span class="sbadge official">🏷 ' + escHtml(o.shipLabel) + '·不用管</span>';
  if (o.needShip) return '<span class="sbadge todo">🏷 ' + escHtml(o.shipLabel) + '·待发货</span>';
  return '<span class="sbadge">' + escHtml(o.shipLabel) + '</span>';
}
function orderStatusText(o, labels) {
  if (o.status === 'cancelled') return '已取消';
  if (o.delivery === 'delivered') return '已发货';
  if (o.delivery === 'pending') return '待发货';
  return (labels && labels[o.status]) || o.status || '-';
}
function orderBadgeClass(o) {
  if (o.status === 'cancelled') return 'cancelled';
  if (o.delivery === 'delivered') return 'shipped';
  if (o.delivery === 'pending') return 'pending';
  if (o.status === 'paid') return 'paid';
  return '';
}
async function loadOrders() {
  const body = $('#orderBody');
  setStateEl($('#orderState'), 'warn', '加载中');
  body.innerHTML = '<div class="empty">正在加载订单…</div>';
  try {
    const d = await mlGet('/api/ml/orders?limit=' + orderView.limit + '&offset=' + orderView.offset + (ORDER_QUERY[orderView.state] || ''));
    orderView.total = d.total || 0;
    setStateEl($('#orderState'), 'ok',
      d.todo ? ('待处理 ' + fmt(orderView.total) + ' 单（另官方代发 ' + fmt(d.pendingAll - orderView.total) + ' 单不用管）')
        : ('共 ' + fmt(orderView.total) + ' 单'));
    renderOrders(d);
  } catch (e) { toolError($('#orderState'), body, e, loadOrders); }
}
function renderOrders(d) {
  const body = $('#orderBody');
  const list = d.orders || [];
  if (!list.length) {
    body.innerHTML = '<div class="empty">' + (d.todo ? '🎉 没有需要你动手发货的订单（官方代发的不算）' : '该状态下暂无订单') + '</div>';
    return;
  }
  const labels = d.statusLabels || {};
  const rows = list.map(o => {
    const items = (o.items || []).map(i => '<div>' + escHtml(i.title || i.id || '商品') + ' <i>×' + (i.qty || 1) + '</i></div>').join('') || '<div><i>无商品明细</i></div>';
    return '<tr>'
      + '<td><span class="oid">' + escHtml(o.id) + '</span><div style="color:var(--mut);font-size:11.5px">' + fmtDate(o.date) + '</div></td>'
      + '<td><span class="obadge ' + orderBadgeClass(o) + '">' + escHtml(orderStatusText(o, labels)) + '</span></td>'
      + '<td>' + shipBadge(o) + '</td>'
      + '<td class="oitems">' + items + '</td>'
      + '<td>' + escHtml(o.buyer || '-') + '</td>'
      + '<td style="white-space:nowrap">' + money(o.amount, o.currency) + '</td>'
      + '</tr>';
  }).join('');
  const pages = Math.max(1, Math.ceil(orderView.total / orderView.limit));
  const cur = Math.floor(orderView.offset / orderView.limit) + 1;
  body.innerHTML = '<div class="tw"><table class="otable"><thead><tr><th>订单号</th><th>状态</th><th>发货方式</th><th>商品</th><th>买家</th><th>金额</th></tr></thead><tbody>' + rows + '</tbody></table></div>' + pagerHtml(cur, pages);
  bindPager(body, n => { orderView.offset = n * orderView.limit; loadOrders(); });
}

/* ---- 商品问答（售前） ---- */
const questionView = { state: 'UNANSWERED', limit: 20, offset: 0, total: 0, demo: false, timer: null };
const questionAutoReplyView = { enabled: false, rules: [], status: {}, dirty: false, editingId: null };
async function loadQuestions() {
  const body = $('#questionBody');
  setStateEl($('#questionState'), 'warn', '加载中');
  body.innerHTML = '<div class="empty">正在加载问答…</div>';
  try {
    const st = questionView.state === 'all' ? '' : ('&status=' + encodeURIComponent(questionView.state));
    const dq = questionView.demo ? '&demo=1' : '';
    const d = await mlGet('/api/ml/questions?limit=' + questionView.limit + '&offset=' + questionView.offset + st + dq);
    questionView.total = d.total || 0;
    setStateEl($('#questionState'), d.demo ? 'warn' : 'ok', d.demo ? '示例预览' : ('共 ' + fmt(questionView.total) + ' 条'));
    renderQuestions(d);
  } catch (e) { toolError($('#questionState'), body, e, loadQuestions); }
}
function renderQuestions(d) {
  const body = $('#questionBody');
  const list = d.questions || [];
  if (!list.length) {
    body.innerHTML = '<div class="empty">当前没有未回复的提问 🎉<br>'
      + '<button class="btn" id="qDemo" style="margin-top:16px">👀 查看示例效果</button>'
      + '<div style="font-size:12px;color:var(--mut);margin-top:10px">示例数据只用于预览界面，回复不会真正发出</div></div>';
    const b = $('#qDemo');
    if (b) b.onclick = () => { questionView.demo = true; questionView.offset = 0; loadQuestions(); };
    return;
  }
  const demoBar = d.demo
    ? '<div class="demo-bar"><span>当前为 <b>示例数据</b>，只用于预览界面效果，回复不会真正发出</span><button class="ghost" id="qDemoExit">退出示例</button></div>'
    : '';
  const cards = list.map(q => {
    const un = q.status === 'UNANSWERED';
    const item = q.itemTitle
      ? (q.permalink ? '<a href="' + escHtml(q.permalink) + '" target="_blank" rel="noreferrer">' + escHtml(q.itemTitle) + '</a>' : escHtml(q.itemTitle))
      : ('商品 ' + escHtml(q.itemId || '-'));
    let foot = '';
    if (q.answer) {
      foot = '<div class="qans"><b>✅ 我方回复</b><div class="qans-t">' + escHtml(q.answer.text) + '</div>'
        + '<div class="qans-d">' + fmtDate(q.answer.date) + '</div></div>';
    } else if (un) {
      foot = '<div class="qreply">'
        + '<textarea rows="2" maxlength="2000" placeholder="输入回复内容，Ctrl / ⌘ + Enter 快速发送…" data-ta="' + escHtml(q.id) + '"></textarea>'
        + '<div class="qreply-b"><span class="qcount" data-cnt="' + escHtml(q.id) + '">0 / 2000</span>'
        + '<button class="btn y" data-send="' + escHtml(q.id) + '">发送回复</button></div>'
        + '<div class="qerr" data-err="' + escHtml(q.id) + '" style="display:none"></div>'
        + '</div>';
    }
    const tag = un ? '⏳ 待回复' : (q.status === 'ANSWERED' ? '✅ 已回复' : escHtml(q.status));
    return '<div class="qcard' + (un ? ' un' : '') + '">'
      + '<div class="qhead"><span>' + tag + '</span><span>' + fmtDate(q.date) + ' · 提问 #' + escHtml(q.id) + '</span></div>'
      + '<div class="qtext">' + escHtml(q.text) + '</div>'
      + '<div class="qitem">关联商品：' + item + '</div>' + foot + '</div>';
  }).join('');
  const pages = Math.max(1, Math.ceil(questionView.total / questionView.limit));
  const cur = Math.floor(questionView.offset / questionView.limit) + 1;
  body.innerHTML = demoBar + '<div class="qlist">' + cards + '</div>' + (d.demo ? '' : pagerHtml(cur, pages));

  body.querySelectorAll('textarea[data-ta]').forEach(ta => {
    const id = ta.dataset.ta;
    ta.addEventListener('input', () => { const c = body.querySelector('[data-cnt="' + id + '"]'); if (c) c.textContent = ta.value.length + ' / 2000'; });
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { const b = body.querySelector('button[data-send="' + id + '"]'); if (b) b.click(); }
    });
  });
  body.querySelectorAll('button[data-send]').forEach(b => b.onclick = () => sendAnswer(b, body));
  const ex = $('#qDemoExit');
  if (ex) ex.onclick = () => { questionView.demo = false; questionView.offset = 0; loadQuestions(); };
  bindPager(body, n => { questionView.offset = n * questionView.limit; loadQuestions(); });
}
async function sendAnswer(btn, root) {
  const id = btn.dataset.send;
  const ta = root.querySelector('textarea[data-ta="' + id + '"]');
  const err = root.querySelector('[data-err="' + id + '"]');
  const text = ta ? ta.value.trim() : '';
  const say = t => { if (err) { err.textContent = t || ''; err.style.display = t ? 'block' : 'none'; } };
  say('');
  if (!text) { say('请先输入回复内容'); if (ta) ta.focus(); return; }
  if (text.length > 2000) { say('内容超过 2000 字（当前 ' + text.length + '），请精简后再发送'); return; }
  btn.disabled = true; btn.textContent = '发送中…';
  try {
    const d = await mlGet('/api/ml/questions/' + encodeURIComponent(id) + '/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    toast(d && d.demo ? '示例模式：未真正发送回复' : '✅ 回复已发送到美客多');
    if (d && d.demo && ta) { ta.value = ''; }
    loadQuestions();
  } catch (e) {
    const p = e.payload || {};
    say('❌ ' + (p.error || e.message) + (p.hint ? ' ｜ ' + p.hint : ''));
    btn.disabled = false; btn.textContent = '发送回复';
  }
}

function renderQuestionAutoReplySummary() {
  const enabled = questionAutoReplyView.enabled;
  const rules = questionAutoReplyView.rules || [];
  const activeCount = rules.filter(rule => rule.enabled).length;
  const badge = $('#questionAutoReplyBadge');
  if (badge) badge.textContent = enabled ? ('运行中 · ' + activeCount + '/' + rules.length) : (rules.length ? ('已关闭 · ' + rules.length + ' 条') : '未设置');
  const enabledText = $('#questionAutoReplyEnabledText');
  if (enabledText) { enabledText.textContent = enabled ? '已开启' : '已关闭'; enabledText.style.color = enabled ? 'var(--ok)' : 'var(--mut)'; }
  const enabledInput = $('#questionAutoReplyEnabled');
  if (enabledInput) enabledInput.checked = enabled;
  const count = $('#questionAutoReplyRuleCount');
  if (count) count.textContent = rules.length + ' 条规则 · ' + activeCount + ' 条启用';
  const status = $('#questionAutoReplyState');
  if (status) {
    const state = questionAutoReplyView.status || {};
    status.className = 'qauto-status' + (state.lastError ? ' error' : (state.lastReplyAt ? ' success' : ''));
    if (questionAutoReplyView.dirty) status.textContent = '有未保存的修改，保存并应用后才会生效。';
    else if (state.lastError) status.textContent = state.lastError;
    else if (state.lastSummary) status.textContent = state.lastSummary;
    else status.textContent = enabled ? '规则已保存，等待自动检查。' : '规则已保存，自动回复当前关闭。';
  }
}
function renderQuestionAutoReplyRules() {
  const box = $('#questionAutoReplyRules');
  if (!box) return;
  const rules = questionAutoReplyView.rules || [];
  if (!rules.length) { box.innerHTML = '<div class="qauto-empty">还没有规则。添加关键词和对应回复文本后保存即可。</div>'; renderQuestionAutoReplySummary(); return; }
  box.innerHTML = rules.map((rule, index) => {
    const id = escHtml(rule.id);
    const words = (rule.keywords || []).map(word => '<span class="qauto-key">' + escHtml(word) + '</span>').join('');
    return '<div class="qauto-rule">'
      + '<div class="qauto-keywords" aria-label="规则关键词">' + words + '</div>'
      + '<div class="qauto-reply">' + escHtml(rule.reply) + '</div>'
      + '<div class="qauto-actions">'
      + '<button class="ghost" type="button" data-qauto-move="up" data-id="' + id + '" aria-label="上移规则"' + (index === 0 ? ' disabled' : '') + '>↑</button>'
      + '<button class="ghost" type="button" data-qauto-move="down" data-id="' + id + '" aria-label="下移规则"' + (index === rules.length - 1 ? ' disabled' : '') + '>↓</button>'
      + '<label class="qauto-toggle"><input type="checkbox" data-qauto-toggle="' + id + '"' + (rule.enabled ? ' checked' : '') + '>启用</label>'
      + '<button class="ghost" type="button" data-qauto-edit="' + id + '">编辑</button>'
      + '<button class="ghost" type="button" data-qauto-delete="' + id + '">删除</button>'
      + '</div></div>';
  }).join('');
  renderQuestionAutoReplySummary();
}
async function loadQuestionAutoReply() {
  try {
    const data = await mlGet('/api/ml/questions/auto-reply');
    questionAutoReplyView.enabled = data.enabled === true;
    questionAutoReplyView.rules = Array.isArray(data.rules) ? data.rules : [];
    questionAutoReplyView.status = data.status || {};
    questionAutoReplyView.dirty = false;
    renderQuestionAutoReplyRules();
  } catch (err) {
    const status = $('#questionAutoReplyState');
    if (status) { status.className = 'qauto-status error'; status.textContent = '读取自动回复配置失败：' + err.message; }
    const badge = $('#questionAutoReplyBadge');
    if (badge) badge.textContent = '加载失败';
  }
}
function openQuestionAutoReply() {
  const modal = $('#questionAutoReplyModal');
  if (!modal) return;
  modal.hidden = false;
  loadQuestionAutoReply();
  $('#questionAutoReplyAdd')?.focus();
}
function closeQuestionAutoReply() {
  const modal = $('#questionAutoReplyModal');
  if (!modal) return;
  if (questionAutoReplyView.dirty && !window.confirm('有尚未保存的自动回复修改，确定关闭吗？')) return;
  modal.hidden = true;
  cancelQuestionAutoReplyEdit();
}
function markQuestionAutoReplyDirty() {
  questionAutoReplyView.dirty = true;
  renderQuestionAutoReplySummary();
}
function cancelQuestionAutoReplyEdit() {
  const editor = $('#questionAutoReplyEditor');
  if (editor) editor.hidden = true;
  questionAutoReplyView.editingId = null;
  const keys = $('#questionAutoReplyKeywords'), reply = $('#questionAutoReplyText');
  if (keys) keys.value = '';
  if (reply) reply.value = '';
}
function editQuestionAutoReplyRule(id) {
  const rule = id ? questionAutoReplyView.rules.find(item => item.id === id) : null;
  questionAutoReplyView.editingId = rule ? rule.id : null;
  $('#questionAutoReplyEditorTitle').textContent = rule ? '编辑回复规则' : '新增回复规则';
  $('#questionAutoReplyKeywords').value = rule ? rule.keywords.join('，') : '';
  $('#questionAutoReplyText').value = rule ? rule.reply : '';
  $('#questionAutoReplyEditor').hidden = false;
  $('#questionAutoReplyKeywords').focus();
}
function saveQuestionAutoReplyRuleDraft() {
  const keywords = [...new Set($('#questionAutoReplyKeywords').value.split(/[,，;；]/).map(word => word.trim()).filter(Boolean))];
  const reply = $('#questionAutoReplyText').value.trim();
  if (!keywords.length) { toast('请填写至少一个关键词', 'err'); $('#questionAutoReplyKeywords').focus(); return; }
  if (keywords.some(word => word.length > 80)) { toast('单个关键词不能超过 80 个字符', 'err'); return; }
  if (!reply) { toast('请填写自动回复文本', 'err'); $('#questionAutoReplyText').focus(); return; }
  if (reply.length > 2000) { toast('回复文本不能超过 2000 个字符', 'err'); return; }
  if (questionAutoReplyView.editingId) {
    const index = questionAutoReplyView.rules.findIndex(item => item.id === questionAutoReplyView.editingId);
    if (index >= 0) questionAutoReplyView.rules[index] = { ...questionAutoReplyView.rules[index], keywords, reply };
  } else {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    questionAutoReplyView.rules.push({ id, keywords, reply, enabled: true });
  }
  cancelQuestionAutoReplyEdit();
  markQuestionAutoReplyDirty();
  renderQuestionAutoReplyRules();
}
function bindQuestionAutoReplyEvents() {
  const modal = $('#questionAutoReplyModal');
  const rules = $('#questionAutoReplyRules');
  if (!modal || !rules || modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';
  $('#questionAutoReplyOpen').onclick = openQuestionAutoReply;
  $('#questionAutoReplyClose').onclick = closeQuestionAutoReply;
  $('#questionAutoReplyCancel').onclick = closeQuestionAutoReply;
  $('#questionAutoReplyAdd').onclick = () => editQuestionAutoReplyRule(null);
  $('#questionAutoReplyCancelEdit').onclick = cancelQuestionAutoReplyEdit;
  $('#questionAutoReplySaveRule').onclick = saveQuestionAutoReplyRuleDraft;
  $('#questionAutoReplyEnabled').onchange = event => {
    questionAutoReplyView.enabled = event.target.checked;
    markQuestionAutoReplyDirty();
  };
  rules.addEventListener('change', event => {
    const input = event.target.closest('[data-qauto-toggle]');
    if (!input) return;
    const rule = questionAutoReplyView.rules.find(item => item.id === input.dataset.qautoToggle);
    if (rule) { rule.enabled = input.checked; markQuestionAutoReplyDirty(); renderQuestionAutoReplyRules(); }
  });
  rules.addEventListener('click', event => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.qautoEdit) { editQuestionAutoReplyRule(id); return; }
    if (button.dataset.qautoDelete) {
      if (!window.confirm('确定删除这条关键词回复规则吗？')) return;
      questionAutoReplyView.rules = questionAutoReplyView.rules.filter(item => item.id !== id);
      markQuestionAutoReplyDirty(); renderQuestionAutoReplyRules(); return;
    }
    const move = button.dataset.qautoMove;
    if (move) {
      const index = questionAutoReplyView.rules.findIndex(item => item.id === id);
      const target = index + (move === 'up' ? -1 : 1);
      if (index < 0 || target < 0 || target >= questionAutoReplyView.rules.length) return;
      const list = questionAutoReplyView.rules; [list[index], list[target]] = [list[target], list[index]];
      markQuestionAutoReplyDirty(); renderQuestionAutoReplyRules();
    }
  });
  $('#questionAutoReplySave').onclick = async () => {
    const button = $('#questionAutoReplySave');
    if (button.disabled) return;
    if (questionAutoReplyView.enabled && !questionAutoReplyView.rules.some(rule => rule.enabled)) { toast('开启自动回复前，至少启用一条规则', 'err'); return; }
    button.disabled = true; button.textContent = '正在保存…';
    try {
      const data = await mlGet('/api/ml/questions/auto-reply', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: questionAutoReplyView.enabled, rules: questionAutoReplyView.rules }),
      });
      questionAutoReplyView.enabled = data.enabled === true;
      questionAutoReplyView.rules = Array.isArray(data.rules) ? data.rules : [];
      questionAutoReplyView.status = data.status || {};
      questionAutoReplyView.dirty = false;
      renderQuestionAutoReplyRules();
      toast(questionAutoReplyView.enabled ? '自动回复规则已保存并启用' : '自动回复规则已保存，功能当前关闭');
    } catch (err) {
      const status = $('#questionAutoReplyState');
      if (status) { status.className = 'qauto-status error'; status.textContent = '保存失败：' + err.message; }
      toast('自动回复配置保存失败：' + err.message, 'err');
    } finally { button.disabled = false; button.textContent = '保存并应用'; }
  };
  modal.addEventListener('click', event => { if (event.target === modal) closeQuestionAutoReply(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) closeQuestionAutoReply(); });
}
/* ---- 退货与投诉（售后） ---- */
const claimView = { cat: 'todo', limit: 50, offset: 0, total: 0, demo: false, counts: {}, all: [], timer: null };
const CLAIM_STAGE = { claim: '纠纷协商', dispute: '平台调解', mediations: '平台调解', recontact: '结案后再联系', none: '-' };
const CLAIM_CAT_META = {
  mediation: { label: '平台调解', ico: '⚖️', cls: 'med', desc: '平台调解员在等你回复' },
  buyer: { label: '买家咨询', ico: '💬', cls: 'buy', desc: '买家主动联系，等你回复' },
  auto: { label: '无需操作', ico: '📦', cls: 'auto', desc: '买家已自行处理退货退款，无需你操作' },
};
const CLAIM_TABS = [
  { k: 'todo', label: '待我处理' },
  { k: 'mediation', label: '平台调解' },
  { k: 'buyer', label: '买家咨询' },
  { k: 'auto', label: '无需操作' },
  { k: 'ignored', label: '已忽略' },
  { k: 'closed', label: '已关闭' },
];

function filterClaims(all, cat) {
  if (cat === 'ignored') return all.filter(c => c.ignored);
  if (cat === 'closed') return all;
  const base = all.filter(c => !c.ignored);
  if (cat === 'todo') return base.filter(c => c.needAction);
  return base.filter(c => c.category === cat);
}

async function loadClaims() {
  const body = $('#claimBody');
  setStateEl($('#claimState'), 'warn', '加载中');
  body.innerHTML = '<div class="empty">正在加载售后台账…</div>';
  try {
    const dq = claimView.demo ? '&demo=1' : '';
    const status = claimView.cat === 'closed' ? 'closed' : 'opened';
    const d = await mlGet('/api/ml/claims?limit=' + claimView.limit + '&offset=0&status=' + status + dq);
    claimView.counts = d.counts || {};
    claimView.total = d.total || 0;
    claimView.all = d.claims || [];
    setStateEl($('#claimState'), d.demo ? 'warn' : 'ok', d.demo ? '示例预览' : ('共 ' + fmt(claimView.total) + ' 条'));
    const db = $('#claimDemoBtn');
    if (db) db.textContent = claimView.demo ? '退出示例' : '👀 示例预览';
    renderClaimTabs();
    renderClaims(d, filterClaims(claimView.all, claimView.cat));
  } catch (e) { toolError($('#claimState'), body, e, loadClaims); }
}

function renderClaimTabs() {
  const el = $('#claimTabs'); if (!el) return;
  const c = claimView.counts || {};
  const map = { todo: c.todo, mediation: c.mediation, buyer: c.buyer, auto: c.auto, ignored: c.ignored };
  el.querySelectorAll('button').forEach(b => {
    const k = b.dataset.k;
    b.classList.toggle('on', k === claimView.cat);
    let i = b.querySelector('.cnt');
    if (k === 'closed') { if (i) i.remove(); return; }
    if (!i) { i = document.createElement('i'); i.className = 'cnt'; b.appendChild(i); }
    const n = map[k];
    i.textContent = (n == null) ? '' : String(n);
    i.hidden = (n == null || n === 0);
    b.classList.toggle('hot', k === 'todo' && n > 0);
  });
}

function claimCard(c) {
  const open = String(c.status).toLowerCase() === 'opened';
  const meta = CLAIM_CAT_META[c.category] || CLAIM_CAT_META.auto;
  const acts = [];
  if (c.canReply) acts.push('<span class="cact ok">' + (c.isMediation ? '可回复调解员' : '可回复买家') + '</span>');
  if (c.canRefund) acts.push('<span class="cact warn">可退款</span>');
  if (c.canDispute) acts.push('<span class="cact">可发起调解</span>');
  if (!acts.length) acts.push('<span class="cact dim">无需我方动作</span>');
  const wait = (c.needAction && c.awaitingSeller) ? '<span class="cwait">⚠️ 等你回复</span>' : '';
  const msgInfo = c.messageCount ? (' · 消息 ' + c.messageCount + ' 条') : '';
  const ignBadge = c.ignored ? '<span class="cign">🚫 已忽略</span>' : '';
  // 调解类但美客多已不接受回复 → 提示可以直接忽略
  const noReplyTip = (!c.ignored && c.isMediation && !c.canReply)
    ? '<div class="cnoreply">美客多当前不接受回复（调解环节已结束或超时），可点「忽略」收起，不再提醒你。</div>' : '';
  const talkLabel = c.needAction ? (c.isMediation ? '⚖️ 查看并回复调解员' : '💬 查看并回复买家') : '💬 查看对话';
  const ignBtn = c.ignored
    ? '<button class="btn ghost" data-unignore="' + escHtml(c.id) + '">↩️ 取消忽略</button>'
    : '<button class="btn ghost" data-ignore="' + escHtml(c.id) + '" title="收进「已忽略」，不再计入待我处理">🚫 忽略</button>';
  return '<div class="ccard ' + meta.cls + (open ? ' open' : '') + (c.ignored ? ' ignored' : '') + '">'
    + '<div class="qhead"><span class="cbag ' + meta.cls + '">' + meta.ico + ' ' + escHtml(meta.label) + '</span>'
    + '<span>' + (open ? '⏳ 处理中' : '✅ ' + escHtml(c.status || '已关闭')) + ' · ' + fmtDate(c.date) + ' · 纠纷 #' + escHtml(c.id) + '</span></div>'
    + '<div class="creason">' + escHtml(c.reason || '-') + '</div>'
    + '<div class="cinfo">'
    + '<div>类型：<b>' + escHtml(c.typeText || c.type || '-') + '</b></div>'
    + '<div>阶段：<b>' + escHtml(CLAIM_STAGE[String(c.stage || '').toLowerCase()] || c.stage || '-') + '</b></div>'
    + '<div>原因码：<b>' + escHtml(c.reasonId || '-') + '</b></div>'
    + '<div>关联订单：<b>' + escHtml(c.resourceId || '-') + '</b></div>'
    + '<div>金额：<b>' + (c.amount ? money(c.amount, c.currency) : '-') + '</b></div>'
    + '<div>数量：<b>' + (c.quantity || '-') + '</b></div>'
    + '</div>'
    + '<div class="cacts">' + acts.join('') + wait + ignBadge + msgInfo + '</div>'
    + noReplyTip
    + '<div class="cfoot"><button class="' + (c.needAction ? 'btn y' : 'btn') + '" data-talk="' + escHtml(c.id) + '">' + talkLabel + '</button>' + ignBtn + '</div>'
    + '<div class="cpanel" data-panel="' + escHtml(c.id) + '" style="display:none"></div>'
    + '</div>';
}

function renderClaims(d, list) {
  const body = $('#claimBody');
  const demoBar = d.demo
    ? '<div class="demo-bar"><span>当前为 <b>示例数据</b>，只用于预览界面效果，回复不会真正发出</span><button class="ghost" id="cDemoExit">退出示例</button></div>'
    : '';

  if (!list.length) {
    const isEmptyAll = !claimView.all.length;
    const tip = claimView.cat === 'todo'
      ? '太好了，当前没有需要你处理的售后 🎉'
      : (claimView.cat === 'mediation' ? '当前没有平台调解'
        : (claimView.cat === 'buyer' ? '当前没有买家主动咨询的售后'
          : '当前没有需要归档的售后'));
    body.innerHTML = demoBar + '<div class="empty">' + tip
      + (isEmptyAll ? '<br><button class="btn" id="cDemo" style="margin-top:16px">👀 查看示例效果</button>'
        + '<div style="font-size:12px;color:var(--mut);margin-top:10px">示例数据只用于预览界面，回复不会真正发出</div>' : '')
      + '</div>';
    const b = $('#cDemo');
    if (b) b.onclick = () => { claimView.demo = true; claimView.cat = 'todo'; loadClaims(); };
    const ex0 = $('#cDemoExit');
    if (ex0) ex0.onclick = () => { claimView.demo = false; claimView.cat = 'todo'; loadClaims(); };
    return;
  }

  const cards = list.map(claimCard).join('');
  body.innerHTML = demoBar + '<div class="clist">' + cards + '</div>';
  body.querySelectorAll('button[data-talk]').forEach(b => b.onclick = () => toggleClaimPanel(b.dataset.talk, b.closest('.ccard'), b));
  body.querySelectorAll('button[data-ignore]').forEach(b => b.onclick = () => toggleIgnore(b.dataset.ignore, true, b));
  body.querySelectorAll('button[data-unignore]').forEach(b => b.onclick = () => toggleIgnore(b.dataset.unignore, false, b));
  const ex = $('#cDemoExit');
  if (ex) ex.onclick = () => { claimView.demo = false; claimView.cat = 'todo'; loadClaims(); };
}

/* 忽略 / 取消忽略一条纠纷（本地记录，不影响美客多数据） */
async function toggleIgnore(id, on, btn) {
  if (btn) btn.disabled = true;
  const old = btn ? btn.textContent : '';
  if (btn) btn.textContent = on ? '忽略中…' : '恢复中…';
  try {
    await mlGet('/api/ml/claims/' + encodeURIComponent(id) + '/ignore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ignored: on }),
    });
    toast(on ? '🚫 已忽略，不再计入「待我处理」' : '↩️ 已恢复到列表');
    loadClaims();
    loadOrderSummary(true);   // 立即刷新角标（忽略后待处理数会变）
  } catch (e) {
    const p = e.payload || {};
    toast('❌ ' + (p.error || e.message));
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

async function toggleClaimPanel(id, card, btn) {
  const panel = card ? card.querySelector('[data-panel="' + id + '"]') : null;
  if (!panel) return;
  if (panel.style.display === 'block') {
    panel.style.display = 'none';
    if (btn) btn.textContent = btn.dataset.label || '💬 查看对话';
    return;
  }
  panel.style.display = 'block';
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = '收起对话';
  panel.innerHTML = '<div class="empty" style="padding:18px 0">正在加载对话…</div>';
  try {
    const d = await mlGet('/api/ml/claims/' + encodeURIComponent(id));
    panel.__data = d;
    renderClaimPanel(panel, d, id);
  } catch (e) {
    const p = e.payload || {};
    panel.innerHTML = '<div class="qerr">❌ 对话加载失败：' + escHtml(p.error || e.message) + '</div>';
  }
}

function renderClaimPanel(panel, d, id) {
  const msgs = d.messages || [];
  const c = d.claim || {};
  const isM = !!c.isMediation;
  const thread = msgs.length
    ? msgs.map(m => {
      const s = String(m.sender || '').toLowerCase();
      const mine = s.includes('seller') || s.includes('respondent');
      const isMed = s.includes('mediator') || s.includes('internal');
      const who = mine ? '我方' : (isMed ? '平台调解员' : '买家');
      const cls = mine ? ' mine' : (isMed ? ' med' : '');
      return '<div class="msg' + cls + '">'
        + '<div class="msg-h"><b>' + who + '</b><span>' + fmtDate(m.date) + '</span></div>'
        + '<div class="msg-t">' + escHtml(m.text || '-') + '</div>'
        + (m.attachments && m.attachments.length ? '<div class="msg-a">📎 ' + m.attachments.map(escHtml).join('、') + '</div>' : '')
        + '</div>';
    }).join('')
    : '<div class="empty" style="padding:14px 0;font-size:12.5px">还没有往来消息'
    + (isM ? '，等待调解员发起新一轮沟通' : '，可以主动联系买家') + '</div>';

  const catMeta = CLAIM_CAT_META[c.category] || CLAIM_CAT_META.auto;
  const ignBtn = c.ignored
    ? '<button class="btn ghost sm" data-pign="' + escHtml(id) + '">↩️ 取消忽略</button>'
    : '<button class="btn ghost sm" data-pign="' + escHtml(id) + '">🚫 忽略这条</button>';
  const banner = '<div class="cban ' + catMeta.cls + '"><div class="cban-tx">' + catMeta.ico + ' <b>' + escHtml(catMeta.label) + '</b> · '
    + escHtml(isM ? '这条消息会发给平台调解员' : '这条消息会发给买家')
    + (c.awaitingSeller ? ' · <span class="cw">对方在等你回复</span>'
      : (c.canReply && !c.canSendNow ? ' · <span class="cw">本轮已回复，等对方回应</span>' : ''))
    + (c.ignored ? ' · <b>已忽略</b>' : '') + '</div>' + ignBtn + '</div>';

  const toLabel = isM ? '发送给调解员' : '发送给买家';
  const ph = isM
    ? '回复平台调解员（如接受/拒绝方案、给出退款比例）… Ctrl / ⌘ + Enter 发送'
    : '给买家发消息（美客多建议 350 字以内）… Ctrl / ⌘ + Enter 发送';
  // 美客多本轮没下发可回复动作：给出预警，避免用户输入一大段后被平台拒绝
  const closedTip = (c.canReply && !c.canSendNow)
    ? '<div class="note" style="margin:0 0 8px;color:var(--warn)">⚠️ 美客多本轮没有下发可回复动作：你很可能已经回复过，现在球在对方那边。此时发送大概率会被平台拒绝，等买家 / 调解员有新消息后窗口会自动重新打开。</div>'
    : '';

  panel.dataset.confirm = '';
  panel.innerHTML = banner + '<div class="cthread">' + thread + '</div>'
    + (c.canReply
      ? '<div class="qreply">' + closedTip
      + '<textarea rows="2" maxlength="2000" placeholder="' + ph + '" data-cta="' + escHtml(id) + '"></textarea>'
      + '<div class="qreply-b"><span class="qcount" data-ccnt="' + escHtml(id) + '">0 / 2000</span>'
      + '<button class="btn y" data-csend="' + escHtml(id) + '">' + toLabel + '</button></div>'
      + '<div class="qerr" data-cerr="' + escHtml(id) + '" style="display:none"></div>'
      + '</div>'
      : '<div class="note" style="margin-top:10px">当前纠纷状态不允许发消息（可用动作：' + escHtml((c.actions || []).join(' / ') || '无') + '）。</div>')
    + (d.demo ? '<div class="note" style="margin-top:10px">示例模式：这里发送不会真正发出。</div>' : '');

  const ta = panel.querySelector('textarea[data-cta]');
  if (ta) {
    ta.addEventListener('input', () => { const cc = panel.querySelector('[data-ccnt="' + id + '"]'); if (cc) cc.textContent = ta.value.length + ' / 2000'; });
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { const b = panel.querySelector('[data-csend="' + id + '"]'); if (b) b.click(); }
    });
  }
  const sb = panel.querySelector('[data-csend]');
  if (sb) sb.onclick = () => sendClaimReply(panel, id);
  const pig = panel.querySelector('[data-pign]');
  if (pig) pig.onclick = () => toggleIgnore(id, !c.ignored, pig);
}

async function sendClaimReply(panel, id) {
  const ta = panel.querySelector('textarea[data-cta]');
  const err = panel.querySelector('[data-cerr]');
  const btn = panel.querySelector('[data-csend]');
  const cur = panel.__data || {};
  const isM = !!((cur.claim || {}).isMediation);
  const who = isM ? '平台调解员' : '买家';
  const sendLabel = isM ? '发送给调解员' : '发送给买家';
  const text = ta ? ta.value.trim() : '';
  const say = (t, color) => { if (err) { err.textContent = t || ''; err.style.display = t ? 'block' : 'none'; err.style.color = color || 'var(--bad)'; } };
  if (!text) { say('请先输入要发给' + who + '的内容'); if (ta) ta.focus(); return; }
  if (text.length > 2000) { say('内容超过 2000 字（当前 ' + text.length + '），请精简后再发送'); return; }

  // 二次确认：第一次点击只提示，第二次才真正发送（消息发给对方，不可撤回）
  if (panel.dataset.confirm !== '1') {
    panel.dataset.confirm = '1';
    say('⚠️ 这条消息会直接发给' + who + '，发送后不可撤回。确认无误请再点一次「确认发送」。', 'var(--warn)');
    if (btn) btn.textContent = '确认发送';
    setTimeout(() => {
      if (panel.dataset.confirm === '1') { panel.dataset.confirm = ''; if (btn) btn.textContent = sendLabel; say(''); }
    }, 10000);
    return;
  }
  panel.dataset.confirm = '';
  if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
  try {
    const d = await mlGet('/api/ml/claims/' + encodeURIComponent(id) + '/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    toast(d && d.demo ? '示例模式：未真正发送' : ('✅ 消息已发送给' + who));
    if (ta) ta.value = '';
    const next = { ...cur, messages: (cur.messages || []).concat([{ sender: 'respondent', receiver: isM ? 'mediator' : 'complainant', text, date: new Date().toISOString(), attachments: [] }]) };
    panel.__data = next;
    renderClaimPanel(panel, next, id);
  } catch (e) {
    const p = e.payload || {};
    say('❌ ' + (p.error || e.message) + (p.hint ? ' ｜ ' + p.hint : ''));
    if (btn) { btn.disabled = false; btn.textContent = sendLabel; }
  }
}

/* ---- API 凭证设置弹窗 ---- */
function mlCfgStatus(msg, type) {
  const el = $('#mlCfgStatus');
  if (!el) return;
  el.textContent = msg; el.className = 'config-status ' + type; el.style.display = 'block';
}
async function openMlModal() {
  $('#mlModal').style.display = 'grid';
  const st = $('#mlCfgStatus'); if (st) st.style.display = 'none';
  try {
    const c = await (await fetch(API_BASE + '/api/config')).json();
    window.__mlHasSecret = !!c.mlSecretSet;
    $('#mlAppId').value = c.mlAppId || '';
    $('#mlSite').value = c.mlSite || 'MLB';
    $('#mlSecretHint').textContent = c.mlSecretSet ? '（已设置，留空不修改）' : '';
    $('#mlTokenHint').textContent = c.mlTokenSet ? '（已设置，留空不修改）' : '';
    $('#mlRefreshHint').textContent = c.mlRefreshSet ? '（已设置，留空不修改）' : '';
    const u = $('#mlRedirectInput'); if (u) u.value = c.mlRedirectUri || ('https://' + location.host);
    const pk = $('#mlPkce'); if (pk) pk.checked = !!c.mlPkce;
    const oa = $('#mlOauthState');
    if (oa) oa.textContent = c.mlTokenSet ? '当前已绑定账号，重新授权会覆盖现有令牌。' : '';
  } catch { }
  ['mlSecret', 'mlToken', 'mlRefresh'].forEach(id => { const e = $('#' + id); if (e) e.value = ''; });
  loadPushStatus();
}
function closeMlModal() { const m = $('#mlModal'); if (m) m.style.display = 'none'; }

// 一键 OAuth：先保存 App ID / Secret / 站点，再跳转美客多授权页
async function startMlOAuth() {
  const appId = $('#mlAppId').value.trim();
  const secret = $('#mlSecret').value.trim();
  const site = $('#mlSite').value;
  const pkce = $('#mlPkce') && $('#mlPkce').checked;
  if (!appId) return mlCfgStatus('请先填写 App ID', 'error');
  if (!secret && !window.__mlHasSecret) return mlCfgStatus('请先填写 Secret Key（密钥）', 'error');
  if (!secret && window.__mlHasSecret) mlCfgStatus('ℹ️ 沿用已保存的 Secret Key 发起授权…', 'loading');
  const btn = $('#mlOAuth'); btn.disabled = true;
  mlCfgStatus('⏳ 正在保存凭证并跳转授权…', 'loading');
  try {
    const redirect = ($('#mlRedirectInput') && $('#mlRedirectInput').value.trim()) || '';
    if (!/^https:\/\/[^\s]+$/i.test(redirect)) {
      btn.disabled = false;
      return mlCfgStatus('❌ 回调地址必须是 https:// 开头的完整网址，且和后台登记的一字不差', 'error');
    }
    const r = await fetch(API_BASE + '/api/ml/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mlAppId: appId, mlSecret: secret, mlSite: site, mlPkce: !!pkce, mlRedirectUri: redirect }),
    });
    const d = await r.json();
    if (!(r.ok && d.success)) { btn.disabled = false; return mlCfgStatus('❌ 保存失败：' + (d.error || '未知错误'), 'error'); }
    window.location.href = API_BASE + '/api/ml/oauth/start?site=' + encodeURIComponent(site) + (pkce ? '&pkce=1' : '');
  } catch (e) { btn.disabled = false; mlCfgStatus('❌ 请求失败：' + e.message, 'error'); }
}
async function saveMlConfig() {
  const btn = $('#mlSave'); btn.disabled = true;
  try {
    const r = await fetch(API_BASE + '/api/ml/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mlAppId: $('#mlAppId').value.trim(),
        mlSecret: $('#mlSecret').value.trim(),
        mlAccessToken: $('#mlToken').value.trim(),
        mlRefreshToken: $('#mlRefresh').value.trim(),
        mlSite: $('#mlSite').value,
      }),
    });
    const d = await r.json();
    if (r.ok && d.success) {
      await savePushConfig(true);           // 弹窗里一并保存微信提醒设置
      mlCfgStatus('✅ 已保存，正在测试连接…', 'success');
      await testMlConnection(); mlSummaryAt = 0; loadOrderSummary(true);
    }
    else mlCfgStatus('❌ 保存失败：' + (d.error || '未知错误'), 'error');
  } catch (e) { mlCfgStatus('❌ 请求失败：' + e.message, 'error'); }
  finally { btn.disabled = false; }
}
async function testMlConnection() {
  mlCfgStatus('⏳ 正在连接美客多 API…', 'loading');
  try {
    const r = await fetch(API_BASE + '/api/ml/status');
    const d = await r.json();
    if (d.ok) mlCfgStatus('✅ 连接成功：' + ((d.user && d.user.nickname) || d.user.id) + ' · ' + ((d.site && (d.site.name || d.site.code)) || ''), 'success');
    else mlCfgStatus('❌ ' + (d.message || '连接失败'), 'error');
  } catch (e) { mlCfgStatus('❌ 连接失败：' + e.message, 'error'); }
}
/* ---- 微信提醒（PushPlus）：售前提问 ---- */
function renderPushStatus(s) {
  if (s) {
    const hint = $('#pushTokenHint');
    if (hint) hint.textContent = s.hasToken ? ('（已设置 · 尾号 ' + (s.tokenTail || '****') + '，留空不修改）') : '（尚未设置）';
    const en = $('#pushEnabled'); if (en) en.checked = !!s.enabled;
    const cl = $('#pushClaims'); if (cl) cl.checked = s.claimsEnabled !== false;
    const iv = $('#pushInterval'); if (iv && document.activeElement !== iv) iv.value = s.intervalMin || 5;
    const box = $('#pushState');
    if (box) {
      const parts = [];
      parts.push(s.enabled ? (s.hasToken ? '✅ 已开启' : '⚠️ 已勾选但还没填 token') : '⏸ 未开启');
      parts.push('每 ' + (s.intervalMin || 5) + ' 分钟检查');
      if (s.lastCheckAt) parts.push('提问上次检查 ' + brClock(s.lastCheckAt));
      if (s.lastPushAt) parts.push('提问上次推送 ' + brClock(s.lastPushAt));
      parts.push('已记录 ' + fmt(s.seenCount) + ' 条提问');
      if (s.claimsEnabled !== false) {
        if (s.lastClaimCheckAt) parts.push('售后上次检查 ' + brClock(s.lastClaimCheckAt));
        if (s.lastClaimPushAt) parts.push('售后上次推送 ' + brClock(s.lastClaimPushAt));
        parts.push('已记录 ' + fmt(s.claimSeenCount || 0) + ' 条售后');
      } else {
        parts.push('售后提醒已关闭');
      }
      if (s.lastSummary) parts.push(s.lastSummary);
      if (s.claimsEnabled !== false && s.lastClaimSummary) parts.push(s.lastClaimSummary);
      if (s.lastError) parts.push('❌ 提问：' + s.lastError);
      if (s.claimsEnabled !== false && s.lastClaimError) parts.push('❌ 售后：' + s.lastClaimError);
      box.innerHTML = parts.map(escHtml).join(' · ');
    }
  }
  // 概览页「站点与任务」那一行
  const tp = $('#task-push'), sp = $('#status-push');
  if (tp && sp) {
    if (!s) { tp.textContent = '未配置'; setStateEl(sp, '', '未开启'); }
    else if (!s.hasToken) { tp.textContent = '未填 token'; setStateEl(sp, 'warn', '未开启'); }
    else if (!s.enabled) { tp.textContent = '已配置 · 未开启'; setStateEl(sp, '', '未开启'); }
    else {
      tp.textContent = '提问 + 售后 · 每 ' + (s.intervalMin || 5) + ' 分钟' + (s.lastCheckAt ? ' · 上次 ' + brClock(s.lastCheckAt) : '');
      setStateEl(sp, 'ok', '运行中');
    }
  }
}
async function loadPushStatus() {
  try {
    const d = await (await fetch(API_BASE + '/api/push/status')).json();
    renderPushStatus(d && d.ok ? d : null);
  } catch { renderPushStatus(null); }
}
async function savePushConfig(silent) {
  const body = {
    pushEnabled: !!($('#pushEnabled') && $('#pushEnabled').checked),
    pushClaims: !!($('#pushClaims') && $('#pushClaims').checked),
    pushIntervalMin: parseInt($('#pushInterval') && $('#pushInterval').value, 10) || 5,
  };
  const tk = $('#pushToken') ? $('#pushToken').value.trim() : '';
  if (tk) body.pushToken = tk;
  try {
    const r = await fetch(API_BASE + '/api/push/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!(r.ok && d.ok)) { if (!silent) mlCfgStatus('❌ 微信提醒保存失败：' + (d.error || '未知错误'), 'error'); return false; }
    renderPushStatus(d);
    if (tk) { const e = $('#pushToken'); if (e) e.value = ''; }
    if (!silent) toast(body.pushEnabled
      ? ('✅ 微信提醒已开启（每 ' + body.pushIntervalMin + ' 分钟检查' + (body.pushClaims ? '，含售后' : '') + '）')
      : '已保存微信提醒设置');
    return true;
  } catch (e) { if (!silent) mlCfgStatus('❌ 请求失败：' + e.message, 'error'); return false; }
}
async function testPush() {
  const btn = $('#pushTest'); if (btn) btn.disabled = true;
  const st = $('#pushState'); if (st) { st.textContent = '⏳ 正在发送测试消息…'; st.style.color = 'var(--mut)'; }
  try {
    const tk = $('#pushToken') ? $('#pushToken').value.trim() : '';
    const r = await fetch(API_BASE + '/api/push/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tk ? { pushToken: tk } : {}),
    });
    const d = await r.json();
    if (d.ok) { if (tk) { const e = $('#pushToken'); if (e) e.value = ''; } toast('✅ 测试消息已发送，去微信看看'); }
    else toast('❌ ' + (d.error || '发送失败'));
    renderPushStatus(d && d.ok !== undefined ? d : null);
  } catch (e) { toast('❌ 请求失败：' + e.message); }
  finally { if (btn) btn.disabled = false; }
}
async function checkPushNow() {
  const btn = $('#pushCheck'); if (btn) btn.disabled = true;
  const st = $('#pushState'); if (st) { st.textContent = '⏳ 正在检查新提问与售后动向…'; st.style.color = 'var(--mut)'; }
  try {
    const r = await fetch(API_BASE + '/api/push/check', { method: 'POST' });
    const d = await r.json();
    if (d.ok) toast('✅ ' + (d.summary || '检查完成'));
    else toast('❌ ' + (d.error || d.message || '检查失败'));
    if (d.lastSummary !== undefined) renderPushStatus(d);
  } catch (e) { toast('❌ 请求失败：' + e.message); }
  finally { if (btn) btn.disabled = false; }
}

// 备用方案：手动粘贴美客多回调网址 / 授权码
async function exchangeManualCode() {
  const el = $('#mlCodeInput');
  const out = $('#mlCodeState');
  const btn = $('#mlCodeBtn');
  const val = (el && el.value || '').trim();
  const say = (t, c) => { if (out) { out.innerHTML = t; out.style.color = c || 'var(--mut)'; } };
  if (!val) return say('请先粘贴美客多回调网址', 'var(--bad)');
  if (btn) btn.disabled = true;
  say('⏳ 正在换取令牌…');
  try {
    const r = await fetch(API_BASE + '/api/ml/oauth/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: val }),
    });
    const d = await r.json();
    if (d.ok) {
      say('✅ 授权成功！user_id=' + d.userId + '，正在刷新数据…', 'var(--ok)');
      mlSummaryAt = 0; loadOrderSummary(true); testMlConnection();
      setTimeout(() => { closeMlModal(); location.reload(); }, 1600);
    } else {
      say('❌ ' + (d.error || '换取失败') + (d.hint ? '<br><b style="color:var(--warn)">' + d.hint + '</b>' : '') + '<br>点上方「开始授权」重新走一遍最稳', 'var(--bad)');
      if (btn) btn.disabled = false;
    }
  } catch (e) { say('❌ 请求失败：' + e.message, 'var(--bad)'); if (btn) btn.disabled = false; }
}

// 若美客多把 code 直接回调到站点根路径，首页加载时自动接手
async function catchOAuthCode() {
  const q = location.search;
  if (!q || !/[?&]code=/.test(q)) return;
  const cameBack = location.href;
  // 立刻清掉地址栏参数：授权码是一次性的，避免刷新时拿已失效的 code 重试
  history.replaceState(null, '', location.pathname + location.hash);
  let d = null;
  try {
    const r = await fetch(API_BASE + '/api/ml/oauth/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: cameBack }),
    });
    d = await r.json();
  } catch (e) {
    await openMlModal();
    mlCfgStatus('❌ 授权处理失败：' + e.message, 'error');
    return;
  }
  await openMlModal();
  const out = $('#mlCodeState');
  const det = document.querySelectorAll('.oauth-more');
  if (d && d.ok) {
    mlSummaryAt = 0;
    if (out) { out.innerHTML = '✅ 授权成功！已绑定卖家账号 user_id=' + d.userId; out.style.color = 'var(--ok)'; }
    mlCfgStatus('✅ 美客多账号授权成功，正在拉取数据…', 'success');
    toast('✅ 美客多账号授权成功');
    loadOrderSummary(true); testMlConnection();
    return;
  }
  // 失败：把原因明明白白摆出来，不再静默
  const msg = (d && d.error) || '换取令牌失败';
  const isPkce = /code_verifier|pkce/i.test(msg);
  const hint = (d && d.hint) || (isPkce ? '应用在美客多后台开启了 PKCE，需要勾选弹窗里的「Use PKCE」后重新授权。' : '');
  if (det[0]) det[0].setAttribute('open', '');
  if (out) {
    out.innerHTML = '❌ 授权未完成：' + escHtml(msg) +
      (hint ? '<br><b style="color:var(--warn)">' + escHtml(hint) + '</b>' : '');
    out.style.color = 'var(--bad)';
  }
  mlCfgStatus('❌ 授权未完成：' + msg + (hint ? '｜' + hint : '') + '（点「开始授权」重来一次）', 'error');
  toast('❌ 授权未完成，请看弹窗提示');
}

function bindMlEvents() {
  const on = (id, fn) => { const e = $('#' + id); if (e) e.onclick = fn; };
  on('ovRefresh', () => refreshOverview());
  on('mlCfgBtn', openMlModal);
  on('mlClose', closeMlModal);
  on('mlSave', saveMlConfig);
  on('mlTest', testMlConnection);
  on('mlOAuth', startMlOAuth);
  on('mlCodeBtn', exchangeManualCode);
  on('pushTest', testPush);
  on('pushCheck', checkPushNow);
  const pe = $('#pushEnabled');
  if (pe) pe.onchange = () => savePushConfig(false);
  const pi = $('#pushInterval');
  if (pi) pi.onchange = () => savePushConfig(false);
  on('orderRefresh', () => { orderView.offset = 0; loadOrders(); });
  on('questionRefresh', () => { questionView.offset = 0; loadQuestions(); });
  bindQuestionAutoReplyEvents();
  on('claimRefresh', () => { claimView.offset = 0; loadClaims(); });
  const mask = $('#mlModal');
  if (mask) mask.addEventListener('click', e => { if (e.target === mask) closeMlModal(); });
  const bindTabs = (id, view, loader) => {
    const el = $('#' + id); if (!el) return;
    el.querySelectorAll('button').forEach(b => b.onclick = () => {
      el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      view.state = b.dataset.k; view.offset = 0; loader();
    });
  };
  bindTabs('orderTabs', orderView, loadOrders);
  bindTabs('questionTabs', questionView, loadQuestions);
  // 售后按「分类」切换（待我处理 / 平台调解 / 买家咨询 / 无需操作 / 已关闭）
  const ctEl = $('#claimTabs');
  if (ctEl) ctEl.querySelectorAll('button').forEach(b => b.onclick = () => {
    ctEl.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    claimView.cat = b.dataset.k; claimView.offset = 0; loadClaims();
  });
  on('claimDemoBtn', () => { claimView.demo = !claimView.demo; claimView.cat = 'todo'; loadClaims(); });
}


function bindAccountEvents(){
  const toggle=$('#accountToggle'),menu=$('#accountMenu'),shade=$('#accountSwitchDialog'),form=$('#accountSwitchForm'),status=$('#accountSwitchStatus'),submit=$('#accountSwitchSubmit'),adminLinks=$('#accountAdminLinks');
  if(!toggle||!menu)return;
  const closeMenu=()=>{menu.hidden=true;toggle.setAttribute('aria-expanded','false');};
  const closeDialog=()=>{shade.hidden=true;status.textContent='';status.classList.remove('error');form.reset();};
  toggle.addEventListener('click',()=>{menu.hidden=!menu.hidden;toggle.setAttribute('aria-expanded',String(!menu.hidden));});
  document.addEventListener('click',e=>{if(!menu.hidden&&!menu.contains(e.target)&&!toggle.contains(e.target))closeMenu();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeMenu();if(!shade.hidden)closeDialog();}});
  fetch('/api/auth/me',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('登录已失效');return r.json();}).then(u=>{
    const name=String(u.username||'账户'),initial=name.slice(0,1).toUpperCase();$('#accountName').textContent=name;$('#accountRole').textContent=u.role==='admin'?'管理员账户':'普通账户';$('#accountInitial').textContent=initial;toggle.textContent=initial;toggle.setAttribute('aria-label','账户菜单：'+name);if(adminLinks)adminLinks.hidden=u.role!=='admin';
  }).catch(()=>{ $('#accountName').textContent='当前账户'; });
  $('#accountApprovals')?.addEventListener('click',()=>{location.href='/admin.html?view=approvals';});
  $('#accountApiQuery')?.addEventListener('click',()=>{location.href='/admin.html?view=apis';});
  $('#accountSwitch').addEventListener('click',()=>{closeMenu();shade.hidden=false;$('#accountSwitchUser').focus();});
  $('#accountSwitchCancel').addEventListener('click',closeDialog);
  shade.addEventListener('click',e=>{if(e.target===shade)closeDialog();});
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(submit.disabled)return;submit.disabled=true;submit.textContent='正在验证…';status.classList.remove('error');status.textContent='正在验证新账号，原账号保持登录。';
    try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#accountSwitchUser').value,password:$('#accountSwitchPass').value})});const d=await r.json();if(!r.ok)throw Error(d.error||'切换账户失败');status.textContent='验证成功，正在切换…';location.reload();}
    catch(err){status.classList.add('error');status.textContent=err.message;submit.disabled=false;submit.textContent='验证并切换';}
  });
  $('#accountLogout').addEventListener('click',async()=>{closeMenu();const b=$('#accountLogout');b.disabled=true;try{const r=await fetch('/api/auth/logout',{method:'POST'});if(!r.ok)throw Error('退出失败，请重试');location.replace('/login.html?logout=1');}catch(err){b.disabled=false;if(typeof toast==='function')toast(err.message,'err');}});
}

/* =========================================================
   6. 启动
   ========================================================= */
function init() {
  // 先绑定各视图的事件/默认范围，再做路由跳转——否则 #ads 直达时会在默认范围设好前就发起请求
  bindConfigEvents();
  bindBoxEvents();
  bindMlEvents();
  bindAccountEvents();
  bindProfitEvents();
  bindSalesEvents();
  bindListingEvents();
  bindAdsEvents();
  bindOverviewEvents();
  initRouting();
  splash();
  applyModeUI();
  loadConfig();
  loadReportStatus();
  setInterval(() => { if (!document.hidden) loadReportStatus(); }, 60000);
  loadOrderSummary();
  loadSales();
  loadListings();
  loadHubProfitEstimate();
  startSalesTimer();
  startAdsTimer();
  startSummaryTimer();
  startQuestionsTimer();
  startClaimsTimer();
  loadPushStatus();
  catchOAuthCode();
  ['MLM', 'MLB', 'MLA'].forEach(code => checkSite(code));
  sparklines();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();


