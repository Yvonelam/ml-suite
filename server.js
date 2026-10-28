const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomBytes } = require('crypto');
const createAuth = require('./auth');
const { ProxyAgent, setGlobalDispatcher } = require('undici');
const nodemailer = require('nodemailer');
const reportSchedule = require('./report-schedule');
const questionAutoReply = require('./question-auto-reply');
const { escPush, questionPushHtml, questionPushTitle, buildQuestionPayload } = require('./push-format');

// node:sqlite（广告账本用）加载时会打一条 "SQLite is an experimental feature" 警告。
// 功能是好的、稳定的，但这条噪音会让人以为启动报错了 —— 精准挡掉它，其它警告照常放行。
{
  const _emitWarning = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    const s = typeof w === 'string' ? w : ((w && w.message) || '');
    if (/SQLite is an experimental/i.test(s)) return;
    return _emitWarning.call(process, w, ...rest);
  };
}

// ---- 崩溃兜底 ----
// 之前这里没有任何兜底：任何一处未捕获的异常 / 未处理的 Promise 拒绝，
// 都会让 Node 以「退出码 1」整个进程结束；而 start-public.js 又会连带把
// Cloudflare 隧道一起杀掉 —— 结果就是整站变成 Cloudflare 1033（隧道错误）。
// 现在改为「记录堆栈 + 继续存活」，保证单个坏请求不会拖垮整站。
function logCrash(kind, err) {
  const t = new Date().toISOString();
  const msg = (err && (err.stack || err.message)) || String(err);
  console.error('[' + t + '] [' + kind + '] ' + msg);
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));

const app = express();
const PORT = process.env.PORT || 3000;

// 利润页「税费」估算税率：平台没代扣税时（巴西站 order.taxes 恒为 null），
// 按订单收入 × 这个比例估一笔税费计入利润，避免把利润算高了。想调整改这一个数即可。
const DEFAULT_TAX_RATE = 0.08;

// 所有 API 响应禁止浏览器缓存：否则忽略/回复后刷新页面可能拿到旧数据
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// JSON body 解析
// ⚠️ 只挂 express.json() 但不管它的报错时，畸形 JSON 会掉进 Express 默认错误页，
//    返回 400 + 一整段 HTML 堆栈（前端 JSON.parse 直接失败，且对外泄漏文件路径）。
//    下面这个中间件专门接住 body 解析错误，统一按 JSON 回，前端就能拿到可读的 error。
app.use(express.json());
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isParseErr = err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err));
  if (isParseErr) return res.status(400).json({ ok: false, error: '请求体不是合法的 JSON' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: '请求体过大' });
  next(err);
});


const LEGACY_CONFIG_PATH = path.join(__dirname, 'daily-search-config.json');
const AUTH_CONFIG_DIR = path.join(__dirname, 'auth-data', 'configs');
const DEFAULT_CONFIG = {
  keyword:'',productTitles:[],sites:['MLM'],pages:5,email:'',
  proxy:process.env.HTTPS_PROXY||process.env.HTTP_PROXY||'http://127.0.0.1:7897',
  scheduleEnabled:false,scheduleHour:14,scheduleMinute:0,smtpHost:'smtp.qq.com',smtpPort:465,smtpUser:'',smtpPass:'',
  mlAppId:'',mlSecret:'',mlAccessToken:'',mlRefreshToken:'',mlTokenExpireAt:0,mlUserId:'',mlSite:'',mlRedirectUri:'',mlPkce:false,
  mlAdvertiserId:'',mlAdvertiserSite:'',pushToken:'',pushEnabled:false,pushIntervalMin:5,pushClaims:true,dmApiKey:'',dmHotSite:'MLB',dmHotTtlHours:24,
  dmHotKeywords:[{k:'fone de ouvido bluetooth',z:'蓝牙耳机'},{k:'headset gamer',z:'游戏耳机'},{k:'fone de ouvido com fio',z:'有线耳机'},{k:'fone de ouvido jbl',z:'JBL 耳机'},{k:'fone de ouvido cancelamento de ruido',z:'降噪耳机'}]
};
function accountConfigPath(id){const k=String(id||'admin');if(!/^[A-Za-z0-9_-]{1,64}$/.test(k))throw Error('非法账号标识');return path.join(AUTH_CONFIG_DIR,k+'.json');}
function readLegacyConfig(){try{return JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH,'utf8'));}catch{return {};}}
function readAccountConfig(id){try{return {...DEFAULT_CONFIG,...JSON.parse(fs.readFileSync(accountConfigPath(id),'utf8'))};}catch{return id==='admin'?{...DEFAULT_CONFIG,...readLegacyConfig()}:{...DEFAULT_CONFIG};}}
function loadConfig(){const id=auth?auth.currentUserId():'admin';return readAccountConfig(id);}
function saveAccountConfig(id,cfg){fs.mkdirSync(AUTH_CONFIG_DIR,{recursive:true});fs.writeFileSync(accountConfigPath(id),JSON.stringify(cfg,null,2),'utf8');}
function saveConfig(cfg){saveAccountConfig(auth.currentUserId(),cfg);}
function privateDataFile(name){return auth.userDataFile(name);}
function loadReportState(){try{return JSON.parse(fs.readFileSync(privateDataFile('report-state.json'),'utf8'));}catch{return {};}}
function saveReportState(patch){try{const p=privateDataFile('report-state.json'),next=Object.assign(loadReportState(),patch);fs.writeFileSync(p,JSON.stringify(next,null,2),'utf8');return next;}catch(e){console.error('[报告] 写入发送状态失败:',e.message);return loadReportState();}}
const auth=createAuth(express,{publicDir:path.join(__dirname,'public'),readLegacyConfig,readAccountApiStatus:id=>{const c=readAccountConfig(id);return {mercadoLibre:{configured:!!(c.mlAppId&&c.mlSecret),authorized:!!c.mlAccessToken},dmMcp:{configured:!!c.dmApiKey},smtp:{configured:!!(c.smtpUser&&c.smtpPass)},pushPlus:{configured:!!c.pushToken,enabled:!!c.pushEnabled}};},migrateAdminConfig:()=>{const c=readLegacyConfig();delete c.accessPassword;saveAccountConfig('admin',{...DEFAULT_CONFIG,...c});}});
app.use('/api/auth',auth.publicRouter);
app.use(auth.middleware);
app.use('/api/admin',auth.adminRouter);
// 读取代理配置：环境变量优先 → 配置文件 → 关闭
function resolveProxyUrl() {
  const fromEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (fromEnv) return fromEnv;
  const cfg = loadConfig();
  if (cfg.proxy) return cfg.proxy;
  return '';
}
const PROXY_URL = resolveProxyUrl();
if (PROXY_URL) {
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.log(`  代理已启用: ${PROXY_URL}`);
} else {
  console.log('  未配置代理，将直连美客多');
}

// 每页商品数（美客多前台每页48个）
const PER_PAGE = 48;

// 站点配置
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

// 延时
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 标准化文本：去除重音符号，转小写，去除多余空格
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // 去除重音符号
    .replace(/\s+/g, ' ')
    .trim();
}

// 解析单页 HTML
function parsePage(html, siteCode, pageNum) {
  const site = SITES[siteCode];
  const offset = (pageNum - 1) * PER_PAGE;

  // 提取商品链接 + 商品ID
  const items = [...html.matchAll(/href="([^"]+)"[^>]*class="[^"]*poly-component__title/g)].map(m => {
    const url = m[1].replace(/&amp;/g, '&');
    const idMatch = url.match(new RegExp(`\\/(${site.idPrefix}\\d+)`));
    return {
      link: url.split('#')[0],
      productId: idMatch ? idMatch[1] : '',
    };
  });

  // 提取标题
  const titles = [...html.matchAll(/poly-component__title[^>]*>([^<]+)</g)].map(m => m[1].trim());

  // 提取价格
  const prices = [...html.matchAll(/andes-money-amount__fraction[^>]*>([^<]+)</g)].map(m => m[1].trim());

  // 提取卖家
  const sellers = [...html.matchAll(/poly-component__seller[^>]*>([^<]+)</g)].map(m => m[1].trim());

  // 提取商品状态
  const conditions = [...html.matchAll(/poly-component__condition[^>]*>([^<]+)</g)].map(m => m[1].trim());

  // 提取总结果数
  let total = 0;
  const totalMatch = html.match(site.totalRegex);
  if (totalMatch) {
    total = parseInt(totalMatch[1].replace(/[.,]/g, ''));
  }

  // 组合结果
  const results = items.map((item, i) => {
    // 价格清理：去掉千分位逗号/点，保留小数
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

// 带重试的 fetch
async function fetchWithRetry(url, headers, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 429) {
        await sleep(3000 * (attempt + 1));
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(1500 * (attempt + 1));
    }
  }
}

// 搜索接口
app.get('/api/search', async (req, res) => {
  try {
    const keyword = (req.query.keyword || '').trim();
    const siteCode = (req.query.site || 'MLM').toUpperCase();
    const maxPages = Math.min(Math.max(parseInt(req.query.pages) || 5, 1), 42);
    const productFilter = (req.query.productFilter || '').trim().toLowerCase();

    if (!keyword) {
      return res.status(400).json({ error: '请输入搜索关键词' });
    }

    const site = SITES[siteCode];
    if (!site) {
      return res.status(400).json({ error: '无效的站点' });
    }

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

        if (page === 1) {
          totalResults = parsed.total;
        }
        pagesSearched = page;

        if (parsed.results.length === 0) {
          break;
        }

        allResults.push(...parsed.results);

        // 已获取所有结果
        if (totalResults > 0 && allResults.length >= totalResults) {
          break;
        }

        // 请求间隔（较长间隔避免触发验证码）
        if (page < maxPages) {
          await sleep(1500);
        }
      } catch (error) {
        if (allResults.length === 0) {
          return res.status(502).json({
            error: `无法获取美客多搜索结果：${error.message}`
          });
        }
        partialError = error.message;
        break;
      }
    }

    // 产品筛选
    let matchedProducts = null;
    if (productFilter) {
      const filterNorm = normalizeText(productFilter);
      matchedProducts = allResults.filter(r =>
        normalizeText(r.title).includes(filterNorm)
      );
    }

    res.json({
      keyword,
      site: siteCode,
      siteName: site.name,
      currency: site.currency,
      currencySymbol: site.currencySymbol,
      totalResults,
      pagesSearched,
      resultsCount: allResults.length,
      matchedCount: productFilter ? (matchedProducts?.length || 0) : null,
      matchedProducts: productFilter ? matchedProducts : null,
      partialError,
      results: allResults,
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: '搜索失败: ' + error.message });
  }
});

// 连接测试接口
app.get('/api/test', async (req, res) => {
  const siteCode = (req.query.site || 'MLM').toUpperCase();
  const site = SITES[siteCode];
  if (!site) return res.status(400).json({ error: '无效站点' });

  try {
    const url = `${site.searchBase}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': site.acceptLang,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      }
    });
    clearTimeout(timeout);

    if (response.ok) {
      res.json({ success: true, message: `连接成功！${site.name}站点可正常访问` });
    } else {
      res.json({ success: false, message: `HTTP ${response.status}` });
    }
  } catch (error) {
    res.json({ success: false, message: `连接失败: ${error.message}` });
  }
});

// 批量搜索接口 —— 一个关键词搜索多个产品标题
app.get('/api/batch-search', async (req, res) => {
  try {
    const keyword = (req.query.keyword || '').trim();
    const siteCode = (req.query.site || 'MLM').toUpperCase();
    const maxPages = Math.min(Math.max(parseInt(req.query.pages) || 5, 1), 42);
    // 产品标题列表，用 \n 分隔
    const productTitlesRaw = (req.query.titles || '').trim();
    const productTitles = productTitlesRaw
      .split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0);

    if (!keyword) {
      return res.status(400).json({ error: '请输入搜索关键词' });
    }
    if (productTitles.length === 0) {
      return res.status(400).json({ error: '请输入至少一个产品标题' });
    }
    if (productTitles.length > 100) {
      return res.status(400).json({ error: '最多支持 100 个产品标题' });
    }

    const site = SITES[siteCode];
    if (!site) {
      return res.status(400).json({ error: '无效的站点' });
    }

    // --- 第一步：搜索关键词，抓取所有页面 ---
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

        if (page === 1) {
          totalResults = parsed.total;
        }
        pagesSearched = page;

        if (parsed.results.length === 0) break;

        allResults.push(...parsed.results);

        if (totalResults > 0 && allResults.length >= totalResults) break;

        if (page < maxPages) await sleep(1500);
      } catch (error) {
        if (allResults.length === 0) {
          return res.status(502).json({
            error: `无法获取美客多搜索结果：${error.message}`
          });
        }
        break;
      }
    }

    // --- 第二步：对每个产品标题进行匹配 ---
    const batchResults = productTitles.map((title, idx) => {
      const titleNorm = normalizeText(title);
      const matches = allResults.filter(r =>
        normalizeText(r.title).includes(titleNorm)
      );

      if (matches.length === 0) {
        return {
          index: idx + 1,
          searchTitle: title,
          found: false,
          page: null,
          rankInPage: null,
          overallRank: null,
          matchedTitle: '',
          price: 0,
          priceDisplay: '',
          currency: site.currency,
          currencySymbol: site.currencySymbol,
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
        price: best.price,
        priceDisplay: best.priceDisplay,
        currency: site.currency,
        currencySymbol: site.currencySymbol,
        link: best.link,
        seller: best.seller,
        matchCount: matches.length,
      };
    });

    const foundCount = batchResults.filter(r => r.found).length;

    res.json({
      keyword,
      site: siteCode,
      siteName: site.name,
      currency: site.currency,
      currencySymbol: site.currencySymbol,
      totalResults,
      pagesSearched,
      totalItems: allResults.length,
      productCount: productTitles.length,
      foundCount,
      notFoundCount: productTitles.length - foundCount,
      results: batchResults,
    });
  } catch (error) {
    console.error('Batch search error:', error);
    res.status(500).json({ error: '批量搜索失败: ' + error.message });
  }
});

// 站点列表
app.get('/api/sites', (req, res) => {
  res.json(Object.entries(SITES).map(([code, s]) => ({
    code,
    name: s.name,
    currency: s.currency,
    currencySymbol: s.currencySymbol,
  })));
});

// ==================== 配置管理接口 ====================

// 获取当前配置
app.get('/api/config', (req, res) => {
  try {
    const config = loadConfig();
    // 敏感字段一律不下发，只返回「是否已设置」
    const safe = { ...config };
    delete safe.smtpPass;
    delete safe.mlSecret;
    delete safe.mlAccessToken;
    delete safe.mlRefreshToken;
    delete safe.pushToken;
    delete safe.dmApiKey;
    res.json({
      ...safe,
      smtpPassSet: !!config.smtpPass,
      dmApiKeySet: !!config.dmApiKey,
      mlAppId: config.mlAppId || '',
      mlSecretSet: !!config.mlSecret,
      mlTokenSet: !!config.mlAccessToken,
      mlRefreshSet: !!config.mlRefreshToken,
      mlUserId: config.mlUserId || '',
      mlSite: config.mlSite || '',
      mlRedirectUri: config.mlRedirectUri || mlRedirectUri(req),
      mlPkce: !!config.mlPkce,
    });
  } catch (error) {
    res.status(500).json({ error: '读取配置失败: ' + error.message });
  }
});

// 保存配置
app.post('/api/config', (req, res) => {
  try {
    const current = loadConfig();
    const body = req.body;

    const newConfig = {
      ...current,
      keyword: (body.keyword || '').trim(),
      productTitles: Array.isArray(body.productTitles)
        ? body.productTitles.map(t => t.trim()).filter(t => t.length > 0).slice(0, 100)
        : [],
      sites: Array.isArray(body.sites) ? body.sites.filter(s => SITES[s]) : ['MLM'],
      pages: Math.min(Math.max(parseInt(body.pages) || 5, 1), 42),
      email: (body.email || '').trim(),
      scheduleEnabled: !!body.scheduleEnabled,
      scheduleHour: Math.min(Math.max(parseInt(body.scheduleHour) || 14, 0), 23),
      scheduleMinute: Math.min(Math.max(parseInt(body.scheduleMinute) || 0, 0), 59),
      smtpHost: (body.smtpHost || 'smtp.qq.com').trim(),
      smtpPort: parseInt(body.smtpPort) || 465,
      smtpUser: (body.smtpUser || '').trim(),
      smtpPass: body.smtpPass ? body.smtpPass.trim() : current.smtpPass, // 不传则保留旧密码
    };

    saveConfig(newConfig);
    console.log('[配置] 已保存新配置:', { keyword: newConfig.keyword, titles: newConfig.productTitles.length, email: newConfig.email, schedule: newConfig.scheduleEnabled ? `${newConfig.scheduleHour}:${String(newConfig.scheduleMinute).padStart(2,'0')}` : 'disabled' });

    res.json({ success: true, message: '配置已保存' });
  } catch (error) {
    console.error('[配置] 保存失败:', error);
    res.status(500).json({ error: '保存配置失败: ' + error.message });
  }
});

// ==================== 美客多官方 API（实时订单 / 问答 / 售后） ====================
const ML_API_BASE = 'https://api.mercadolibre.com';

// 三站点时区 / 偏移 / 币种（这三国的站点目前均不实行夏令时，静态偏移即可）
const ML_SITES = {
  MLM: { code: 'MLM', name: '墨西哥', tz: 'America/Mexico_City', offset: '-06:00', currency: 'MXN', domain: 'mercadolibre.com.mx', authBase: 'https://auth.mercadolibre.com.mx/authorization' },
  MLB: { code: 'MLB', name: '巴西', tz: 'America/Sao_Paulo', offset: '-03:00', currency: 'BRL', domain: 'mercadolivre.com.br', authBase: 'https://auth.mercadolivre.com.br/authorization' },
  MLA: { code: 'MLA', name: '阿根廷', tz: 'America/Argentina/Buenos_Aires', offset: '-03:00', currency: 'ARS', domain: 'mercadolibre.com.ar', authBase: 'https://auth.mercadolibre.com.ar/authorization' },
  MLC: { code: 'MLC', name: '智利', tz: 'America/Santiago', offset: '-04:00', currency: 'CLP', domain: 'mercadolibre.cl', authBase: 'https://auth.mercadolibre.cl/authorization' },
  MCO: { code: 'MCO', name: '哥伦比亚', tz: 'America/Bogota', offset: '-05:00', currency: 'COP', domain: 'mercadolibre.com.co', authBase: 'https://auth.mercadolibre.com.co/authorization' },
  MPE: { code: 'MPE', name: '秘鲁', tz: 'America/Lima', offset: '-05:00', currency: 'PEN', domain: 'mercadolibre.com.pe', authBase: 'https://auth.mercadolibre.com.pe/authorization' },
  // 跨境（CBT / Global Selling）：应用建在 global-selling 那套后台时用这个入口
  CBT: { code: 'CBT', name: '跨境(CBT)', tz: 'America/Mexico_City', offset: '-06:00', currency: 'MXN', domain: 'global-selling.mercadolibre.com', authBase: 'https://global-selling.mercadolibre.com/authorization' },
};
function mlSite(site) {
  return ML_SITES[String(site || '').toUpperCase()] || ML_SITES.MLB;
}

// 订单状态中文映射
const ML_ORDER_STATUS = {
  confirmed: '已确认', payment_required: '待付款', payment_in_process: '付款处理中',
  partially_paid: '部分付款', paid: '已付款', partially_refunded: '部分退款',
  pending_cancel: '待取消', cancelled: '已取消', invalid: '无效',
};

// 「已配置」= 拿到了 App ID + Secret Key（够发起 OAuth 授权、也能刷新令牌）
// 是否已完成账号授权（有 access_token）是另一个状态，用 mlAuthorized 区分
function mlConfigured(cfg = loadConfig()) {
  return !!(cfg.mlAppId && cfg.mlSecret);
}
function mlAuthorized(cfg = loadConfig()) {
  return !!cfg.mlAccessToken;
}

const mlUserCache = new Map();

// 用 refresh_token 换新的 access_token
async function refreshMlToken() {
  const cfg = loadConfig();
  if (!cfg.mlAppId || !cfg.mlSecret || !cfg.mlRefreshToken) {
    const e = new Error('缺少 App ID / Secret Key / Refresh Token，无法自动刷新令牌');
    e.status = 401; e.needConfig = true; throw e;
  }
  const r = await fetch(`${ML_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.mlAppId,
      client_secret: cfg.mlSecret,
      refresh_token: cfg.mlRefreshToken,
    }),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || !d.access_token) {
    const e = new Error('刷新令牌失败：' + ((d && (d.message || d.error)) || ('HTTP ' + r.status)));
    e.status = r.status || 401; throw e;
  }
  saveConfig({
    ...cfg,
    mlAccessToken: d.access_token,
    mlRefreshToken: d.refresh_token || cfg.mlRefreshToken,
    mlTokenExpireAt: Date.now() + (Number(d.expires_in) || 21600) * 1000,
    mlUserId: d.user_id ? String(d.user_id) : cfg.mlUserId,
  });
  mlUserCache.delete(auth.currentUserId());
  console.log('[ML API] Access Token 已自动刷新，有效期 ' + (d.expires_in || 21600) + ' 秒');
  return d.access_token;
}

// 取一个可用 token（快过期则先刷新）
async function mlToken() {
  const cfg = loadConfig();
  if (!cfg.mlAccessToken) {
    const e = new Error(cfg.mlAppId && cfg.mlSecret ? '凭证已保存，但还没完成美客多账号授权' : '尚未配置美客多 API 凭证');
    e.status = 401;
    if (cfg.mlAppId && cfg.mlSecret) e.needAuth = true; else e.needConfig = true;
    throw e;
  }
  if (cfg.mlTokenExpireAt && Date.now() > cfg.mlTokenExpireAt - 120000 && cfg.mlRefreshToken) {
    return await refreshMlToken();
  }
  return cfg.mlAccessToken;
}

// 统一请求：自动带 token，401 时刷新一次并重试
async function mlRequest(pathname, options = {}, retry = true) {
  const token = await mlToken();
  const headers = { Accept: 'application/json', ...(options.headers || {}), Authorization: `Bearer ${token}` };
  // 硬超时：美客多接口偶尔会「连接建上了但一直不返回」，没有超时的话整条请求链会永远等下去，
  // 前端表现就是一直转圈 —— 比报错难查得多。超时按 504 抛出，上层照常降级。
  const ML_TIMEOUT_MS = Number(process.env.ML_TIMEOUT_MS) || 30000;
  const signal = options.signal || AbortSignal.timeout(ML_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(ML_API_BASE + pathname, { ...options, headers, signal });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      const err = new Error('美客多接口超时（' + Math.round(ML_TIMEOUT_MS / 1000) + ' 秒无响应）：' + String(pathname).split('?')[0]);
      err.status = 504; throw err;
    }
    throw e;
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (r.status === 401 && retry) {
    await refreshMlToken();
    return mlRequest(pathname, options, false);
  }
  if (!r.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${r.status}`;
    const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    e.status = r.status; e.data = data; throw e;
  }
  return data;
}

// 依次尝试多个候选路径，返回第一个成功的（应对同一能力存在新旧两版接口）
async function mlRequestFirst(paths) {
  let lastErr = null;
  for (const p of paths) {
    try { return await mlRequest(p); } catch (e) {
      lastErr = e;
      if (e.status === 401) throw e;
      if (e.status === 404 || e.status === 400) continue;
      throw e;
    }
  }
  throw lastErr || new Error('请求失败');
}

// 当前授权卖家信息（缓存 1 小时）
async function mlUser() {
  const accountId=auth.currentUserId(), cached=mlUserCache.get(accountId);
  if (cached && Date.now() - cached.at < 3600000) return cached;
  const u = await mlRequest('/users/me');
  const cfg = loadConfig();
  const user = {
    id: String(u.id), nickname: u.nickname || '', site_id: (u.site_id || '').toUpperCase(),
    email: u.email || '', country: u.country_id || '', at: Date.now(),
  };
  mlUserCache.set(accountId,user);
  saveConfig({ ...cfg, mlUserId: user.id, mlSite: (cfg.mlSite && cfg.mlSite !== 'CBT') ? cfg.mlSite : user.site_id });
  return user;
}

// CBT 不是真实站点（它可能同时卖 MX/BR/AR），取真实站点时要把 CBT 忽略掉
function mlEffectiveSite(v) { const s = String(v || '').toUpperCase(); return (s && s !== 'CBT') ? s : ''; }

// 批量取商品标题（用于订单/问答展示）
async function mlItemTitles(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean).map(String))].slice(0, 20);
  if (!uniq.length) return {};
  try {
    const d = await mlRequest(`/items?ids=${uniq.join(',')}&attributes=id,title,permalink`);
    const map = {};
    for (const row of (Array.isArray(d) ? d : [])) {
      if (row && row.body && row.body.id) map[String(row.body.id)] = { title: row.body.title || '', permalink: row.body.permalink || '' };
    }
    return map;
  } catch { return {}; }
}

// 批量取商品信息（标题 + 主图 + 链接），用于 Listing 出单统计
async function mlItemInfo(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!uniq.length) return {};
  const map = {};
  for (let i = 0; i < uniq.length; i += 20) {
    const batch = uniq.slice(i, i + 20);
    try {
      const d = await mlRequest(`/items?ids=${batch.join(',')}&attributes=id,title,thumbnail,permalink`);
      for (const row of (Array.isArray(d) ? d : [])) {
        const b = row && row.body;
        if (b && b.id) map[String(b.id)] = { title: b.title || '', thumbnail: b.thumbnail || '', permalink: b.permalink || '' };
      }
    } catch { /* 单批失败不影响其它批次 */ }
  }
  return map;
}

function normalizeOrder(o) {
  const buyer = o.buyer || {};
  const items = (o.order_items || []).map(it => ({
    title: (it.item && it.item.title) || '',
    id: (it.item && it.item.id) || '',
    qty: it.quantity || 1,
    unit: Number(it.unit_price) || 0,
    variation: ((it.item && it.item.variation_attributes) || []).map(v => v.value_name).filter(Boolean).join(' / '),
  }));
  return {
    id: o.id, status: o.status || '', detail: o.status_detail || '',
    date: o.date_created || '', amount: Number(o.total_amount) || 0, paid: Number(o.paid_amount) || 0,
    currency: o.currency_id || '', buyer: buyer.nickname || '', buyerId: buyer.id || '',
    tags: o.tags || [], itemCount: items.reduce((s, i) => s + i.qty, 0), items,
    shippingId: (o.shipping && o.shipping.id) || '', packId: o.pack_id || '',
    delivery: ((o.tags || []).includes('delivered') ? 'delivered' : ((o.tags || []).includes('not_delivered') ? 'pending' : '')),
  };
}

/* ============ 发货方式分类：官方发货不用管，自发货/要打面单的才提示 ============ */
// 分类结果持久缓存（发货方式不会变，缓存一次终身受用）
const shipCaches = new Map();
function loadShipCache() {
  const id=auth.currentUserId(); if(shipCaches.has(id))return shipCaches.get(id);
  try { const d=JSON.parse(fs.readFileSync(privateDataFile('ship-cache.json'),'utf8'));shipCaches.set(id,(d&&typeof d==='object'&&!Array.isArray(d))?d:{}); }
  catch { shipCaches.set(id,{}); } return shipCaches.get(id);
}
function saveShipCache() {
  try { fs.writeFileSync(privateDataFile('ship-cache.json'), JSON.stringify(loadShipCache(), null, 2), 'utf8'); } catch { }
}
// 发货方式中文标签
function shipLabel(mode, logistic) {
  if (mode === 'me1') return '自发货';
  if (mode === 'me2' && logistic === 'fulfillment') return '官方发货';
  if (mode === 'me2' && logistic === 'self_service') return '自发货(Flex)';
  if (mode === 'me2') return '官方面单';
  return '自发货';
}
// 是否需要卖家动手发货（官方仓代发和已发货/已取消的不需要）
function shipNeedAction(mode, logistic, status) {
  if (['shipped', 'delivered', 'not_delivered', 'cancelled'].includes(String(status))) return false;
  if (mode === 'me2' && logistic === 'fulfillment') return false; // FULL 仓库代发，卖家无需操作
  return true;
}
// 查单个发货单并分类（带持久缓存）
async function mlShipClassify(sid) {
  const key = String(sid || '');
  if (!key) return null;
  const cache = loadShipCache();
  if (cache[key]) return cache[key];
  try {
    const s = await mlRequest('/shipments/' + encodeURIComponent(key));
    const mode = s.mode || '', logistic = s.logistic_type || '', status = s.status || '';
    const rec = {
      mode, logistic, status,
      substatus: s.substatus || '',
      label: shipLabel(mode, logistic),
      needShip: shipNeedAction(mode, logistic, status),
      at: Date.now(),
    };
    cache[key] = rec;
    return rec;
  } catch { return null; }
}
// 并发限制地批量分类（避免一次打太多请求）
async function classifyShips(ids, concurrency = 10) {
  const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
  const out = {};
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, uniq.length) }, async () => {
    while (i < uniq.length) {
      const id = uniq[i++];
      out[id] = await mlShipClassify(id);
    }
  });
  await Promise.all(workers);
  saveShipCache();
  return { map: out };
}

function normalizeQuestion(q, titles = {}) {
  const t = titles[String(q.item_id)] || {};
  return {
    id: q.id, text: q.text || '', status: q.status || '', date: q.date_created || '',
    itemId: q.item_id || '', itemTitle: t.title || '', permalink: t.permalink || '',
    fromId: (q.from && q.from.id) || q.from_id || '',
    answer: q.answer ? { text: q.answer.text || '', date: q.answer.date_created || '' } : null,
  };
}

// ---- 纠纷原因文案缓存（reason_id → 名称 + 人话说明） ----
const claimReasonCache = new Map();
async function mlClaimReasons(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
  const out = {};
  await Promise.all(uniq.map(async (rid) => {
    const cacheKey=auth.currentUserId()+':'+rid;
    if (claimReasonCache.has(cacheKey)) { out[rid] = claimReasonCache.get(cacheKey); return; }
    try {
      const d = await mlRequest(`/post-purchase/v1/claims/reasons/${encodeURIComponent(rid)}`);
      const r = { name: d.name || '', detail: d.detail || '', expected: ((d.settings || {}).expected_resolutions) || [] };
      claimReasonCache.set(cacheKey, r); out[rid] = r;
    } catch { /* 拿不到原因不影响主流程 */ }
  }));
  return out;
}

// 纠纷类型中文映射
const ML_CLAIM_TYPE = {
  returns: '退货', mediations: '平台调解', cancellation: '取消订单', 'fulfillment': '物流问题',
  'ml_case': '平台介入', 'service': '服务纠纷', 'payment': '支付问题', 'shipping': '物流纠纷',
};
function claimTypeText(t) { return ML_CLAIM_TYPE[String(t || '').toLowerCase()] || t || '-'; }

function normalizeClaim(c, reasonMap = {}) {
  const res = c.resolution || {};
  const players = c.players || [];
  const seller = players.find(p => p.type === 'seller') || {};
  const buyer = players.find(p => p.type === 'buyer') || {};
  const actions = (seller.available_actions || []).map(a => (a && a.action) || a).filter(Boolean);
  const reasonId = c.reason_id || '';
  const r = reasonMap[reasonId] || {};
  const type = String(c.type || '').toLowerCase();
  const stage = String(c.stage || '').toLowerCase();
  // 是否属于「平台调解」：type=mediations 或已进入 dispute 阶段
  const isMediation = type === 'mediations' || stage === 'dispute' || stage === 'mediations';
  const buyerUser = String(buyer.user_id || '');
  const sellerUser = String(seller.user_id || '');
  return {
    id: String(c.id || c.claim_id || ''),
    status: c.status || '', stage: c.stage || '',
    type: c.type || '', typeText: claimTypeText(c.type),
    isMediation,
    resource: c.resource || '', resourceId: String(c.resource_id || ''),
    // 买家自行处理的退货/退款：related_entities 含 return，且处于 claim 阶段（尚未升级调解）
    fulfilled: c.fulfilled === true,
    relatedEntities: c.related_entities || [],
    reasonId,
    reasonName: r.name || '',
    reason: r.detail || (c.reason && (c.reason.detail || c.reason.title)) || reasonId || '-',
    expected: r.expected || [],
    date: c.date_created || c.last_updated || '',
    lastUpdated: c.last_updated || '',
    amount: Number(res.applied_amount || res.amount || c.amount || 0) || 0,
    currency: res.currency_id || c.currency_id || '',
    quantity: c.claimed_quantity || 0,
    quantityType: c.quantity_type || '',
    buyerId: buyerUser,
    sellerId: sellerUser,
    actions,
    // 美客多下发的「可发送消息」动作 —— 这是能否发消息的权威判据
    canSendNow: actions.includes('send_message_to_complainant') || actions.includes('send_message_to_mediator'),
    // 调解阶段美客多不一定下发 available_actions，UI 仍给出回复框（真正能否发送由美客多在提交时判定）
    canReply: isMediation || actions.includes('send_message_to_complainant') || actions.includes('send_message_to_mediator'),
    replyTarget: isMediation ? 'mediator' : 'buyer',
    // send-message 必填的 receiver_role：优先按美客多下发的动作判定，无动作时按阶段兜底
    // （claim 阶段 → complainant 买家；dispute/mediations 阶段 → mediator 调解员）
    replyRole: actions.includes('send_message_to_mediator') ? 'mediator'
      : actions.includes('send_message_to_complainant') ? 'complainant'
      : (isMediation ? 'mediator' : 'complainant'),
    canRefund: actions.includes('refund') || actions.includes('allow_partial_refund'),
    canDispute: actions.includes('open_dispute'),
    players,
  };
}

/* ============ 售后分类：把「平台调解 / 买家主动咨询 / 买家自行处理」分开 ============ */
// 无需我操作的买家自行退货原因（反悔/无理由/买家主动取消）
const CLAIM_AUTO_REASON_RE = /repentant|arrepend|change_of_mind|buyer_cancel|regret|withdraw/i;
// 分类常量
const CLAIM_CAT = {
  mediation: { key: 'mediation', label: '平台调解', desc: '平台调解员在等你回复', need: true },
  buyer: { key: 'buyer', label: '买家咨询', desc: '买家主动联系，等你回复', need: true },
  auto: { key: 'auto', label: '无需操作', desc: '买家已自行处理，无需你操作', need: false },
};
/**
 * 判定一条纠纷归到哪一类（在已拿到消息线程后调用）
 * @param {object} nc normalizeClaim 的结果
 * @param {object} thread { buyerMessages, sellerMessages, mediatorMessages, total, lastSender, lastReceiver }
 */
function classifyClaim(nc, thread = {}) {
  const type = String(nc.type || '').toLowerCase();
  const stage = String(nc.stage || '').toLowerCase();
  // 1) 平台调解 —— 需要我方回复调解员
  if (type === 'mediations' || stage === 'dispute' || stage === 'mediations') return 'mediation';
  // awaitingSeller 由线程计算；示例数据只给 lastSender 时按发送方兜底
  const awaiting = thread.awaitingSeller != null
    ? !!thread.awaitingSeller
    : /complainant|buyer|mediator/i.test(String(thread.lastSender || ''));
  // 2) 对方（买家/调解员）最后发言 —— 球在我方，才可能是「等你回复」
  if (awaiting && ((thread.buyerMessages || 0) + (thread.mediatorMessages || 0)) > 0) return 'buyer';
  // 3) 买家自行处理（反悔退货 / 无理由退货），且买家没有留言 —— 无需操作
  if (CLAIM_AUTO_REASON_RE.test(nc.reasonName || '')) return 'auto';
  // 4) 兜底：仅仅「还能回复/退款/发起调解」不再算待处理。
  //    美客多几乎所有开启中的纠纷都带这些动作，按动作判定会把买家反悔退货等
  //    平台自动流转的纠纷全算成「等你处理」，导致长期空提醒。必须先有对方留言。
  return 'auto';
}

// 球是否真的在我方：平台调解只要不是我方最后发言就提醒；买家类必须「对方最后发言 + 当前可回复」
function claimAwaitingUs(cat, nc, t = {}) {
  // 线程未给出 awaitingSeller（如示例数据）时，按最后发送方兜底
  const awaiting = t.awaitingSeller != null
    ? !!t.awaitingSeller
    : /complainant|buyer|mediator/i.test(String(t.lastSender || ''));
  if (cat === 'mediation') return String(t.lastSender || '') !== 'respondent';
  return awaiting && !!nc.canSendNow;
}

// 拉取单条纠纷的消息线程（带短缓存），用于分类与判断谁在等回复
const claimThreadCache = new Map(); // id -> { at, data }
async function mlClaimThread(id) {
  const key = String(id);
  const scopedKey=auth.currentUserId()+':'+key;
  const hit = claimThreadCache.get(scopedKey);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  let list = [];
  let fetchError = false;
  try {
    const m = await mlRequest(`/post-purchase/v1/claims/${encodeURIComponent(key)}/messages`);
    const arr = Array.isArray(m) ? m : ((m && (m.messages || m.data)) || []);
    list = arr.map(x => ({
      sender: x.sender_role || (x.from && x.from.role) || '',
      receiver: x.receiver_role || (x.to && x.to.role) || '',
      text: x.message || x.text || '',
      date: x.date_created || x.message_date || '',
      stage: x.stage || '',
      attachments: (x.attachments || []).map(a => a.original_filename || a.filename).filter(Boolean),
    }));
  } catch { fetchError = true; /* 拉取失败要标记：不能当成「没有新消息」，否则会误判成新动向反复推送 */ }
  // 按时间正序（接口多为倒序返回）
  list.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  const buyer = list.filter(m => /complainant|buyer/i.test(m.sender)).length;
  const seller = list.filter(m => /respondent|seller/i.test(m.sender)).length;
  const mediator = list.filter(m => /mediator|internal/i.test(m.sender)).length;
  const last = list[list.length - 1] || null;
  const data = {
    messages: list, total: list.length,
    buyerMessages: buyer, sellerMessages: seller, mediatorMessages: mediator,
    lastSender: last ? last.sender : '',
    lastReceiver: last ? last.receiver : '',
    // 最后一条是对方（买家/调解员）发的 → 大概率在等我方回复
    awaitingSeller: !!last && /complainant|buyer|mediator/i.test(last.sender),
    // 消息线程拉取失败：分类与推送都要跳过，避免把「没拉到」当成状态变化
    fetchError,
  };
  claimThreadCache.set(scopedKey, { at: Date.now(), data });
  return data;
}

// 退货/投诉查询接口的多版本候选路径
function mlClaimPaths(uid, { status, limit = 20, offset = 0 } = {}) {
  const base = `limit=${limit}&offset=${offset}`;
  const st = status ? `status=${encodeURIComponent(status)}&` : '';
  return [
    `/post-purchase/v1/claims/search?${st}${base}&seller_id=${uid}`,
    `/post-purchase/v1/claims/search?${st}${base}`,
    `/v1/claims/search?${st}${base}&seller_id=${uid}`,
  ];
}

/**
 * 取「最新」的 opened 纠纷（与售后页同一口径）。
 * 美客多 claims/search 默认按时间升序翻页（offset 0 = 最旧），
 * 此前角标/推送直接用 offset 0，导致与售后页（反向分页，offset 0 = 最新）对不上：
 * 开启纠纷较多时，角标数的可能是页面上翻不到的老纠纷。
 */
async function mlOpenClaimsNewest(limit = 50) {
  const u = await mlUser();
  const meta = await mlRequestFirst(mlClaimPaths(u.id, { status: 'opened', limit: 1, offset: 0 }));
  const total = (meta && meta.paging && meta.paging.total) || 0;
  if (!total) return { total: 0, list: [] };
  const n = Math.min(limit, total);
  const d = await mlRequestFirst(mlClaimPaths(u.id, { status: 'opened', limit: n, offset: Math.max(0, total - n) }));
  const list = ((d && (d.data || d.results || d.claims)) || []).slice()
    .sort((a, b) => String(b.date_created || '').localeCompare(String(a.date_created || '')));
  return { total, list };
}

function sendMlError(res, e) {
  if (e && e.needConfig) return res.json({ ok: false, configured: false, needConfig: true, error: e.message });
  if (e && e.needAuth) return res.json({ ok: false, configured: true, authorized: false, needAuth: true, error: e.message });
  const code = (e && e.status >= 400 && e.status < 500) ? e.status : 500;
  res.status(code).json({ ok: false, error: (e && e.message) || '请求失败', status: (e && e.status) || 0 });
}

// ---- 授权状态 ----
app.get('/api/ml/status', async (req, res) => {
  const cfg = loadConfig();
  if (!mlConfigured(cfg)) return res.json({ configured: false, authorized: false, ok: false, message: '尚未配置美客多 API 凭证' });
  if (!mlAuthorized(cfg)) return res.json({ configured: true, authorized: false, ok: false, needAuth: true, message: '凭证已保存，但还没完成美客多账号授权' });
  try {
    const u = await mlUser();
    const site = mlSite(mlEffectiveSite(cfg.mlSite) || u.site_id);
    res.json({
      configured: true, authorized: true, ok: true, user: u,
      site: { code: site.code, name: site.name, currency: site.currency, domain: site.domain },
      tokenExpireAt: cfg.mlTokenExpireAt || 0,
    });
  } catch (e) {
    res.json({ configured: true, authorized: mlAuthorized(cfg), ok: false, needConfig: !!e.needConfig, needAuth: !!e.needAuth, message: e.message, status: e.status || 0 });
  }
});

// ---- 订单汇总（概览实时看板） ----
app.get('/api/ml/orders/summary', async (req, res) => {
  const cfg = loadConfig();
  if (!mlConfigured(cfg)) return res.json({ configured: false, authorized: false, ok: false, needConfig: true, message: '尚未配置美客多 API 凭证' });
  if (!mlAuthorized(cfg)) return res.json({ configured: true, authorized: false, ok: false, needAuth: true, message: '凭证已保存，但还没完成美客多账号授权' });
  try {
    const u = await mlUser();
    const siteCode = String(req.query.site || mlEffectiveSite(cfg.mlSite) || u.site_id || 'MLB').toUpperCase();
    const site = mlSite(siteCode);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: site.tz }).format(new Date());
    const from = `${day}T00:00:00.000${site.offset}`;
    const to = `${day}T23:59:59.999${site.offset}`;
    const uid = u.id;

    const safe = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };

    const todayRes = await safe(() => mlRequest(
      `/orders/search?seller=${uid}&order.date_created.from=${encodeURIComponent(from)}&order.date_created.to=${encodeURIComponent(to)}&sort=date_desc&limit=50`
    ));
    const today = todayRes && todayRes.paging ? todayRes.paging.total : ((todayRes && todayRes.results) ? todayRes.results.length : null);
    const todayAmount = ((todayRes && todayRes.results) || []).reduce((s, o) => s + (Number(o.total_amount) || 0), 0);
    const currency = (((todayRes && todayRes.results) || []).find(o => o.currency_id) || {}).currency_id || site.currency;

    const countOf = async (qs) => {
      const d = await safe(() => mlRequest(`/orders/search?seller=${uid}&${qs}&limit=1`));
      if (!d) return null;
      return d.paging ? d.paging.total : ((d.results || []).length);
    };

    const [pending, shipped, cancelled] = await Promise.all([
      countOf('order.status=paid&tags=not_delivered'),
      countOf('tags=delivered'),
      countOf('order.status=cancelled'),
    ]);
    const [questionUnanswered, claimOpen] = await Promise.all([
      safe(async () => (await mlRequest(`/questions/search?seller_id=${uid}&status=UNANSWERED&limit=1`)).total, null),
      safe(async () => { const d = await mlRequestFirst(mlClaimPaths(uid, { status: 'opened', limit: 1 })); return d && d.paging ? d.paging.total : null; }, null),
    ]);
    // 需要我处理的售后数（平台调解 + 买家主动咨询；已忽略的不算；球不在我方的不算）
    const claimTodo = await safe(async () => {
      const { list } = await mlOpenClaimsNewest(50);
      const reasons = await mlClaimReasons(list.map(c => c.reason_id));
      const norm = list.map(c => normalizeClaim(c, reasons));
      const th = await Promise.all(norm.map(nc => mlClaimThread(nc.id)));
      return norm.filter((nc, i) => {
        if (isIgnored(nc.id)) return false;
        if (th[i] && th[i].fetchError) return false; // 线程没拉到 → 不误报成待处理
        const cat = classifyClaim(nc, th[i]);
        if (!(CLAIM_CAT[cat] || CLAIM_CAT.auto).need) return false;
        return claimAwaitingUs(cat, nc, th[i]);
      }).length;
    }, null);
    // 需要我动手发货的订单数（自发货/打面单；官方代发不算）
    const pendingTodo = await safe(async () => {
      const CAP = 300;
      const all = [];
      for (let off = 0; off < CAP; off += 50) {
        const d = await mlRequest(`/orders/search?seller=${uid}&sort=date_desc&limit=50&offset=${off}&order.status=paid&tags=not_delivered`);
        all.push(...((d && d.results) || []));
        const total = (d && d.paging && d.paging.total) || 0;
        if (!all.length || all.length >= total || all.length >= CAP) break;
      }
      const norm = all.map(normalizeOrder);
      const cls = (await classifyShips(norm.map(o => o.shippingId))).map;
      return norm.filter(o => { const s = cls[o.shippingId]; return s ? s.needShip : true; }).length;
    }, null);

    res.json({
      configured: true, ok: true, site: siteCode, day, today, todayAmount, currency,
      pending, pendingTodo, shipped, cancelled, questionUnanswered, claimOpen, claimTodo, updatedAt: Date.now(),
    });
  } catch (e) { sendMlError(res, e); }
});

// ---- 销售金额看板（实时流水，按巴西时区） ----
// 巴西自 2019 年起不再实行夏令时，全年 UTC-3，静态偏移即可
const SALES_TZ = { tz: 'America/Sao_Paulo', offset: '-03:00', label: '巴西时间 GMT-3' };

// 把任意 ISO 时间换算成指定时区的 年-月-日 / 时 / 分
function tzParts(iso, tz) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const o = {};
    for (const p of f.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value;
    return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), minute: Number(o.minute) };
  } catch { return null; }
}
// 指定时区的「今天」（YYYY-MM-DD）
function tzToday(tz = SALES_TZ.tz, ts = Date.now()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ts)); }
  catch { return new Date(ts).toISOString().slice(0, 10); }
}
function isDateStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

// 20 秒内存缓存：自动刷新时避免频繁打美客多接口
const salesCache = { key: '', at: 0, data: null };

app.get('/api/ml/sales', async (req, res) => {
  const cfg = loadConfig();
  if (!mlConfigured(cfg)) return res.json({ configured: false, authorized: false, ok: false, needConfig: true, message: '尚未配置美客多 API 凭证' });
  if (!mlAuthorized(cfg)) return res.json({ configured: true, authorized: false, ok: false, needAuth: true, message: '凭证已保存，但还没完成美客多账号授权' });
  try {
    const u = await mlUser();
    const today = tzToday();
    let to = isDateStr(req.query.to) ? String(req.query.to) : today;
    let from = isDateStr(req.query.from) ? String(req.query.from) : to;
    if (from > to) { const t = from; from = to; to = t; }
    if (rejectTooWideRange(res, from, to, MAX_ORDER_SPAN_DAYS, '销售日期')) return;
    const siteCode = String(mlEffectiveSite(cfg.mlSite) || u.site_id || 'MLB').toUpperCase();
    const site = mlSite(siteCode);
    const uid = u.id;

    const key = auth.currentUserId() + '|' + uid + '|' + from + '|' + to;
    if (salesCache.key === key && Date.now() - salesCache.at < 20000) {
      return res.json({ ...salesCache.data, cached: true });
    }

    // 全量抓取：复用利润页的 fetchAllOrders（按 paging.total 拉满 + 大区间按天切片 + order.id 去重）。
    // 踩过的坑：这里原来写死 CAP=500，10 月 939 单时只统计到最近 500 单，
    // 概览的销售额/订单数与实际订单对不上（「仅统计最近 500 单」的横幅就是这儿来的）。
    const qFrom = `${from}T00:00:00.000${SALES_TZ.offset}`;
    const qTo = `${to}T23:59:59.999${SALES_TZ.offset}`;
    const fetched = await fetchAllOrders(uid, from, to);
    const raw = fetched.orders;
    const apiTotal = Number(fetched.apiTotal) || raw.length;

    const rows = raw.map(o => {
      const p = tzParts(o.date_created, SALES_TZ.tz) || {};
      const items = o.order_items || [];
      const qty = items.reduce((s, it) => s + (Number(it.quantity) || 1), 0);
      const first = items[0] || {};
      return {
        orderId: String(o.id || ''),
        time: o.date_created || '',
        date: p.date || '',
        hour: (p.hour == null ? null : p.hour),
        hhmm: (p.hour == null ? '' : String(p.hour).padStart(2, '0') + ':' + String(p.minute || 0).padStart(2, '0')),
        buyer: (o.buyer && o.buyer.nickname) || '',
        status: o.status || '',
        qty: qty || 1,
        title: (first.item && first.item.title) || '',
        amount: Number(o.total_amount) || 0,
        currency: o.currency_id || site.currency,
      };
    });

    const voided = r => r.status === 'cancelled' || r.status === 'invalid';
    const valid = rows.filter(r => !voided(r));
    const amount = valid.reduce((s, r) => s + r.amount, 0);
    const itemsTotal = valid.reduce((s, r) => s + r.qty, 0);
    const currency = (rows.find(r => r.currency) || {}).currency || site.currency;

    const data = {
      ok: true, site: siteCode, siteName: site.name,
      tz: SALES_TZ.tz, tzLabel: SALES_TZ.label, offset: SALES_TZ.offset,
      range: { from, to }, truncated: apiTotal > rows.length + 20, apiTotal,
      currency,
      totals: {
        orders: valid.length,
        cancelled: rows.length - valid.length,
        amount: Math.round(amount * 100) / 100,
        items: itemsTotal,
        avg: valid.length ? Math.round((amount / valid.length) * 100) / 100 : 0,
      },
      rows,
      updatedAt: Date.now(),
    };
    salesCache.key = key; salesCache.at = Date.now(); salesCache.data = data;
    res.json(data);
  } catch (e) { sendMlError(res, e); }
});

// ---- Listing 出单统计（按商品聚合出单数量与金额） ----
const listingsCache = { key: '', at: 0, data: null };

// ---- 产品利润：成本按账户私有保存，始终只读取当前登录卖家的 Listing ----
const profitCache = new Map();
const profitOrderCache = new Map();
const shipmentCostCache = new Map();
const warehouseStockCache = new Map();

// ---- 运费成本持久缓存 ----
// 一单的运费在发货之后就不再变了，但原来只放在内存 Map（1 小时 TTL）：
// 服务重启、或者换一个日期范围，就得把几百个 shipment 重新拉一遍 —— 实测 408 个要 59 秒。
// 现在落进 SQLite，30 天内直接命中；再打开同一段时间几乎是瞬时的。
const SHIP_COST_KEEP_DAYS = 30;
let _shipCostReady = false;
function shipCostDb() {
  const db = adsDb();
  if (!db) return null;
  if (!_shipCostReady) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ship_cost (
        shipment_id TEXT PRIMARY KEY,
        amount      REAL,
        currency    TEXT,
        at          INTEGER
      )`);
      _shipCostReady = true;
    } catch (e) { return null; }
  }
  return db;
}
function shipCostGet(id) {
  const db = shipCostDb(); if (!db) return null;
  try {
    const row = db.prepare('SELECT amount, currency, at FROM ship_cost WHERE shipment_id = ?').get(String(id));
    if (!row) return null;
    if (Date.now() - Number(row.at || 0) > SHIP_COST_KEEP_DAYS * 86400000) return null;
    return { amount: Number(row.amount) || 0, currency: String(row.currency || '') };
  } catch (e) { return null; }
}
function shipCostSet(id, data) {
  const db = shipCostDb(); if (!db) return;
  try {
    db.prepare('INSERT OR REPLACE INTO ship_cost (shipment_id, amount, currency, at) VALUES (?,?,?,?)')
      .run(String(id), Number(data.amount) || 0, String(data.currency || ''), Date.now());
  } catch (e) { }
}
// /marketplace/shipments/{id}/costs 这个新接口对部分卖家直接 403；记下时间，
// 一小时内不再白试，每个 shipment 省掉一次往返（几百个就是几百次）。
let _mpCostsDeadAt = 0;

// 中行网页牌价单位为每 100 单位外币对应人民币；订单与 Listing 共用公开汇率缓存。
const bocFxCache = { at: 0, rates: {} };
const BOC_CURRENCY_NAMES = { BRL:'巴西雷亚尔', MXN:'墨西哥比索', ARS:'阿根廷比索', CLP:'智利比索', COP:'哥伦比亚比索', USD:'美元' };
async function getBocFxRates(currencies) {
  if (Date.now() - bocFxCache.at > 10 * 60 * 1000 || !Object.keys(bocFxCache.rates).length) {
    const response = await fetch('https://www.boc.cn/sourcedb/whpj/', { signal: AbortSignal.timeout(12000), headers: { Accept: 'text/html' } });
    if (!response.ok) throw new Error('读取中国银行汇率失败（HTTP ' + response.status + '）');
    const html = await response.text(), byName = {};
    for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x => x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').trim());
      if (cells.length < 7) continue;
      const name = cells[0], spotSell = Number(cells[3]), benchmark = Number(cells[5]), cnyPer100 = Number.isFinite(spotSell) && spotSell > 0 ? spotSell : benchmark, rateType = Number.isFinite(spotSell) && spotSell > 0 ? '现汇卖出价' : '中行折算价', publishedAt = cells[6] || '';
      if (name && Number.isFinite(cnyPer100) && cnyPer100 > 0) byName[name] = { cnyPer100, rateType, publishedAt };
    }
    const rates = { CNY: { localPerCny: 1, cnyPer100: 100, publishedAt: '' } };
    for (const [code, name] of Object.entries(BOC_CURRENCY_NAMES)) {
      const row = byName[name];
      if (row) rates[code] = { localPerCny: 100 / row.cnyPer100, cnyPer100: row.cnyPer100, rateType: row.rateType, publishedAt: row.publishedAt };
    }
    if (!Object.keys(rates).some(code => code !== 'CNY')) {
      if (Object.keys(bocFxCache.rates).length) return bocFxCache.rates;
      throw new Error('中国银行牌价页面暂不可用');
    }
    bocFxCache.at = Date.now(); bocFxCache.rates = rates;
  }
  const out = {};
  for (const currency of currencies || []) out[currency] = bocFxCache.rates[currency] || null;
  return out;
}
function readProfitCosts() { try { return JSON.parse(fs.readFileSync(privateDataFile('product-profit.json'), 'utf8')) || {}; } catch { return {}; } }
function saveProfitCosts(data) { fs.writeFileSync(privateDataFile('product-profit.json'), JSON.stringify(data, null, 2), 'utf8'); }
// 利润页设置：税费估算税率。没设置过就用 DEFAULT_TAX_RATE，永远返回一个合法的小数税率。
function readProfitSettings() {
  try {
    const d = JSON.parse(fs.readFileSync(privateDataFile('profit-settings.json'), 'utf8')) || {};
    const r = Number(d.taxRate);
    return { taxRate: Number.isFinite(r) && r >= 0 && r < 1 ? r : DEFAULT_TAX_RATE };
  } catch { return { taxRate: DEFAULT_TAX_RATE }; }
}
function saveProfitSettings(patch) {
  const next = Object.assign(readProfitSettings(), patch);
  fs.writeFileSync(privateDataFile('profit-settings.json'), JSON.stringify(next, null, 2), 'utf8');
  return next;
}
// ---- 订单全量抓取 ----
// 踩过的坑：原来写死 CAP=500，10 月有 779 单时只拉了 500 条（过滤取消后剩 465），
// 于是「利润只核算了 400 多单」。现在：
//   ① 不再设条数上限，改成「按 paging.total 拉满」
//   ② 单量不大（≤900）就在区间内并发翻页；单量大则按天切片 —— 避开 orders/search
//      的 offset 上限（约 1000，超了会被拒或返回空，表现为静默丢单）
//   ③ 全程按 order.id 去重 —— 实测逐天 paging.total 相加比全区间多出 11 单，
//      是跨日边界重复，不去重反而会越算越多
const ORDER_PAGE_LIMIT = 50;
const ORDER_PAGE_CONCURRENCY = 5;
const ORDER_OFFSET_SAFE = 900;      // offset 安全上限，留 100 条余量

function orderDayList(from, to) {
  const out = [];
  let t = Date.parse(from + 'T12:00:00Z');
  const end = Date.parse(to + 'T12:00:00Z');
  if (!Number.isFinite(t) || !Number.isFinite(end) || end < t) return [from];
  for (let i = 0; t <= end && i < 400; i++, t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function fetchOrdersPage(sellerId, from, to, offset) {
  const qs = new URLSearchParams({
    seller: String(sellerId),
    'order.date_created.from': from + 'T00:00:00.000' + SALES_TZ.offset,
    'order.date_created.to': to + 'T23:59:59.999' + SALES_TZ.offset,
    sort: 'date_asc',
    limit: String(ORDER_PAGE_LIMIT),
    offset: String(offset),
  });
  return mlRequest('/orders/search?' + qs.toString()).then((d) => ({
    rows: (d && d.results) || [],
    total: Number((d && d.paging && d.paging.total) || 0),
  }));
}

// 单天拉全（单天单量远小于 offset 上限，最多几页）
async function fetchOrdersOneDay(sellerId, day) {
  const out = [];
  let offset = 0;
  for (;;) {
    const r = await fetchOrdersPage(sellerId, day, day, offset);
    out.push(...r.rows);
    offset += ORDER_PAGE_LIMIT;
    if (r.rows.length < ORDER_PAGE_LIMIT || offset >= r.total || offset >= ORDER_OFFSET_SAFE) break;
  }
  return out;
}

async function fetchAllOrders(sellerId, from, to) {
  const map = new Map();
  const first = await fetchOrdersPage(sellerId, from, to, 0);
  for (const o of first.rows) map.set(String(o.id), o);
  const apiTotal = first.total || first.rows.length;
  if (first.rows.length < ORDER_PAGE_LIMIT) return { orders: [...map.values()], apiTotal, strategy: '单页' };

  if (apiTotal <= ORDER_OFFSET_SAFE) {
    // 区间内并发翻页（offset 全在安全范围内）
    const lastPage = Math.ceil(Math.min(apiTotal, ORDER_OFFSET_SAFE) / ORDER_PAGE_LIMIT);
    for (let p = 1; p < lastPage; p += ORDER_PAGE_CONCURRENCY) {
      const batch = [];
      for (let k = p; k < Math.min(p + ORDER_PAGE_CONCURRENCY, lastPage); k++) {
        batch.push(fetchOrdersPage(sellerId, from, to, k * ORDER_PAGE_LIMIT));
      }
      for (const r of await Promise.all(batch)) for (const o of r.rows) map.set(String(o.id), o);
    }
    return { orders: [...map.values()], apiTotal, strategy: '区间并发翻页' };
  }

  // 单量超过 offset 安全线：按天切片，天与天之间并发
  const days = orderDayList(from, to);
  const dayConc = 4;
  for (let i = 0; i < days.length; i += dayConc) {
    const chunk = days.slice(i, i + dayConc);
    const results = await Promise.all(chunk.map((d) => fetchOrdersOneDay(sellerId, d)));
    for (const rows of results) for (const o of rows) map.set(String(o.id), o);
  }
  return { orders: [...map.values()], apiTotal, strategy: '按天切片 ' + days.length + ' 天' };
}

app.get('/api/ml/profit/orders', async (req,res)=>{
  const cfg=loadConfig();
  if(!mlConfigured(cfg))return res.json({ok:false,needConfig:true,message:'尚未配置美客多 API 凭证'});
  if(!mlAuthorized(cfg))return res.json({ok:false,needAuth:true,message:'请先完成美客多账号授权'});
  try{
    const u=await mlUser(),today=tzToday();let from=isDateStr(req.query.from)?String(req.query.from):today,to=isDateStr(req.query.to)?String(req.query.to):today;
    if(from>to){const t=from;from=to;to=t;}
    const cacheKey=`ads-v2-total|${auth.currentUserId()}|${u.id}|${from}|${to}`,cached=profitOrderCache.get(cacheKey);
    const summaryOnly=req.query.summary==='1';
    const toSummary=(data,cachedValue)=>({
      ok:true,range:data.range,updatedAt:data.updatedAt,cached:!!cachedValue,ads:data.ads,
      totals:{profitCny:data.totals?.profitCny,profitAfterAdsCny:data.totals?.profitAfterAdsCny,
        matched:data.totals?.matched,validLines:data.totals?.validLines,unmatched:data.totals?.unmatched,
        orders:data.totals?.orders,validUnits:data.totals?.validUnits,profitUnits:data.totals?.profitUnits},
    });
    if(!req.query.refresh&&cached&&Date.now()-cached.at<30000){
      const data={...cached.data,cached:true};
      return res.json(summaryOnly?toSummary(data,true):data);
    }
    const pulled=await fetchAllOrders(u.id,from,to);
    const rawOrders=pulled.orders,apiTotal=pulled.apiTotal;
    // 取消 / 退款单**不再从列表里剔除** —— 后台看到的「已卖出 841 件」是含取消单的口径，
    // 剔掉就对不上账了。这里保留全量并打标记，只有利润合计排除它们。
    const isDeadOrder=(o)=>{
      const s=String(o.status||'').toLowerCase(),d=String(o.status_detail||'').toLowerCase();
      return s==='cancelled'||s==='invalid'||/cancel|refund/.test(d);
    };
    const validOrders=rawOrders.filter(o=>!isDeadOrder(o));
    const cancelledOrders=rawOrders.filter(isDeadOrder);
    // 运费只为有效单去拉：取消单不产生卖家运费，白拉 49 次没意义
    const shipmentIds=[...new Set(validOrders.map(o=>String(o.shipping?.id||'')).filter(Boolean))];
    // 订单币种按 shipment 建索引：运费接口的退化版不返回币种，用它兜底
    const shipCurrencyOf={};
    for(const o of validOrders){const sid=String(o.shipping?.id||'');if(sid&&!shipCurrencyOf[sid])shipCurrencyOf[sid]=o.currency_id||(o.order_items?.[0]?.currency_id)||'';}
    async function getShipmentCost(id,fallbackCurrency){
      const key=String(id);
      const mem=shipmentCostCache.get(key);if(mem&&Date.now()-mem.at<3600000)return mem.data;
      const disk=shipCostGet(key);if(disk){shipmentCostCache.set(key,{at:Date.now(),data:disk});return disk;}
      let d=null;
      // 新接口：一小时内已知 403/404 的话直接跳过，别每个 shipment 都白试一次
      if(Date.now()-_mpCostsDeadAt>3600000){
        try{d=await mlRequest(`/marketplace/shipments/${encodeURIComponent(key)}/costs`,{headers:{'x-format-new':'true'}});}
        catch(e){if(e.status===403||e.status===404)_mpCostsDeadAt=Date.now();}
      }
      if(!d){
        for(let attempt=0;attempt<2&&!d;attempt++){
          try{d=await mlRequest(`/shipments/${encodeURIComponent(key)}/costs?seller_id=${encodeURIComponent(u.id)}`);}
          catch(e){
            // 被限流就等一下再来一次，别把这一单直接记成「运费缺失」
            if(e.status===429){await new Promise(r=>setTimeout(r,600*(attempt+1)));continue;}
            break;
          }
        }
      }
      let data=null;
      if(d){
        const senders=Array.isArray(d.senders)?d.senders:[];const seller=senders.find(x=>String(x.user_id)===String(u.id))||senders[0];
        const rawCost=seller?.cost??d.shipping_fee;const n=Number(rawCost);
        if(rawCost!==undefined&&rawCost!==null&&Number.isFinite(n)){
          // 关键修复：退化的 /shipments/{id}/costs 响应**不带 currency_id**（实测 24/24 全缺）。
          // 老代码把它记成空串，而下面的分摊判定要求「运费币种 === 订单币种」→ 永远不相等 →
          // 利润表每一行都报「运费缺失」。运费一定以站点本币计价，缺省时用该订单的币种。
          const cur=String(d.currency_id||seller?.currency_id||d.currency?.id||fallbackCurrency||'');
          data={amount:n,currency:cur};
        }
      }
      if(data)shipCostSet(key,data);
      shipmentCostCache.set(key,{at:Date.now(),data});return data;
    }
    const shipmentCosts={};
    // 并发从 6 提到 16：单次 ~750ms，改成全量抓取后 10 月有 730 个 shipment，
    // 并发 6 要 90 秒、并发 16 约 35 秒；再叠加 30 天持久缓存，同一区间第二次基本秒开。
    // 遇到 429 会在 getShipmentCost 里退避重试，不会把订单直接记成「运费缺失」。
    const SHIP_CONCURRENCY=16;
    for(let i=0;i<shipmentIds.length;i+=SHIP_CONCURRENCY){
      const part=await Promise.all(shipmentIds.slice(i,i+SHIP_CONCURRENCY).map(async id=>[id,await getShipmentCost(id,shipCurrencyOf[id])]));
      for(const [id,cost] of part)shipmentCosts[id]=cost;
    }
    const costs=readProfitCosts(), currencies=[...new Set(rawOrders.flatMap(o=>[o.currency_id,...(o.order_items||[]).map(x=>x.currency_id)].filter(Boolean)))],rates=await getBocFxRates(currencies);
    const taxRate=readProfitSettings().taxRate;
    const flattened=[];
    for(const order of rawOrders){
      const dead=isDeadOrder(order);
      const items=order.order_items||[];
      const revenues=items.map(it=>(Number(it.unit_price)||0)*(Number(it.quantity)||1)),sumRevenue=revenues.reduce((a,b)=>a+b,0),shipmentId=String(order.shipping?.id||'');
      // 税额语义修正：美客多的 order.taxes 字段**一直存在**，但平台不代扣税时 amount 是 null
      // （实测巴西站 410/410 全是 null）。老代码把 null 当「未知」→ 每一行利润都算不出来，
      // 整个利润页等于废掉。正确语义：拿到数字就用它；null / 缺失 = 平台没代扣，
      // 按订单收入 × DEFAULT_TAX_RATE 估算（卖家实际仍有税费成本，按 0 会虚高利润）。
      const taxRaw=order.taxes&&typeof order.taxes==='object'?order.taxes.amount:order.taxes;
      const taxNum=Number(taxRaw),taxKnown=true,taxAssumed=taxRaw===undefined||taxRaw===null||!Number.isFinite(taxNum);
      const taxAmount=taxAssumed?sumRevenue*taxRate:taxNum,currency=order.currency_id||(items[0]?.currency_id)||'';
      const shipment=shipmentCosts[shipmentId],shipmentTotal=shipment?Number(shipment.amount):null;
      const shipmentGroup=shipmentId+'|'+currency;
      for(let i=0;i<items.length;i++)flattened.push({order,item:items[i],currency,cancelled:dead,qty:Number(items[i].quantity)||1,revenue:revenues[i],taxShare:sumRevenue?taxAmount*revenues[i]/sumRevenue:0,taxAssumed,shipmentId,shipmentGroup,orderRevenue:sumRevenue,shipmentTotal,shipmentCurrency:shipment?.currency||''});
    }
    const shipmentGroupRevenue={};for(const line of flattened)if(line.shipmentId)shipmentGroupRevenue[line.shipmentGroup]=(shipmentGroupRevenue[line.shipmentGroup]||0)+line.revenue;
    const lines=flattened.map(line=>{
      const item=line.item,id=String(item.item?.id||''),saved=costs[id],currency=line.currency,fx=Number(rates[currency]?.localPerCny||0),fxCnyPer100=Number(rates[currency]?.cnyPer100||0),saleFeeRaw=item.sale_fee,saleFeeUnit=Number(saleFeeRaw),feeKnown=saleFeeRaw!==undefined&&saleFeeRaw!==null&&Number.isFinite(saleFeeUnit);
      let shippingShare=null;
      if(line.shipmentTotal!==null&&line.shipmentCurrency===currency){const groupRevenue=shipmentGroupRevenue[line.shipmentGroup]||0;shippingShare=groupRevenue?line.shipmentTotal*line.revenue/groupRevenue:0;}
      else if(line.shipmentTotal===0&&line.shipmentCurrency===currency)shippingShare=0;
      const costReady=saved&&saved.costCny!==''&&saved.costCny!==undefined&&saved.costCny!==null&&saved.freightCny!==''&&saved.freightCny!==undefined&&saved.freightCny!==null;
      const costLocal=costReady&&fx?(Number(saved.costCny)+Number(saved.freightCny))*fx*line.qty+(Number(saved.otherFee)||0)*line.qty:null;
      const feeTotal=feeKnown?saleFeeUnit*line.qty:null,allKnown=feeKnown&&shippingShare!==null&&line.taxShare!==null&&costLocal!==null;
      // 取消 / 退款单照常算收入与费用（好让你看清「丢了多少钱」），但利润恒为 null，
      // 绝不进合计 —— 退款后平台会把佣金退回，硬算出来的「利润」是假数。
      const profit=(allKnown&&!line.cancelled)?line.revenue-feeTotal-shippingShare-line.taxShare-costLocal:null;
      const reasons=[];
      if(line.cancelled)reasons.push('订单已取消 / 退款，不计入利润');
      else{
        if(!id)reasons.push('订单缺少 Listing ID');else if(!saved)reasons.push('未保存该商品成本');else if(!costReady)reasons.push('未填写成本/头程');if(!fx)reasons.push('中国银行暂无该币种牌价');if(!feeKnown)reasons.push('销售费缺失');if(shippingShare===null)reasons.push('运费缺失');if(line.taxShare===null)reasons.push('订单税额缺失');
      }
      return {orderId:String(line.order.id||''),cancelled:!!line.cancelled,statusDetail:String(line.order.status_detail||''),date:line.order.date_created||'',status:line.order.status||'',itemId:id,title:item.item?.title||('Listing '+id),qty:line.qty,currency,unitPrice:Number(item.unit_price)||0,revenue:line.revenue,saleFee:feeTotal,shipping:shippingShare,tax:line.taxShare,taxAssumed:!!line.taxAssumed,cost:costLocal,profit,profitCny:profit!==null&&fx?profit/fx:null,revenueCny:fx?line.revenue/fx:null,saleFeeCny:feeTotal!==null&&fx?feeTotal/fx:null,shippingCny:shippingShare!==null&&fx?shippingShare/fx:null,taxCny:line.taxShare!==null&&fx?line.taxShare/fx:null,costCny:costLocal!==null&&fx?costLocal/fx:null,fxCnyPer100,fxPublishedAt:rates[currency]?.publishedAt||'',margin:profit!==null&&line.revenue?profit/line.revenue*100:null,missing:reasons,fxRate:fx};
    });
    const complete=lines.filter(x=>!x.cancelled&&x.profit!==null),active=lines.filter(x=>!x.cancelled);
    const totalProfitCny=complete.reduce((s,x)=>s+(x.profitCny||0),0),totalRevenueCny=complete.reduce((s,x)=>s+(x.revenueCny||0),0);
    const qtyOf=(arr)=>arr.reduce((s,x)=>s+(Number(x.qty)||0),0);
    const deadLines=lines.filter(x=>x.cancelled);
    const r2=(v)=>Math.round((Number(v)||0)*100)/100;

    // ---- 产品维度汇总：按 Listing 聚，带主图 ----
    // 件数口径要跟后台对得上：取消单的件数**单独统计但照样展示**（units 含取消，validUnits 不含），
    // 否则「后台 841 件 / 这里 793 件」永远解释不清。
    const byItem=new Map();
    for(const x of lines){
      const key=x.itemId||'__no_id__';
      let p=byItem.get(key);
      if(!p){p={itemId:x.itemId||'',title:x.title||'',units:0,cancelledUnits:0,cancelledLines:0,orders:new Set(),cancelledOrders:new Set(),revenue:0,saleFee:0,shipping:0,tax:0,cost:0,profit:0,profitCny:0,revenueCny:0,computed:0,lines:0,lastDate:''};byItem.set(key,p);}
      p.lines++;
      if(x.cancelled){p.cancelledUnits+=Number(x.qty)||0;p.cancelledLines++;p.cancelledOrders.add(x.orderId);}
      else{
        p.units+=Number(x.qty)||0;p.orders.add(x.orderId);
        p.revenue+=x.revenue||0;p.saleFee+=x.saleFee||0;p.shipping+=x.shipping||0;p.tax+=x.tax||0;p.cost+=x.cost||0;p.revenueCny+=x.revenueCny||0;
        if(x.profit!==null){p.profit+=x.profit;p.profitCny+=x.profitCny||0;p.computed++;}
      }
      if(String(x.date)>p.lastDate)p.lastDate=String(x.date);
    }
    // Product Ads API: sum total campaign/ad-group spend for this selected period.
    let adStatus={available:false,error:'广告数据尚未读取',currency:mlSite(mlEffectiveSite(cfg.mlSite)||u.site_id||'MLB').currency,costLocal:null,costCny:null};
    try{
      if(daysBetween(from,to)>ADS_MAX_DAYS-1) throw new Error(`广告指标最多查询 ${ADS_MAX_DAYS} 天；请缩短日期范围后重新计算`);
      const siteCode=String(mlEffectiveSite(cfg.mlSite)||u.site_id||'MLB').toUpperCase(), adv=await mlAdvertiser(siteCode);
      const pageLimit=50;let totalCost=0,hasCost=false,totalGroups=0;
      for(let offset=0, total=Infinity;offset<total;offset+=pageLimit){
        const qs=new URLSearchParams({date_from:from,date_to:to,metrics:'COST',limit:String(pageLimit),offset:String(offset)});
        const d=await mlRequest(`/advertising/${adv.site}/advertisers/${encodeURIComponent(adv.id)}/product_ads/ad_groups/search?${qs}`,{headers:{'api-version':'2'}});
        const batch=Array.isArray(d?.results)?d.results:[];
        totalGroups=Number(d?.paging?.total||batch.length);
        for(const group of batch){
          const raw=group.metrics?.cost??group.cost??group.metrics?.COST??group.COST;
          if(raw!==undefined&&raw!==null&&Number.isFinite(Number(raw))){totalCost+=Number(raw);hasCost=true;}
        }
        total=Number(d?.paging?.total||batch.length);if(!batch.length||offset+batch.length>=total)break;
      }
      if(!hasCost&&totalGroups>0)throw new Error('广告接口没有返回花费指标');
      adStatus={available:true,error:'',currency:mlSite(siteCode).currency,costLocal:r2(totalCost)};
      const adRates=await getBocFxRates([adStatus.currency]),localPerCny=Number(adRates[adStatus.currency]?.localPerCny||0);
      if(!localPerCny)throw new Error(`中国银行暂无 ${adStatus.currency} 牌价，广告费暂无法折算成人民币`);
      adStatus.costCny=r2(totalCost/localPerCny);
      adStatus.fxCnyPer100=Number(adRates[adStatus.currency]?.cnyPer100||0);
      adStatus.fxPublishedAt=adRates[adStatus.currency]?.publishedAt||'';
    }catch(e){adStatus={...adStatus,available:false,error:String(e.message||e)};}
    let itemInfo={};
    try{itemInfo=await mlItemInfo([...byItem.values()].map(p=>p.itemId).filter(Boolean));}catch{/* 图取不到不影响数字 */}
    const products=[...byItem.values()].map(p=>{
      const inf=itemInfo[p.itemId]||{};
      return {itemId:p.itemId,title:inf.title||p.title,thumbnail:inf.thumbnail||'',permalink:inf.permalink||'',
        units:p.units,orders:p.orders.size,cancelledUnits:p.cancelledUnits,cancelledOrders:p.cancelledOrders.size,cancelledLines:p.cancelledLines,
        revenue:r2(p.revenue),saleFee:r2(p.saleFee),shipping:r2(p.shipping),tax:r2(p.tax),cost:r2(p.cost),
        profit:r2(p.profit),profitCny:r2(p.profitCny),revenueCny:r2(p.revenueCny),
        margin:p.revenueCny?r2(p.profitCny/p.revenueCny*100):null,
        computed:p.computed,lines:p.lines,lastDate:p.lastDate};
    }).sort((a,b)=>b.units-a.units||b.profitCny-a.profitCny);

    const data={ok:true,range:{from,to},currency:'CNY',taxRate,defaultTaxRate:DEFAULT_TAX_RATE,
      truncated:rawOrders.length<apiTotal,
      apiTotal,pulled:rawOrders.length,cancelled:cancelledOrders.length,strategy:pulled.strategy,
      orders:lines,products,ads:adStatus,
      totals:{allOrders:rawOrders.length,orders:validOrders.length,cancelledOrders:cancelledOrders.length,
        ordersWithMultiItem:rawOrders.filter(o=>(o.order_items||[]).length>1).length,
        lines:lines.length,validLines:active.length,matched:complete.length,unmatched:active.length-complete.length,
        units:qtyOf(lines),validUnits:qtyOf(active),cancelledUnits:qtyOf(deadLines),profitUnits:qtyOf(complete),
        cancelledRevenueCny:r2(deadLines.reduce((s,x)=>s+(x.revenueCny||0),0)),
        profitCny:r2(totalProfitCny),profitAfterAdsCny:adStatus.available?r2(totalProfitCny-(adStatus.costCny||0)):null,margin:totalRevenueCny?Math.round(totalProfitCny/totalRevenueCny*10000)/100:null},
      updatedAt:Date.now()};
    profitOrderCache.set(cacheKey,{at:Date.now(),data});res.json(summaryOnly?toSummary(data,false):data);
  }catch(e){sendMlError(res,e);}
});
app.get('/api/ml/profit/listings', async (req, res) => {
  const cfg = loadConfig();
  if (!mlConfigured(cfg)) return res.json({ ok:false, needConfig:true, message:'尚未配置美客多 API 凭证' });
  if (!mlAuthorized(cfg)) return res.json({ ok:false, needAuth:true, message:'请先完成美客多账号授权' });
  try {
    const u = await mlUser(), key = `${auth.currentUserId()}|${u.id}`, cached = profitCache.get(key);
    if (!req.query.refresh && cached && Date.now() - cached.at < 300000) return res.json({ ...cached.data, cached:true });
    const ids=[]; let offset=0, total=0;
    while (offset < 1000) {
      const d=await mlRequest(`/users/${encodeURIComponent(u.id)}/items/search?status=active&limit=100&offset=${offset}`);
      const batch=(d && d.results)||[]; total=Number(d?.paging?.total||batch.length); ids.push(...batch.map(String));
      offset += batch.length; if (!batch.length || offset >= total) break;
    }
    const items=[];
    for(let i=0;i<ids.length;i+=20){
      const batch=ids.slice(i,i+20); if(!batch.length)continue;
      const d=await mlRequest(`/items?ids=${batch.join(',')}&attributes=id,title,permalink,thumbnail,price,currency_id,site_id,category_id,listing_type_id,shipping,status`);
      for(const row of (Array.isArray(d)?d:[])){const b=row?.body;if(b?.id&&b.status==='active')items.push(b);}
    }
    const costs=readProfitCosts(), currencies=[...new Set(items.map(x=>x.currency_id).filter(Boolean))], rates=await getBocFxRates(currencies);
    const output=[];
    for(let i=0;i<items.length;i+=8){
      const batch=await Promise.all(items.slice(i,i+8).map(async item=>{
        const id=String(item.id), currency=item.currency_id||'', site=item.site_id||u.site_id, price=Number(item.price)||0;
        let fee=null, feeError='', shipping=null;
        try { const q=new URLSearchParams({price:String(price),currency_id:currency,category_id:item.category_id||'',listing_type_id:item.listing_type_id||''}); const d=await mlRequest(`/sites/${encodeURIComponent(site)}/listing_prices?${q}`); const row=Array.isArray(d)?(d.find(x=>x.listing_type_id===item.listing_type_id)||d[0]):d; const sale=Number(row?.sale_fee_amount ?? row?.sale_fee_details?.fixed_fee ?? NaN), listing=Number(row?.listing_fee_amount||0); fee=Number.isFinite(sale)?sale+(Number.isFinite(listing)?listing:0):null; } catch(e){feeError=e.message;}
        try { const d=await mlRequest(`/users/${encodeURIComponent(u.id)}/shipping_options/cost?item_id=${encodeURIComponent(id)}`); shipping=Number(d?.coverage?.all_country?.list_cost ?? d?.receiver?.cost ?? d?.shipping_options?.[0]?.cost ?? d?.shipping_fee); if(!Number.isFinite(shipping))shipping=null; } catch {}
        return {id,title:item.title||`商品 ${id}`,permalink:item.permalink||'',thumbnail:item.thumbnail||'',price,currency,site,fee,feeError,shipping,fxRate:Number(rates[currency]?.localPerCny||0),fxCnyPer100:Number(rates[currency]?.cnyPer100||0),fxPublishedAt:rates[currency]?.publishedAt||'',fxRateType:rates[currency]?.rateType||'',fxSource:'中国银行牌价',cost:costs[id]||{costCny:'',freightCny:'',otherFee:''}};
      })); output.push(...batch);
    }
    const data={ok:true,items:output,total,loaded:items.length,truncated:total>ids.length,updatedAt:Date.now()}; profitCache.set(key,{at:Date.now(),data}); res.json(data);
  } catch(e){sendMlError(res,e);}
});
// 利润页设置：税费估算税率（按账号存，不进仓库）
app.get('/api/ml/profit/settings', (req,res)=>{
  res.json({ ok:true, ...readProfitSettings(), defaultTaxRate:DEFAULT_TAX_RATE });
});
app.put('/api/ml/profit/settings', (req,res)=>{
  const raw=req.body?.taxRate;
  const n = raw===''||raw===null||raw===undefined ? DEFAULT_TAX_RATE : Number(raw);
  if(!Number.isFinite(n)||n<0||n>=1)return res.status(400).json({error:'税率需为 0 ~ 1 之间的小数（8% 填 0.08）'});
  const next=saveProfitSettings({ taxRate:n });
  // 税率变了，利润缓存全部失效，下次查询会用新税率重算
  const prefix=auth.currentUserId()+'|';
  for(const key of profitOrderCache.keys())if(key.startsWith(prefix))profitOrderCache.delete(key);
  for(const key of profitCache.keys())if(key.startsWith(prefix))profitCache.delete(key);
  res.json({ ok:true, ...next, defaultTaxRate:DEFAULT_TAX_RATE });
});
app.put('/api/ml/profit/items', (req,res)=>{
  const rows=Array.isArray(req.body?.items)?req.body.items:null;
  if(!rows||rows.length>2000)return res.status(400).json({error:'保存数据格式无效'});
  const num=(v)=>{if(v===''||v===null||v===undefined)return '';const n=Number(v);return Number.isFinite(n)&&n>=0?n:null;};
  const all=readProfitCosts();
  for(const row of rows){
    const id=String(row?.id||''); if(!/^[A-Za-z0-9_-]{1,40}$/.test(id))return res.status(400).json({error:'发现无效 Listing ID'});
    const next={costCny:num(row.costCny),freightCny:num(row.freightCny),otherFee:num(row.otherFee)};
    if(Object.values(next).includes(null))return res.status(400).json({error:'费用必须是大于等于 0 的数字'});
    all[id]={...(all[id]||{}),...next};
  }
  saveProfitCosts(all);
  const prefix=auth.currentUserId()+'|'; for(const key of profitCache.keys())if(key.startsWith(prefix))profitCache.delete(key);for(const key of profitOrderCache.keys())if(key.startsWith(prefix))profitOrderCache.delete(key);
  res.json({ok:true,saved:rows.length});
});
app.put('/api/ml/profit/items/:id', (req,res)=>{
  const id=String(req.params.id||''); if(!/^[A-Za-z0-9_-]{1,40}$/.test(id))return res.status(400).json({error:'无效 Listing ID'});
  const num=(v)=>{if(v===''||v===null||v===undefined)return '';const n=Number(v);return Number.isFinite(n)&&n>=0?n:null;};
  const next={costCny:num(req.body?.costCny),freightCny:num(req.body?.freightCny),otherFee:num(req.body?.otherFee)};
  if(Object.values(next).includes(null))return res.status(400).json({error:'费用必须是大于等于 0 的数字'});
  const all=readProfitCosts();all[id]=next;saveProfitCosts(all);
  const prefix=auth.currentUserId()+'|'; for(const key of profitCache.keys())if(key.startsWith(prefix))profitCache.delete(key);for(const key of profitOrderCache.keys())if(key.startsWith(prefix))profitOrderCache.delete(key);
  res.json({ok:true,cost:next});
});

// ---- Fulfillment 平台仓库存：按 Listing 汇总可售及不可售库存 ----
app.get('/api/ml/warehouse-stock', async (req,res)=>{
  const cfg=loadConfig();
  if(!mlConfigured(cfg))return res.json({ok:false,needConfig:true,message:'尚未配置美客多 API 凭证'});
  if(!mlAuthorized(cfg))return res.json({ok:false,needAuth:true,message:'请先完成美客多账号授权'});
  try{
    const u=await mlUser(), key=String(auth.currentUserId())+'|'+u.id, cached=warehouseStockCache.get(key);
    if(!req.query.refresh&&cached&&Date.now()-cached.at<60000)return res.json({...cached.data,cached:true});
    const ids=[];let offset=0,total=0;
    while(offset<1000){
      const d=await mlRequest(`/users/${encodeURIComponent(u.id)}/items/search?status=active&limit=100&offset=${offset}`);
      const batch=d?.results||[];total=Number(d?.paging?.total||batch.length);ids.push(...batch.map(String));offset+=batch.length;
      if(!batch.length||offset>=total)break;
    }
    const all=[];
    for(let i=0;i<ids.length;i+=20){
      const d=await mlRequest(`/items?ids=${ids.slice(i,i+20).join(',')}&attributes=id,title,permalink,thumbnail,status,shipping,inventory_id,user_product_id,variations`);
      for(const row of(Array.isArray(d)?d:[])){const item=row?.body;if(item?.id&&item.status==='active')all.push(item);}
    }
    const listings=all.filter(item=>item.shipping?.logistic_type==='fulfillment'||item.user_product_id||(item.variations||[]).some(v=>v.inventory_id||v.user_product_id));
    const stockByKey=new Map(),stockRequests=new Map();
    for(const item of listings){
      const vars=Array.isArray(item.variations)&&item.variations.length?item.variations:null;
      const stockUnits=vars?vars.map(v=>({userProductId:String(v.user_product_id||''),inventoryId:String(v.inventory_id||''),variationId:String(v.id||''),label:(v.attribute_combinations||[]).map(a=>a.value_name).filter(Boolean).join(' / ')})):[{userProductId:String(item.user_product_id||''),inventoryId:String(item.inventory_id||''),variationId:'',label:''}];
      for(const unit of stockUnits){
        const stockKey=unit.userProductId?'up:'+unit.userProductId:'inventory:'+unit.inventoryId;
        if(unit.userProductId||unit.inventoryId){unit.stockKey=stockKey;if(!stockRequests.has(stockKey))stockRequests.set(stockKey,unit.userProductId?{kind:'up',id:unit.userProductId,inventoryId:unit.inventoryId}:{kind:'inventory',id:unit.inventoryId,inventoryId:unit.inventoryId});}
        else {const group=stockByKey.get(String(item.id))||[];group.push({id:String(item.id),stockKey:'',inventoryId:'',userProductId:'',variationId:unit.variationId,label:unit.label,available:null,notAvailable:null,total:null,detail:[],error:'该变体缺少库存编号'});stockByKey.set(String(item.id),group);}
      }
    }
    const uniqueRequests=[...stockRequests.entries()];
    let nextStockRequestAt=0;
    async function limitedStockGet(path){const now=Date.now(),scheduled=Math.max(now,nextStockRequestAt);nextStockRequestAt=scheduled+650;if(scheduled>now)await new Promise(resolve=>setTimeout(resolve,scheduled-now));return mlRequest(path);}
    for(let i=0;i<uniqueRequests.length;i+=5){
      const results=await Promise.all(uniqueRequests.slice(i,i+5).map(async([stockKey,request])=>{
        try{
          if(request.kind==='up'){
            const d=await limitedStockGet(`/user-products/${encodeURIComponent(request.id)}/stock`),locations=Array.isArray(d?.locations)?d.locations:[],full=locations.find(x=>x.type==='meli_facility');
            if(!full)throw new Error('平台仓未返回该商品库存');
            return {stockKey,inventoryId:request.inventoryId,userProductId:request.id,available:Number(full.quantity),notAvailable:null,total:Number(full.quantity),detail:[],error:''};
          }
          const d=await limitedStockGet(`/inventories/${encodeURIComponent(request.id)}/stock/fulfillment`);
          return {stockKey,inventoryId:request.inventoryId,userProductId:'',available:Number(d?.available_quantity),notAvailable:Number(d?.not_available_quantity),total:Number(d?.total),detail:Array.isArray(d?.not_available_detail)?d.not_available_detail:[],error:''};
        }catch(e){return {stockKey,inventoryId:request.inventoryId,userProductId:request.kind==='up'?request.id:'',available:null,notAvailable:null,total:null,detail:[],error:e.status===403?'无库存接口权限':e.status===404?'库存编号或商品编号未关联该账号':e.message||'读取失败'};}
      }));
      for(const row of results)stockByKey.set(row.stockKey,[row]);
    }
    const rows=listings.map(item=>{
      const vars=Array.isArray(item.variations)&&item.variations.length?item.variations:null;
      const stockUnits=vars?vars.map(v=>({userProductId:String(v.user_product_id||''),inventoryId:String(v.inventory_id||''),variationId:String(v.id||''),label:(v.attribute_combinations||[]).map(a=>a.value_name).filter(Boolean).join(' / ')})):[{userProductId:String(item.user_product_id||''),inventoryId:String(item.inventory_id||''),variationId:'',label:''}];
      const units=stockUnits.map(x=>{const stockKey=x.userProductId?'up:'+x.userProductId:'inventory:'+x.inventoryId,stock=stockByKey.get(stockKey)?.[0];return {...(stock||{...x,available:null,notAvailable:null,total:null,detail:[],error:'库存暂不可用'}),variationId:x.variationId,label:x.label};});
      const complete=units.length>0&&units.every(x=>Number.isFinite(x.available));
      return {id:String(item.id),title:String(item.title||''),permalink:String(item.permalink||''),thumbnail:String(item.thumbnail||''),available:complete?units.reduce((s,x)=>s+x.available,0):null,notAvailable:complete&&units.every(x=>Number.isFinite(x.notAvailable))?units.reduce((s,x)=>s+(Number(x.notAvailable)||0),0):null,total:complete?units.reduce((s,x)=>s+(Number(x.total)||0),0):null,variations:units,errors:units.filter(x=>x.error).map(x=>x.error),missingInventoryId:units.every(x=>!x.userProductId&&!x.inventoryId)};
    }).sort((a,b)=>(a.available??-1)-(b.available??-1)||a.title.localeCompare(b.title,'zh-CN'));
    const distinctStock=[...stockByKey.values()].map(x=>x[0]),data={ok:true,rows,totalListings:total,loadedListings:all.length,truncated:total>ids.length,updatedAt:Date.now(),summary:{listings:rows.length,available:distinctStock.filter(x=>Number.isFinite(x.available)).reduce((s,x)=>s+x.available,0),confirmed:rows.filter(x=>x.available!==null).length,unknown:rows.filter(x=>x.available===null||x.errors.length>0).length}};
    warehouseStockCache.set(key,{at:Date.now(),data});res.json(data);
  }catch(e){sendMlError(res,e);}
});

app.get('/api/ml/listings', async (req, res) => {
  const cfg = loadConfig();
  if (!mlConfigured(cfg)) return res.json({ configured: false, authorized: false, ok: false, needConfig: true, message: '尚未配置美客多 API 凭证' });
  if (!mlAuthorized(cfg)) return res.json({ configured: true, authorized: false, ok: false, needAuth: true, message: '凭证已保存，但还没完成美客多账号授权' });
  try {
    const u = await mlUser();
    const today = tzToday();
    let to = isDateStr(req.query.to) ? String(req.query.to) : today;
    let from = isDateStr(req.query.from) ? String(req.query.from) : to;
    if (from > to) { const t = from; from = to; to = t; }
    const siteCode = String(mlEffectiveSite(cfg.mlSite) || u.site_id || 'MLB').toUpperCase();
    const site = mlSite(siteCode);
    const uid = u.id;

    const key = `${uid}|${from}|${to}`;
    if (listingsCache.key === key && Date.now() - listingsCache.at < 20000) {
      return res.json({ ...listingsCache.data, cached: true });
    }

    // 全量抓取：与 /api/ml/sales 同款 fetchAllOrders，修掉 CAP=1000 截断隐患
    // （超过 1000 单时 Listing 销售表现同样会静默少算）。
    const qFrom = `${from}T00:00:00.000${SALES_TZ.offset}`;
    const qTo = `${to}T23:59:59.999${SALES_TZ.offset}`;
    const fetched = await fetchAllOrders(uid, from, to);
    const raw = fetched.orders;
    const apiTotal = Number(fetched.apiTotal) || raw.length;

    // 按商品聚合（排除已取消/无效订单）
    const agg = {};
    let currency = site.currency;
    for (const o of raw) {
      if (o.status === 'cancelled' || o.status === 'invalid') continue;
      if (o.currency_id) currency = o.currency_id;
      for (const it of (o.order_items || [])) {
        const id = it.item && it.item.id;
        if (!id) continue;
        const qty = Number(it.quantity) || 1;
        const unit = Number(it.unit_price) || 0;
        const a = agg[String(id)] || (agg[String(id)] = { qty: 0, amount: 0, orders: 0 });
        a.qty += qty;
        a.amount += unit * qty;
        a.orders += 1;
      }
    }

    const ids = Object.keys(agg);
    const info = await mlItemInfo(ids);
    const listings = ids.map(id => {
      const a = agg[id];
      const inf = info[id] || {};
      return {
        id,
        title: inf.title || ('商品 ' + id),
        thumbnail: inf.thumbnail || '',
        permalink: inf.permalink || '',
        qty: a.qty,
        amount: Math.round(a.amount * 100) / 100,
        orders: a.orders,
      };
    }).sort((x, y) => (y.qty - x.qty) || (y.amount - x.amount));

    const totalQty = listings.reduce((s, l) => s + l.qty, 0);
    const totalAmount = Math.round(listings.reduce((s, l) => s + l.amount, 0) * 100) / 100;

    const data = {
      ok: true, site: siteCode, siteName: site.name,
      tz: SALES_TZ.tz, tzLabel: SALES_TZ.label, offset: SALES_TZ.offset,
      range: { from, to }, truncated: apiTotal > raw.length + 20, apiTotal,
      currency,
      totals: { listings: listings.length, qty: totalQty, amount: totalAmount },
      listings,
      updatedAt: Date.now(),
    };
    listingsCache.key = key; listingsCache.at = Date.now(); listingsCache.data = data;
    res.json(data);
  } catch (e) { sendMlError(res, e); }
});

// ---- 商品广告（Mercado Ads / Product Ads） ----
// 接口：/advertising/{站点}/advertisers/{advertiser_id}/product_ads/campaigns/search
//   aggregation_type=DAILY  → 账户级按天趋势（与 limit 无关，返回全账户汇总）
//   不加 aggregation_type     → 活动级明细（每行一个活动，带 metrics）
// 指标口径：ctr / acos / cvr 为百分数，roas 为倍数
const ADS_FIELDS = 'clicks,prints,ctr,cost,cpc,acos,roas,cvr,sov,units_quantity,total_amount,direct_amount,indirect_amount,advertising_items_quantity,direct_units_quantity,indirect_units_quantity';
const ADS_MAX_DAYS = 90; // 美客多限制：指标最多回溯 90 天

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
// 小时金额用 3 位小数：单天金额可能很小（如 R$1.75 / 24 小时），只留 2 位时 24 个小时累加会差出好几分
function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}

/* 订单是「按天切片 + 逐页翻页」的全量抓取，跨度不设限时一个
   from=1990-01-01&to=2030-12-31 的请求会变成上万次 API 调用，进程和配额一起拖死
   （探针 probe-api-fuzz.js 实测：该请求 25 秒仍无响应）。
   正常使用最长看季度，180 天足够宽松。 */
const MAX_ORDER_SPAN_DAYS = 180;
function rejectTooWideRange(res, from, to, maxDays, label) {
  const span = daysBetween(from, to) + 1;
  if (span > maxDays) {
    res.status(400).json({
      ok: false,
      error: `${label || '日期'}跨度最多 ${maxDays} 天（当前 ${span} 天），请缩小范围后重试`,
      maxDays, span,
    });
    return true;
  }
  return false;
}

// Advertiser IDs are private to the connected ML account; never reuse across users.
const adsAdvertiserCache = new Map();

// 发现当前账号在指定站点的广告账户（advertiser_id）
async function mlAdvertiser(siteCode) {
  const cacheKey = `${auth.currentUserId()}|${siteCode}`;
  const cached = adsAdvertiserCache.get(cacheKey);
  if (cached && cached.site === siteCode && Date.now() - cached.at < 3600000) return cached;
  const d = await mlRequest('/advertising/advertisers?product_id=PADS', { headers: { 'api-version': '1' } });
  const list = (d && d.advertisers) || [];
  if (!list.length) {
    const e = new Error('该账号没有商品广告权限。请到美客多「我的资料 → 广告」开通 Product Ads 后再试');
    e.status = 404; e.needAds = true; throw e;
  }
  const pick = list.find(a => String(a.site_id || '').toUpperCase() === siteCode) || list[0];
  const advertiser = {
    site: String(pick.site_id || '').toUpperCase(),
    id: pick.advertiser_id,
    name: pick.advertiser_name || '',
    accountName: pick.account_name || '',
    at: Date.now(),
  };
  adsAdvertiserCache.set(cacheKey, advertiser);
  const cfg = loadConfig();
  if (String(cfg.mlAdvertiserId || '') !== String(advertiser.id)) {
    try { saveConfig({ ...cfg, mlAdvertiserId: String(advertiser.id), mlAdvertiserSite: advertiser.site }); } catch { }
  }
  return advertiser;
}

function adsRow(r) {
  return {
    date: r.date || '',
    clicks: Number(r.clicks) || 0, prints: Number(r.prints) || 0,
    ctr: Number(r.ctr) || 0, cost: Number(r.cost) || 0, cpc: Number(r.cpc) || 0,
    acos: Number(r.acos) || 0, roas: Number(r.roas) || 0, cvr: Number(r.cvr) || 0,
    units: Number(r.units_quantity) || 0,
    totalAmount: Number(r.total_amount) || 0,
    directAmount: Number(r.direct_amount) || 0,
    indirectAmount: Number(r.indirect_amount) || 0,
    advertisingItems: Number(r.advertising_items_quantity) || 0,
  };
}

const adsCache = { key: '', at: 0, data: null };

app.get('/api/ml/ads', async (req, res) => {
  const cfg = loadConfig();
  if (!mlConfigured(cfg)) return res.json({ configured: false, authorized: false, ok: false, needConfig: true, message: '尚未配置美客多 API 凭证' });
  if (!mlAuthorized(cfg)) return res.json({ configured: true, authorized: false, ok: false, needAuth: true, message: '凭证已保存，但还没完成美客多账号授权' });
  try {
    const u = await mlUser();
    const today = tzToday();
    let to = isDateStr(req.query.to) ? String(req.query.to) : today;
    let from = isDateStr(req.query.from) ? String(req.query.from) : addDaysStr(to, -6);
    if (from > to) { const t = from; from = to; to = t; }
    if (daysBetween(from, to) > ADS_MAX_DAYS - 1) from = addDaysStr(to, -(ADS_MAX_DAYS - 1));

    const siteCode = String(mlEffectiveSite(cfg.mlSite) || u.site_id || 'MLB').toUpperCase();
    const site = mlSite(siteCode);
    const adv = await mlAdvertiser(siteCode);

    const key = auth.currentUserId() + '|' + adv.id + '|' + from + '|' + to;
    if (adsCache.key === key && Date.now() - adsCache.at < 20000) return res.json({ ...adsCache.data, cached: true });

    const qs = (extra) => `/advertising/${adv.site}/advertisers/${adv.id}/product_ads/campaigns/search?date_from=${from}&date_to=${to}&metrics=${ADS_FIELDS}&${extra}`;
    const H = { headers: { 'api-version': '2' } };
    const safe = async (fn) => { try { return await fn(); } catch (e) { return { __err: e.message }; } };

    const [dailyRes, campRes] = await Promise.all([
      safe(() => mlRequest(qs('aggregation_type=DAILY&limit=1&offset=0'), H)),
      safe(() => mlRequest(qs('limit=50&offset=0'), H)),
    ]);

    if (dailyRes && dailyRes.__err && campRes && campRes.__err) {
      const e = new Error('广告接口请求失败：' + dailyRes.__err); e.status = 502; throw e;
    }

    const daily = (((dailyRes && dailyRes.results) || [])).map(adsRow).sort((a, b) => String(a.date).localeCompare(String(b.date)));

    // 账本介入：① 把这次拿到的按天广告值写进账本（当天=live，跨天会被自动冻结）
    //           ② 已冻结的天一律改用账本值（这样「次日回看」与「当天看到的」完全一致，不会越看越大）
    daily.forEach(r => { if (r.date) adsLedgerUpsertAd(r.date, r.cost, r.totalAmount, r.units); });
    const dailyFixed = daily.map(r => {
      const b = adsLedgerGet(r.date);
      if (!b || b.level !== 'final') return r;
      const c2 = b.cost, a2 = b.adAmount, u2 = b.adUnits;
      return {
        ...r, cost: round2(c2), totalAmount: round2(a2), units: u2,
        acos: a2 > 0 ? round2(c2 / a2 * 100) : 0,
        roas: c2 > 0 ? round2(a2 / c2) : 0,
        cpc: r.clicks ? round2(c2 / r.clicks) : 0,
      };
    });

    const campaigns = (((campRes && campRes.results) || [])).map(c => ({
      id: c.id, name: c.name || ('活动 ' + c.id),
      status: String(c.status || '').toLowerCase(),
      strategy: c.strategy || '', channel: c.channel || '',
      budget: Number(c.budget) || 0, dailyBudget: Number(c.daily_budget) || 0,
      acosTarget: Number(c.acos_target) || 0, roasTarget: Number(c.roas_target) || 0,
      lastUpdated: c.last_updated || '',
      ...adsRow(c.metrics || {}),
    })).sort((a, b) => (b.cost - a.cost));

    // 汇总优先用账户级按天数据（完整）；没有时退化为活动求和
    const src = dailyFixed.length ? dailyFixed : campaigns;
    const sum = (k) => src.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const clicks = sum('clicks'), prints = sum('prints'), cost = sum('cost');
    const amount = sum('totalAmount'), units = sum('units');
    const totals = {
      clicks, prints, cost: round2(cost), units,
      totalAmount: round2(amount),
      directAmount: round2(sum('directAmount')),
      indirectAmount: round2(sum('indirectAmount')),
      advertisingItems: sum('advertisingItems'),
      cpc: clicks ? round2(cost / clicks) : 0,
      ctr: prints ? round2(clicks / prints * 100) : 0,
      acos: amount > 0 ? round2(cost / amount * 100) : 0,
      roas: cost > 0 ? round2(amount / cost) : 0,
      cvr: clicks ? round2(units / clicks * 100) : 0,
    };

    const data = {
      ok: true, site: adv.site || siteCode, siteName: site.name,
      tz: SALES_TZ.tz, tzLabel: SALES_TZ.label,
      range: { from, to }, days: daysBetween(from, to) + 1,
      currency: site.currency,
      advertiser: { id: adv.id, name: adv.name, accountName: adv.accountName },
      campaignTotal: (campRes && campRes.paging && campRes.paging.total) || campaigns.length,
      campaignsTruncated: !!((campRes && campRes.paging && campRes.paging.total) > campaigns.length),
      activeCampaigns: campaigns.filter(c => c.status === 'active').length,
      pauseCampaigns: campaigns.filter(c => c.status === 'paused').length,
      totals, daily: dailyFixed, campaigns,
      updatedAt: Date.now(),
    };
    adsCache.key = key; adsCache.at = Date.now(); adsCache.data = data;
    res.json(data);
  } catch (e) { sendMlError(res, e); }
});

// ==================== 广告花费「实测」采样器 ====================
// 美客多广告接口只有「当天累计花费」（按天聚合）。当天累计值在盘中是不断上涨的，
// 用它按出单占比分摊到小时，会导致「已经过去的小时」的花费一直漂移。
// 解决办法：每 5 分钟把「当天累计花费」记一次，形成累计曲线；用相邻两次采样的差值
// 反推出每个小时真实花了多少，并在小时结束后「定档」写死（此后永不再变）。
//   实际花费 = 累计花费(小时结束) − 累计花费(小时开始)

const ADS_SETTLE_MS = 12 * 60 * 1000;    // 小时结束后多久定档：美客多落账延迟约 1-3 分钟 + 采样间隔 5 分钟，12 分钟足够（原来 2 小时太保守，导致过去的小时长期停留在分摊估算上而漂移）
const ADS_SAMPLE_EVERY_MS = 5 * 60 * 1000;

// 「小时」的统一口径：固定用 SALES_TZ（巴西时间 GMT-3）。订单 date_created 哪怕字面量是 -04:00，
// 也要换算到巴西时间后再分桶，否则跨天附近会被窗口过滤、出现"订单凭空消失"和"花费被均摊"的 bug。
const BR_OFFSET_MIN = (() => {
  const m = String(SALES_TZ.offset).match(/^([+-])(\d{2}):(\d{2})$/);
  return (m && m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
})();

function loadJsonSafe(p, dflt) { try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); return (d && typeof d === 'object') ? d : dflt; } catch { return dflt; } }
function saveJsonSafe(p, o) { try { fs.writeFileSync(p, JSON.stringify(o), 'utf8'); } catch { } }

// 以下两个函数名沿用 acct*（为减少改动），内部全部以 BR_OFFSET_MIN 算出"巴西时间"下的 date/hourStart
function acctDateStr(ts) { return new Date(ts + BR_OFFSET_MIN * 60000).toISOString().slice(0, 10); }
// 「巴西时间 date 的 hour 点」对应的 epoch 毫秒
function acctHourStart(dateStr, hour) { return Date.parse(dateStr + 'T00:00:00Z') + hour * 3600000 - BR_OFFSET_MIN * 60000; }

// ---------- 广告账本（node:sqlite，Node 22 内置，零依赖）----------
// 为什么要它：每小时花费里「未实测的小时」是分摊出来的，分摊口径一旦随天数变化，
// 同一天就会「今天看一个数、次日看另一个数」。所以把每天的结果固化下来，次日直接读账本、不再重算。
// 规则：当天 level='live' 持续更新；跨天后自动冻结为 'final' 且永不再改；只保留最近 90 天（3 个月）。
const ADS_LEDGER_KEEP_DAYS = 90;

let _adsDb = null, _adsDbPath = '';
function adsDb() {
  let p;
  try { p = privateDataFile('ads-ledger.db'); } catch { return null; }
  if (_adsDb && _adsDbPath === p) return _adsDb;
  if (_adsDb) { try { _adsDb.close(); } catch { } _adsDb = null; _adsDbPath = ''; }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(p);
    try { db.exec('PRAGMA journal_mode=WAL'); } catch { }
    db.exec(`CREATE TABLE IF NOT EXISTS daily (
      date         TEXT PRIMARY KEY,
      cost         REAL    DEFAULT 0,
      ad_amount    REAL    DEFAULT 0,
      ad_units     INTEGER DEFAULT 0,
      orders       INTEGER DEFAULT 0,
      tot_units    INTEGER DEFAULT 0,
      tot_amount   REAL    DEFAULT 0,
      hcost        TEXT,
      horders      TEXT,
      hsrc         TEXT,
      hmeasured    INTEGER DEFAULT 0,
      level        TEXT    DEFAULT 'live',
      observed_at  INTEGER,
      finalized_at INTEGER
    )`);
    _adsDb = db; _adsDbPath = p;
    return db;
  } catch (e) {
    console.error('[广告账本] 打开失败，本次退回实时计算:', e.message);
    _adsDb = null; _adsDbPath = '';
    return null;
  }
}
const num = v => Number(v) || 0;
const int = v => Math.round(Number(v) || 0);
const parseArr = s => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : null; } catch { return null; } };
function mapLedgerRow(r) {
  if (!r) return null;
  return {
    date: r.date, cost: num(r.cost), adAmount: num(r.ad_amount), adUnits: int(r.ad_units),
    orders: int(r.orders), totUnits: int(r.tot_units), totAmount: num(r.tot_amount),
    hcost: parseArr(r.hcost), horders: parseArr(r.horders), hsrc: parseArr(r.hsrc),
    hmeasured: int(r.hmeasured), level: r.level,
    observedAt: r.observed_at || 0, finalizedAt: r.finalized_at || 0,
  };
}
function adsLedgerGet(date) {
  const db = adsDb(); if (!db || !date) return null;
  try { return mapLedgerRow(db.prepare('SELECT * FROM daily WHERE date=?').get(date)); } catch { return null; }
}
// 采样器专用：只写「广告三项」，不碰订单/小时数据（那些由查看接口写）
function adsLedgerUpsertAd(date, cost, adAmount, adUnits) {
  const db = adsDb(); if (!db || !date) return false;
  try {
    const today = acctDateStr(Date.now());
    const cur = adsLedgerGet(date);
    if (cur && cur.level === 'final') return false;            // 已冻结，永不再改
    // 只把「已经过去、且确实有花费」的天冻结；花费为 0 的先留在 live，
    // 免得美客多还没落账（当天看着是 0）就被永久冻结成 0
    const level = (date < today && num(cost) > 0) ? 'final' : 'live';
    const now = Date.now();
    db.prepare(`INSERT INTO daily (date,cost,ad_amount,ad_units,level,observed_at,finalized_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET
        cost=excluded.cost, ad_amount=excluded.ad_amount, ad_units=excluded.ad_units,
        level=excluded.level, observed_at=excluded.observed_at,
        finalized_at=COALESCE(daily.finalized_at, excluded.finalized_at)`)
      .run(date, num(cost), num(adAmount), int(adUnits), level, now, level === 'final' ? now : null);
    return true;
  } catch { return false; }
}
// 查看接口专用：写完整一天（含订单数与 24 小时分布）
function adsLedgerUpsertFull(day) {
  const db = adsDb(); if (!db || !day || !day.date) return false;
  try {
    const today = acctDateStr(Date.now());
    const cur = adsLedgerGet(day.date);
    if (cur && cur.level === 'final') return false;
    const level = (day.date < today && num(day.cost) > 0) ? 'final' : 'live';
    const now = Date.now();
    db.prepare(`INSERT INTO daily (date,cost,ad_amount,ad_units,orders,tot_units,tot_amount,hcost,horders,hsrc,hmeasured,level,observed_at,finalized_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET
        cost=excluded.cost, ad_amount=excluded.ad_amount, ad_units=excluded.ad_units,
        orders=excluded.orders, tot_units=excluded.tot_units, tot_amount=excluded.tot_amount,
        hcost=excluded.hcost, horders=excluded.horders, hsrc=excluded.hsrc, hmeasured=excluded.hmeasured,
        level=excluded.level, observed_at=excluded.observed_at,
        finalized_at=COALESCE(daily.finalized_at, excluded.finalized_at)`)
      .run(day.date, num(day.cost), num(day.adAmount), int(day.adUnits), int(day.orders), int(day.totUnits), num(day.totAmount),
        JSON.stringify(day.hcost || []), JSON.stringify(day.horders || []), JSON.stringify(day.hsrc || []), int(day.hmeasured),
        level, now, level === 'final' ? now : null);
    return true;
  } catch { return false; }
}
// 把「已经过去的、还是 live 的」天冻结掉（跨天那一刻的兜底，防止一直停留在可改写状态）
function adsLedgerFreezePast() {
  const db = adsDb(); if (!db) return 0;
  try {
    const today = acctDateStr(Date.now());
    const r = db.prepare("UPDATE daily SET level='final', finalized_at=COALESCE(finalized_at,?) WHERE level='live' AND date < ? AND cost > 0").run(Date.now(), today);
    return Number(r.changes) || 0;
  } catch { return 0; }
}
// 清理：只保留最近 N 天（默认 90 天 ≈ 3 个月）
function adsLedgerPurge(keepDays) {
  const db = adsDb(); if (!db) return 0;
  try {
    const cut = addDaysStr(acctDateStr(Date.now()), -(keepDays || ADS_LEDGER_KEEP_DAYS));
    const r = db.prepare('DELETE FROM daily WHERE date < ?').run(cut);
    return Number(r.changes) || 0;
  } catch { return 0; }
}

function loadLedger() {
  const o = loadJsonSafe(privateDataFile('ads-hourly.json'), null) || {};
  if (!o.days || typeof o.days !== 'object') o.days = {};
  return o;
}
function saveLedger(o) { saveJsonSafe(privateDataFile('ads-hourly.json'), o); }

// 累计曲线在 T 时刻的值（相邻采样线性插值）
function cumAt(arr, T) {
  if (!arr || !arr.length) return null;
  if (T <= arr[0].t) return arr[0].c;
  const last = arr[arr.length - 1];
  if (T >= last.t) return last.c;
  for (let i = 1; i < arr.length; i++) {
    if (T <= arr[i].t) {
      const a = arr[i - 1], b = arr[i];
      if (b.t === a.t) return b.c;
      return a.c + (b.c - a.c) * (T - a.t) / (b.t - a.t);
    }
  }
  return last.c;
}

// 把已采样的累计曲线物化成「每小时实测花费」，并对已过定档期的小时写死
function materializeLedger(samples) {
  const led = loadLedger();
  led.tz = BR_OFFSET_MIN;
  const now = Date.now();
  const today = acctDateStr(now);
  Object.keys(samples).forEach(date => {
    const arr = (samples[date] || []).slice().sort((a, b) => a.t - b.t);
    if (!arr.length) return;
    const frozen = led.days[date] || (led.days[date] = {});
    for (let h = 0; h < 24; h++) {
      const hs = acctHourStart(date, h), he = hs + 3600000;
      if (now < he + ADS_SETTLE_MS) continue;   // 还没到定档时间
      if (frozen[h]) continue;                  // 已定档，永不再改
      if (hs < arr[0].t) continue;              // 首个采样之前的小时，无法反推
      const c0 = cumAt(arr, hs), c1 = cumAt(arr, he);
      if (c0 == null || c1 == null) continue;
      frozen[h] = { c: round2(Math.max(0, c1 - c0)), src: 'measured' };
    }
    (void today);
  });
  // 与 SQLite 账本同口径：小时台账也只保留最近 N 天（否则这个 JSON 会无限长胖）
  const cut = addDaysStr(acctDateStr(Date.now()), -ADS_LEDGER_KEEP_DAYS);
  Object.keys(led.days).forEach(k => { if (k < cut) delete led.days[k]; });
  saveLedger(led);
}

// 每 5 分钟采一次：一次请求拿到最近几天的按天花费（历史日期是终值，今天的是累计值）
async function adsSampleOnce() {
  const cfg = loadConfig();
  if (!mlConfigured(cfg) || !mlAuthorized(cfg)) return;
  try {
    const siteCode = String(mlEffectiveSite(cfg.mlSite) || 'MLB').toUpperCase();
    const adv = await mlAdvertiser(siteCode);
    const today = acctDateStr(Date.now());
    const from = addDaysStr(today, -3);
    const d = await mlRequest(
      `/advertising/${adv.site}/advertisers/${adv.id}/product_ads/campaigns/search?date_from=${from}&date_to=${today}&metrics=${ADS_FIELDS}&aggregation_type=DAILY&limit=1&offset=0`,
      { headers: { 'api-version': '2' } }
    );
    const rows = (((d && d.results) || [])).map(adsRow);
    const now = Date.now();
    const samples = loadJsonSafe(privateDataFile('ads-cost-samples.json'), {});
    rows.forEach(r => {
      if (!r.date) return;
      const arr = samples[r.date] || (samples[r.date] = []);
      const cost = round2(Number(r.cost) || 0);
      const last = arr[arr.length - 1];
      if (last && Math.abs(last.c - cost) < 0.001 && now - last.t < 4 * 60000) return; // 值没变且刚采过
      arr.push({ t: now, c: cost });
      if (arr.length > 1500) arr.splice(0, arr.length - 1500);
    });
    const keep = new Set();
    for (let i = 0; i <= 6; i++) keep.add(addDaysStr(today, -i));
    Object.keys(samples).forEach(k => { if (!keep.has(k)) delete samples[k]; });
    saveJsonSafe(privateDataFile('ads-cost-samples.json'), samples);
    materializeLedger(samples);

    // 写广告账本：当天持续更新(live)，跨天自动冻结(final 后永不再改)
    rows.forEach(r => { if (r.date) adsLedgerUpsertAd(r.date, r.cost, r.totalAmount, r.units); });
    adsLedgerFreezePast();
    adsLedgerPurge();   // 只留最近 90 天（3 个月）
  } catch { /* 采样失败静默，下轮再试 */ }
}

let adsSampleTimer = null;
function startAdsSampler() {
  if (adsSampleTimer) return;
  // 启动即清一次超出保留期的历史（默认 90 天 ≈ 3 个月）
  try {
    const del = adsLedgerPurge();
    if (del) console.log(`  广告账本：已清理 ${del} 天超过保留期（${ADS_LEDGER_KEEP_DAYS} 天）的历史数据`);
  } catch { }
  setTimeout(() => { adsSampleOnce(); }, 20000);
  adsSampleTimer = setInterval(() => { adsSampleOnce(); }, ADS_SAMPLE_EVERY_MS);
  console.log('  广告花费采样器已启动（每 5 分钟记录一次当天累计花费，用于反推真实小时花费）');
}

// ---- 广告分时分布（按小时看花费 / 出单）----
// 事实：美客多广告接口 aggregation_type 只支持 CAMPAIGN / DAILY —— 官方没有「按小时」花费。
// 本接口口径：
//   出单数量 = 按订单创建时间（统一换算为巴西时间 GMT-3）真实分桶
//   每小时花费 = 当天广告花费 ×（该小时出单 ÷ 当天出单）分摊 —— 估算值，只用于看投放时段结构
const adsHourlyCache = { key: '', at: 0, data: null };

// 从订单时间戳里取「巴西时间」的年-月-日 与 小时（无论 date_created 字面量是 -03:00 还是 -04:00，
// 都按 SALES_TZ 换算后再分桶，与查询窗口、实测台账、当前时间保持一致——避免跨天附近被窗口过滤掉）
function orderLocalHM(iso) {
  const p = tzParts(iso, SALES_TZ.tz);
  if (!p) return null;
  return { date: p.date, hour: p.hour };
}

app.get('/api/ml/ads/hourly', async (req, res) => {
  const cfg = loadConfig();
  if (!mlConfigured(cfg)) return res.json({ configured: false, authorized: false, ok: false, needConfig: true, message: '尚未配置美客多 API 凭证' });
  if (!mlAuthorized(cfg)) return res.json({ configured: true, authorized: false, ok: false, needAuth: true, message: '凭证已保存，但还没完成美客多账号授权' });
  try {
    const u = await mlUser();
    const today = tzToday();
    let to = isDateStr(req.query.to) ? String(req.query.to) : today;
    let from = isDateStr(req.query.from) ? String(req.query.from) : addDaysStr(to, -6);
    if (from > to) { const t = from; from = to; to = t; }
    if (daysBetween(from, to) > ADS_MAX_DAYS - 1) from = addDaysStr(to, -(ADS_MAX_DAYS - 1));

    const siteCode = String(mlEffectiveSite(cfg.mlSite) || u.site_id || 'MLB').toUpperCase();
    const site = mlSite(siteCode);
    const adv = await mlAdvertiser(siteCode);

    const key = `${adv.id}|${u.id}|${from}|${to}`;
    if (adsHourlyCache.key === key && Date.now() - adsHourlyCache.at < 60000) return res.json({ ...adsHourlyCache.data, cached: true });

    // 1) 订单：前后各多取一天做缓冲，最终按订单自带本地日期过滤/分桶
    const CAP = 2400;
    const qFrom = `${addDaysStr(from, -1)}T00:00:00.000${SALES_TZ.offset}`;
    const qTo = `${addDaysStr(to, 1)}T23:59:59.999${SALES_TZ.offset}`;
    const url = (off) => `/orders/search?seller=${u.id}&order.date_created.from=${encodeURIComponent(qFrom)}&order.date_created.to=${encodeURIComponent(qTo)}&sort=date_asc&limit=50&offset=${off}`;

    const first = await mlRequest(url(0));
    const apiTotal = (first && first.paging && first.paging.total) || ((first && first.results) || []).length;
    const all = [...(((first && first.results) || []))];
    const pages = Math.min(Math.ceil(Math.min(apiTotal, CAP) / 50), 48);
    let cursor = 1;
    await Promise.all(Array.from({ length: Math.min(8, Math.max(0, pages - 1)) }, async () => {
      for (;;) {
        const p = cursor++;
        if (p >= pages) return;
        try { const d = await mlRequest(url(p * 50)); all.push(...(((d && d.results) || []))); } catch { }
      }
    }));

    const dayMap = new Map();      // date -> { orders, amount, units, hours[24], hourAmount[24] }
    let kept = 0, cancelled = 0;
    for (const o of all) {
      if (!o || !o.date_created) continue;
      const hm = orderLocalHM(o.date_created);
      if (!hm || hm.date < from || hm.date > to) continue;
      const st = String(o.status || '');
      if (st === 'cancelled' || st === 'invalid') { cancelled++; continue; }
      let d = dayMap.get(hm.date);
      if (!d) { d = { orders: 0, amount: 0, units: 0, hours: new Array(24).fill(0), hourAmount: new Array(24).fill(0) }; dayMap.set(hm.date, d); }
      const items = o.order_items || [];
      const qty = items.reduce((s, it) => s + (Number(it.quantity) || 1), 0) || 1;
      const amt = Number(o.total_amount) || 0;
      d.orders += 1; d.hours[hm.hour] += 1; d.amount += amt; d.hourAmount[hm.hour] += amt; d.units += qty;
      kept++;
    }

    // 2) 广告按天数据（失败也照常返回订单分时）
    let dailyRes = null;
    try {
      dailyRes = await mlRequest(
        `/advertising/${adv.site}/advertisers/${adv.id}/product_ads/campaigns/search?date_from=${from}&date_to=${to}&metrics=${ADS_FIELDS}&aggregation_type=DAILY&limit=1&offset=0`,
        { headers: { 'api-version': '2' } }
      );
    } catch { }
    const adByDate = new Map((((dailyRes && dailyRes.results) || [])).map(adsRow).map(r => [r.date, r]));

    // 2.5) 当前时刻（用于判断某小时是否已经开始 / 已经结束）
    const nowTs = Date.now();

    // 3) 汇总
    //   小时花费口径（本段是关键）：
    //     · 已实测(定档)的小时 → 用实测值，不参与分摊；
    //     · 其余金额 = 当天总额 − 已实测合计，按出单占比「一次性」分摊到未实测的小时。
    //   分母统一取「未实测小时的出单总数」，所以 Σ(小时花费) 恒等于当天总额。
    //   ⚠️ 旧代码里"过去的小时"用的是「截至该小时的累计单量」当分母，Σ 会远大于当天总额
    //      （3 单分落 10/11/12 点时会算出 1 + 1/2 + 1/3 = 1.83 倍）——
    //      这正是「今天看是对的、次日回看数值膨胀」的根因。
    //   已冻结(level=final)的天：花费/广告销售额/广告单量一律读账本，不再用实时接口重算
    //      → 同一天「今天看到的」与「次日回看的」完全一致。
    const led = loadLedger();
    // 采样累计曲线：用来「实时反推」还没到定档时间的小时（这一步才是"记录"出来的花费，不是摊出来的）
    const samples = loadJsonSafe(privateDataFile('ads-cost-samples.json'), {});
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, amount: 0, cost: 0, measured: 0 }));
    const byDay = [];
    let totOrders = 0, totAmount = 0, totUnits = 0, totCost = 0, totAdUnits = 0, totAdAmount = 0;
    let measuredSlots = 0, finalDays = 0;
    const n = daysBetween(from, to) + 1;
    for (let i = 0; i < n; i++) {
      const date = addDaysStr(from, i);
      const d = dayMap.get(date) || { orders: 0, amount: 0, units: 0, hours: new Array(24).fill(0), hourAmount: new Array(24).fill(0) };
      const ad = adByDate.get(date) || { cost: 0, units: 0, totalAmount: 0 };
      const book = adsLedgerGet(date);
      const isFinal = !!(book && book.level === 'final');   // 已冻结：账本为准
      if (isFinal) finalDays++;
      const adCost = isFinal ? num(book.cost) : (Number(ad.cost) || 0);
      const adUnits = isFinal ? book.adUnits : (Number(ad.units) || 0);
      const adAmount = isFinal ? book.adAmount : (Number(ad.totalAmount) || 0);

      const frozen = led.days[date] || {};
      const hoursCost = new Array(24).fill(0);
      const hoursSrc = new Array(24).fill('est');
      const isFixed = new Array(24).fill(false);   // 已定值的小时（不管是定档还是采样反推），一律不再参与分摊

      // ① 已定档的实测小时：直接用
      let fixedSum = 0;
      for (let h = 0; h < 24; h++) {
        const fz = frozen[h];
        if (fz && typeof fz.c === 'number') {
          hoursCost[h] = num(fz.c); hoursSrc[h] = 'measured'; isFixed[h] = true; fixedSum += hoursCost[h];
        }
      }
      // ② 还没定档、但有采样曲线覆盖的小时：用相邻采样差值「实时反推」真实花费。
      //    采样器每 5 分钟记一次「当天累计花费」，所以
      //        这一小时的花费 = 累计(该小时结束或此刻) − 累计(该小时开始)
      //    —— 这才是"记录"出来的值。千万别只等定档，否则凌晨刚过的那些小时会全部落进分摊，看着像均摊。
      const sampArr = (samples[date] || []).slice().sort((a, b) => a.t - b.t);
      const dayStartTs = acctHourStart(date, 0);
      if (sampArr.length) {
        for (let h = 0; h < 24; h++) {
          if (isFixed[h]) continue;
          const hs = acctHourStart(date, h), he = hs + 3600000;
          if (hs > nowTs) break;                                       // 这一小时还没开始，保持 0
          const c0 = (hs <= dayStartTs) ? 0                            // 当天 00:00 起算，基线为 0
            : (hs < sampArr[0].t ? null : cumAt(sampArr, hs));         // 早于首个采样点 → 反推不了
          const endT = Math.min(nowTs, he);
          const c1 = (endT >= sampArr[0].t) ? cumAt(sampArr, endT) : null;
          if (c0 == null || c1 == null) continue;                      // 覆盖不到 → 留给 ③ 兜底
          hoursCost[h] = Math.max(0, c1 - c0);
          hoursSrc[h] = (he <= nowTs) ? 'measured' : 'progress';
          isFixed[h] = true; fixedSum += hoursCost[h];
        }
      }
      // ③ 兜底：采样完全覆盖不到的小时（典型是服务启动前那几个小时），
      //    用「当天总额 − 已定值合计」按出单占比分摊；**只分给已经开始的小时**，未来的小时保持 0（不然凌晨看就像人均摊）。
      const restAmt = Math.max(0, adCost - fixedSum);
      if (restAmt > 0) {
        const pending = [];
        for (let h = 0; h < 24; h++) if (!isFixed[h] && acctHourStart(date, h) <= nowTs) pending.push(h);
        if (pending.length) {
          let pool = 0;
          for (const h of pending) pool += Number(d.hours[h]) || 0;
          for (const h of pending) {
            hoursCost[h] = pool > 0 ? restAmt * ((Number(d.hours[h]) || 0) / pool) : restAmt / pending.length;
            const he = acctHourStart(date, h) + 3600000;
            hoursSrc[h] = (he <= nowTs) ? 'est' : 'progress';
          }
        }
      }

      for (let h = 0; h < 24; h++) {
        hourly[h].orders += Number(d.hours[h]) || 0;
        hourly[h].amount += Number(d.hourAmount[h]) || 0;
        hourly[h].cost += hoursCost[h];
        if (hoursSrc[h] === 'measured') { hourly[h].measured++; measuredSlots++; }
      }
      totOrders += d.orders; totAmount += d.amount; totUnits += d.units; totCost += adCost;
      totAdUnits += adUnits; totAdAmount += adAmount;
      byDay.push({
        date, orders: d.orders, amount: round2(d.amount), units: d.units,
        adCost: round2(adCost), adUnits, adAmount: round2(adAmount),
        hours: d.hours, hoursCost: hoursCost.map(round3), hoursSrc,
        measured: hoursSrc.filter(s => s === 'measured').length,
        final: isFinal,
      });
      // 写账本（已冻结的会被拒绝，不会覆盖）
      if (!isFinal) {
        adsLedgerUpsertFull({
          date, cost: adCost, adAmount, adUnits,
          orders: d.orders, totUnits: d.units, totAmount: d.amount,
          hcost: hoursCost.map(round3), horders: d.hours, hsrc: hoursSrc,
          hmeasured: hoursSrc.filter(s => s === 'measured').length,
        });
      }
    }
    hourly.forEach(h => { h.amount = round2(h.amount); h.cost = round3(h.cost); });

    const peak = hourly.reduce((a, b) => (b.orders > a.orders ? b : a), hourly[0]);

    const data = {
      ok: true, site: adv.site || siteCode, siteName: site.name,
      currency: site.currency, tz: SALES_TZ.tz, tzOffset: SALES_TZ.offset,
      tzLabel: SALES_TZ.label,
      range: { from, to }, days: n,
      advertiser: { id: adv.id, name: adv.name },
      orders: { total: totOrders, cancelled, amount: round2(totAmount), units: totUnits },
      ads: { cost: round2(totCost), units: totAdUnits, amount: round2(totAdAmount) },
      hourly, byDay, peakHour: peak ? peak.hour : null,
      adsAvailable: !!dailyRes,
      truncated: apiTotal > all.length, apiTotal, fetched: all.length,
      measuredSlots, totalSlots: n * 24,
      // 账本状态：finalDays 表示这几天里已「冻结」的天数（冻结后数值不再变化）
      ledger: { finalDays, days: n, keepDays: ADS_LEDGER_KEEP_DAYS, on: !!adsDb() },
      note: '出单数量按订单创建时间（统一换算为巴西时间 GMT-3）真实分桶。每小时花费：服务器每 5 分钟记录一次「当天累计花费」，用相邻采样差值反推出每小时真实花费，小时结束后 12 分钟定档（实测，此后不再变化）；没能反推的小时，用「当天官方总额 − 已实测合计」按出单占比分摊，因此各小时加起来恒等于当天总额。当天的值会随投放继续更新；跨天后写入本地账本并冻结，此后不再变化（账本保留最近 90 天）。',
      updatedAt: Date.now(),
    };
    adsHourlyCache.key = key; adsHourlyCache.at = Date.now(); adsHourlyCache.data = data;
    res.json(data);
  } catch (e) { sendMlError(res, e); }
});

// ---- 订单列表 ----
app.get('/api/ml/orders', async (req, res) => {
  try {
    const u = await mlUser();
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    // todo=1：只看需要卖家动手发货的（自发货 / 需要打面单的），官方代发不算
    if (req.query.todo === '1') {
      const CAP = 300;
      const all = [];
      for (let off = 0; off < CAP; off += 50) {
        const d = await mlRequest(`/orders/search?seller=${u.id}&sort=date_desc&limit=50&offset=${off}&order.status=paid&tags=not_delivered`);
        all.push(...((d && d.results) || []));
        const total = (d && d.paging && d.paging.total) || 0;
        if (!all.length || all.length >= total || all.length >= CAP) break;
      }
      const norm = all.map(normalizeOrder);
      const cls = (await classifyShips(norm.map(o => o.shippingId))).map;
      const todo = norm
        .map(o => {
          const s = cls[o.shippingId] || null;
          return { ...o, shipMode: s ? s.mode : '', shipLogistic: s ? s.logistic : '', shipLabel: s ? s.label : '未知', shipStatus: s ? s.status : '', needShip: s ? s.needShip : true };
        })
        .filter(o => o.needShip);
      return res.json({
        ok: true, todo: true, total: todo.length, pendingAll: norm.length,
        statusLabels: ML_ORDER_STATUS,
        orders: todo.slice(offset, offset + limit),
      });
    }
    const parts = [`seller=${u.id}`, 'sort=date_desc', `limit=${limit}`, `offset=${offset}`];
    if (req.query.status) parts.push(`order.status=${encodeURIComponent(req.query.status)}`);
    if (req.query.tag) parts.push(`tags=${encodeURIComponent(req.query.tag)}`);
    const d = await mlRequest('/orders/search?' + parts.join('&'));
    const norm = ((d && d.results) || []).map(normalizeOrder);
    // 待发货订单顺带查发货方式（有持久缓存，首次慢一点之后零开销）
    const pending = norm.filter(o => o.delivery === 'pending');
    const cls = pending.length ? (await classifyShips(pending.map(o => o.shippingId))).map : {};
    const orders = norm.map(o => {
      if (o.delivery !== 'pending') return o;
      const s = cls[o.shippingId] || null;
      return { ...o, shipMode: s ? s.mode : '', shipLogistic: s ? s.logistic : '', shipLabel: s ? s.label : '未知', shipStatus: s ? s.status : '', needShip: s ? s.needShip : true };
    });
    res.json({
      ok: true, total: (d && d.paging && d.paging.total) || 0,
      orders, statusLabels: ML_ORDER_STATUS,
    });
  } catch (e) { sendMlError(res, e); }
});

// ---- 商品问答 ----
// ---- 关键词自动回复（配置与运行状态严格按 ML Suite 账号隔离） ----
const QUESTION_AUTO_REPLY_FILE = 'question-auto-reply.json';
const QUESTION_AUTO_REPLY_INTERVAL_MS = 60000;
const QUESTION_AUTO_REPLY_MAX_SENDS_PER_TICK = 5;
const questionAutoReplyTimers = new Map();
const questionAutoReplyInFlight = new Set();
function defaultQuestionAutoReplyState() {
  // autoReplied: { [questionId]: { at: 毫秒, ruleId, ruleLabel } } —— 只记「本系统真的回成功了」的。
  // 和 processedIds 的区别很关键：processedIds 是「别再碰这条」（包含别人已回、提问已失效），
  // 而 autoReplied 是「我们替用户回了」。推送文案只认后者，不能把「别碰」说成「已自动回复」。
  return { enabled: false, rules: [], processedIds: [], autoReplied: {}, lastCheckAt: 0, lastReplyAt: 0, lastReplyQuestionId: '', lastReplyRuleId: '', totalReplies: 0, lastError: '', lastSummary: '尚未运行' };
}
const AUTO_REPLIED_KEEP_MAX = 300;
function pruneAutoReplied(map) {
  const entries = Object.entries(map && typeof map === 'object' ? map : {});
  if (entries.length <= AUTO_REPLIED_KEEP_MAX) return Object.fromEntries(entries);
  // 按时间留最新的，防止这个 map 无限长
  entries.sort((a, b) => (Number(b[1] && b[1].at) || 0) - (Number(a[1] && a[1].at) || 0));
  return Object.fromEntries(entries.slice(0, AUTO_REPLIED_KEEP_MAX));
}
function readQuestionAutoReplyState() {
  const fallback = defaultQuestionAutoReplyState();
  try {
    const raw = JSON.parse(fs.readFileSync(privateDataFile(QUESTION_AUTO_REPLY_FILE), 'utf8')) || {};
    fallback.enabled = raw.enabled === true;
    fallback.rules = questionAutoReply.sanitizeRules(raw.rules || [], () => 'rule-' + randomBytes(8).toString('hex'));
    fallback.processedIds = questionAutoReply.keepRecentIds(raw.processedIds);
    fallback.autoReplied = pruneAutoReplied(raw.autoReplied);
    fallback.lastCheckAt = Number(raw.lastCheckAt) || 0;
    fallback.lastReplyAt = Number(raw.lastReplyAt) || 0;
    fallback.lastReplyQuestionId = String(raw.lastReplyQuestionId || '');
    fallback.lastReplyRuleId = String(raw.lastReplyRuleId || '');
    fallback.totalReplies = Math.max(0, Number(raw.totalReplies) || 0);
    fallback.lastError = String(raw.lastError || '').slice(0, 500);
    fallback.lastSummary = String(raw.lastSummary || '尚未运行').slice(0, 500);
  } catch { /* 首次使用时返回空配置 */ }
  return fallback;
}
function writeQuestionAutoReplyState(state) {
  const next = {
    ...defaultQuestionAutoReplyState(),
    ...state,
    rules: questionAutoReply.sanitizeRules(state.rules || [], () => 'rule-' + randomBytes(8).toString('hex')),
    processedIds: questionAutoReply.keepRecentIds(state.processedIds),
    autoReplied: pruneAutoReplied(state.autoReplied),
  };
  fs.writeFileSync(privateDataFile(QUESTION_AUTO_REPLY_FILE), JSON.stringify(next, null, 2), 'utf8');
  return next;
}
function stopQuestionAutoReplyMonitor(uid) {
  const slot = questionAutoReplyTimers.get(String(uid));
  if (!slot) return;
  if (slot.tick) clearInterval(slot.tick);
  if (slot.boot) clearTimeout(slot.boot);
  questionAutoReplyTimers.delete(String(uid));
}
function scheduleQuestionAutoReplyMonitor(uid) {
  const targetId = String(uid || auth.currentUserId());
  stopQuestionAutoReplyMonitor(targetId);
  const state = auth.runAsUser(targetId, () => readQuestionAutoReplyState());
  if (!state.enabled || !state.rules.some(rule => rule.enabled)) return;
  const slot = { busy: false, tick: null, boot: null };
  const run = () => {
    if (slot.busy || questionAutoReplyInFlight.has(targetId)) return;
    slot.busy = true;
    questionAutoReplyInFlight.add(targetId);
    auth.runAsUser(targetId, () => runQuestionAutoReplyCheck())
      .catch(err => auth.runAsUser(targetId, () => {
        const state = readQuestionAutoReplyState();
        state.lastCheckAt = Date.now();
        state.lastError = String(err.message || '检查失败').slice(0, 500);
        state.lastSummary = '自动回复检查失败；请检查美客多 API 连接。';
        writeQuestionAutoReplyState(state);
        console.warn('[自动回复] 账号 ' + targetId + ' 检查失败：' + err.message);
      }))
      .finally(() => { slot.busy = false; questionAutoReplyInFlight.delete(targetId); });
  };
  slot.tick = setInterval(run, QUESTION_AUTO_REPLY_INTERVAL_MS);
  if (slot.tick.unref) slot.tick.unref();
  slot.boot = setTimeout(run, 8000);
  if (slot.boot.unref) slot.boot.unref();
  questionAutoReplyTimers.set(targetId, slot);
  console.log('[自动回复] 账号 ' + targetId + ' 关键词监控已启动，每分钟检查一次');
}
function scheduleAllQuestionAutoReplyMonitors() {
  let count = 0;
  for (const user of auth.users()) {
    if (user.status !== 'approved') continue;
    try {
      const state = auth.runAsUser(user.id, () => readQuestionAutoReplyState());
      if (state.enabled && state.rules.some(rule => rule.enabled)) {
        scheduleQuestionAutoReplyMonitor(user.id);
        count++;
      }
    } catch (err) { console.warn('[自动回复] 账号 ' + user.id + ' 排期失败：' + err.message); }
  }
  return count;
}
async function runQuestionAutoReplyCheck() {
  let state = readQuestionAutoReplyState();
  if (!state.enabled) return { checked: 0, sent: 0 };
  const cfg = loadConfig();
  if (!mlConfigured(cfg)) throw Object.assign(new Error('尚未配置美客多 API 凭证'), { needConfig: true });
  if (!mlAuthorized(cfg)) throw Object.assign(new Error('美客多账号尚未授权'), { needAuth: true });
  const user = await mlUser();
  const query = 'seller_id=' + encodeURIComponent(user.id) + '&status=UNANSWERED&limit=50&sort_fields=date_created&sort_types=DESC';
  const response = await mlRequest('/questions/search?' + query);
  const questions = ((response && (response.questions || response.results)) || []).slice();
  questions.sort((a, b) => String(a.date_created || '').localeCompare(String(b.date_created || '')));
  let processed = new Set(state.processedIds);
  let matched = 0, sent = 0, attempts = 0, failure = '';
  for (const question of questions) {
    const questionId = String(question.id || question.question_id || '').trim();
    if (!questionId || processed.has(questionId)) continue;
    // 在每次发送前重新读本账号配置。用户关闭开关或编辑规则时，
    // 不让正在进行中的旧轮询继续使用过期配置发送。
    state = readQuestionAutoReplyState();
    if (!state.enabled) return { checked: questions.length, matched, sent, disabled: true };
    processed = new Set(state.processedIds);
    if (processed.has(questionId)) continue;
    const rule = questionAutoReply.matchRule(question.text || '', state.rules);
    if (!rule) continue;
    matched++;
    if (attempts >= QUESTION_AUTO_REPLY_MAX_SENDS_PER_TICK) break;
    attempts++;
    try {
      const qid = /^[0-9]+$/.test(questionId) ? Number(questionId) : questionId;
      await mlRequest('/answers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question_id: qid, text: rule.reply }),
      });
      state = readQuestionAutoReplyState();
      state.processedIds = questionAutoReply.keepRecentIds(state.processedIds.concat(questionId));
      // 记一笔「我们替用户回了」。推送那边靠这个 map 决定要不要打「已自动回复 · 无需处理」。
      state.autoReplied = pruneAutoReplied({
        ...state.autoReplied,
        [questionId]: { at: Date.now(), ruleId: rule.id, ruleLabel: (rule.keywords || []).join(' / ').slice(0, 40) },
      });
      state.totalReplies++;
      state.lastReplyAt = Date.now();
      state.lastReplyQuestionId = questionId;
      state.lastReplyRuleId = rule.id;
      state.lastError = '';
      processed = new Set(state.processedIds);
      sent++;
      console.log('[自动回复] 账号 ' + auth.currentUserId() + ' 已回复提问 #' + questionId + '（规则 ' + rule.id + '）');
      writeQuestionAutoReplyState(state);
    } catch (err) {
      const message = String(err.message || '自动回复失败');
      state = readQuestionAutoReplyState();
      if (/already.{0,30}(answer|repl)|question.{0,30}(not found|does not exist)|not_found/i.test(message)) {
        state.processedIds = questionAutoReply.keepRecentIds(state.processedIds.concat(questionId));
        processed = new Set(state.processedIds);
      }
      failure = message.slice(0, 500);
      state.lastError = failure;
      state.lastSummary = '提问 #' + questionId + ' 自动回复失败；请检查规则或美客多状态。';
      writeQuestionAutoReplyState(state);
      console.warn('[自动回复] 账号 ' + auth.currentUserId() + ' 回复提问 #' + questionId + ' 失败：' + message);
      break;
    }
  }
  state = readQuestionAutoReplyState();
  if (!state.enabled) return { checked: questions.length, matched, sent, disabled: true };
  state.lastCheckAt = Date.now();
  state.lastError = failure;
  state.lastSummary = failure
    ? '检查未回复提问 ' + questions.length + ' 条；本轮发送 ' + sent + ' 条后遇到错误。'
    : '检查未回复提问 ' + questions.length + ' 条；命中规则 ' + matched + ' 条；本轮发送 ' + sent + ' 条。';
  writeQuestionAutoReplyState(state);
  return { checked: questions.length, matched, sent };
}

app.get('/api/ml/questions/auto-reply', (req, res) => {
  try {
    const state = readQuestionAutoReplyState();
    res.json({
      ok: true,
      enabled: state.enabled,
      rules: state.rules,
      status: {
        running: questionAutoReplyTimers.has(auth.currentUserId()),
        lastCheckAt: state.lastCheckAt,
        lastReplyAt: state.lastReplyAt,
        lastReplyQuestionId: state.lastReplyQuestionId,
        totalReplies: state.totalReplies,
        lastError: state.lastError,
        lastSummary: state.lastSummary,
      },
    });
  } catch (err) { res.status(500).json({ ok: false, error: '读取自动回复规则失败：' + err.message }); }
});
app.put('/api/ml/questions/auto-reply', (req, res) => {
  try {
    const body = req.body || {};
    const enabled = body.enabled === true;
    const rules = questionAutoReply.sanitizeRules(body.rules, () => 'rule-' + randomBytes(8).toString('hex'));
    if (enabled && !rules.some(rule => rule.enabled)) return res.status(400).json({ ok: false, error: '请至少启用一条回复规则后再开启自动回复' });
    if (enabled) {
      const cfg = loadConfig();
      if (!mlConfigured(cfg)) return res.status(400).json({ ok: false, error: '请先配置美客多 API 凭证' });
      if (!mlAuthorized(cfg)) return res.status(400).json({ ok: false, error: '请先完成美客多账号授权' });
    }
    const state = readQuestionAutoReplyState();
    state.enabled = enabled;
    state.rules = rules;
    state.lastError = '';
    state.lastSummary = enabled ? '自动回复已开启，等待下一轮检查。' : '自动回复已关闭。';
    writeQuestionAutoReplyState(state);
    scheduleQuestionAutoReplyMonitor(auth.currentUserId());
    res.json({ ok: true, enabled: state.enabled, rules: state.rules, status: { running: questionAutoReplyTimers.has(auth.currentUserId()), lastCheckAt: state.lastCheckAt, lastReplyAt: state.lastReplyAt, totalReplies: state.totalReplies, lastError: state.lastError, lastSummary: state.lastSummary } });
  } catch (err) { res.status(400).json({ ok: false, error: err.message || '保存自动回复规则失败' }); }
});
// 示例数据（仅在 ?demo=1 时返回，用于在没有真实提问时预览界面效果）
function demoQuestions() {
  const now = Date.now();
  // id 一律以 demo- 开头，服务端据此识别示例模式，绝不会误发到美客多
  const mk = (n, text, title, permalink, minsAgo, answer) => ({
    id: 'demo-' + n, text, status: answer ? 'ANSWERED' : 'UNANSWERED', date: new Date(now - minsAgo * 60000).toISOString(),
    itemId: 'MLB' + (3000000000 + n), itemTitle: title, permalink,
    fromId: 100000000 + (n % 9999),
    answer: answer ? { text: answer, date: new Date(now - (minsAgo - 20) * 60000).toISOString() } : null,
  });
  return {
    ok: true, demo: true, total: 4, status: 'UNANSWERED',
    questions: [
      mk(910001, 'Boa tarde! Esse headset tem entrada P2 de 3,5mm ou só USB? Preciso usar no PS4.',
        'Headset Gamer Nubwo® U3 Fone 3d Estéreo Ouvido Para Pc Ps4 Prateado',
        'https://produto.mercadolivre.com.br/MLB-0000000001', 12),
      mk(910002, 'Oi, vocês emitem nota fiscal? Preciso para garantia na empresa.',
        'Fone Gamer Bg02 3d Surround Ouvido Headset Para Pc,ps,xbox',
        'https://produto.mercadolivre.com.br/MLB-0000000002', 48),
      mk(910003, 'Consigo usar no Xbox Series S sem adaptador? Vem com cabo óptico?',
        'Fone Nubwo Hg04l Headset Gamer Surround 7.1 Ouvido Para Pc,Xbox,PS',
        'https://produto.mercadolivre.com.br/MLB-0000000004', 180),
      mk(910004, 'Esse modelo tem microfone removível? E qual o prazo de entrega para o CEP 01310-100?',
        'Fone de ouvido Nubwo HW02 Negócios Headset Unidade de controle de som com conexão USB',
        'https://produto.mercadolivre.com.br/MLB-0000000008', 320,
        'Olá! Sim, o microfone é removível e o prazo para o CEP informado é de 2 a 4 dias úteis. Qualquer dúvida estamos à disposição!'),
    ],
  };
}

app.get('/api/ml/questions', async (req, res) => {
  try {
    if (req.query.demo === '1') return res.json(demoQuestions());
    const u = await mlUser();
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const status = String(req.query.status || 'UNANSWERED').toUpperCase();
    // 美客多默认按创建时间「升序」翻页（offset 0 = 最旧），显式指定倒序，保证「最新在前」
    const d = await mlRequest(`/questions/search?seller_id=${u.id}&status=${status}&limit=${limit}&offset=${offset}&sort_fields=date_created&sort_types=DESC`);
    const list = (d && (d.questions || d.results)) || [];
    const titles = await mlItemTitles(list.map(q => q.item_id));
    res.json({ ok: true, total: (d && d.total) != null ? d.total : list.length, status, questions: list.map(q => normalizeQuestion(q, titles)) });
  } catch (e) { sendMlError(res, e); }
});

// 回复提问（POST /answers，官方接口，字段：question_id + text）
app.post('/api/ml/questions/:id/answer', async (req, res) => {
  try {
    const raw = String(req.params.id);
    const text = ((req.body && req.body.text) || '').trim();
    if (!text) return res.json({ ok: false, error: '回复内容不能为空' });
    if (text.length > 2000) return res.json({ ok: false, error: '回复内容不能超过 2000 个字符（当前 ' + text.length + '）' });
    if (/^demo/i.test(raw)) return res.json({ ok: true, demo: true, message: '示例模式：未真正发送回复' });
    const qid = /^\d+$/.test(raw) ? Number(raw) : raw;
    const d = await mlRequest('/answers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: qid, text }),
    });
    console.log('[问答] 已回复提问 #' + raw);
    res.json({ ok: true, answer: d });
  } catch (e) {
    const msg = String(e.message || '');
    let hint = '';
    if (/text can't be null|text_is_blank/i.test(msg)) hint = '回复内容为空，美客多拒绝了这次提交。';
    else if (/not_found|Question not found|404/i.test(msg)) hint = '这条提问不存在或已被删除，刷新列表即可。';
    else if (/already|answered/i.test(msg)) hint = '这条提问已经回复过了，美客多不允许重复回复。';
    else if (/forbidden|403/i.test(msg)) hint = '没有权限回复这条提问（可能不是你的商品）。';
    if (hint) return res.json({ ok: false, error: msg, hint, status: e.status || 0 });
    return sendMlError(res, e);
  }
});

// ---- 示例数据：退货与投诉（覆盖三类：平台调解 / 买家咨询 / 无需操作） ----
function demoClaims() {
  const now = Date.now();
  const mk = (id, rid, type, stage, reasonId, reasonName, detail, amount, minsAgo, actions, thread) => {
    const isMediation = String(type).toLowerCase() === 'mediations' || String(stage).toLowerCase() === 'dispute';
    const t = thread || { buyerMessages: 0, sellerMessages: 0, mediatorMessages: 0, total: 0, lastSender: '' };
    const base = {
      id: 'demo-' + id, status: 'opened', stage, type, typeText: claimTypeText(type),
      isMediation, resource: 'order', resourceId: String(rid), reasonId, reasonName, reason: detail,
      expected: ['return_product'], fulfilled: true, relatedEntities: ['return'],
      date: new Date(now - minsAgo * 60000).toISOString(), lastUpdated: new Date(now - 30 * 60000).toISOString(),
      amount, currency: 'BRL', quantity: 1, quantityType: 'total',
      buyerId: '3135696179', sellerId: '2079199901', actions,
      canReply: isMediation || actions.includes('send_message_to_complainant'),
      canSendNow: actions.includes('send_message_to_complainant') || actions.includes('send_message_to_mediator'),
      replyTarget: isMediation ? 'mediator' : 'buyer',
      replyRole: actions.includes('send_message_to_mediator') ? 'mediator'
        : actions.includes('send_message_to_complainant') ? 'complainant'
        : (isMediation ? 'mediator' : 'complainant'),
      canRefund: actions.includes('refund'), canDispute: actions.includes('open_dispute'), players: [],
    };
    const category = classifyClaim(base, t);
    const meta = CLAIM_CAT[category] || CLAIM_CAT.auto;
    const ignored = isIgnored(base.id);
    return {
      ...base, category, categoryLabel: meta.label, categoryDesc: meta.desc,
      needAction: !!meta.need && !ignored, ignored,
      messageCount: t.total, buyerMessages: t.buyerMessages, mediatorMessages: t.mediatorMessages,
      lastSender: t.lastSender, awaitingSeller: base.canSendNow && /complainant|buyer|mediator/i.test(t.lastSender || ''),
    };
  };
  const items = [
    mk(5592361001, 2000018771245003, 'mediations', 'dispute', 'PDD9551', 'not_delivered',
      'Não recebi o produto até hoje e já passou do prazo（买家称未收到货且已超时）',
      246.99, 1500, [],
      { buyerMessages: 0, sellerMessages: 0, mediatorMessages: 2, total: 2, lastSender: 'mediator' }),
    mk(5592399007, 2000018662011884, 'returns', 'claim', 'PDD9821', 'defective_product',
      'O produto veio com defeito no lado direito do fone（买家称右侧耳罩有故障）',
      189.9, 600, ['send_message_to_complainant', 'allow_return_label', 'refund'],
      { buyerMessages: 1, sellerMessages: 1, mediatorMessages: 0, total: 2, lastSender: 'complainant' }),
    mk(5592352378, 2000018900489320, 'returns', 'claim', 'PDD9939', 'repentant_buyer',
      'A minha compra chegou em boas condições, mas eu não a quero mais（买家反悔：商品完好但不想买了）',
      96.0, 2600, ['send_message_to_complainant', 'refund', 'open_dispute'],
      { buyerMessages: 0, sellerMessages: 0, mediatorMessages: 0, total: 0, lastSender: '' }),
    mk(5593382247, 2000018906046318, 'mediations', 'dispute', 'PDD9939', 'repentant_buyer',
      'A minha compra chegou em boas condições, mas eu não a quero mais（平台已介入，等待卖家回复方案）',
      96.0, 900, [],
      { buyerMessages: 0, sellerMessages: 3, mediatorMessages: 4, total: 7, lastSender: 'mediator' }),
  ];
  const counts = { all: items.length, mediation: 0, buyer: 0, auto: 0, todo: 0, ignored: 0 };
  items.forEach(c => {
    if (c.ignored) { counts.ignored++; return; }
    counts[c.category] = (counts[c.category] || 0) + 1;
    if (c.needAction) counts.todo++;
  });
  return {
    ok: true, demo: true, total: items.length, status: 'opened',
    categories: CLAIM_CAT,
    counts,
    claims: items,
  };
}
function demoClaimDetail(id) {
  const all = demoClaims().claims;
  const c = all.find(x => x.id === String(id)) || all[0];
  const now = Date.now();
  const isM = c && c.isMediation;
  const messages = isM
    ? [
      { sender: 'mediator', text: 'Olá! Sou o assistente virtual do Mercado Livre. O comprador preferiu uma solução diferente da que você ofereceu.\n\nPara seguir com o reembolso parcial sem devolução, me informe apenas uma destas opções:\n\n- 30%\n- R$ 30,00', date: new Date(now - 300 * 60000).toISOString(), attachments: [] },
      { sender: 'respondent', text: '30%', date: new Date(now - 240 * 60000).toISOString(), attachments: [] },
      { sender: 'mediator', text: 'Perfeito.\n\nVou levar sua proposta de reembolso parcial de 30% sem devolução para o comprador. Em qualquer caso, você será avisado por aqui sobre o resultado final.', date: new Date(now - 60 * 60000).toISOString(), attachments: [] },
    ]
    : [
      { sender: 'complainant', text: 'Olá, comprei o fone e ele chegou com o lado direito sem som. Podem me ajudar?', date: new Date(now - 2500 * 60000).toISOString(), attachments: ['foto_defeito.jpg'] },
      { sender: 'respondent', text: 'Olá! Sentimos muito pelo ocorrido. Você poderia confirmar se testou em outro aparelho? Se o defeito persistir, autorizamos a troca imediatamente.', date: new Date(now - 2400 * 60000).toISOString(), attachments: [] },
      { sender: 'complainant', text: 'Testei em dois celulares e no PC, continua sem som do lado direito.', date: new Date(now - 120 * 60000).toISOString(), attachments: [] },
    ];
  return { claim: c, sellerId: '2079199901', messages };
}

/* ============ 售后「忽略」：把已经无法回复 / 不想再处理的纠纷收起来 ============ */
// 持久化到本地文件；示例数据（demo- 前缀）只在本进程内存里生效，不落盘

const demoIgnored = new Set();
function loadIgnored() {
  try {
    const d = JSON.parse(fs.readFileSync(privateDataFile('claim-ignore.json'), 'utf8'));
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch { return {}; }
}
function saveIgnored(map) {
  try { fs.writeFileSync(privateDataFile('claim-ignore.json'), JSON.stringify(map, null, 2), 'utf8'); } catch { }
}
function isIgnored(id) {
  const key = String(id);
  if (/^demo/i.test(key)) return demoIgnored.has(auth.currentUserId()+':'+key);
  return !!loadIgnored()[key];
}
function setIgnored(id, on) {
  const key = String(id);
  if (/^demo/i.test(key)) { const k=auth.currentUserId()+':'+key; on ? demoIgnored.add(k) : demoIgnored.delete(k); return; }
  const map = loadIgnored();
  if (on) map[key] = { at: new Date().toISOString() };
  else delete map[key];
  saveIgnored(map);
}

// ---- 退货与投诉（售后） ----
app.get('/api/ml/claims', async (req, res) => {
  try {
    if (req.query.demo === '1') return res.json(demoClaims());
    const u = await mlUser();
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const status = req.query.status || 'opened';
    // 售后 claims/search 不支持排序参数（实测 sort_fields / sort_types / sort 均被忽略），
    // 且默认按时间「升序」翻页（offset 0 = 最旧）。这里做「反向分页」，让 offset 0 = 最新。
    const meta = await mlRequestFirst(mlClaimPaths(u.id, { status, limit: 1, offset: 0 }));
    const total = (meta && meta.paging && meta.paging.total) || 0;
    const revOffset = Math.max(0, total - offset - limit);
    const revLimit = total > 0 ? Math.max(1, Math.min(limit, total - offset)) : limit;
    const d = total > 0
      ? await mlRequestFirst(mlClaimPaths(u.id, { status, limit: revLimit, offset: revOffset }))
      : meta;
    let list = (d && (d.data || d.results || d.claims)) || [];
    // 页内也按创建时间倒序（美客多页内顺序不保证有序）
    list = list.slice().sort((a, b) => String(b.date_created || '').localeCompare(String(a.date_created || '')));
    const reasons = await mlClaimReasons(list.map(c => c.reason_id));
    // 并行拉取每条纠纷的消息线程（用于分类 + 判断谁在等回复）
    const norm = list.map(c => normalizeClaim(c, reasons));
    const threads = await Promise.all(norm.map(nc => mlClaimThread(nc.id)));
    const claims = norm.map((nc, i) => {
      const t = threads[i];
      const category = classifyClaim(nc, t);
      const meta = CLAIM_CAT[category] || CLAIM_CAT.auto;
      const ignored = isIgnored(nc.id);
      return {
        ...nc,
        category, categoryLabel: meta.label, categoryDesc: meta.desc,
        // 已忽略的不再计入「需要我处理」；球不在我方（最后一条是自己发的）同样不算
        // ——与角标/推送同一口径，避免角标有数、页面列表却为空
        needAction: !!meta.need && !ignored && claimAwaitingUs(category, nc, t),
        ignored,
        messageCount: t.total, buyerMessages: t.buyerMessages, mediatorMessages: t.mediatorMessages,
        lastSender: t.lastSender, lastReceiver: t.lastReceiver, awaitingSeller: t.awaitingSeller && nc.canSendNow,
      };
    });
    // 各类计数（基于当前所取全部数据）；已忽略单独计数
    const counts = { all: claims.length, mediation: 0, buyer: 0, auto: 0, todo: 0, ignored: 0 };
    claims.forEach(c => {
      if (c.ignored) { counts.ignored++; return; }
      counts[c.category] = (counts[c.category] || 0) + 1;
      if (c.needAction) counts.todo++;
    });
    res.json({
      ok: true, status,
      total: (d && d.paging && d.paging.total) != null ? d.paging.total : list.length,
      categories: CLAIM_CAT, counts,
      claims,
    });
  } catch (e) { sendMlError(res, e); }
});

// 单条纠纷详情 + 消息线程
app.get('/api/ml/claims/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    if (/^demo/i.test(id)) return res.json({ ok: true, demo: true, ...demoClaimDetail(id) });
    const u = await mlUser();
    const d = await mlRequest(`/post-purchase/v1/claims/${encodeURIComponent(id)}`);
    const reasons = await mlClaimReasons([d.reason_id]);
    const t = await mlClaimThread(id);
    const nc = normalizeClaim(d, reasons);
    const category = classifyClaim(nc, t);
    const meta = CLAIM_CAT[category] || CLAIM_CAT.auto;
    const ignored = isIgnored(nc.id);
    res.json({
      ok: true, sellerId: String(u.id),
      claim: {
        ...nc, category, categoryLabel: meta.label, categoryDesc: meta.desc,
        needAction: !!meta.need && !ignored, ignored, awaitingSeller: t.awaitingSeller && nc.canSendNow,
      },
      messages: t.messages,
    });
  } catch (e) { sendMlError(res, e); }
});

// 忽略 / 取消忽略某条纠纷（本地记录，不动美客多数据）
app.post('/api/ml/claims/:id/ignore', async (req, res) => {
  try {
    const id = String(req.params.id);
    const on = !(req.body && req.body.ignored === false);
    setIgnored(id, on);
    console.log('[售后] ' + (on ? '忽略' : '恢复') + '纠纷 #' + id);
    res.json({ ok: true, id, ignored: on });
  } catch (e) { sendMlError(res, e); }
});

// 在工具内回复买家 / 平台调解员
// 端点：POST /post-purchase/v1/claims/{id}/actions/send-message
// 必填字段：message（正文）+ receiver_role（收件人角色：complainant 买家 / mediator 调解员）
//   —— 少 receiver_role 美客多会直接报 "param action is null"，因为它无法判断这条消息该走哪个动作
// 调解类纠纷：receiver_role=mediator（美客多调解员）；普通纠纷：receiver_role=complainant（买家）
app.post('/api/ml/claims/:id/reply', async (req, res) => {
  try {
    const id = String(req.params.id);
    const text = ((req.body && req.body.text) || '').trim();
    if (!text) return res.json({ ok: false, error: '回复内容不能为空' });
    if (text.length > 2000) return res.json({ ok: false, error: '回复内容不能超过 2000 个字符（当前 ' + text.length + '）' });
    if (/^demo/i.test(id)) return res.json({ ok: true, demo: true, message: '示例模式：未真正发送' });

    // 先读当前纠纷，确认是否允许发消息、以及发给谁
    const d = await mlRequest(`/post-purchase/v1/claims/${encodeURIComponent(id)}`);
    const reasons = await mlClaimReasons([d.reason_id]);
    const c = normalizeClaim(d, reasons);
    if (!c.canReply) {
      return res.json({
        ok: false,
        error: '当前纠纷状态不允许直接发消息',
        hint: '可用动作：' + (c.actions.length ? c.actions.join(' / ') : '无') + '。如果只剩退款或发起调解，需要先在美客多后台处理。',
      });
    }
    const receiverRole = c.replyRole || (c.isMediation ? 'mediator' : 'complainant');
    const r = await mlRequest(`/post-purchase/v1/claims/${encodeURIComponent(id)}/actions/send-message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiver_role: receiverRole, message: text }),
    });
    claimThreadCache.delete(id);           // 让下次读到的线程是最新的
    console.log(`[售后] 已回复纠纷 #${id}（receiver_role=${receiverRole}）`);
    res.json({ ok: true, result: r, target: receiverRole });
  } catch (e) {
    const msg = String(e.message || '');
    let hint = '';
    if (/send message is not allowed|not allowed/i.test(msg)) {
      hint = '美客多当前不允许在这条纠纷里发消息。常见原因：本轮你已经回复过（比如已提交退款/方案），现在轮到买家或调解员回应，等对方有动作后窗口会自动重新打开；也可能是该纠纷已进入调解、只能通过平台指定通道处理。';
    }
    else if (/param action is null/i.test(msg)) hint = '美客多未能识别这条消息的接收方（receiver_role），请把 App 升级到最新版后重试。';
    else if (/cant be null|can't be null|message.*null/i.test(msg)) hint = '消息内容为空，美客多拒绝了这次提交。';
    else if (/forbidden|403/i.test(msg)) hint = '美客多不允许在当前状态发消息：可能调解环节已结束、需要等待调解员发起新一轮，或订单已取消。';
    else if (/not_found|404/i.test(msg)) hint = '纠纷不存在或已关闭。';
    else if (/mediat|dispute/i.test(msg)) hint = '该纠纷已进入平台调解阶段，只能在调解通道内回复。';
    res.json({ ok: false, error: msg, hint, status: e.status || 0 });
  }
});

// ---- 保存美客多 API 凭证 ----
app.post('/api/ml/config', (req, res) => {
  try {
    const cur = loadConfig();
    const b = req.body || {};
    const next = { ...cur };
    if (typeof b.mlAppId === 'string') next.mlAppId = b.mlAppId.trim();
    if (typeof b.mlSecret === 'string' && b.mlSecret.trim()) next.mlSecret = b.mlSecret.trim();
    if (typeof b.mlRefreshToken === 'string' && b.mlRefreshToken.trim()) next.mlRefreshToken = b.mlRefreshToken.trim();
    if (typeof b.mlAccessToken === 'string' && b.mlAccessToken.trim()) {
      next.mlAccessToken = b.mlAccessToken.trim();
      next.mlTokenExpireAt = 0; // 手工粘贴的 token 有效期未知，靠 401 自动重试
    }
    if (typeof b.mlSite === 'string' && b.mlSite) next.mlSite = b.mlSite.toUpperCase();
    if (typeof b.mlRedirectUri === 'string' && b.mlRedirectUri.trim()) next.mlRedirectUri = b.mlRedirectUri.trim();
    if (typeof b.mlPkce === 'boolean') next.mlPkce = b.mlPkce;
    if (b.clearTokens) { next.mlAccessToken = ''; next.mlRefreshToken = ''; next.mlTokenExpireAt = 0; }
    saveConfig(next);
    mlUserCache.delete(auth.currentUserId());
    console.log('[ML API] 凭证已更新：', { appId: next.mlAppId ? '已设置' : '空', token: next.mlAccessToken ? '已设置' : '空', refresh: next.mlRefreshToken ? '已设置' : '空', site: next.mlSite || '-' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '保存失败: ' + e.message });
  }
});

// ==================== 微信提醒（PushPlus）：售前提问实时提醒 ====================
const PUSHPLUS_URL = 'https://www.pushplus.plus/send';


// 各账号独立的持久推送状态
const pushStates=new Map();
const pushDefault={seen:[],baselineDone:false,lastCheckAt:0,lastPushAt:0,lastError:'',lastFresh:0,lastSummary:'',claimSeen:{},claimBaselineDone:false,lastClaimCheckAt:0,lastClaimPushAt:0,lastClaimError:'',lastClaimSummary:'',lastClaimFresh:0};
function getPushState(){const id=auth.currentUserId();if(pushStates.has(id))return pushStates.get(id);let d={...pushDefault,claimSeen:{}};try{d={...d,...JSON.parse(fs.readFileSync(privateDataFile('push-state.json'),'utf8'))};}catch{}pushStates.set(id,d);return d;}
const pushState=new Proxy({}, {get(_t,k){return getPushState()[k];},set(_t,k,v){getPushState()[k]=v;return true;}});
function savePushState(){try{fs.writeFileSync(privateDataFile('push-state.json'),JSON.stringify(getPushState(),null,2),'utf8');}catch{}}

// 服务端 HTML 转义 + 提问推送正文/标题的渲染在 ./push-format（纯函数，探针可直接断言）

// 巴西时间文本（mm-dd hh:mm）
function brStamp(iso) {
  const p = tzParts(iso, SALES_TZ.tz);
  if (!p) return String(iso || '');
  return `${p.date} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

async function pushplusSend({ title, content, template = 'html' }, tokenOverride) {
  const cfg = loadConfig();
  const token = String(tokenOverride || cfg.pushToken || '').trim();
  if (!token) { const e = new Error('还没填 PushPlus token'); e.status = 400; throw e; }
  let r, d;
  try {
    r = await fetch(PUSHPLUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, title, content, template, channel: 'wechat' }),
    });
    d = await r.json().catch(() => null);
  } catch (e2) {
    const e = new Error('连不上 PushPlus：' + e2.message);
    e.status = 502; throw e;
  }
  if (!r.ok || !d || Number(d.code) !== 200) {
    const e = new Error('PushPlus 返回失败：' + ((d && (d.msg || d.message)) || ('HTTP ' + r.status)));
    e.status = 502; e.data = d; throw e;
  }
  return d;
}

// 检查是否有新提问；首次运行只建立基线（不推送），避免一次刷屏
/* 自动回复这一侧是不是「配了、也开着」——推送前的预跑只在开着的时候才有意义 */
function autoReplyStateUsable() {
  try {
    const st = readQuestionAutoReplyState();
    return !!(st && st.enabled && (st.rules || []).some(r => r && r.enabled));
  } catch { return false; }
}

async function checkNewQuestions({ manual = false, preview = false } = {}) {
  const cfg = loadConfig();
  if (!mlConfigured(cfg)) throw Object.assign(new Error('尚未配置美客多 API 凭证'), { status: 400, needConfig: true });
  if (!mlAuthorized(cfg)) throw Object.assign(new Error('还没有完成美客多账号授权'), { status: 401, needAuth: true });

  const u = await mlUser();
  const siteCode = String(mlEffectiveSite(cfg.mlSite) || u.site_id || 'MLB').toUpperCase();
  const site = mlSite(siteCode);
  const d = await mlRequest(`/questions/search?seller_id=${u.id}&status=UNANSWERED&limit=50`);
  const list = (d && (d.questions || d.results)) || [];

  pushState.lastCheckAt = Date.now();
  const seen = new Set(pushState.seen);
  const fresh = list.filter(q => !seen.has(String(q.id)));

  if (!pushState.baselineDone) {
    pushState.seen = [...new Set([...list.map(q => String(q.id)), ...pushState.seen])].slice(0, 1000);
    pushState.baselineDone = true;
    pushState.lastFresh = 0;
    pushState.lastError = '';
    pushState.lastSummary = `已建立基线：现存未回复提问 ${list.length} 条已记录，之后有新的才会推送`;
    savePushState();
    return { ok: true, baseline: true, total: list.length, pushed: 0, summary: pushState.lastSummary };
  }

  if (!fresh.length) {
    pushState.lastFresh = 0;
    pushState.lastError = '';
    pushState.lastSummary = `无新提问（当前未回复 ${list.length} 条）`;
    savePushState();
    return { ok: true, fresh: 0, total: list.length, pushed: 0, summary: pushState.lastSummary };
  }

  const batch = fresh.slice(0, 10); // 单次最多推 10 条，避免刷屏

  /* 推送前先把「能自动回复的」回复掉。
     原因：自动回复是 1 分钟一轮、推送是 N 分钟一轮，两边谁先到不确定。
     推送先到就会出现「推 3 条新提问叫你去回」→ 你点进后台发现机器人早回完了，白跑一趟。
     这里先同步跑一轮自动回复，下面打标签时读到的就是「已经发生的事实」，而不是猜测。
     失败不影响推送本身（catch 掉，按「没自动回复」如实标注）。
     注意 preview 模式不跑这一步：预览是只读的，不能因为「看一眼」就去给买家发消息。 */
  if (!preview && autoReplyStateUsable()) {
    const uid = String(auth.currentUserId());
    if (!questionAutoReplyInFlight.has(uid)) {
      questionAutoReplyInFlight.add(uid);
      try { await runQuestionAutoReplyCheck(); }
      catch (e) { console.warn('[微信提醒] 推送前自动回复失败（不影响推送）：' + e.message); }
      finally { questionAutoReplyInFlight.delete(uid); }
    }
  }

  const autoState = readQuestionAutoReplyState();
  const titles = await mlItemTitles(batch.map(q => q.item_id));
  const payload = buildQuestionPayload(batch, titles, autoState.autoReplied, brStamp);

  const autoCount = payload.filter(p => p.autoReplied).length;
  if (preview) return {
    ok: true, preview: true, total: list.length, pushed: 0, fresh: fresh.length,
    autoReplied: autoCount,
    title: questionPushTitle(payload, site.name),
    html: questionPushHtml(payload, site.name),
    summary: '预览（未发送）：新提问 ' + payload.length + ' 条，其中 ' + autoCount + ' 条已自动回复',
  };

  await pushplusSend({
    title: questionPushTitle(payload, site.name),
    content: questionPushHtml(payload, site.name),
  });

  pushState.seen = [...new Set([...batch.map(q => String(q.id)), ...pushState.seen])].slice(0, 1000);
  pushState.lastFresh = payload.length;
  pushState.lastPushAt = Date.now();
  pushState.lastError = '';
  const autoNote = autoCount === 0 ? ''
    : (autoCount === payload.length ? '（全部已自动回复，无需处理）' : '（其中 ' + autoCount + ' 条已自动回复）');
  pushState.lastSummary = fresh.length > payload.length
    ? `已推送 ${payload.length} 条${autoNote}（还有 ${fresh.length - payload.length} 条将在下轮推送），未回复共 ${list.length} 条`
    : `已推送 ${payload.length} 条新提问${autoNote}，未回复共 ${list.length} 条`;
  savePushState();
  return { ok: true, fresh: fresh.length, pushed: payload.length, total: list.length, autoReplied: autoCount, summary: pushState.lastSummary };
}

/* ============ 售后（纠纷 / 平台调解）推送 ============
 * 为什么单独一条链路：售前提问靠 /questions/search 就能发现「新提问」，
 * 但售后没有「新」这个概念 —— 一条纠纷会持续存在很久，真正的新动向是「对方又说话了」。
 * 所以这里的判据是「信号变了」：把每条待关注纠纷的「最后一条消息的 发送方|时间」记下来，
 * 只有变了、且最后说话的不是我方（respondent）时，才推一条。
 * 这样既能抓到平台调解员发来的新方案，也不会因为我方刚回复就把自己吵醒。
 */
const PUBLIC_URL_FILE = path.join(__dirname, '公网地址.txt');
const TUNNEL_CFG_FILE = path.join(__dirname, 'tunnel-config.json');

// 公网地址：优先读「公网地址.txt」，退回 tunnel-config.json 的 hostname；都没有就不放链接
function publicBaseUrl() {
  try {
    const t = String(fs.readFileSync(PUBLIC_URL_FILE, 'utf8')).trim().split(/\s+/)[0];
    if (/^https?:\/\//i.test(t)) return t.replace(/\/+$/, '');
  } catch { /* 走下面 */ }
  try {
    const h = String((JSON.parse(fs.readFileSync(TUNNEL_CFG_FILE, 'utf8')) || {}).hostname || '').trim();
    if (h) return 'https://' + h.replace(/\/+$/, '');
  } catch { /* 都没有 */ }
  return '';
}

// 值得打扰用户的分类：平台调解 / 买家咨询（= 需要我处理）；「无需操作」不推
function claimNeedsAttention(cat) { return cat === 'mediation' || cat === 'buyer'; }

// 一条纠纷的信号 = 最后一条消息的「发送方|时间」；完全没有消息时退回纠纷的 last_updated
function claimSignalOf(thread, nc) {
  const list = thread.messages || [];
  const last = list[list.length - 1];
  return last ? (last.sender + '|' + (last.date || '')) : ('none|' + (nc.lastUpdated || ''));
}

function claimPushHtml(rows, siteName) {
  const head = `<div style="font-size:13px;color:#888;margin-bottom:8px">${escPush(siteName || '')} · 共 ${rows.length} 条售后需要关注</div>`;
  const body = rows.map(r => {
    const color = r.awaiting ? '#ef4444' : '#f59e0b';
    const seg = ['<div style="padding:12px 0;border-bottom:1px dashed #e0e0e0">'];
    seg.push(`<div style="font-size:12px;color:#fff;background:${color};border-radius:4px;padding:2px 7px;display:inline-block">${escPush(r.badge)}</div>`);
    seg.push(`<div style="font-size:15px;font-weight:600;color:#111;margin:8px 0 4px;line-height:1.6">纠纷 #${escPush(r.id)}</div>`);
    seg.push(`<div style="color:#555;font-size:13px;line-height:1.7">原因：${escPush(r.reason)}<br>关联订单：${escPush(r.resourceId)}</div>`);
    if (r.lastText) seg.push(`<div style="margin-top:6px;color:#333;font-size:13px;line-height:1.6;background:#f6f6f6;border-radius:6px;padding:8px 10px">${escPush(r.lastFrom)}：${escPush(r.lastText)}</div>`);
    seg.push(`<div style="color:#999;font-size:12px;margin-top:6px">${escPush(r.time)}（巴西时间）</div>`);
    if (r.link) seg.push(`<div style="margin-top:8px"><a href="${escPush(r.link)}" style="color:#3b82f6">👉 打开工作台去处理</a></div>`);
    seg.push('</div>');
    return seg.join('');
  }).join('');
  return head + body;
}

async function checkNewClaims({ manual = false } = {}) {
  const cfg = loadConfig();
  if (!mlConfigured(cfg)) throw Object.assign(new Error('尚未配置美客多 API 凭证'), { status: 400, needConfig: true });
  if (!mlAuthorized(cfg)) throw Object.assign(new Error('还没有完成美客多账号授权'), { status: 401, needAuth: true });

  const u = await mlUser();
  const siteCode = String(mlEffectiveSite(cfg.mlSite) || u.site_id || 'MLB').toUpperCase();
  const site = mlSite(siteCode);
  // 与售后页同口径：取「最新」的 opened 纠纷，而不是接口默认的「最旧 50 条」
  const { list } = await mlOpenClaimsNewest(50);
  const reasons = await mlClaimReasons(list.map(c => c.reason_id));

  // 逐条取线程（mlClaimThread 自带 60 秒缓存，正常只有个位数纠纷，串行足够）
  const rows = [];
  const scanned = new Set();     // 本轮真正扫到的纠纷 id
  let threadErr = 0;
  for (const c of list) {
    const nc = normalizeClaim(c, reasons);
    const t = await mlClaimThread(nc.id);
    scanned.add(String(nc.id));
    if (isIgnored(nc.id)) continue;        // 已忽略的不再提醒
    if (t.fetchError) { threadErr++; continue; }  // 线程没拉到 → 本轮不做任何判定，也不淘汰已有记录
    const cat = classifyClaim(nc, t);
    if (!claimNeedsAttention(cat)) continue;
    if (!claimAwaitingUs(cat, nc, t)) continue;   // 球不在我方（如平台自动退货流程）→ 不推
    rows.push({ nc, t, cat, signal: claimSignalOf(t, nc) });
  }

  pushState.lastClaimCheckAt = Date.now();

  // 首轮只建基线：把存量纠纷记下来，避免服务一开就刷一堆历史
  if (!pushState.claimBaselineDone) {
    const m = {};
    for (const r of rows) m[r.nc.id] = r.signal;
    pushState.claimSeen = m;
    pushState.claimBaselineDone = true;
    pushState.lastClaimFresh = 0;
    pushState.lastClaimError = '';
    pushState.lastClaimSummary = `已建立基线：现存待关注售后 ${rows.length} 条已记录，之后有新动向才推送`;
    savePushState();
    return { ok: true, baseline: true, total: rows.length, pushed: 0, summary: pushState.lastClaimSummary };
  }

  const fresh = rows.filter(r => {
    const old = pushState.claimSeen[r.nc.id];
    if (old === undefined) return true;            // 新出现的纠纷
    if (old === r.signal) return false;            // 信号没变
    return r.t.lastSender !== 'respondent';        // 变成「对方说话」才算新动向
  });

  // 重算记录表：只淘汰「本轮确实扫到、且已不在待关注名单」的条目；
  // 线程拉取失败的条目保留上轮信号，避免恢复后被当成新纠纷再推一次
  const alive = { ...(pushState.claimSeen || {}) };
  for (const r of rows) alive[r.nc.id] = r.signal;
  for (const id of Object.keys(alive)) {
    if (scanned.has(String(id)) && !rows.some(r => String(r.nc.id) === String(id))) delete alive[id];
  }
  pushState.claimSeen = alive;

  if (!fresh.length) {
    pushState.lastClaimFresh = 0;
    pushState.lastClaimError = threadErr ? `本轮 ${threadErr} 条消息线程拉取失败，已跳过不判定` : '';
    pushState.lastClaimSummary = `无售后新动向（当前待关注 ${rows.length} 条）`;
    savePushState();
    return { ok: true, fresh: 0, total: rows.length, pushed: 0, summary: pushState.lastClaimSummary };
  }

  const batch = fresh.slice(0, 10);   // 单次最多推 10 条，避免刷屏
  const base = publicBaseUrl();
  const payload = batch.map(r => {
    const list2 = r.t.messages || [];
    const last = list2[list2.length - 1];
    const awaiting = !!(r.t.awaitingSeller && r.nc.canSendNow);
    const badge = awaiting ? '⚡ 等你回复'
      : (r.cat === 'mediation' ? '⚖️ 平台调解有新动向' : '💬 买家有新消息');
    return {
      id: r.nc.id,
      badge, awaiting,
      reason: r.nc.reason || r.nc.reasonId || '-',
      resourceId: r.nc.resourceId || '-',
      time: brStamp(r.nc.lastUpdated || ''),
      lastFrom: last ? (/mediator/i.test(last.sender) ? '调解员'
        : (/complainant|buyer/i.test(last.sender) ? '买家' : '我方')) : '',
      lastText: last ? String(last.text || '').slice(0, 160) : '',
      link: base ? (base + '/index.html#claims') : '',
    };
  });

  const urgent = payload.filter(p => p.awaiting).length;
  await pushplusSend({
    title: urgent
      ? `⚖️ 美客多售后 ${urgent} 条等你回复 · ${site.name}`
      : `⚖️ 美客多售后新动向 ${payload.length} 条 · ${site.name}`,
    content: claimPushHtml(payload, site.name),
  });

  pushState.lastClaimFresh = payload.length;
  pushState.lastClaimPushAt = Date.now();
  pushState.lastClaimError = '';
  pushState.lastClaimSummary = fresh.length > payload.length
    ? `已推送 ${payload.length} 条售后（还有 ${fresh.length - payload.length} 条将在下轮推送），待关注共 ${rows.length} 条`
    : `已推送 ${payload.length} 条售后，待关注共 ${rows.length} 条`;
  savePushState();
  return { ok: true, fresh: fresh.length, pushed: payload.length, total: rows.length, summary: pushState.lastClaimSummary };
}

function pushIntervalMin(cfg = loadConfig()) {
  return Math.min(Math.max(parseInt(cfg.pushIntervalMin) || 5, 1), 120);
}
function publicPushStatus() {
  const cfg = loadConfig();
  return {
    enabled: !!cfg.pushEnabled,
    hasToken: !!cfg.pushToken,
    tokenTail: cfg.pushToken ? String(cfg.pushToken).slice(-4) : '',
    intervalMin: pushIntervalMin(cfg),
    claimsEnabled: cfg.pushClaims !== false,
    running: pushTimers.has(auth.currentUserId()),
    baselineDone: pushState.baselineDone,
    seenCount: pushState.seen.length,
    lastCheckAt: pushState.lastCheckAt,
    lastPushAt: pushState.lastPushAt,
    lastError: pushState.lastError,
    lastSummary: pushState.lastSummary,
    // ---- 售后 ----
    claimBaselineDone: pushState.claimBaselineDone,
    claimSeenCount: Object.keys(pushState.claimSeen || {}).length,
    lastClaimCheckAt: pushState.lastClaimCheckAt,
    lastClaimPushAt: pushState.lastClaimPushAt,
    lastClaimError: pushState.lastClaimError,
    lastClaimSummary: pushState.lastClaimSummary,
    hasPublicUrl: !!publicBaseUrl(),
  };
}

// 每个账号各自一份监控定时器（配置与推送状态都是按账号隔离的）
const pushTimers = new Map();   // uid -> { tick, boot }

function stopPushMonitor(uid) {
  const s = pushTimers.get(String(uid));
  if (!s) return;
  if (s.tick) clearInterval(s.tick);
  if (s.boot) clearTimeout(s.boot);
  pushTimers.delete(String(uid));
}

// 开关 / 间隔变化后重新排期（uid 省略 = 当前请求所在的账号）
function schedulePushMonitor(uid) {
  const targetId = String(uid || auth.currentUserId());
  stopPushMonitor(targetId);
  const cfg = auth.runAsUser(targetId, () => loadConfig());
  if (!cfg.pushEnabled || !cfg.pushToken) return;
  const min = pushIntervalMin(cfg);
  const claimsOn = cfg.pushClaims !== false;
  // 一轮 = 售前提问 + 售后，各自独立 try，一个挂了不影响另一个。
  // 必须包在 runAsUser 里：定时器回调没有请求上下文，否则 loadConfig / pushState / privateDataFile
  // 都会落到默认账号 admin 上，等于替别人检查。
  const tick = () => auth.runAsUser(targetId, async () => {
    try { await checkNewQuestions(); }
    catch (e) { pushState.lastCheckAt = Date.now(); pushState.lastError = e.message; savePushState(); console.warn(`[微信提醒] ${targetId} 提问检查失败：`, e.message); }
    if (!claimsOn) return;
    try { await checkNewClaims(); }
    catch (e) { pushState.lastClaimCheckAt = Date.now(); pushState.lastClaimError = e.message; savePushState(); console.warn(`[微信提醒] ${targetId} 售后检查失败：`, e.message); }
  });
  const slot = {};
  slot.tick = setInterval(tick, min * 60000);
  if (slot.tick.unref) slot.tick.unref();
  // 开启后 15 秒先跑一次（建立基线 / 抢救刚到的提问）
  slot.boot = setTimeout(tick, 15000);
  if (slot.boot.unref) slot.boot.unref();
  pushTimers.set(targetId, slot);
  console.log(`[微信提醒] 账号 ${targetId} 监控已启动，每 ${min} 分钟检查一次（提问${claimsOn ? ' + 售后' : ''}）`);
}

// 启动时给所有已审批账号排期
function scheduleAllPushMonitors() {
  let n = 0;
  for (const u of auth.users()) {
    if (u.status !== 'approved') continue;
    try { schedulePushMonitor(u.id); n++; } catch (e) { console.warn('[微信提醒] 账号 ' + u.id + ' 排期失败：' + e.message); }
  }
  return n;
}

// ---- 微信提醒接口 ----
app.get('/api/push/status', (req, res) => {
  try { res.json({ ok: true, ...publicPushStatus() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/push/config', (req, res) => {
  try {
    const cur = loadConfig();
    const b = req.body || {};
    const next = { ...cur };
    if (typeof b.pushToken === 'string') next.pushToken = b.pushToken.trim();
    if (typeof b.pushEnabled === 'boolean') next.pushEnabled = b.pushEnabled;
    if (typeof b.pushClaims === 'boolean') next.pushClaims = b.pushClaims;
    if (b.pushIntervalMin != null) next.pushIntervalMin = Math.min(Math.max(parseInt(b.pushIntervalMin) || 5, 1), 120);
    saveConfig(next);
    schedulePushMonitor();
    console.log('[微信提醒] 配置已更新：', { token: next.pushToken ? '已设置' : '空', enabled: !!next.pushEnabled, claims: next.pushClaims !== false, interval: pushIntervalMin(next) });
    res.json({ ok: true, ...publicPushStatus() });
  } catch (e) { res.status(500).json({ ok: false, error: '保存失败: ' + e.message }); }
});

// 发送测试消息（允许用还没保存的 token 直接测）
app.post('/api/push/test', async (req, res) => {
  try {
    const cur = loadConfig();
    const b = req.body || {};
    const incoming = String(b.pushToken || '').trim();
    if (incoming && incoming !== cur.pushToken) saveConfig({ ...cur, pushToken: incoming });
    const token = incoming || cur.pushToken;
    if (!token) return res.json({ ok: false, error: '请先填写 PushPlus token' });
    await pushplusSend({
      title: '✅ ML Suite · 微信提醒测试',
      content: '<div style="font-size:15px;line-height:1.7">这条是测试消息，收到即代表通道打通。</div>'
        + '<div style="color:#666;font-size:13px;margin-top:10px">之后<b>买家提新售前问题</b>、以及<b>售后有新动向</b>（平台调解员发来新方案 / 买家新留言）都会推到这里。</div>'
        + `<div style="color:#999;font-size:12px;margin-top:10px">发送于 ${brStamp(new Date().toISOString())}（巴西时间）</div>`,
    }, token);
    res.json({ ok: true, message: '测试消息已发送，去微信看看', ...publicPushStatus() });
  } catch (e) {
    res.json({ ok: false, error: e.message, status: e.status || 0, ...publicPushStatus() });
  }
});

// 立即检查一次（默认「提问 + 售后」都查；?only=claims / ?only=questions 可单独查）
// ?preview=1 只渲染不发送，用来核对推送长什么样（只读，不会给买家发回复，也不会记 seen）
app.post('/api/push/check', async (req, res) => {
  try {
    const only = String((req.query && req.query.only) || (req.body && req.body.only) || '').toLowerCase();
    const q = req.query || {}, b = req.body || {};
    const preview = String(q.preview || b.preview || '') === '1' || (q.preview === true || b.preview === true);
    const out = {};
    if (only !== 'claims') out.questions = await checkNewQuestions({ manual: true, preview });
    if (only !== 'questions') out.claims = await checkNewClaims({ manual: true });
    const first = out.questions || out.claims || {};
    res.json({
      ok: true, ...first,
      summary: [out.questions && out.questions.summary, out.claims && out.claims.summary].filter(Boolean).join(' ｜ '),
      ...publicPushStatus(),
    });
  } catch (e) { sendMlError(res, e); }
});

// ==================== 大麦数据（MCP）：真实热搜词 ====================
// 数据源：dm-client.js → 大麦 MCP 的 search_product_snapshots
//        （按「站点 + 关键词」搜商品，sort_by=sales_30d 降序）
// 热度口径：该关键词 Top100 商品的「近30天销量合计」，归一化到 0-100。
// 关键约束：单次 MCP 调用实测约 25 秒，所以接口永远只回缓存；
//          缓存过期时在后台异步刷新，绝不阻塞 HTTP 请求。
const dmClient = require('./dm-client');

const DM_HOT_FORCE_MIN_MS = 5 * 60 * 1000;   // 手动刷新的最小间隔，防止误点连刷白扣积分

const dmHotMemByUser=new Map();
const dmHotBusyByUser=new Set();
function dmBusy(){return dmHotBusyByUser.has(auth.currentUserId());}
let dmHotTimer = null;

function loadDmHot() {
  const id=auth.currentUserId();if(dmHotMemByUser.has(id))return dmHotMemByUser.get(id);
  let d=null;try{d=JSON.parse(fs.readFileSync(privateDataFile('dm-hot-cache.json'),'utf8'));}catch{}
  dmHotMemByUser.set(id,d);return d;
}
function saveDmHot(snap) {
  dmHotMemByUser.set(auth.currentUserId(),snap);
  try { fs.writeFileSync(privateDataFile('dm-hot-cache.json'), JSON.stringify(snap, null, 2), 'utf8'); } catch (e) { }
}
function dmHotTtlHours(cfg) {
  const h = Number(cfg.dmHotTtlHours);
  return (Number.isFinite(h) && h > 0) ? h : 12;
}
function dmHotSiteName(cfg) { return cfg.dmHotSite || 'MLB'; }
function dmHotKeywordList(cfg) {
  const l = Array.isArray(cfg.dmHotKeywords) ? cfg.dmHotKeywords.filter(x => x && x.k) : [];
  return l.length ? l : DEFAULT_CONFIG.dmHotKeywords;
}
function dmHotStale(cfg) {
  const s = loadDmHot();
  if (!s || !s.at || !Array.isArray(s.items) || !s.items.length) return true;
  if (s.site !== dmHotSiteName(cfg)) return true;
  return (Date.now() - s.at) > dmHotTtlHours(cfg) * 3600 * 1000;
}

async function refreshDmHot(reason) {
  if (dmBusy()) return { ok: false, busy: true };
  const cfg = loadConfig();
  const site = dmHotSiteName(cfg);
  const list = dmHotKeywordList(cfg);
  dmHotBusyByUser.add(auth.currentUserId());
  const t0 = Date.now();
  console.log(`[大麦] 开始刷新热搜词（${reason}）：${list.length} 个关键词 @ ${site}`);
  try {
    const items = [];
    let failed = 0;
    for (const item of list) {
      try {
        const r = await dmClient.callTool('search_product_snapshots', {
          market_code: site, keyword: item.k,
          sort_by: 'sales_30d', sort_order: 'desc', limit: 100, page: 1,
        }, cfg.dmApiKey);
        const recs = (r && r.records) || [];
        const sales30 = recs.reduce((s, x) => s + (Number(x.orders_last_30_days) || 0), 0);
        items.push({
          keyword: item.k,
          label: item.z || '',
          listings: (r && r.matched_count) || 0,
          sales30d: sales30,
          avgPrice: recs.length
            ? Math.round(recs.reduce((s, x) => s + (Number(x.selling_price) || 0), 0) / recs.length * 100) / 100
            : 0,
          topProduct: recs[0] ? String(recs[0].product_name || '').slice(0, 90) : '',
        });
      } catch (e) {
        failed++;
        console.warn(`[大麦] 关键词「${item.k}」查询失败：${e.message}`);
      }
    }
    if (!items.length) throw new Error('全部关键词查询失败');
    const mx = Math.max(...items.map(i => i.sales30d)) || 1;
    items.forEach(i => { i.heat = Math.max(1, Math.round(100 * i.sales30d / mx)); });
    items.sort((a, b) => b.heat - a.heat);
    const snap = { at: Date.now(), site, ttlHours: dmHotTtlHours(cfg), cost: items.length, items };
    saveDmHot(snap);
    console.log(`[大麦] 热搜词刷新完成：${items.length} 条成功 / ${failed} 条失败，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
    return { ok: true, snapshot: snap };
  } catch (e) {
    console.warn('[大麦] 热搜词刷新失败：' + e.message);
    return { ok: false, error: e.message };
  } finally {
    dmHotBusyByUser.delete(auth.currentUserId());
  }
}

// 定时兜底：每 10 分钟看一次缓存是否过期（不会每次都扣积分）
function scheduleDmHot() {
  if (dmHotTimer) clearInterval(dmHotTimer);
  dmHotTimer = setInterval(() => {
    const cfg = loadConfig();
    if (dmHotStale(cfg) && !dmBusy()) refreshDmHot('定时刷新').catch(() => { });
  }, 10 * 60 * 1000);
  if (dmHotTimer.unref) dmHotTimer.unref();
}

// 读缓存（立即返回）；过期则后台刷新。?force=1 手动刷新（有 5 分钟保护）
app.get('/api/dm/hot-keywords', (req, res) => {
  try {
    const cfg = loadConfig();
    const snap = loadDmHot();
    const stale = dmHotStale(cfg);
    const lastAt = (snap && snap.at) || 0;
    const canForce = req.query.force === '1' && (Date.now() - lastAt) > DM_HOT_FORCE_MIN_MS;
    if ((stale || canForce) && !dmBusy()) {
      refreshDmHot(canForce ? '手动刷新' : '缓存过期').catch(() => { });
    }
    res.json({
      ok: true,
      site: (snap && snap.site) || dmHotSiteName(cfg),
      updatedAt: lastAt,
      ttlHours: dmHotTtlHours(cfg),
      cost: (snap && snap.cost) || dmHotKeywordList(cfg).length,
      refreshing: !!(dmBusy() || stale),
      source: '大麦数据 MCP · search_product_snapshots',
      items: (snap && snap.items) || [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 查大麦额度（免费，不扣积分）
app.get('/api/dm/quota', async (req, res) => {
  try {
    const cfg = loadConfig();
    res.json({ ok: true, ...(await dmClient.quota(cfg.dmApiKey)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== 美客多 OAuth 授权（一键拿 access_token / refresh_token） ====================
// 授权码流程：/api/ml/oauth/start → 美客多登录授权 → /api/ml/oauth/callback 自动换 Token 并落盘
const ML_OAUTH_STATES = new Map(); // state -> { at, site, verifier }

// PKCE 辅助（后台开启「Use PKCE」时才用得上）
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function makePkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(require('crypto').createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// 回调地址：优先用请求 Host 自动推断（必须是 HTTPS 公网域名），也可用 mlRedirectUri 强制指定
function mlHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
}
function mlRedirectUri(req) {
  const cfg = loadConfig();
  if (cfg.mlRedirectUri) return cfg.mlRedirectUri;
  const host = mlHost(req);
  if (!host || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return '';
  return `https://${host}/api/ml/oauth/callback`;
}

// 用 code 换 token。redirects 可给多个候选，依次尝试（应对后台登记的地址与请求用的不一致）
async function mlExchangeCode(code, redirects, verifier) {
  const cfg = loadConfig();
  let lastErr = null;
  for (const redirect of redirects) {
    const body = {
      grant_type: 'authorization_code', client_id: cfg.mlAppId, client_secret: cfg.mlSecret,
      code: String(code), redirect_uri: redirect,
    };
    if (verifier) body.code_verifier = verifier;
    let r, d;
    try {
      r = await fetch(`${ML_API_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(body),
      });
      d = await r.json().catch(() => null);
    } catch (e) { lastErr = { msg: '网络异常：' + e.message, code: 'network', redirect }; continue; }
    if (r.ok && d && d.access_token) return { ok: true, data: d, redirect };
    const code2 = (d && d.error) || String(r.status);
    lastErr = { msg: (d && (d.message || d.error_description || d.error)) || ('HTTP ' + r.status), code: code2, redirect };
    console.warn(`[ML OAuth] redirect=${redirect} 换 token 失败：${lastErr.msg}`);
    if (code2 === 'invalid_client') break; // 密钥本身有问题，换地址也没用
  }
  return { ok: false, error: lastErr };
}

function mlSaveToken(d, siteCode, redirect) {
  const cfg = loadConfig();
  saveConfig({
    ...cfg,
    mlAccessToken: d.access_token,
    mlRefreshToken: d.refresh_token || cfg.mlRefreshToken,
    mlTokenExpireAt: Date.now() + (Number(d.expires_in) || 21600) * 1000,
    mlUserId: d.user_id ? String(d.user_id) : cfg.mlUserId,
    mlSite: (siteCode && siteCode !== 'CBT') ? siteCode : (cfg.mlSite === 'CBT' ? '' : cfg.mlSite),
    mlRedirectUri: redirect || cfg.mlRedirectUri,
  });
  mlUserCache.delete(auth.currentUserId());
}

function oauthResultPage(ok, title, detail, extra = '') {
  const color = ok ? '#22c55e' : '#ef4444';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ML Suite · 授权</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#ededf0;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif}
.card{background:#131316;border:1px solid #242429;border-radius:14px;padding:34px 32px;width:min(460px,88vw);text-align:center}
.dot{width:52px;height:52px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;background:${color}22;color:${color};font-size:26px;font-weight:700}
h1{font-size:18px;margin:0 0 8px;color:${color}}p{color:#a1a1aa;font-size:13px;line-height:1.7;margin:0 0 6px;word-break:break-all}
a{display:inline-block;margin-top:18px;padding:10px 22px;border-radius:8px;background:#3b82f6;color:#fff;text-decoration:none;font-size:14px;font-weight:600}</style></head>
<body><div class="card"><div class="dot">${ok ? '✓' : '!'}</div><h1>${title}</h1><p>${detail}</p>${extra}<a href="/">返回工作台</a></div></body></html>`;
}

// 第一步：跳转到美客多授权页
app.get('/api/ml/oauth/start', (req, res) => {
  const cfg = loadConfig();
  const site = String(req.query.site || cfg.mlSite || 'MLB').toUpperCase();
  if (!ML_SITES[site]) return res.status(400).send(oauthResultPage(false, '站点不支持', `未知站点代码 ${site}，可选：${Object.keys(ML_SITES).join(' / ')}`));
  if (!cfg.mlAppId) return res.status(400).send(oauthResultPage(false, '缺少 App ID', '请先在「美客多 API 配置」里填入 App ID（Client ID）并保存。'));
  const redirect = mlRedirectUri(req);
  if (!redirect) return res.status(400).send(oauthResultPage(false, '无法推断回调地址', '请通过固定公网域名（https://ml.yvonework.website）访问本页再点击授权，或在配置里指定回调地址。'));

  const state = randomBytes(16).toString('hex');
  const usePkce = req.query.pkce === '1' || (req.query.pkce !== '0' && !!cfg.mlPkce);
  const pkce = usePkce ? makePkce() : null;

  ML_OAUTH_STATES.set(state, { at: Date.now(), site, verifier: pkce ? pkce.verifier : '' });
  // 清理 30 分钟前的 state
  for (const [k, v] of ML_OAUTH_STATES) if (Date.now() - v.at > 1800000) ML_OAUTH_STATES.delete(k);

  let url = `${ML_SITES[site].authBase}?response_type=code&client_id=${encodeURIComponent(cfg.mlAppId)}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
  if (pkce) url += `&code_challenge=${pkce.challenge}&code_challenge_method=S256`;
  console.log(`[ML OAuth] 跳转授权：site=${site} redirect_uri=${redirect} pkce=${usePkce}`);
  res.redirect(url);
});

// 第二步：美客多回调，拿 code 换 Token
app.get('/api/ml/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(oauthResultPage(false, '授权被拒绝', String(error_description || error)));
  if (!code) return res.status(400).send(oauthResultPage(false, '缺少授权码', '回调没有带回 code 参数，请重新发起授权。'));

  const st = ML_OAUTH_STATES.get(String(state || ''));
  if (!st) return res.status(400).send(oauthResultPage(false, '授权状态已失效', 'state 校验失败（可能超时或已使用过），请回到工作台重新点击「一键授权」。'));
  ML_OAUTH_STATES.delete(String(state));

  const host = mlHost(req);
  const redirects = [...new Set([mlRedirectUri(req), `https://${host}/api/ml/oauth/callback`, `https://${host}`, `https://${host}/`].filter(Boolean))];
  try {
    const r = await mlExchangeCode(code, redirects, st.verifier);
    if (!r.ok) {
      const e = r.error || {};
      console.error('[ML OAuth] 换 Token 失败：', e.msg, '| 错误码:', e.code);
      const extra = e.code === 'invalid_grant'
        ? '<p style="color:#71717a;font-size:12px;margin-top:10px">常见原因：授权码已过期/已用过，或后台登记的 Redirect URI 与授权时用的不一致。</p>'
        : e.code === 'invalid_client'
          ? '<p style="color:#71717a;font-size:12px;margin-top:10px">App ID 或 Secret Key 不对，请回工作台「API 设置」重新核对（注意区分 client id 和 client secret）。</p>'
          : '';
      return res.status(400).send(oauthResultPage(false, '换取令牌失败', String(e.msg || '未知错误') + (e.redirect ? `<br><span style="color:#71717a;font-size:11px">尝试的回调地址：${e.redirect}</span>` : ''), extra));
    }
    const d = r.data;
    mlSaveToken(d, st.site, r.redirect);
    console.log(`[ML OAuth] 授权成功：user_id=${d.user_id} site=${st.site} 有效期=${d.expires_in || 21600}s redirect=${r.redirect}`);
    const site = mlSite(st.site);
    res.send(oauthResultPage(true, '授权成功', `已绑定 ${site.name}站点（${site.code}）卖家账号 user_id=${d.user_id}。<br>Access Token 有效期约 ${Math.round((Number(d.expires_in) || 21600) / 3600)} 小时，之后会自动用 Refresh Token 续期。`));
  } catch (e) {
    console.error('[ML OAuth] 异常：', e.message);
    res.status(500).send(oauthResultPage(false, '授权过程出错', escapeHtmlEmail(e.message)));
  }
});

// 备用：手动粘贴回调网址 / 授权码换 Token（应对后台登记的 Redirect URI 与自动流不一致）
app.post('/api/ml/oauth/exchange', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.mlAppId || !cfg.mlSecret) return res.status(400).json({ ok: false, error: '请先填写 App ID 与 Secret Key' });
  const input = String((req.body && (req.body.input || req.body.code || req.body.url)) || '').trim();
  if (!input) return res.status(400).json({ ok: false, error: '请粘贴美客多回调网址或授权码' });

  const codeM = input.match(/[?&]code=([^&\s]+)/);
  const code = codeM ? decodeURIComponent(codeM[1]) : (/^[A-Za-z0-9\-_.]+$/.test(input) ? input : '');
  if (!code) return res.status(400).json({ ok: false, error: '没能在内容里找到授权码（code）' });
  const stateM = input.match(/[?&]state=([^&\s]+)/);
  const state = stateM ? decodeURIComponent(stateM[1]) : '';
  const st = state ? ML_OAUTH_STATES.get(state) : null;

  const host = mlHost(req);
  const redirects = [...new Set([mlRedirectUri(req), `https://${host}/api/ml/oauth/callback`, `https://${host}`, `https://${host}/`].filter(Boolean))];
  try {
    const r = await mlExchangeCode(code, redirects, st ? st.verifier : '');
    if (!r.ok) {
      const e = r.error || {};
      console.warn('[ML OAuth] 手动换 Token 失败：', e.msg, '| 错误码:', e.code);
      let hint = '';
      if (/code_verifier/i.test(e.msg || '')) hint = '应用在美客多后台开启了 PKCE，需要勾选弹窗里的「Use PKCE」后重新授权。';
      else if (/redirect_uri does not match/i.test(e.msg || '')) hint = '回调地址与后台登记的不完全一致（注意结尾斜杠）。核对弹窗里那一栏和后台 Redirect URIs 是否逐字符相同。';
      else if (e.code === 'invalid_client') hint = 'App ID 或 Secret Key 不正确。';
      else if (/already used|expired/i.test(e.msg || '')) hint = '授权码已过期或已被使用，请重新点「开始授权」。';
      return res.json({ ok: false, error: e.msg || '换取令牌失败', hint, code: e.code || '', triedRedirects: redirects });
    }
    if (state) ML_OAUTH_STATES.delete(state);
    mlSaveToken(r.data, st ? st.site : (cfg.mlSite || ''), r.redirect);
    console.log(`[ML OAuth] 手动授权成功：user_id=${r.data.user_id} redirect=${r.redirect}`);
    res.json({ ok: true, userId: r.data.user_id, site: r.data.site_id || '', expiresIn: r.data.expires_in || 21600 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ==================== 邮件发送功能 ====================

function escapeHtmlEmail(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

async function runReportAndSendEmail(config) {
  const results = [];

  for (const siteCode of config.sites) {
    const site = SITES[siteCode];
    if (!site) continue;

    console.log(`[报告] 搜索 ${site.name} (${siteCode})...`);

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

    for (let page = 1; page <= config.pages; page++) {
      let url;
      if (page === 1) {
        url = `${site.searchBase}/${encodeURIComponent(config.keyword)}`;
      } else {
        const desde = (page - 1) * PER_PAGE + 1;
        url = `${site.searchBase}/${encodeURIComponent(config.keyword)}_Desde_${desde}_NoIndex_True`;
      }

      try {
        const html = await fetchWithRetry(url, headers);
        const parsed = parsePage(html, siteCode, page);
        if (page === 1) totalResults = parsed.total;
        pagesSearched = page;
        if (parsed.results.length === 0) break;
        allResults.push(...parsed.results);
        if (totalResults > 0 && allResults.length >= totalResults) break;
        if (page < config.pages) await sleep(1500);
      } catch (error) {
        partialError = error.message;
        break;
      }
    }

    // 匹配产品
    const batchResults = config.productTitles.map((title, idx) => {
      const titleNorm = normalizeText(title);
      const matches = allResults.filter(r => normalizeText(r.title).includes(titleNorm));
      if (matches.length === 0) {
        return { index: idx + 1, searchTitle: title, found: false, page: null, rankInPage: null, overallRank: null, matchedTitle: '', priceDisplay: '', currencySymbol: site.currencySymbol, link: '', seller: '', matchCount: 0 };
      }
      const best = matches[0];
      return { index: idx + 1, searchTitle: title, found: true, page: best.page, rankInPage: best.rankInPage, overallRank: best.overallRank, matchedTitle: best.title, priceDisplay: best.priceDisplay, currencySymbol: best.currencySymbol, link: best.link, seller: best.seller, matchCount: matches.length };
    });

    const foundCount = batchResults.filter(r => r.found).length;
    console.log(`[报告] ${site.name}: ${foundCount}/${batchResults.length} 已找到`);

    results.push({ siteCode, siteName: site.name, allResults, totalResults, pagesSearched, partialError, batchResults, foundCount, notFoundCount: batchResults.length - foundCount });
  }

  // 生成邮件 HTML
  const dateStr = formatDateStr(new Date());
  let sitesHtml = '';

  for (const sr of results) {
    let rowsHtml = '';
    if (sr.batchResults && sr.batchResults.length > 0) {
      rowsHtml = sr.batchResults.map(r => {
        if (!r.found) {
          return `<tr style="background:#fff5f5;"><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">${r.index}</td><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;"><span style="color:#e53935;font-weight:bold;">未找到</span></td><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">-</td><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">-</td><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">-</td><td style="padding:8px 12px;border:1px solid #e0e0e0;">${escapeHtmlEmail(r.searchTitle)}</td><td style="padding:8px 12px;border:1px solid #e0e0e0;color:#999;">未在前 ${sr.pagesSearched} 页中匹配到</td><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">-</td></tr>`;
        }
        const rankColor = r.overallRank === 1 ? '#ffd700' : r.overallRank <= 3 ? '#c0c0c0' : r.overallRank <= 10 ? '#cd7f32' : '#4caf50';
        const rankBg = r.overallRank === 1 ? '#fffdf0' : r.overallRank <= 3 ? '#f9f9f9' : r.overallRank <= 10 ? '#fff8f0' : '#f0fff0';
        return `<tr style="background:${rankBg};"><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">${r.index}</td><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;"><span style="color:#4caf50;font-weight:bold;">已找到</span></td><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;font-weight:bold;">第${r.page}页</td><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">第${r.rankInPage}位</td><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;"><span style="background:${rankColor};color:#fff;padding:2px 8px;border-radius:10px;font-weight:bold;">${r.overallRank}</span></td><td style="padding:8px 12px;border:1px solid #e0e0e0;">${escapeHtmlEmail(r.searchTitle)}</td><td style="padding:8px 12px;border:1px solid #e0e0e0;"><a href="${r.link}" target="_blank" style="color:#3483fa;text-decoration:none;">${escapeHtmlEmail(r.matchedTitle)}</a>${r.matchCount > 1 ? ` <span style="color:#999;font-size:12px;">(${r.matchCount}个匹配)</span>` : ''}</td><td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">${r.currencySymbol} ${r.priceDisplay || '-'}</td></tr>`;
      }).join('');
    }

    sitesHtml += `<div style="margin-bottom:24px;"><h2 style="color:#3483fa;border-bottom:2px solid #3483fa;padding-bottom:8px;">${sr.siteName} (${sr.siteCode}) <span style="font-size:14px;color:#666;font-weight:normal;">关键词: "${escapeHtmlEmail(config.keyword)}" | 总结果: ${sr.totalResults} | 搜索 ${sr.pagesSearched} 页 (${sr.allResults.length} 个商品)</span></h2>${sr.partialError ? `<p style="color:#e53935;">部分页面获取失败: ${escapeHtmlEmail(sr.partialError)}</p>` : ''}<div style="margin-bottom:12px;font-size:14px;"><span style="background:#e8f5e9;color:#2e7d32;padding:4px 12px;border-radius:4px;font-weight:bold;">已找到: ${sr.foundCount}</span><span style="background:#fbe9e7;color:#c62828;padding:4px 12px;border-radius:4px;font-weight:bold;margin-left:8px;">未找到: ${sr.notFoundCount}</span></div><table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#f5f5f5;"><th style="padding:8px 12px;border:1px solid #e0e0e0;width:40px;">#</th><th style="padding:8px 12px;border:1px solid #e0e0e0;width:70px;">状态</th><th style="padding:8px 12px;border:1px solid #e0e0e0;width:70px;">页码</th><th style="padding:8px 12px;border:1px solid #e0e0e0;width:70px;">页内位次</th><th style="padding:8px 12px;border:1px solid #e0e0e0;width:70px;">总排名</th><th style="padding:8px 12px;border:1px solid #e0e0e0;">搜索的产品标题</th><th style="padding:8px 12px;border:1px solid #e0e0e0;">匹配到的实际标题</th><th style="padding:8px 12px;border:1px solid #e0e0e0;width:90px;">价格</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
  }

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>美客多排名日报</title></head><body style="font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#f5f5f5;margin:0;padding:20px;"><div style="max-width:900px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.1);"><div style="text-align:center;margin-bottom:24px;"><h1 style="color:#3483fa;margin:0 0 8px;">\u{1F6D2} 美客多关键词排名日报</h1><p style="color:#999;font-size:14px;">${dateStr} | 自动搜索报告</p></div>${sitesHtml}<div style="margin-top:32px;padding:16px;background:#f5f5f5;border-radius:4px;text-align:center;color:#999;font-size:12px;"><p>本邮件由美客多搜索排名查询工具自动发送</p><p>如需修改设置，请在工具页面「定时报告」标签中配置</p></div></div></body></html>`;

  // 发送邮件
  const transporter = nodemailer.createTransport({
    host: config.smtpHost || 'smtp.qq.com',
    port: config.smtpPort || 465,
    secure: (config.smtpPort || 465) === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });

  const subject = `美客多排名日报 - ${dateStr} | 关键词: ${config.keyword}`;
  const info = await transporter.sendMail({
    from: `"美客多排名监控" <${config.smtpUser}>`,
    to: config.email,
    subject,
    html,
  });

  return { messageId: info.messageId, sitesCount: results.length, dateStr };
}

// 立即发送报告邮件
app.post('/api/send-report', async (req, res) => {
  try {
    const config = loadConfig();

    if (!config.keyword) {
      return res.status(400).json({ error: '请先在配置中设置搜索关键词' });
    }
    if (!config.productTitles || config.productTitles.length === 0) {
      return res.status(400).json({ error: '请先在配置中设置至少一个产品标题' });
    }
    if (!config.email) {
      return res.status(400).json({ error: '请先在配置中设置收件邮箱' });
    }

    console.log('[报告] 手动触发邮件发送...');
    const result = await runReportAndSendEmail(config);
    // 手动发也算「今天已发」：避免定时器稍后在今天的计划点上再补一封重复的
    saveReportState({
      lastDate: reportSchedule.beijingDate(new Date()),
      lastAt: reportSchedule.beijingLabel(new Date()),
      lastMessageId: (result && result.messageId) || '',
      lastError: '',
    });
    console.log('[报告] 邮件发送成功:', result.messageId);
    res.json({ success: true, message: `报告已发送至 ${config.email}`, ...result });
  } catch (error) {
    console.error('[报告] 发送失败:', error);
    res.status(500).json({ error: '发送报告失败: ' + error.message, hint: mailErrorHint(error.message) });
  }
});

// ==================== 内置定时调度器 ====================
// 决策逻辑在 report-schedule.js 里（纯函数、有单测），这里只负责「执行 + 落状态」。
//
// 相比旧实现修掉的问题：
//   旧：setInterval(60s) + 「小时==H 且 分钟==M」严格相等 → 只要某次 tick 跨过整分钟
//       （事件循环被卡一下就会），当天就永远不发；且没有任何「今天发过没」的记录，
//       一旦和外部任务并存就会重复发。
//   新：过了计划时间且今天还没发过就发（错过也只是晚一分钟），并用 lastDate 去重。
const REPORT_MAX_ATTEMPTS = 6;          // 每天最多尝试几次，免得一直失败一直重试
const REPORT_RETRY_GAP_MS = 5 * 60000;  // 失败后隔 5 分钟再试

// 邮件失败时「为什么 / 怎么办」——
// 2026-10-27 就是这么栽的：Clash 被切到全局模式（mode: global），TUN 把所有流量（含国内
// smtp.qq.com:465）都送到机场节点，机场封邮件端口，于是 TLS 握手直接被掐断，
// 报一个跟邮箱毫无关系的 "Client network socket disconnected before secure TLS connection
// was established"。光看这句话根本想不到是代理，所以直接把结论摊给用户。
function mailErrorHint(msg) {
  const m = String(msg || '');
  if (/secure TLS connection|ECONNRESET|socket disconnected|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(m)) {
    return '连不上 SMTP 服务器（握手阶段就被掐断）。Clash 若是「全局」模式，所有流量都走 GLOBAL 组选中的那个节点，而多数机场节点封 465/587/993 —— 换个不封的节点（实测日本[CM]、德国可发），或切回「规则」模式；也可以把 SMTP 端口改成 587 再试。跑 node probe-mail-path.js 能直接测出是哪一层断的。';
  }
  if (/535|Invalid login|Username and Password not accepted|authentication failed/i.test(m)) {
    return '账号或授权码不对。QQ 邮箱要填的是「授权码」不是登录密码：邮箱设置 → 账户 → 开启 SMTP 服务后生成，填到「SMTP 授权码」里保存。';
  }
  if (/550|553|Mailbox|recipient address rejected/i.test(m)) {
    return '收件地址被服务器拒收，检查收件邮箱是否写错、或该邮箱是否被退信限制。';
  }
  return '';
}

let reportSending = false;                        // 正在发送，防并发
let reportAttempt = { date: '', count: 0, nextAt: 0 };

function startScheduler() {
  setInterval(async () => {
    const config = loadConfig();
    const state = loadReportState();
    const d = reportSchedule.decideReportFire(config, new Date(), state.lastDate);

    if (!d.fire) return;                 // 未启用 / 今天还没到点 / 今天已发过
    if (reportSending) return;           // 上一封还在发

    if (reportAttempt.date !== d.date) reportAttempt = { date: d.date, count: 0, nextAt: 0 };
    if (reportAttempt.count >= REPORT_MAX_ATTEMPTS) return;  // 今天已放弃
    if (Date.now() < reportAttempt.nextAt) return;           // 退避中

    reportAttempt.count += 1;
    reportAttempt.nextAt = Date.now() + REPORT_RETRY_GAP_MS;
    reportSending = true;

    console.log(`[调度] 触发发报（${d.reason === 'catch-up' ? '补发' : '准点'}）：计划 ${d.scheduledAt}，第 ${reportAttempt.count} 次尝试`);

    try {
      const result = await runReportAndSendEmail(config);
      saveReportState({
        lastDate: d.date,
        lastAt: reportSchedule.beijingLabel(new Date()),
        lastMessageId: (result && result.messageId) || '',
        lastError: '',
        lastErrorHint: '',
      });
      console.log('[调度] 邮件发送成功:', result && result.messageId);
    } catch (err) {
      const hint = mailErrorHint(err.message);
      saveReportState({
        lastError: `第 ${reportAttempt.count} 次失败：${err.message}（${reportSchedule.beijingLabel(new Date())}）`,
        lastErrorHint: hint,
      });
      console.error('[调度] 邮件发送失败:', err.message, hint ? '｜' + hint : '');
    } finally {
      reportSending = false;
    }
  }, 60000); // 每分钟检查一次
}

// 报告发送状态（前端用它显示「上次 / 下次发送时间」，让用户看得见设置已生效）
app.get('/api/report/status', (req, res) => {
  const config = loadConfig();
  const state = loadReportState();
  res.json({
    ok: true,
    scheduleEnabled: !!config.scheduleEnabled,
    scheduleHour: config.scheduleHour,
    scheduleMinute: config.scheduleMinute,
    timezone: reportSchedule.TZ,
    lastDate: state.lastDate || '',
    lastAt: state.lastAt || '',
    lastMessageId: state.lastMessageId || '',
    lastError: state.lastError || '',
    // 老状态文件里没有 lastErrorHint，就用 lastError 现推一遍，不用等再次失败
    lastErrorHint: state.lastErrorHint || mailErrorHint(state.lastError) || '',
    nextRunAt: reportSchedule.computeNextRun(config, new Date(), state.lastDate || ''),
    serverNow: reportSchedule.beijingLabel(new Date()),
  });
});

// 全局兜底错误处理：必须放在所有路由之后。
// 没有它时任何未捕获异常都会走 Express 默认错误页 —— 返回 HTML + 完整堆栈，
// 前端拿到的是 HTML 而不是 JSON，报错信息只剩「HTTP 500」，排查全靠翻日志。
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[未捕获异常] ' + req.method + ' ' + req.originalUrl + ' → ' + ((err && err.stack) || err));
  res.status(500).json({ ok: false, error: (err && err.message) || '服务器内部错误' });
});

// 静态文件
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

const server = app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  美客多关键词搜索排名查询工具已启动`);
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`========================================\n`);

  // 启动内置定时调度器
  startScheduler();
  // 启动广告花费采样器（每 5 分钟记录当天累计花费，用于反推真实小时花费）
  startAdsSampler();
  // 启动微信提醒监控：给所有已审批账号各排一份（各自只在自己配置开启时才真正排期）
  scheduleAllPushMonitors();
  scheduleAllQuestionAutoReplyMonitors();
  // 大麦热搜词：只在缓存过期时后台刷新（不阻塞启动，也不重复扣积分）
  scheduleDmHot();
  const config = loadConfig();
  if (config.scheduleEnabled) {
    console.log(`  定时调度已启用: 每日 ${config.scheduleHour}:${String(config.scheduleMinute).padStart(2, '0')} (北京时间)`);
  } else {
    console.log(`  定时调度未启用`);
  }
  console.log('');
});

// 设置超时：42页搜索可能需要几分钟
server.timeout = 600000; // 10 分钟
server.keepAliveTimeout = 600000;
server.requestTimeout = 600000;

