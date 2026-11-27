/* 产品利润 Excel（.xlsx）生成器
 *
 * 两张主表 + 一张口径表：
 *   1) 产品利润 —— 每个 Listing 一行，收入/佣金/运费/税费/成本头程/利润/利润率/利润占比，带合计行
 *   2) 订单明细 —— 逐单一行，**带产品列并按产品排序**，这样点开就知道每个产品的利润是由哪些订单组成的
 *   3) 口径与汇率 —— 税率、汇率来源、口径说明
 *
 * 数据来源就是前端页面正在显示的那份（与 HTML 报告完全同源），不重新调美客多接口，
 * 避免「Excel 和页面数字不一致」这种最招人烦的问题。
 */
'use strict';
const ExcelJS = require('exceljs');

const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
const HEAD_FONT = { bold: true, size: 10.5, color: { argb: 'FF334155' } };
const BORDER = { style: 'thin', color: { argb: 'FFE2E8F0' } };
const MONEY = '#,##0.00';
const INT = '#,##0';

function thin(row) { row.eachCell(c => { c.border = { bottom: BORDER }; }); }

function buildProfitXlsx(d) {
  const lcur = (d.orders && d.orders[0] && d.orders[0].currency) || (d.ads && d.ads.currency) || 'BRL';
  const T = d.totals || {}, ads = d.ads || {}, fx = d.fx || {};
  const products = (d.products || []).slice();
  const orders = (d.orders || []).slice();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ML Suite';
  wb.created = new Date();

  /* ---------- Sheet 1：产品利润 ---------- */
  const s1 = wb.addWorksheet('产品利润', { views: [{ state: 'frozen', ySplit: 3 }] });
  s1.mergeCells('A1:O1');
  s1.getCell('A1').value = '产品利润报告 · ' + d.range.from + ' 至 ' + d.range.to;
  s1.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF0F172A' } };
  s1.getRow(1).height = 24;
  s1.mergeCells('A2:O2');
  s1.getCell('A2').value = '成本与利润为人民币；收入与平台费用为当地币（' + lcur + '）；广告费不分摊到产品，只从整体净利润中扣一次；平台未代扣税时按收入 × '
    + (Math.round((d.taxRate || 0) * 10000) / 100) + '% 估算。生成时间 ' + new Date().toLocaleString('zh-CN', { hour12: false });
  s1.getCell('A2').font = { size: 9.5, color: { argb: 'FF64748B' } };

  const h1 = ['#', '产品', 'Listing ID', '件数', '订单数', '取消件', '收入(' + lcur + ')', '收入(¥)', '平台佣金(' + lcur + ')',
    '尾程运费(' + lcur + ')', '税费(' + lcur + ')', '成本+头程(¥)', '利润(¥)', '利润率', '利润占比'];
  const hr1 = s1.getRow(3);
  hr1.values = h1;
  hr1.eachCell(c => { c.font = HEAD_FONT; c.fill = HEAD_FILL; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
  hr1.height = 30;

  products.forEach((p, i) => {
    const row = s1.addRow([
      i + 1, p.title || p.itemId, p.itemId || '', p.units || 0, p.orders || 0, p.cancelledUnits || 0,
      Number(p.revenue) || 0, Number(p.revenueCny) || 0, Number(p.saleFee) || 0, Number(p.shipping) || 0,
      Number(p.tax) || 0, Number(p.cost) || 0, Number(p.profitCny) || 0,
      p.margin == null ? null : Number(p.margin) / 100,
      Number(T.profitCny) ? (Number(p.profitCny) || 0) / Number(T.profitCny) : null,
    ]);
    row.getCell(7).numFmt = MONEY; row.getCell(8).numFmt = MONEY; row.getCell(9).numFmt = MONEY;
    row.getCell(10).numFmt = MONEY; row.getCell(11).numFmt = MONEY; row.getCell(12).numFmt = MONEY;
    row.getCell(13).numFmt = MONEY; row.getCell(14).numFmt = '0.00%'; row.getCell(15).numFmt = '0.00%';
    row.getCell(4).numFmt = INT; row.getCell(5).numFmt = INT; row.getCell(6).numFmt = INT;
    row.getCell(13).font = { bold: true, color: { argb: Number(p.profitCny) < 0 ? 'FFDC2626' : 'FF2563EB' } };
    thin(row);
  });

  const sumRow = s1.addRow([
    '', '合计 ' + products.length + ' 个产品',
    '', products.reduce((s, p) => s + (p.units || 0), 0), products.reduce((s, p) => s + (p.orders || 0), 0),
    products.reduce((s, p) => s + (p.cancelledUnits || 0), 0),
    products.reduce((s, p) => s + (Number(p.revenue) || 0), 0), products.reduce((s, p) => s + (Number(p.revenueCny) || 0), 0),
    products.reduce((s, p) => s + (Number(p.saleFee) || 0), 0), products.reduce((s, p) => s + (Number(p.shipping) || 0), 0),
    products.reduce((s, p) => s + (Number(p.tax) || 0), 0), products.reduce((s, p) => s + (Number(p.cost) || 0), 0),
    Number(T.profitCny) || 0, T.margin == null ? null : Number(T.margin) / 100, 1,
  ]);
  for (const i of [7, 8, 9, 10, 11, 12, 13]) sumRow.getCell(i).numFmt = MONEY;
  sumRow.getCell(14).numFmt = '0.00%'; sumRow.getCell(15).numFmt = '0.00%';
  sumRow.getCell(4).numFmt = INT; sumRow.getCell(5).numFmt = INT; sumRow.getCell(6).numFmt = INT;
  sumRow.eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }; });

  // 整体净利润（含广告）另起两行，避免和「产品利润合计」混为一谈
  s1.addRow([]);
  const adRow = s1.addRow(['', '广告费（本期，折¥）', '', '', '', '', ads.available ? Number(ads.costCny) || 0 : '待核对']);
  adRow.getCell(7).numFmt = MONEY;
  const netRow = s1.addRow(['', '扣除广告后净利润（¥）', '', '', '', '', ads.available ? Number(T.profitAfterAdsCny) || 0 : '—']);
  netRow.getCell(7).numFmt = MONEY;
  netRow.getCell(7).font = { bold: true, color: { argb: Number(T.profitAfterAdsCny) < 0 ? 'FFDC2626' : 'FF16A34A' } };

  s1.columns = [
    { width: 5 }, { width: 52 }, { width: 16 }, { width: 7 }, { width: 8 }, { width: 8 },
    { width: 14 }, { width: 13 }, { width: 15 }, { width: 15 }, { width: 12 }, { width: 14 },
    { width: 13 }, { width: 9 }, { width: 9 },
  ];

  /* ---------- Sheet 2：订单明细 ---------- */
  const s2 = wb.addWorksheet('订单明细', { views: [{ state: 'frozen', ySplit: 1 }] });
  const h2 = ['下单时间', '订单号', '产品', 'Listing ID', '数量', '收入(' + lcur + ')', '平台佣金(' + lcur + ')',
    '尾程运费(' + lcur + ')', '税费(' + lcur + ')', '成本+头程(¥)', '利润(¥)', '利润率', '状态', '待核对原因'];
  const hr2 = s2.getRow(1);
  hr2.values = h2;
  hr2.eachCell(c => { c.font = HEAD_FONT; c.fill = HEAD_FILL; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
  hr2.height = 30;

  // 按产品 → 时间排序：同一个产品的订单挨在一起，打开就能看出「这个产品的利润是哪几单凑的」
  const sorted = orders.slice().sort((a, b) => {
    const t = String(a.title || a.itemId || '').localeCompare(String(b.title || b.itemId || ''));
    if (t) return t;
    return String(a.date || '').localeCompare(String(b.date || ''));
  });
  for (const x of sorted) {
    const dead = !!x.cancelled;
    const row = s2.addRow([
      String(x.date || '').replace('T', ' ').slice(0, 19),
      String(x.orderId || ''),
      x.title || x.itemId || '',
      x.itemId || '',
      Number(x.qty) || 0,
      Number(x.revenue) || 0,
      x.saleFee == null ? null : Number(x.saleFee),
      x.shipping == null ? null : Number(x.shipping),
      x.tax == null ? null : Number(x.tax),
      x.costCny == null ? null : Number(x.costCny),
      dead ? null : (x.profitCny == null ? null : Number(x.profitCny)),
      dead || x.margin == null ? null : Number(x.margin) / 100,
      dead ? '已取消 / 退款' : (x.profit == null ? '待核对' : '有效'),
      dead ? '不计入利润' : (x.profit == null ? (x.missing || []).join('、') : ''),
    ]);
    for (const i of [6, 7, 8, 9, 10, 11]) row.getCell(i).numFmt = MONEY;
    row.getCell(12).numFmt = '0.00%';
    row.getCell(5).numFmt = INT;
    if (dead) row.eachCell(c => { c.font = { color: { argb: 'FF94A3B8' }, strike: true }; });
    else if (Number(x.profitCny) < 0) row.getCell(11).font = { color: { argb: 'FFDC2626' } };
    thin(row);
  }
  s2.columns = [
    { width: 19 }, { width: 16 }, { width: 48 }, { width: 16 }, { width: 7 },
    { width: 13 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 13 }, { width: 9 },
    { width: 13 }, { width: 34 },
  ];
  s2.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, s2.rowCount), column: h2.length } };

  /* ---------- Sheet 3：口径与汇率 ---------- */
  const s3 = wb.addWorksheet('口径与汇率');
  s3.columns = [{ width: 22 }, { width: 96 }];
  const lines = [
    ['统计区间', d.range.from + ' 至 ' + d.range.to],
    ['经营币种', lcur],
    ['全部订单', String(T.allOrders || 0) + ' 单（取消 / 退款 ' + (T.cancelledOrders || 0) + ' 单）'],
    ['售出件数', String(T.units || 0) + ' 件（有效 ' + (T.validUnits || 0) + ' 件，取消 ' + (T.cancelledUnits || 0) + ' 件）'],
    ['订单利润（¥）', String(T.profitCny || 0)],
    ['广告费（¥）', ads.available ? String(ads.costCny || 0) : '待核对：' + (ads.error || '')],
    ['净利润（¥）', ads.available ? String(T.profitAfterAdsCny || 0) : '—'],
    ['利润率', (T.margin == null ? '—' : T.margin + '%')],
    ['税费税率', (Math.round((d.taxRate || 0) * 10000) / 100) + '%（平台未代扣时按订单收入估算）'],
    ['', ''],
    ['口径说明', '1. 件数含取消 / 退款单（与美客多后台「已售出」口径一致），取消单不计入收入与利润。'],
    ['', '2. 产品利润 = 收入 − 平台佣金 − 尾程运费 − 税费 − 产品成本 − 头程；广告费不分摊到产品，只从整体净利润扣一次。'],
    ['', '3. 标「待核对」的行表示缺成本、缺运费或暂无牌价，未计入合计。'],
    ['', '4. 原币列与人民币列不能直接相减，折算汇率见下表。最终结算以美客多账单为准。'],
  ];
  for (const [k, v] of lines) {
    const row = s3.addRow([k, v]);
    row.getCell(1).font = { bold: true, size: 10 };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  }
  s3.addRow([]);
  const fh = s3.addRow(['币种', '每 100 单位折¥ / 类型 / 发布']);
  fh.eachCell(c => { c.font = HEAD_FONT; c.fill = HEAD_FILL; });
  for (const code of Object.keys(fx)) {
    s3.addRow([code, Number(fx[code].cnyPer100 || 0).toFixed(2) + ' / ' + (fx[code].rateType || '中行牌价') + ' / ' + (fx[code].publishedAt || '—')]);
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { buildProfitXlsx };
