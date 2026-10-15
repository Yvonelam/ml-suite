// ==================== 常量 ====================
const API_BASE = 'http://localhost:3002';
const ROWS_PER_PAGE = 50;

const CURRENCY_SYMBOLS = {
  ARS: '$', BRL: 'R$', MXN: '$'
};

// ==================== 全局状态 ====================
let currentResults = [];
let currentPage = 1;
let currentKeyword = '';
let currentFilter = '';
let currentBatchResults = [];
let currentBatchKeyword = '';
let autoSaveTimer = null;
let suppressAutoSave = true; // 初始加载填充表单时不触发自动保存

// ==================== 初始化 ====================
function init() {
  setupEventListeners();
  updateBatchTitleCount();
  loadConfig();
  setupGlassHighlight();
}

// 玻璃卡片鼠标跟随高光
function setupGlassHighlight() {
  document.querySelectorAll('.search-card').forEach(card => {
    // 动态注入光斑元素
    const glow = document.createElement('div');
    glow.className = 'glass-glow';
    card.appendChild(glow);

    card.addEventListener('mousemove', e => {
      const rect = card.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width * 100;
      const my = (e.clientY - rect.top) / rect.height * 100;
      card.style.setProperty('--mx', mx + '%');
      card.style.setProperty('--my', my + '%');
    });
  });
}

function getSelectedSiteInfo() {
  const select = document.getElementById('site');
  const opt = select.options[select.selectedIndex];
  return {
    code: opt.value,
    name: opt.textContent.split(' - ')[1] || opt.value,
    currency: opt.dataset.currency || '',
    currencySymbol: opt.dataset.currencySymbol || ''
  };
}

function setupEventListeners() {
  // 单关键词搜索
  document.getElementById('searchBtn').addEventListener('click', handleSearch);
  document.getElementById('testBtn').addEventListener('click', testConnection);
  document.getElementById('keyword').addEventListener('keypress', e => {
    if (e.key === 'Enter') handleSearch();
  });
  document.getElementById('productFilter').addEventListener('keypress', e => {
    if (e.key === 'Enter') handleSearch();
  });
  document.getElementById('exportBtn').addEventListener('click', exportCSV);

  // 批量搜索
  document.getElementById('batchSearchBtn').addEventListener('click', handleBatchSearch);
  document.getElementById('batchKeyword').addEventListener('keypress', e => {
    if (e.key === 'Enter') handleBatchSearch();
  });
  document.getElementById('batchTitles').addEventListener('input', updateBatchTitleCount);
  document.getElementById('batchExportBtn').addEventListener('click', exportBatchCSV);
  document.getElementById('clearBatchBtn').addEventListener('click', () => {
    document.getElementById('batchTitles').value = '';
    updateBatchTitleCount();
  });

  // 定时报告设置
  document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
  document.getElementById('sendReportBtn').addEventListener('click', sendReportNow);
  document.getElementById('cfgProductTitles').addEventListener('input', () => {
    updateCfgTitleCount();
    scheduleAutoSave();
  });
  document.getElementById('cfgScheduleEnabled').addEventListener('change', () => {
    updateScheduleToggle();
    scheduleAutoSave();
  });

  // 自动保存：设置面板任意字段修改后 1.5 秒自动保存
  ['cfgKeyword', 'cfgEmail', 'cfgSmtpHost', 'cfgSmtpPort', 'cfgSmtpUser', 'cfgSmtpPass'].forEach(id => {
    document.getElementById(id).addEventListener('input', scheduleAutoSave);
  });
  ['cfgPages', 'cfgScheduleHour', 'cfgScheduleMinute', 'cfgSiteMLM', 'cfgSiteMLB', 'cfgSiteMLA'].forEach(id => {
    document.getElementById(id).addEventListener('change', scheduleAutoSave);
  });
}

// ==================== Tab 切换 ====================
function switchTab(mode) {
  const tabs = ['Single', 'Batch', 'Settings'];
  const panels = { single: 'singlePanel', batch: 'batchPanel', settings: 'settingsPanel' };

  for (const t of tabs) {
    const btn = document.getElementById('tab' + t);
    if (btn) btn.classList.remove('active');
  }
  for (const key in panels) {
    const panel = document.getElementById(panels[key]);
    if (panel) panel.style.display = 'none';
  }

  const activeTab = document.getElementById('tab' + mode.charAt(0).toUpperCase() + mode.slice(1));
  const activePanel = document.getElementById(panels[mode]);
  if (activeTab) activeTab.classList.add('active');
  if (activePanel) activePanel.style.display = mode === 'settings' ? 'block' : 'block';

  hideResults();
  hideBatchResults();
  hideError();
  hideLoading();
}

// ==================== 批量标题计数 ====================
function updateBatchTitleCount() {
  const text = document.getElementById('batchTitles').value;
  const count = text.split('\n').map(t => t.trim()).filter(t => t.length > 0).length;
  document.getElementById('batchTitleCount').textContent = count;
}

// ==================== 连接测试 ====================
async function testConnection() {
  const btn = document.getElementById('testBtn');
  const result = document.getElementById('testResult');
  const site = document.getElementById('site').value;

  btn.disabled = true;
  result.textContent = '正在测试...';
  result.className = 'test-result';

  try {
    const response = await fetch(`${API_BASE}/api/test?site=${site}`);
    const data = await response.json();

    if (data.success) {
      result.textContent = '\u2705 ' + data.message;
      result.classList.add('success');
    } else {
      result.textContent = '\u274C ' + data.message;
      result.classList.add('fail');
    }
  } catch (error) {
    result.textContent = '\u274C 请求失败: ' + error.message;
    result.classList.add('fail');
  } finally {
    btn.disabled = false;
  }
}

// ==================== 单关键词搜索 ====================
async function handleSearch() {
  const keyword = document.getElementById('keyword').value.trim();
  const site = document.getElementById('site').value;
  const pages = parseInt(document.getElementById('pages').value);
  const productFilter = document.getElementById('productFilter').value.trim();

  if (!keyword) {
    showError('请输入搜索关键词');
    return;
  }

  currentKeyword = keyword;
  currentFilter = productFilter.toLowerCase();

  showLoading(keyword, site);
  hideError();
  hideResults();
  hideBatchResults();
  disableSearchBtn(true);

  try {
    const params = new URLSearchParams({ keyword, site, pages, productFilter });
    const response = await fetch(`${API_BASE}/api/search?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '搜索请求失败');
    }

    currentResults = data.results || [];
    currentPage = 1;
    displayResults(data);
  } catch (error) {
    showError(error.message);
  } finally {
    hideLoading();
    disableSearchBtn(false);
  }
}

// ==================== 批量搜索 ====================
async function handleBatchSearch() {
  const keyword = document.getElementById('batchKeyword').value.trim();
  const site = document.getElementById('batchSite').value;
  const pages = parseInt(document.getElementById('batchPages').value);
  const titles = document.getElementById('batchTitles').value.trim();

  if (!keyword) {
    showError('请输入搜索关键词');
    return;
  }

  const titleList = titles.split('\n').map(t => t.trim()).filter(t => t.length > 0);
  if (titleList.length === 0) {
    showError('请输入至少一个产品标题');
    return;
  }
  if (titleList.length > 100) {
    showError('最多支持 100 个产品标题');
    return;
  }

  currentBatchKeyword = keyword;

  showBatchLoading(keyword, site, titleList.length, pages);
  hideError();
  hideResults();
  hideBatchResults();
  disableBatchSearchBtn(true);

  try {
    const params = new URLSearchParams({ keyword, site, pages, titles });
    const response = await fetch(`${API_BASE}/api/batch-search?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '批量搜索请求失败');
    }

    currentBatchResults = data.results || [];
    displayBatchResults(data);
  } catch (error) {
    showError(error.message);
  } finally {
    hideLoading();
    disableBatchSearchBtn(false);
  }
}

// ==================== 单关键词结果展示 ====================
function displayResults(data) {
  const statsBar = document.getElementById('statsBar');
  let statsHtml = `
    <div class="stat-item">
      <span class="stat-value">${formatNumber(data.totalResults)}</span>
      <span class="stat-label">总结果数</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${data.pagesSearched}</span>
      <span class="stat-label">已搜索页数</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${data.resultsCount}</span>
      <span class="stat-label">已获取商品</span>
    </div>
  `;
  if (data.matchedCount !== null) {
    statsHtml += `
      <div class="stat-item highlight">
        <span class="stat-value">${data.matchedCount}</span>
        <span class="stat-label">匹配商品数</span>
      </div>
    `;
  }
  statsBar.innerHTML = statsHtml;

  const matchedSection = document.getElementById('matchedSection');
  const matchedList = document.getElementById('matchedList');
  const matchedTitle = document.getElementById('matchedTitle');

  if (data.matchedProducts) {
    matchedSection.style.display = 'block';
    if (data.matchedProducts.length > 0) {
      matchedTitle.textContent = `\u{1F3AF} 匹配的产品（共 ${data.matchedProducts.length} 个）`;
      matchedList.innerHTML = data.matchedProducts.map(p => `
        <div class="matched-item">
          <span class="matched-rank">第${p.page}页 第${p.rankInPage}位</span>
          <span class="matched-title">${escapeHtml(p.title)}</span>
          <span class="matched-price">${formatPrice(p.price, p.currency, data.currencySymbol)}</span>
          <a href="${p.link}" target="_blank" rel="noopener" class="matched-link">查看商品 \u2192</a>
        </div>
      `).join('');
    } else {
      const filterText = document.getElementById('productFilter').value.trim();
      matchedTitle.textContent = '\u{1F50D} 未找到匹配产品';
      matchedList.innerHTML = `
        <div class="no-match">
          \u26A0\uFE0F 在前 ${data.pagesSearched} 页（共 ${data.resultsCount} 个商品）中未找到标题包含 "<strong>${escapeHtml(filterText)}</strong>" 的产品。<br>
          建议扩大搜索页数或更换筛选关键词。
        </div>
      `;
    }
  } else {
    matchedSection.style.display = 'none';
  }

  const partialError = document.getElementById('partialError');
  if (data.partialError) {
    partialError.textContent = `\u26A0\uFE0F 部分页面获取失败：${data.partialError}（已返回成功获取的结果）`;
    partialError.style.display = 'block';
  } else {
    partialError.style.display = 'none';
  }

  updateTableInfo();
  renderTable();
  showResults();
}

function updateTableInfo() {
  const total = currentResults.length;
  const start = total === 0 ? 0 : (currentPage - 1) * ROWS_PER_PAGE + 1;
  const end = Math.min(currentPage * ROWS_PER_PAGE, total);
  document.getElementById('tableInfo').textContent =
    `共 ${total} 个商品 \u00B7 显示第 ${start}-${end} 个`;
}

function renderTable() {
  const tbody = document.getElementById('resultsBody');
  const start = (currentPage - 1) * ROWS_PER_PAGE;
  const end = start + ROWS_PER_PAGE;
  const pageResults = currentResults.slice(start, end);

  if (pageResults.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted);">暂无数据</td></tr>`;
    renderPagination();
    return;
  }

  tbody.innerHTML = pageResults.map(r => {
    const isMatch = currentFilter && r.title.toLowerCase().includes(currentFilter);
    const rankClass = r.overallRank === 1 ? 'top1' :
                      r.overallRank <= 3 ? 'top3' :
                      r.overallRank <= 10 ? 'top10' : 'other';
    const conditionTag = r.condition === 'new'
      ? '<span class="condition-tag condition-new">全新</span>'
      : r.condition === 'used'
      ? '<span class="condition-tag condition-used">二手</span>'
      : '';
    const sym = r.currencySymbol || CURRENCY_SYMBOLS[r.currency] || '';
    const priceStr = r.priceDisplay || (r.price > 0 ? r.price.toLocaleString('en-US', {maximumFractionDigits: 2}) : '-');

    return `
      <tr class="${isMatch ? 'highlighted' : ''}">
        <td class="col-rank"><span class="rank-badge ${rankClass}">${r.overallRank}</span></td>
        <td class="col-page"><span class="page-badge">P${r.page}</span></td>
        <td class="col-rank">${r.rankInPage}</td>
        <td class="col-thumb"></td>
        <td class="col-title">
          <a href="${r.link}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>${conditionTag}
        </td>
        <td class="col-price">${sym} ${priceStr}</td>
        <td class="col-sold">-</td>
        <td class="col-seller">${escapeHtml(r.seller)}</td>
        <td class="col-link"><a href="${r.link}" target="_blank" rel="noopener" title="查看商品">\u{1F517}</a></td>
      </tr>
    `;
  }).join('');

  renderPagination();
}

function renderPagination() {
  const container = document.getElementById('pagination');
  const totalPages = Math.ceil(currentResults.length / ROWS_PER_PAGE);

  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  html += `<button class="page-btn" onclick="goToPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>\u2039</button>`;

  const maxVisible = 7;
  let startPage = Math.max(1, currentPage - 3);
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }

  if (startPage > 1) {
    html += `<button class="page-btn" onclick="goToPage(1)">1</button>`;
    if (startPage > 2) html += `<span class="page-ellipsis">...</span>`;
  }

  for (let i = startPage; i <= endPage; i++) {
    html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += `<span class="page-ellipsis">...</span>`;
    html += `<button class="page-btn" onclick="goToPage(${totalPages})">${totalPages}</button>`;
  }

  html += `<button class="page-btn" onclick="goToPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>\u203A</button>`;

  container.innerHTML = html;
}

function goToPage(page) {
  const totalPages = Math.ceil(currentResults.length / ROWS_PER_PAGE);
  if (page < 1 || page > totalPages) return;
  currentPage = page;
  renderTable();
  updateTableInfo();
  const section = document.getElementById('resultsSection');
  if (section) {
    window.scrollTo({ top: section.offsetTop - 20, behavior: 'smooth' });
  }
}

// ==================== 批量搜索结果展示 ====================
function displayBatchResults(data) {
  // 统计概览
  const statsBar = document.getElementById('batchStatsBar');
  statsBar.innerHTML = `
    <div class="stat-item">
      <span class="stat-value">${data.productCount}</span>
      <span class="stat-label">产品总数</span>
    </div>
    <div class="stat-item highlight">
      <span class="stat-value">${data.foundCount}</span>
      <span class="stat-label">已找到</span>
    </div>
    <div class="stat-item">
      <span class="stat-value" style="color:var(--red);">${data.notFoundCount}</span>
      <span class="stat-label">未找到</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${formatNumber(data.totalResults)}</span>
      <span class="stat-label">关键词总结果</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${data.pagesSearched}</span>
      <span class="stat-label">搜索页数</span>
    </div>
  `;

  // 表格信息
  document.getElementById('batchTableInfo').textContent =
    `关键词: "${data.keyword}" \u00B7 站点: ${data.siteName} \u00B7 共搜索 ${data.totalItems} 个商品`;

  // 渲染表格
  const tbody = document.getElementById('batchResultsBody');
  tbody.innerHTML = data.results.map(r => {
    const sym = r.currencySymbol || CURRENCY_SYMBOLS[r.currency] || '';
    const priceStr = r.priceDisplay || (r.price > 0 ? r.price.toLocaleString('en-US', {maximumFractionDigits: 2}) : '-');

    if (!r.found) {
      return `
        <tr class="batch-not-found">
          <td class="col-idx">${r.index}</td>
          <td class="col-status"><span class="status-tag status-not-found">\u274C 未找到</span></td>
          <td class="col-page">-</td>
          <td class="col-rank">-</td>
          <td class="col-rank">-</td>
          <td class="col-batch-title">${escapeHtml(r.searchTitle)}</td>
          <td class="col-batch-matched"><span class="text-muted">未在前 ${data.pagesSearched} 页中匹配到</span></td>
          <td class="col-price">-</td>
          <td class="col-seller">-</td>
          <td class="col-link">-</td>
        </tr>
      `;
    }

    const rankClass = r.overallRank === 1 ? 'top1' :
                      r.overallRank <= 3 ? 'top3' :
                      r.overallRank <= 10 ? 'top10' : 'other';
    const matchBadge = r.matchCount > 1
      ? `<span class="match-count-badge">${r.matchCount} 个匹配</span>`
      : '';

    return `
      <tr class="batch-found">
        <td class="col-idx">${r.index}</td>
        <td class="col-status"><span class="status-tag status-found">\u2705 已找到</span></td>
        <td class="col-page"><span class="page-badge">P${r.page}</span></td>
        <td class="col-rank"><span class="rank-badge ${rankClass}">${r.rankInPage}</span></td>
        <td class="col-rank"><span class="rank-badge ${rankClass}">${r.overallRank}</span></td>
        <td class="col-batch-title">${escapeHtml(r.searchTitle)}</td>
        <td class="col-batch-matched">
          <a href="${r.link}" target="_blank" rel="noopener">${escapeHtml(r.matchedTitle)}</a>
          ${matchBadge}
        </td>
        <td class="col-price">${sym} ${priceStr}</td>
        <td class="col-seller">${escapeHtml(r.seller)}</td>
        <td class="col-link"><a href="${r.link}" target="_blank" rel="noopener" title="查看商品">\u{1F517}</a></td>
      </tr>
    `;
  }).join('');

  showBatchResults();
}

// ==================== CSV 导出 ====================
function exportCSV() {
  if (currentResults.length === 0) {
    alert('暂无数据可导出');
    return;
  }

  const headers = ['总排名', '页码', '页内位次', '产品标题', '价格', '币种', '卖家', '商品状态', '商品链接', '商品ID'];
  const rows = currentResults.map(r => [
    r.overallRank,
    r.page,
    r.rankInPage,
    `"${r.title.replace(/"/g, '""')}"`,
    r.priceDisplay || r.price,
    r.currency,
    `"${r.seller.replace(/"/g, '""')}"`,
    r.condition === 'new' ? '全新' : r.condition === 'used' ? '二手' : r.conditionDisplay || '',
    r.link,
    r.id
  ]);

  const csv = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `美客多搜索_${currentKeyword}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportBatchCSV() {
  if (currentBatchResults.length === 0) {
    alert('暂无数据可导出');
    return;
  }

  const headers = ['序号', '状态', '页码', '页内位次', '总排名', '搜索的产品标题', '匹配的实际标题', '价格', '币种', '卖家', '匹配数', '商品链接'];
  const rows = currentBatchResults.map(r => [
    r.index,
    r.found ? '已找到' : '未找到',
    r.page || '',
    r.rankInPage || '',
    r.overallRank || '',
    `"${r.searchTitle.replace(/"/g, '""')}"`,
    `"${(r.matchedTitle || '').replace(/"/g, '""')}"`,
    r.priceDisplay || '',
    r.currency,
    `"${(r.seller || '').replace(/"/g, '""')}"`,
    r.matchCount,
    r.link || ''
  ]);

  const csv = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `美客多批量搜索_${currentBatchKeyword}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ==================== 工具函数 ====================
function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatPrice(price, currency, symbol) {
  if (!price) return '-';
  const sym = CURRENCY_SYMBOLS[currency] || symbol || '';
  return `${sym} ${Number(price).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ==================== UI 控制 ====================
function showLoading(keyword, siteCode) {
  const section = document.getElementById('loadingSection');
  const text = document.getElementById('loadingText');
  const subtext = document.getElementById('loadingSubtext');
  const progress = document.getElementById('loadingProgress');
  const siteInfo = getSelectedSiteInfo();
  const pages = parseInt(document.getElementById('pages').value);
  const estSec = Math.round(pages * 3.5);
  const estStr = estSec >= 60 ? `${Math.floor(estSec/60)}分${estSec%60}秒` : `${estSec}秒`;
  text.textContent = `正在搜索 "${keyword}" ...`;
  subtext.textContent = `站点：${siteInfo.name} \u00B7 搜索 ${pages} 页（${pages * 48} 个商品）\u00B7 预计 ${estStr}`;
  if (progress) progress.style.display = 'none';
  section.style.display = 'block';
}

function showBatchLoading(keyword, siteCode, titleCount, pages) {
  const section = document.getElementById('loadingSection');
  const text = document.getElementById('loadingText');
  const subtext = document.getElementById('loadingSubtext');
  const progress = document.getElementById('loadingProgress');
  const estSec = Math.round(pages * 3.5);
  const estStr = estSec >= 60 ? `${Math.floor(estSec/60)}分${estSec%60}秒` : `${estSec}秒`;
  text.textContent = `正在批量搜索 "${keyword}" ...`;
  subtext.textContent = `${titleCount} 个产品标题 \u00B7 搜索 ${pages} 页（最多 ${pages * 48} 个商品）`;
  if (progress) {
    progress.textContent = `\u{1F4E6} 正在抓取美客多搜索结果并匹配产品... 预计 ${estStr}`;
    progress.style.display = 'block';
  }
  section.style.display = 'block';
}

function hideLoading() {
  document.getElementById('loadingSection').style.display = 'none';
}

function showError(msg) {
  const section = document.getElementById('errorSection');
  document.getElementById('errorText').innerHTML = msg;
  section.style.display = 'block';
}

function hideError() {
  document.getElementById('errorSection').style.display = 'none';
}

function showResults() {
  document.getElementById('resultsSection').style.display = 'block';
}

function hideResults() {
  document.getElementById('resultsSection').style.display = 'none';
}

function showBatchResults() {
  document.getElementById('batchResultsSection').style.display = 'block';
  const section = document.getElementById('batchResultsSection');
  if (section) {
    window.scrollTo({ top: section.offsetTop - 20, behavior: 'smooth' });
  }
}

function hideBatchResults() {
  document.getElementById('batchResultsSection').style.display = 'none';
}

function disableSearchBtn(disabled) {
  const btn = document.getElementById('searchBtn');
  btn.disabled = disabled;
  btn.innerHTML = disabled
    ? '<span class="btn-icon">\u23F3</span> 搜索中...'
    : '<span class="btn-icon">\u{1F50D}</span> 开始搜索';
}

function disableBatchSearchBtn(disabled) {
  const btn = document.getElementById('batchSearchBtn');
  btn.disabled = disabled;
  btn.innerHTML = disabled
    ? '<span class="btn-icon">\u23F3</span> 搜索中...'
    : '<span class="btn-icon">\u{1F4E6}</span> 批量搜索';
}

// ==================== 定时报告配置 ====================

async function loadConfig() {
  try {
    const response = await fetch(`${API_BASE}/api/config`);
    const config = await response.json();

    document.getElementById('cfgKeyword').value = config.keyword || '';
    document.getElementById('cfgPages').value = config.pages || 5;
    document.getElementById('cfgEmail').value = config.email || '';
    document.getElementById('cfgSmtpHost').value = config.smtpHost || 'smtp.qq.com';
    document.getElementById('cfgSmtpPort').value = config.smtpPort || 465;
    document.getElementById('cfgSmtpUser').value = config.smtpUser || '';
    document.getElementById('cfgSmtpPass').value = '';
    document.getElementById('cfgSmtpPass').placeholder = config.smtpPassSet ? '已设置，留空则不修改' : '请输入 SMTP 授权码';
    document.getElementById('cfgScheduleHour').value = config.scheduleHour ?? 14;
    document.getElementById('cfgScheduleMinute').value = config.scheduleMinute ?? 0;
    document.getElementById('cfgScheduleEnabled').checked = !!config.scheduleEnabled;

    // 产品标题
    if (config.productTitles && config.productTitles.length > 0) {
      document.getElementById('cfgProductTitles').value = config.productTitles.join('\n');
    }

    // 站点多选
    const sites = config.sites || ['MLM'];
    document.getElementById('cfgSiteMLM').checked = sites.includes('MLM');
    document.getElementById('cfgSiteMLB').checked = sites.includes('MLB');
    document.getElementById('cfgSiteMLA').checked = sites.includes('MLA');

    updateCfgTitleCount();
    updateScheduleToggle();
    // 填充完成，延迟放开自动保存
    setTimeout(() => { suppressAutoSave = false; }, 300);
  } catch (error) {
    console.error('加载配置失败:', error);
    suppressAutoSave = false;
  }
}

// 从表单收集配置
function collectConfigForm() {
  const titles = document.getElementById('cfgProductTitles').value.trim();
  const sites = [];
  if (document.getElementById('cfgSiteMLM').checked) sites.push('MLM');
  if (document.getElementById('cfgSiteMLB').checked) sites.push('MLB');
  if (document.getElementById('cfgSiteMLA').checked) sites.push('MLA');

  return {
    keyword: document.getElementById('cfgKeyword').value.trim(),
    productTitles: titles.split('\n').map(t => t.trim()).filter(t => t.length > 0),
    sites,
    pages: parseInt(document.getElementById('cfgPages').value),
    email: document.getElementById('cfgEmail').value.trim(),
    scheduleEnabled: document.getElementById('cfgScheduleEnabled').checked,
    scheduleHour: parseInt(document.getElementById('cfgScheduleHour').value),
    scheduleMinute: parseInt(document.getElementById('cfgScheduleMinute').value),
    smtpHost: document.getElementById('cfgSmtpHost').value.trim() || 'smtp.qq.com',
    smtpPort: parseInt(document.getElementById('cfgSmtpPort').value) || 465,
    smtpUser: document.getElementById('cfgSmtpUser').value.trim(),
    smtpPass: document.getElementById('cfgSmtpPass').value.trim(),
  };
}

function validateConfigForm(cfg) {
  if (!cfg.keyword) return '请输入搜索关键词';
  if (cfg.productTitles.length === 0) return '请输入至少一个产品标题';
  if (!cfg.email) return '请输入收件邮箱';
  if (cfg.sites.length === 0) return '请至少选择一个站点';
  return null;
}

async function postConfig(cfg) {
  return fetch(`${API_BASE}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
}

// 自动保存（防抖 1.5 秒）
function scheduleAutoSave() {
  if (suppressAutoSave) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(autoSaveConfig, 1500);
}

async function autoSaveConfig() {
  const cfg = collectConfigForm();
  if (validateConfigForm(cfg)) return; // 必填项未填完整时跳过自动保存
  try {
    const response = await postConfig(cfg);
    const data = await response.json();
    if (response.ok && data.success) {
      const t = new Date();
      showConfigStatus(`\u2713 已自动保存 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}（修改实时生效，无需手动保存）`, 'autosave');
    }
  } catch {
    // 静默失败，手动保存时会再提示
  }
}

async function saveConfig() {
  const cfg = collectConfigForm();
  const err = validateConfigForm(cfg);
  if (err) {
    showConfigStatus('\u26A0\uFE0F ' + err, 'error');
    return;
  }

  const btn = document.getElementById('saveConfigBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">\u23F3</span> 保存中...';

  try {
    const response = await postConfig(cfg);
    const data = await response.json();

    if (response.ok && data.success) {
      showConfigStatus('\u2705 设置已保存！' + (cfg.scheduleEnabled ? ` 定时发送已启用：每日 ${cfg.scheduleHour}:${String(cfg.scheduleMinute).padStart(2, '0')} 北京时间` : ''), 'success');
    } else {
      showConfigStatus('\u274C 保存失败：' + (data.error || '未知错误'), 'error');
    }
  } catch (error) {
    showConfigStatus('\u274C 请求失败：' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">\u{1F4BE}</span> 保存设置';
  }
}

async function sendReportNow() {
  const email = document.getElementById('cfgEmail').value.trim();
  const keyword = document.getElementById('cfgKeyword').value.trim();

  if (!keyword) {
    showConfigStatus('请先输入搜索关键词并保存设置', 'error');
    return;
  }
  if (!email) {
    showConfigStatus('请先输入收件邮箱并保存设置', 'error');
    return;
  }

  // 先保存当前配置
  await saveConfig();

  const btn = document.getElementById('sendReportBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">\u23F3</span> 发送中...（搜索+发邮件，请耐心等待）';
  showConfigStatus('\u{1F4E7} 正在搜索美客多并发送邮件，请耐心等待...', 'loading');

  try {
    const response = await fetch(`${API_BASE}/api/send-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();

    if (response.ok && data.success) {
      showConfigStatus(`\u2705 报告已发送至 ${data.message || '邮箱'}！`, 'success');
    } else {
      showConfigStatus('\u274C 发送失败：' + (data.error || '未知错误'), 'error');
    }
  } catch (error) {
    showConfigStatus('\u274C 请求失败：' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">\u{1F4E7}</span> 立即发送报告';
  }
}

function updateCfgTitleCount() {
  const text = document.getElementById('cfgProductTitles').value;
  const count = text.split('\n').map(t => t.trim()).filter(t => t.length > 0).length;
  document.getElementById('cfgTitleCount').textContent = count;
}

function updateScheduleToggle() {
  const enabled = document.getElementById('cfgScheduleEnabled').checked;
  const label = document.getElementById('scheduleStatusLabel');
  label.textContent = enabled ? '已启用' : '未启用';
  label.style.color = enabled ? '#00a650' : '#999';
}

function showConfigStatus(msg, type) {
  const el = document.getElementById('configStatus');
  el.textContent = msg;
  el.className = 'config-status ' + (type || '');
  el.style.display = 'block';
}

// 启动
init();
