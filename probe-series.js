#!/usr/bin/env node
/*
 * 型号（系列）识别单测 —— 纯 Node，不启浏览器、不打接口，秒级跑完。
 *
 * 为什么值得单独测：这段是「同型号合并利润」的唯一判据，错一个词就把两个
 * 毫无关系的商品并成一栏（利润全错），而页面上看不出任何异常。
 * 样本全部取自本店真实标题（2026-11 的 18 个 Listing）。
 *
 * 用法：node probe-series.js
 */
'use strict';
const { assignSeries, tokensOf, fromSku, UNKNOWN } = require('./lib/series');

let pass = 0, fail = 0;
const ok = (cond, name, got) => {
  if (cond) { pass++; console.log('  ✅ ' + name + (got === undefined ? '' : ' · ' + got)); }
  else { fail++; console.log('  ❌ ' + name + (got === undefined ? '' : ' · ' + got)); }
};

/* 真实标题 → 期望系列（本店 18 个 Listing 全量） */
const CASES = [
  ['Headset Gamer Nubwo® U3 Fone 3d Estéreo Ouvido Para Pc Ps4 Preto', 'U3'],
  ['Headset Gamer Nubwo® U3 Fone 3d Estéreo Ouvido Para Pc Ps4 Prateado', 'U3'],
  ['Headset Wireless Binnune Bw06 Fone Sem Fio Usb 2.4ghz,bluetooth 5.3 ,conexão De Três Modelos 100h Bateria De Longa Duração,função Manos Libres Conexão Sem Fio Bluetooth Simultânea ,preto', 'BW06'],
  ['Fone De Ouvido Binnune Bw06 Over-ear Sem Fio Bluetooth 5.3 E 2.4ghz Para Playstation Azul-celeste', 'BW06'],
  ['Headphone Gamer Binnune Bw06 Over-ear Sem Fio 2.4ghz E Bluetooth Com Microfone E Bateria 80h Cinza', 'BW06'],
  ['Headset Wireless Bw06 Usb Fone Gamer Bluetooth Para Mac,pc Preto', 'BW06'],
  ['Headset Wireless Binnune Bw06 Fone Sem Fio 2.4ghz Usb 5.3 Bluetooth Conexão De Três Modelos 80h Bateria De Longa Duração Conexão Sem Fio Bluetooth Simultânea Função Manos Libres Branco', 'BW06'],
  ['Wireless Headset Binnune® Bw01 Usb Fone Gamer Três-mode 2.4g', 'BW01'],
  ['Headset Nubwo Hw02 On-ear Profissional Com Microfone Para Reuniões E Escritório Preto', 'HW02'],
  ['Fone Ouvido Hw02 Negócios Headset Usb Microfone Para Reunião Vermelho', 'HW02'],
  ['Wireless Headset Nubwo® G06 Fone Gamer 2.4ghz Usb Bluetooth', 'G06'],
  ['Fone De Nubwo® N16 Headset Gamer Surround 7.1 Ouvido Para Pc', 'N16'],
  ['Fone Gamer Bg02 3d Surround Ouvido Headset Para Pc,ps,xbox', 'BG02'],
  ['Fone Nubwo Hg04l Headset Gamer Surround 7.1 Ouvido Para Pc,xbox,ps Possui Uma Entrada Para Fones De Ouvido De 3,5 Mm Preto', 'HG04L'],
  ['Fone De Ouvido Nubwo Hg04l Headset Gamer Surround 7.1 Som Para Pc Console De Microfone/pc, Para Jogos,branco', 'HG04L'],
  ['Fone Nubwo® Hg04l Headset Gamer Surround 7.1 Ouvido Para Pc Preto', 'HG04L'],
  ['Fone De Ouvido Eh01 Headset Com Fio Para Pc Reunião Office Preto', 'EH01'],
  ['Headset Gamer Nubwo N7 Over-ear Som Surround 7.1 Com Microfone E Cancelamento De Ruído Adequado Para Escritórios Corporativos E Fins Comerciais Preto', 'N7'],
];

console.log('--- 1. 真实标题全量识别 ---');
{
  const got = assignSeries(CASES.map(([title]) => ({ title })));
  ok(got.length === CASES.length, '返回条数与输入一致', got.length + ' / ' + CASES.length);
  CASES.forEach(([title, want], i) => ok(got[i] === want, '「' + title.slice(0, 34) + '…」→ ' + want, got[i]));
  const wrong = CASES.filter(([, want], i) => got[i] !== want).length;
  ok(wrong === 0, '18 个真实标题零误判', wrong ? wrong + ' 条错' : '18 条全对');
}

console.log('--- 2. 合并效果（同一型号必须并到一起） ---');
{
  const got = assignSeries(CASES.map(([title]) => ({ title })));
  const count = new Map();
  got.forEach(s => count.set(s, (count.get(s) || 0) + 1));
  ok(count.get('BW06') === 5, 'BW06 合并 5 个链接', '得 ' + count.get('BW06'));
  ok(count.get('U3') === 2, 'U3 合并 2 个链接', '得 ' + count.get('U3'));
  ok(count.get('HG04L') === 3, 'HG04L 合并 3 个链接（大小写混写也算同一个）', '得 ' + count.get('HG04L'));
  ok(count.size === 10, '18 个 Listing 归成 10 个系列', '得 ' + count.size);
}

console.log('--- 3. 规格词不能当型号 ---');
{
  const noise = [
    'Fone Gamer 3d Surround Para Pc Ps4 7.1 2.4ghz 80h Bateria',
    'Headset Com Fio 3,5 Mm Para Pc Ps5 Xbox One',
    'Fone Bluetooth 5.3 Usb 2.4g Bateria 100h',
    'Headset Gamer Rgb Led 4k Hd Com Microfone',
  ];
  const got = assignSeries(noise.map(title => ({ title })));
  got.forEach((s, i) => ok(s === UNKNOWN, '纯规格标题归「未识别型号」·' + (i + 1), s));
  ok(!tokensOf('Fone Gamer 3d Surround 7.1 2.4ghz Ps4').length, '3d / 7.1 / 2.4ghz / Ps4 一个都不当候选', JSON.stringify(tokensOf('Fone Gamer 3d Surround 7.1 2.4ghz Ps4')));
}

console.log('--- 4. 一个标题多个候选：选重复最多的 ---');
{
  // 5 条 BW06 + 1 条同时写了 U3，应选 BW06
  const rows = [
    { title: 'Fone Bw06 Preto' }, { title: 'Fone Bw06 Branco' }, { title: 'Fone Bw06 Azul' },
    { title: 'Fone Bw06 Cinza' }, { title: 'Fone Bw06 Rosa' }, { title: 'Fone Bw06 Compatível U3' },
  ];
  const got = assignSeries(rows);
  ok(got[5] === 'BW06', '同标题含 U3 也选重复更多的 BW06', got[5]);
  // 同频（各 1 次）时取更靠前的
  const one = assignSeries([{ title: 'Fone G06 Adaptador N16' }]);
  ok(one[0] === 'G06', '同频取标题里更靠前的型号', one[0]);
}

console.log('--- 5. SKU 兜底 + 边界 ---');
{
  ok(fromSku('BW06BB-ML-BR-A') === 'BW06BB', 'SKU 前缀当型号', fromSku('BW06BB-ML-BR-A'));
  ok(fromSku('XZ-ML-BR') === '', '不像型号的 SKU 不硬凑', JSON.stringify(fromSku('XZ-ML-BR')));
  const got = assignSeries([{ title: 'Fone Sem Fio Genérico', sku: 'BW06BB-ML-BR-A' }, { title: 'Outro', sku: '' }]);
  ok(got[0] === 'BW06BB', '标题认不出时用 SKU 兜底', got[0]);
  ok(got[1] === UNKNOWN, '都没有时归「未识别型号」', got[1]);
  const edge = assignSeries([{ title: '' }, { title: null }, {}, { title: '   ' }]);
  ok(edge.every(s => s === UNKNOWN), '空标题 / null 不炸且不返回空串', JSON.stringify(edge));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
