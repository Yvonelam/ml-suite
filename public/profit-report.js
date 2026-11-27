
/* =========================================================
   产品利润报告：一份自包含 HTML（表格 + 内嵌 SVG 图表）
   - 不依赖任何 CDN / 外部图片，下载后离线能看、能直接打印成 PDF
   - 图表是手写 SVG：条形长度由数据算出来，不引第三方图表库（离线才不会白屏）
   - 口径与页面完全一致：产品利润不含广告分摊，广告只从总利润里扣
   ========================================================= */
const RPT = { pos: '#2563eb', neg: '#dc2626', dead: '#cbd5e1', axis: '#e2e8f0', ink: '#0f172a', mut: '#64748b', band: '#f8fafc' };

function rptNum(v, d = 0) {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function rptYuan(v) { const n = Number(v); return isFinite(n) ? (n < 0 ? '-¥ ' : '¥ ') + rptNum(Math.abs(n), 2) : '—'; }
function rptPct(v) { const n = Number(v); return isFinite(n) ? n.toFixed(2) + '%' : '—'; }

/* 横向堆叠条形：每个产品一行，可多段（如 有效件 / 取消件） */
function rptClip(s, n = 34) { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; }

function rptStackBars(items, series, opt = {}) {
  const W = 940, labelW = 300, padR = 92, rowH = 26, gap = 8, top = 34;
  const H = top + items.length * (rowH + gap) + 16;
  const max = Math.max(1, ...items.map(it => it.values.reduce((a, b) => a + Math.max(0, Number(b) || 0), 0)));
  const barW = W - labelW - padR;
  let y0 = top, out = '';
  for (const it of items) {
    const total = it.values.reduce((a, b) => a + Math.max(0, Number(b) || 0), 0);
    let x = labelW;
    let segs = '';
    it.values.forEach((v, i) => {
      const w = Math.max(0, Number(v) || 0) / max * barW;
      if (w > 0.4) segs += `<rect x="${x.toFixed(1)}" y="${y0}" width="${w.toFixed(1)}" height="${rowH}" fill="${series[i].color}" rx="3"/>`;
      x += w;
    });
    out += `<text x="0" y="${y0 + rowH / 2 + 4}" font-size="12" fill="${RPT.ink}">${escHtml(rptClip(it.label))}</text>`
      + `<text x="${(labelW - 8)}" y="${y0 + rowH / 2 + 4}" font-size="11" fill="${RPT.mut}" text-anchor="end">${escHtml(it.sub || '')}</text>`
      + segs
      + `<text x="${(W - padR + 8)}" y="${y0 + rowH / 2 + 4}" font-size="12" font-weight="700" fill="${RPT.ink}">${escHtml(opt.fmt ? opt.fmt(total) : total)}</text>`;
    y0 += rowH + gap;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${escHtml(opt.title || '')}">${out}</svg>`;
}

/* 正负分叉条形：利润可能为负，零轴居中，负值向左画 */
function rptDivergeBars(items, opt = {}) {
  const W = 940, labelW = 300, padR = 110, rowH = 26, gap = 8, top = 34;
  const H = top + items.length * (rowH + gap) + 22;
  const maxAbs = Math.max(1, ...items.map(it => Math.abs(Number(it.value) || 0)));
  const area = W - labelW - padR;
  const zero = labelW + area / 2;
  let y0 = top, out = `<line x1="${zero}" y1="${top - 8}" x2="${zero}" y2="${H - 10}" stroke="${RPT.axis}" stroke-width="1.5"/>`;
  for (const it of items) {
    const v = Number(it.value) || 0;
    const w = Math.abs(v) / maxAbs * (area / 2 - 6);
    const x = v >= 0 ? zero : zero - w;
    const color = v < 0 ? RPT.neg : (opt.color || RPT.pos);
    out += `<text x="0" y="${y0 + rowH / 2 + 4}" font-size="12" fill="${RPT.ink}">${escHtml(rptClip(it.label))}</text>`
      + `<text x="${(labelW - 8)}" y="${y0 + rowH / 2 + 4}" font-size="11" fill="${RPT.mut}" text-anchor="end">${escHtml(it.sub || '')}</text>`
      + (w > 0.4 ? `<rect x="${x.toFixed(1)}" y="${y0}" width="${w.toFixed(1)}" height="${rowH}" fill="${color}" rx="3"/>` : '')
      + `<text x="${v >= 0 ? (zero + w + 8) : (zero - w - 8)}" y="${y0 + rowH / 2 + 4}" font-size="12" font-weight="700" fill="${color}" text-anchor="${v >= 0 ? 'start' : 'end'}">${escHtml(rptYuan(v))}</text>`;
    y0 += rowH + gap;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${escHtml(opt.title || '')}">${out}</svg>`;
}

/* 收入 vs 总成本：分组条形，一眼看出每个产品还剩多少空间 */
function rptRevCostBars(items) {
  const W = 940, labelW = 300, padR = 100, rowH = 30, gap = 10, top = 34;
  const H = top + items.length * (rowH + gap) + 20;
  const max = Math.max(1, ...items.map(it => Math.max(it.revenueCny, it.costAll)));
  const area = W - labelW - padR, half = rowH / 2 - 2;
  let y0 = top, out = '';
  for (const it of items) {
    const wR = it.revenueCny / max * area, wC = it.costAll / max * area;
    out += `<text x="0" y="${y0 + rowH / 2 + 4}" font-size="12" fill="${RPT.ink}">${escHtml(rptClip(it.label))}</text>`
      + `<rect x="${labelW}" y="${y0}" width="${Math.max(0, wR)}" height="${half}" fill="${RPT.pos}" rx="2"/>`
      + `<rect x="${labelW}" y="${y0 + half + 3}" width="${Math.max(0, wC)}" height="${half}" fill="#f59e0b" rx="2"/>`
      + `<text x="${(W - padR + 6)}" y="${y0 + rowH / 2 + 4}" font-size="11" fill="${RPT.mut}">${escHtml(rptYuan(it.revenueCny - it.costAll))}</text>`;
    y0 += rowH + gap;
  }
  const legend = `<g><rect x="${labelW}" y="6" width="10" height="10" fill="${RPT.pos}" rx="2"/><text x="${labelW + 15}" y="15" font-size="11" fill="${RPT.mut}">收入（折¥）</text>`
    + `<rect x="${labelW + 110}" y="6" width="10" height="10" fill="#f59e0b" rx="2"/><text x="${labelW + 125}" y="15" font-size="11" fill="${RPT.mut}">成本合计（佣金+运费+税费+成本头程，折¥）</text>`
    + `<text x="${W - padR + 6}" y="15" font-size="11" fill="${RPT.mut}">差</text></g>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="收入与成本对比">${legend}${out}</svg>`;
}

function buildProfitReportHTML(d) {
  const lcur = (d.orders && d.orders[0] && d.orders[0].currency) || (d.ads && d.ads.currency) || 'BRL';
  const T = d.totals || {}, ads = d.ads || {}, fx = d.fx || {};
  const products = (d.products || []).slice();
  const orders = (d.orders || []).slice();
  const genAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const fxRows = Object.keys(fx).map(c => `<tr><td>${escHtml(c)}</td><td>${rptNum(fx[c].cnyPer100, 2)}</td><td>${escHtml(fx[c].rateType || '中行牌价')}</td><td>${escHtml(fx[c].publishedAt || '—')}</td></tr>`).join('');

  // 每产品：把原币费用折成人民币，方便「收入 - 成本 = 利润」在表里能对上
  const fxOf = c => Number((fx[c] || {}).localPerCny) || Number((d.orders.find(x => x.currency === c) || {}).fxRate) || 0;
  const rows = products.map((p, i) => {
    const rate = fxOf(lcur) || Number((d.orders.find(x => x.currency === lcur) || {}).fxRate) || 0;
    const feeCny = rate ? p.saleFee / rate : null;
    const shipCny = rate ? p.shipping / rate : null;
    const taxCny = rate ? p.tax / rate : null;
    const costAll = [feeCny, shipCny, taxCny, p.cost].reduce((s, v) => s + (Number(v) || 0), 0);
    return {
      rank: i + 1, p, rate, feeCny, shipCny, taxCny, costAll,
      profitShare: Number(T.profitCny) ? (Number(p.profitCny) || 0) / Number(T.profitCny) * 100 : null,
    };
  });

  const unitsItems = rows.map(r => ({ label: r.p.title || r.p.itemId, sub: r.p.itemId, values: [r.p.units || 0, r.p.cancelledUnits || 0] }));
  const profitItems = rows.map(r => ({ label: r.p.title || r.p.itemId, sub: (r.p.units || 0) + ' 件 · ' + rptPct(r.p.margin), value: r.p.profitCny || 0 }));
  const revCostItems = rows.map(r => ({ label: r.p.title || r.p.itemId, sub: (r.p.units || 0) + ' 件', revenueCny: Number(r.p.revenueCny) || 0, costAll: r.costAll }));

  const productTable = rows.map(r => {
    const p = r.p, neg = Number(p.profitCny) < 0;
    return `<tr>
      <td class="num">${r.rank}</td>
      <td class="name">${escHtml(p.title || p.itemId)}<small>${escHtml(p.itemId || '')}</small></td>
      <td class="num">${rptNum(p.units)}</td>
      <td class="num">${rptNum(p.orders)}</td>
      <td class="num">${p.cancelledUnits ? rptNum(p.cancelledUnits) : '—'}</td>
      <td class="num">${rptNum(p.revenue, 2)}</td>
      <td class="num">${rptYuan(p.revenueCny)}</td>
      <td class="num">${rptNum(p.saleFee, 2)}</td>
      <td class="num">${rptNum(p.shipping, 2)}</td>
      <td class="num">${rptNum(p.tax, 2)}</td>
      <td class="num">${rptYuan(p.cost)}</td>
      <td class="num ${neg ? 'neg' : 'pos'}"><b>${rptYuan(p.profitCny)}</b></td>
      <td class="num ${neg ? 'neg' : ''}">${rptPct(p.margin)}</td>
      <td class="num">${r.profitShare == null || !isFinite(r.profitShare) ? '—' : rptPct(r.profitShare)}</td>
    </tr>`;
  }).join('');
  const productSum = `<tr class="sum">
      <td></td><td>合计 ${rptNum(products.length)} 个产品</td>
      <td class="num">${rptNum(products.reduce((s, p) => s + (p.units || 0), 0))}</td>
      <td class="num">${rptNum(products.reduce((s, p) => s + (p.orders || 0), 0))}</td>
      <td class="num">${rptNum(products.reduce((s, p) => s + (p.cancelledUnits || 0), 0))}</td>
      <td class="num">${rptNum(products.reduce((s, p) => s + (p.revenue || 0), 0), 2)}</td>
      <td class="num">${rptYuan(products.reduce((s, p) => s + (p.revenueCny || 0), 0))}</td>
      <td class="num">${rptNum(products.reduce((s, p) => s + (p.saleFee || 0), 0), 2)}</td>
      <td class="num">${rptNum(products.reduce((s, p) => s + (p.shipping || 0), 0), 2)}</td>
      <td class="num">${rptNum(products.reduce((s, p) => s + (p.tax || 0), 0), 2)}</td>
      <td class="num">${rptYuan(products.reduce((s, p) => s + (p.cost || 0), 0))}</td>
      <td class="num"><b>${rptYuan(T.profitCny)}</b></td>
      <td class="num">${rptPct(T.margin)}</td><td class="num">100.00%</td>
    </tr>`;

  const orderTable = orders.map(x => {
    const dead = !!x.cancelled;
    return `<tr class="${dead ? 'dead' : ''}">
      <td>${escHtml(String(x.date || '').replace('T', ' ').slice(0, 16))}</td>
      <td>${escHtml(x.orderId)}</td>
      <td class="name">${escHtml(x.title || x.itemId)}<small>${escHtml(x.itemId || '')}</small></td>
      <td class="num">${rptNum(x.qty)}</td>
      <td class="num">${rptNum(x.revenue, 2)}</td>
      <td class="num">${x.saleFee == null ? '—' : rptNum(x.saleFee, 2)}</td>
      <td class="num">${dead ? '—' : (x.shipping == null ? '待核对' : rptNum(x.shipping, 2))}</td>
      <td class="num">${dead ? '—' : (x.tax == null ? '待核对' : rptNum(x.tax, 2))}</td>
      <td class="num">${dead ? '—' : (x.costCny == null ? '待核对' : rptYuan(x.costCny))}</td>
      <td class="num ${Number(x.profitCny) < 0 ? 'neg' : ''}">${dead ? '已取消' : (x.profitCny == null ? '待核对' : rptYuan(x.profitCny))}</td>
    </tr>`;
  }).join('');

  const kpi = (label, value, sub, cls) => `<div class="kpi"><div class="kpi-l">${label}</div><div class="kpi-v ${cls || ''}">${value}</div><div class="kpi-s">${sub || ''}</div></div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>产品利润报告 ${escHtml(d.range.from)} ~ ${escHtml(d.range.to)}</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;padding:28px;background:#fff;color:#0f172a;
    font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  h1{font-size:22px;margin:0 0 4px}
  h2{font-size:15px;margin:26px 0 10px;padding-left:9px;border-left:3px solid ${RPT.pos}}
  .meta{color:#64748b;font-size:12px;margin-bottom:4px}
  .meta b{color:#0f172a}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0 6px}
  .kpi{border:1px solid #e2e8f0;border-radius:9px;padding:10px 12px;background:#f8fafc}
  .kpi-l{font-size:11.5px;color:#64748b}
  .kpi-v{font-size:19px;font-weight:800;letter-spacing:-.3px;margin-top:2px}
  .kpi-s{font-size:11px;color:#94a3b8;margin-top:2px}
  .kpi-v.pos{color:${RPT.pos}} .kpi-v.neg{color:${RPT.neg}}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{padding:7px 8px;border-bottom:1px solid #eef2f7;vertical-align:middle}
  th{background:#f1f5f9;text-align:left;font-weight:700;font-size:11.5px;color:#334155;white-space:nowrap}
  td.num,th.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  td.name{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  td.name small{display:block;color:#94a3b8;font-size:10.5px}
  tr.sum td{background:#f8fafc;font-weight:700;border-top:2px solid #cbd5e1}
  tr.dead td{color:#94a3b8;text-decoration:line-through}
  .pos{color:${RPT.pos};font-weight:700} .neg{color:${RPT.neg};font-weight:700}
  .chart{border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin:10px 0;overflow:hidden}
  .chart-h{font-size:12px;color:#475569;font-weight:700;margin-bottom:6px}
  .legend{font-size:11px;color:#64748b;margin:6px 0 0;display:flex;gap:14px;flex-wrap:wrap}
  .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
  .note{font-size:11.5px;color:#64748b;line-height:1.75;border-top:1px dashed #e2e8f0;margin-top:22px;padding-top:10px}
  .note b{color:#334155}
  table.mini{width:auto;min-width:420px}
  @media print{body{padding:0} .chart,table,.kpi{break-inside:avoid} h2{break-after:avoid}}
</style></head><body>

<h1>产品利润报告</h1>
<div class="meta">统计区间 <b>${escHtml(d.range.from)} 至 ${escHtml(d.range.to)}</b> · 经营币种 ${escHtml(lcur)} · 生成时间 ${escHtml(genAt)}</div>
<div class="meta">口径：成本与利润为人民币；收入与平台费用为当地币（${escHtml(lcur)}）；汇率取中国银行牌价；平台未代扣税时按订单收入 × ${rptNum((d.taxRate || 0) * 100, 1)}% 估算</div>

<div class="kpis">
  ${kpi('全部订单', rptNum(T.allOrders), '取消 / 退款 ' + rptNum(T.cancelledOrders || 0) + ' 单')}
  ${kpi('售出件数', rptNum(T.units), '有效 ' + rptNum(T.validUnits) + ' 件' + (T.cancelledUnits ? ' · 取消 ' + rptNum(T.cancelledUnits) + ' 件' : ''))}
  ${kpi('收入（折¥）', rptYuan(products.reduce((s, p) => s + (p.revenueCny || 0), 0)), '不含取消单', 'pos')}
  ${kpi('订单利润（折¥）', rptYuan(T.profitCny), '有效 ' + rptNum(T.profitUnits) + ' 件计入', Number(T.profitCny) < 0 ? 'neg' : 'pos')}
  ${kpi('广告费（折¥）', ads.available ? rptYuan(ads.costCny) : '待核对', ads.available ? escHtml(ads.currency || '') + ' ' + rptNum(ads.costLocal, 2) : escHtml(ads.error || '广告数据不可用'))}
  ${kpi('净利润（折¥）', ads.available ? rptYuan(T.profitAfterAdsCny) : '—', '订单利润 − 广告费', Number(T.profitAfterAdsCny) < 0 ? 'neg' : 'pos')}
  ${kpi('利润率', rptPct(T.margin), '订单利润 ÷ 收入')}
</div>

<h2>各产品出单件数</h2>
<div class="chart">
  <div class="chart-h">横向长度 = 件数；深色为有效件，浅灰为取消 / 退款件</div>
  ${unitsItems.length ? rptStackBars(unitsItems, [{ color: RPT.pos }, { color: RPT.dead }], { fmt: v => rptNum(v) + ' 件' }) : '<p class="meta">区间内没有出单</p>'}
  <div class="legend"><span><i style="background:${RPT.pos}"></i>有效件数</span><span><i style="background:${RPT.dead}"></i>取消 / 退款件数</span></div>
</div>

<h2>各产品利润（折¥）</h2>
<div class="chart">
  <div class="chart-h">零轴居中：向右为盈利，向左为亏损</div>
  ${profitItems.length ? rptDivergeBars(profitItems) : '<p class="meta">区间内没有可核算利润的产品</p>'}
  <div class="legend"><span><i style="background:${RPT.pos}"></i>盈利</span><span><i style="background:${RPT.neg}"></i>亏损</span><span>说明：利润已扣平台佣金、尾程运费、税费、产品成本与头程，<b>未扣广告费</b></span></div>
</div>

<h2>收入 vs 成本</h2>
<div class="chart">
  <div class="chart-h">上条为收入、下条为成本合计，右侧为差额（即该产品利润，折¥）</div>
  ${revCostItems.length ? rptRevCostBars(revCostItems) : '<p class="meta">区间内没有数据</p>'}
</div>

<h2>产品利润明细</h2>
<table>
  <thead><tr>
    <th class="num">#</th><th>产品</th>
    <th class="num">件数</th><th class="num">订单数</th><th class="num">取消件</th>
    <th class="num">收入（${escHtml(lcur)}）</th><th class="num">收入（折¥）</th>
    <th class="num">平台佣金（${escHtml(lcur)}）</th><th class="num">尾程运费（${escHtml(lcur)}）</th><th class="num">税费（${escHtml(lcur)}）</th>
    <th class="num">成本+头程（¥）</th><th class="num">利润（¥）</th><th class="num">利润率</th><th class="num">利润占比</th>
  </tr></thead>
  <tbody>${productTable || '<tr><td colspan="14">区间内没有产品数据</td></tr>'}${products.length ? productSum : ''}</tbody>
</table>

<h2>逐单明细（${rptNum(orders.length)} 行）</h2>
<table>
  <thead><tr>
    <th>下单时间</th><th>订单号</th><th>商品</th><th class="num">数量</th>
    <th class="num">收入（${escHtml(lcur)}）</th><th class="num">佣金（${escHtml(lcur)}）</th><th class="num">运费（${escHtml(lcur)}）</th><th class="num">税费（${escHtml(lcur)}）</th>
    <th class="num">成本+头程（¥）</th><th class="num">利润（¥）</th>
  </tr></thead>
  <tbody>${orderTable || '<tr><td colspan="10">区间内没有订单</td></tr>'}</tbody>
</table>

<div class="note">
  <b>口径说明</b><br>
  1. 件数含取消 / 退款单（与美客多后台「已售出」口径一致），但取消单不计入收入与利润，逐单明细里整行置灰并划掉。<br>
  2. 产品利润 = 收入 − 平台佣金 − 尾程运费 − 税费 − 产品成本 − 头程；<b>广告费不分摊到产品</b>，只从整体净利润里扣一次。<br>
  3. 税费：平台返回 <code>order.taxes.amount</code> 有数字就用平台值；巴西站平台不代扣，按订单收入 × ${rptNum((d.taxRate || 0) * 100, 1)}% 估算，因此是<b>估算值</b>。<br>
  4. 汇率：中国银行牌价，${Object.keys(fx).length ? '参与折算的币种见下表' : '本次区间无可用牌价，相关金额显示为待核对'}。同一行里原币列与人民币列<b>不能直接相减</b>。<br>
  5. 标「待核对」的行表示缺成本、缺运费或暂无牌价，未计入合计。<br>
  <b>最终结算以美客多账单为准。</b>
</div>

${Object.keys(fx).length ? `<h2>本次折算汇率（中国银行牌价）</h2>
<table class="mini"><thead><tr><th>币种</th><th class="num">每 100 单位折¥</th><th>类型</th><th>发布时间</th></tr></thead><tbody>${fxRows}</tbody></table>` : ''}

</body></html>`;
}

function downloadProfitReport() {
  const d = lastProfitOrderData;
  if (!d || !(d.products || []).length) { toast('请先查询一个日期范围，有数据后再下载报告', 'err'); return; }
  const html = buildProfitReportHTML(d);
  const name = '产品利润报告_' + d.range.from + '_' + d.range.to + '.html';
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('报告已生成：' + name);
}

function exportProfitProductsCSV() {
  const d = lastProfitOrderData;
  if (!d || !(d.products || []).length) { toast('请先查询一个日期范围，有数据后再导出', 'err'); return; }
  const lcur = (d.orders && d.orders[0] && d.orders[0].currency) || 'BRL';
  const headers = ['产品', 'Listing', '件数', '订单数', '取消件数', '收入(' + lcur + ')', '收入(¥)', '平台佣金(' + lcur + ')', '尾程运费(' + lcur + ')', '税费(' + lcur + ')', '成本+头程(¥)', '利润(¥)', '利润率%'];
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = (d.products || []).map(p => [
    q(p.title || ''), p.itemId || '', p.units || 0, p.orders || 0, p.cancelledUnits || 0,
    (Number(p.revenue) || 0).toFixed(2), (Number(p.revenueCny) || 0).toFixed(2),
    (Number(p.saleFee) || 0).toFixed(2), (Number(p.shipping) || 0).toFixed(2), (Number(p.tax) || 0).toFixed(2),
    (Number(p.cost) || 0).toFixed(2), (Number(p.profitCny) || 0).toFixed(2),
    p.margin == null ? '' : Number(p.margin).toFixed(2),
  ]);
  downloadCSV('产品利润_' + d.range.from + '_' + d.range.to + '.csv', headers, rows);
}

/* ---- 按钮绑定：脚本在 body 末尾加载，DOM 已就绪 ---- */
(function bindProfitReportButtons() {
  const b1 = document.getElementById('profitExportReport');
  const b2 = document.getElementById('profitExportCsv');
  if (b1) {
    b1.onclick = () => {
      try { downloadProfitReport(); }
      // 只弹 toast 的话线上报错就彻底没痕迹（探针也抓不到 console），这里补一条 error 日志
      catch (e) { console.error('[报告] 生成失败：', e); toast('报告生成失败：' + e.message, 'err'); }
    };
  }
  if (b2) {
    b2.onclick = () => {
      try { exportProfitProductsCSV(); }
      catch (e) { toast('CSV 导出失败：' + e.message, 'err'); }
    };
  }
})();
