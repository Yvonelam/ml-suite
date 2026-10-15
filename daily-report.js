/**
 * daily-report.js — 每日定时搜索美客多排名并邮件发送报告
 * 
 * 读取 daily-search-config.json 配置 → 搜索美客多 → 匹配产品 → 发送邮件
 * 
 * 用法: node daily-report.js
 * 配置: 编辑 daily-search-config.json
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { ProxyAgent, setGlobalDispatcher } = require('undici');

// ==================== 配置 ====================

const CONFIG_PATH = path.join(__dirname, 'daily-search-config.json');
const PER_PAGE = 48;

const SITES = {
  MLM: {
    name: '墨西哥',
    currency: 'MXN',
    currencySymbol: '$',
    searchBase: 'https://listado.mercadolibre.com.mx',
    idPrefix: 'MLM',
    acceptLang: 'es-MX,es;q=0.9',
    totalRegex: /([\d,]+)\s+resultados?/i,
  },
  MLB: {
    name: '巴西',
    currency: 'BRL',
    currencySymbol: 'R$',
    searchBase: 'https://lista.mercadolivre.com.br',
    idPrefix: 'MLB',
    acceptLang: 'pt-BR,pt;q=0.9',
    totalRegex: /([\d.]+)\s+resultados?/i,
  },
  MLA: {
    name: '阿根廷',
    currency: 'ARS',
    currencySymbol: '$',
    searchBase: 'https://listado.mercadolibre.com.ar',
    idPrefix: 'MLA',
    acceptLang: 'es-AR,es;q=0.9',
    totalRegex: /([\d.]+)\s+resultados?/i,
  },
};

// QQ 邮箱 SMTP —— 凭据从 daily-search-config.json 读取（不再硬编码，避免源码泄漏）
const SMTP_CONFIG = (() => {
  let cfg = {};
  try {
    cfg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'daily-search-config.json'), 'utf8'));
  } catch (e) { }
  return {
    host: cfg.smtpHost || 'smtp.qq.com',
    port: cfg.smtpPort || 465,
    secure: true,
    auth: {
      user: cfg.smtpUser || process.env.SMTP_USER || '',
      pass: cfg.smtpPass || process.env.SMTP_PASS || '',
    },
  };
})();

// ==================== 工具函数 ====================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

// ==================== HTML 解析 ====================

function parsePage(html, siteCode, pageNum) {
  const site = SITES[siteCode];
  const offset = (pageNum - 1) * PER_PAGE;

  const items = [...html.matchAll(/href="([^"]+)"[^>]*class="[^"]*poly-component__title/g)].map(m => {
    const url = m[1].replace(/&amp;/g, '&');
    const idMatch = url.match(new RegExp(`\\/(${site.idPrefix}\\d+)`));
    return {
      link: url.split('#')[0],
      productId: idMatch ? idMatch[1] : '',
    };
  });

  const titles = [...html.matchAll(/poly-component__title[^>]*>([^<]+)</g)].map(m => m[1].trim());
  const prices = [...html.matchAll(/andes-money-amount__fraction[^>]*>([^<]+)</g)].map(m => m[1].trim());
  const sellers = [...html.matchAll(/poly-component__seller[^>]*>([^<]+)</g)].map(m => m[1].trim());
  const conditions = [...html.matchAll(/poly-component__condition[^>]*>([^<]+)</g)].map(m => m[1].trim());

  let total = 0;
  const totalMatch = html.match(site.totalRegex);
  if (totalMatch) {
    total = parseInt(totalMatch[1].replace(/[.,]/g, ''));
  }

  const results = items.map((item, i) => {
    let price = 0;
    if (prices[i]) {
      const cleaned = prices[i].replace(/[.,](?=\d{3})/g, '').replace(/[.,]/, '.');
      price = parseFloat(cleaned) || 0;
    }

    const condition = conditions[i] || '';
    let conditionCode = '';
    if (/nuevo/i.test(condition)) conditionCode = 'new';
    else if (/usado|reacondicionado/i.test(condition)) conditionCode = 'used';

    return {
      page: pageNum,
      rankInPage: i + 1,
      overallRank: offset + i + 1,
      id: item.productId,
      title: titles[i] || '',
      price,
      priceDisplay: prices[i] || '',
      currency: site.currency,
      currencySymbol: site.currencySymbol,
      link: item.link,
      seller: sellers[i] || '',
      condition: conditionCode,
      conditionDisplay: condition,
    };
  });

  return { total, results };
}

// ==================== 搜索 ====================

async function fetchWithRetry(url, headers, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);

      if (response.status === 429) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(1500 * (attempt + 1));
    }
  }
}

async function searchSite(keyword, siteCode, maxPages) {
  const site = SITES[siteCode];
  if (!site) return { error: `未知站点: ${siteCode}` };

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': site.acceptLang,
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
  };

  const allResults = [];
  let totalResults = 0;
  let pagesSearched = 0;
  let partialError = null;

  for (let page = 1; page <= maxPages; page++) {
    let url;
    if (page === 1) {
      url = `${site.searchBase}/${encodeURIComponent(keyword)}`;
    } else {
      const desde = (page - 1) * PER_PAGE + 1;
      url = `${site.searchBase}/${encodeURIComponent(keyword)}_Desde_${desde}_NoIndex_True`;
    }

    try {
      const html = await fetchWithRetry(url, headers);
      const parsed = parsePage(html, siteCode, page);

      if (page === 1) totalResults = parsed.total;
      pagesSearched = page;

      if (parsed.results.length === 0) break;

      allResults.push(...parsed.results);

      if (totalResults > 0 && allResults.length >= totalResults) break;
      if (page < maxPages) await sleep(1500);
    } catch (error) {
      partialError = error.message;
      break;
    }
  }

  return { allResults, totalResults, pagesSearched, partialError };
}

// ==================== 产品匹配 ====================

function matchProducts(allResults, productTitles) {
  return productTitles.map((title, idx) => {
    const titleNorm = normalizeText(title);
    const matches = allResults.filter(r => normalizeText(r.title).includes(titleNorm));

    if (matches.length === 0) {
      return {
        index: idx + 1,
        searchTitle: title,
        found: false,
        page: null,
        rankInPage: null,
        overallRank: null,
        matchedTitle: '',
        priceDisplay: '',
        currencySymbol: '',
        link: '',
        seller: '',
        matchCount: 0,
      };
    }

    const best = matches[0];
    return {
      index: idx + 1,
      searchTitle: title,
      found: true,
      page: best.page,
      rankInPage: best.rankInPage,
      overallRank: best.overallRank,
      matchedTitle: best.title,
      priceDisplay: best.priceDisplay,
      currencySymbol: best.currencySymbol,
      link: best.link,
      seller: best.seller,
      matchCount: matches.length,
    };
  });
}

// ==================== 邮件 HTML 生成 ====================

function generateEmailHTML(config, searchResults, dateStr) {
  let sitesHtml = '';

  for (const sr of searchResults) {
    const site = SITES[sr.siteCode];
    const foundCount = sr.batchResults ? sr.batchResults.filter(r => r.found).length : 0;
    const notFoundCount = sr.batchResults ? sr.batchResults.length - foundCount : 0;

    let rowsHtml = '';
    if (sr.batchResults && sr.batchResults.length > 0) {
      rowsHtml = sr.batchResults.map(r => {
        if (!r.found) {
          return `
            <tr style="background:#fff5f5;">
              <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">${r.index}</td>
              <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;"><span style="color:#e53935;font-weight:bold;">未找到</span></td>
              <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">-</td>
              <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">-</td>
              <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">-</td>
              <td style="padding:8px 12px;border:1px solid #e0e0e0;">${escapeHtml(r.searchTitle)}</td>
              <td style="padding:8px 12px;border:1px solid #e0e0e0;color:#999;">未在前 ${sr.pagesSearched} 页中匹配到</td>
              <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">-</td>
            </tr>
          `;
        }

        const rankColor = r.overallRank === 1 ? '#ffd700' :
                          r.overallRank <= 3 ? '#c0c0c0' :
                          r.overallRank <= 10 ? '#cd7f32' : '#4caf50';
        const rankBg = r.overallRank === 1 ? '#fffdf0' :
                       r.overallRank <= 3 ? '#f9f9f9' :
                       r.overallRank <= 10 ? '#fff8f0' : '#f0fff0';

        return `
          <tr style="background:${rankBg};">
            <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">${r.index}</td>
            <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;"><span style="color:#4caf50;font-weight:bold;">已找到</span></td>
            <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;font-weight:bold;">第${r.page}页</td>
            <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">第${r.rankInPage}位</td>
            <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;"><span style="background:${rankColor};color:#fff;padding:2px 8px;border-radius:10px;font-weight:bold;">${r.overallRank}</span></td>
            <td style="padding:8px 12px;border:1px solid #e0e0e0;">${escapeHtml(r.searchTitle)}</td>
            <td style="padding:8px 12px;border:1px solid #e0e0e0;"><a href="${r.link}" target="_blank" style="color:#3483fa;text-decoration:none;">${escapeHtml(r.matchedTitle)}</a>${r.matchCount > 1 ? ` <span style="color:#999;font-size:12px;">(${r.matchCount}个匹配)</span>` : ''}</td>
            <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">${r.currencySymbol} ${r.priceDisplay || '-'}</td>
          </tr>
        `;
      }).join('');
    }

    sitesHtml += `
      <div style="margin-bottom:24px;">
        <h2 style="color:#3483fa;border-bottom:2px solid #3483fa;padding-bottom:8px;">
          ${site.name} (${sr.siteCode}) 
          <span style="font-size:14px;color:#666;font-weight:normal;">
            关键词: "${escapeHtml(config.keyword)}" | 
            总结果: ${sr.totalResults} | 
            搜索 ${sr.pagesSearched} 页 (${sr.allResults.length} 个商品)
          </span>
        </h2>
        ${sr.partialError ? `<p style="color:#e53935;">部分页面获取失败: ${escapeHtml(sr.partialError)}</p>` : ''}
        <div style="margin-bottom:12px;font-size:14px;">
          <span style="background:#e8f5e9;color:#2e7d32;padding:4px 12px;border-radius:4px;font-weight:bold;">已找到: ${foundCount}</span>
          <span style="background:#fbe9e7;color:#c62828;padding:4px 12px;border-radius:4px;font-weight:bold;margin-left:8px;">未找到: ${notFoundCount}</span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="padding:8px 12px;border:1px solid #e0e0e0;width:40px;">#</th>
              <th style="padding:8px 12px;border:1px solid #e0e0e0;width:70px;">状态</th>
              <th style="padding:8px 12px;border:1px solid #e0e0e0;width:70px;">页码</th>
              <th style="padding:8px 12px;border:1px solid #e0e0e0;width:70px;">页内位次</th>
              <th style="padding:8px 12px;border:1px solid #e0e0e0;width:70px;">总排名</th>
              <th style="padding:8px 12px;border:1px solid #e0e0e0;">搜索的产品标题</th>
              <th style="padding:8px 12px;border:1px solid #e0e0e0;">匹配到的实际标题</th>
              <th style="padding:8px 12px;border:1px solid #e0e0e0;width:90px;">价格</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>美客多排名日报</title></head>
<body style="font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f5f5f5;margin:0;padding:20px;">
  <div style="max-width:900px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    <div style="text-align:center;margin-bottom:24px;">
      <h1 style="color:#3483fa;margin:0 0 8px;">🛒 美客多关键词排名日报</h1>
      <p style="color:#999;font-size:14px;">${dateStr} | 自动搜索报告</p>
    </div>
    ${sitesHtml}
    <div style="margin-top:32px;padding:16px;background:#f5f5f5;border-radius:4px;text-align:center;color:#999;font-size:12px;">
      <p>本邮件由美客多搜索排名查询工具自动发送</p>
      <p>如需修改搜索关键词或产品标题，请编辑 daily-search-config.json 配置文件</p>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ==================== 邮件发送 ====================

async function sendEmail(to, subject, html) {
  const transporter = nodemailer.createTransport(SMTP_CONFIG);

  const info = await transporter.sendMail({
    from: '"美客多排名监控" <' + (SMTP_CONFIG.auth.user || 'noreply@example.com') + '>',
    to,
    subject,
    html,
  });

  return info;
}

// ==================== 主流程 ====================

async function main() {
  console.log('========== 美客多每日排名报告 ==========');
  console.log(`时间: ${formatDate(new Date())}`);

  // 读取配置
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  console.log(`关键词: ${config.keyword}`);
  console.log(`产品标题: ${config.productTitles.length} 个`);
  console.log(`站点: ${config.sites.join(', ')}`);
  console.log(`搜索页数: ${config.pages}`);
  console.log(`收件邮箱: ${config.email}`);

  // 设置代理
  if (config.proxy) {
    setGlobalDispatcher(new ProxyAgent(config.proxy));
    console.log(`代理: ${config.proxy}`);
  }

  const searchResults = [];

  // 逐站点搜索
  for (const siteCode of config.sites) {
    const site = SITES[siteCode];
    if (!site) {
      console.log(`\n[跳过] 未知站点: ${siteCode}`);
      continue;
    }

    console.log(`\n--- 搜索 ${site.name} (${siteCode}) ---`);

    const { allResults, totalResults, pagesSearched, partialError } = await searchSite(
      config.keyword, siteCode, config.pages
    );

    console.log(`  总结果: ${totalResults}, 已获取: ${allResults.length}, 搜索页数: ${pagesSearched}`);

    // 匹配产品
    const batchResults = matchProducts(allResults, config.productTitles);
    const foundCount = batchResults.filter(r => r.found).length;
    console.log(`  匹配结果: ${foundCount}/${batchResults.length} 已找到`);

    searchResults.push({
      siteCode,
      allResults,
      totalResults,
      pagesSearched,
      partialError,
      batchResults,
    });
  }

  // 生成邮件
  const dateStr = formatDate(new Date());
  const html = generateEmailHTML(config, searchResults, dateStr);
  const subject = `美客多排名日报 - ${dateStr} | 关键词: ${config.keyword}`;

  console.log('\n--- 发送邮件 ---');
  console.log(`收件人: ${config.email}`);

  try {
    const info = await sendEmail(config.email, subject, html);
    console.log(`邮件发送成功! Message ID: ${info.messageId}`);
    console.log('\n========== 报告完成 ==========');
  } catch (error) {
    console.error(`邮件发送失败: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('运行失败:', err);
  process.exit(1);
});
