// ========================================================
//  Settings (persisted in localStorage)
// ========================================================
const $ = id => document.getElementById(id);
const apiUrlInput = $('api-url');
const delayInput = $('delay');
const autoplayChk = $('autoplay');

function defaultApiUrl() {
  return /^https?:$/.test(window.location.protocol)
    ? window.location.origin
    : 'http://127.0.0.1:8080';
}
apiUrlInput.value = defaultApiUrl();

function loadSettings() {
  const url = localStorage.getItem('lexica.apiUrl');
  const delay = localStorage.getItem('lexica.delay');
  const ap = localStorage.getItem('lexica.autoplay');
  if (url) apiUrlInput.value = url;
  if (delay) delayInput.value = delay;
  if (ap !== null) autoplayChk.checked = ap === '1';
}
loadSettings();

apiUrlInput.addEventListener('change', () => {
  localStorage.setItem('lexica.apiUrl', apiUrlInput.value);
  refreshGCSFiles();
});
delayInput.addEventListener('change', () => localStorage.setItem('lexica.delay', delayInput.value));
autoplayChk.addEventListener('change', () => localStorage.setItem('lexica.autoplay', autoplayChk.checked ? '1' : '0'));

const apiBase = () => apiUrlInput.value.trim().replace(/\/+$/, '');

// ========================================================
//  File loading & format dispatch
// ========================================================
const fileInput = $('file-input');
const loadBtn = $('load-btn');
const tableFileInput = $('table-file-input');
const tableReadBtn = $('table-read-btn');
const statusEl = $('status');
const contentEl = $('content');
const readerPanel = $('reader-panel');
const readerHeader = $('reader-header');
const readerBody = $('reader-body');
const readerTablebar = $('reader-tablebar');
const readerCloseBtn = $('reader-close-btn');
const gcsPrefixEl = $('gcs-prefix');
const gcsStatusEl = $('gcs-status');
const gcsListEl = $('gcs-list');
const gcsRefreshBtn = $('gcs-refresh');
const recentBtn = $('recent-btn');
const recentMenu = $('recent-menu');

let gcsFiles = [];
let activeGCSName = '';
let openGCSFolders = new Set(JSON.parse(localStorage.getItem('lexica.gcs.openFolders') || '[]'));

loadBtn.addEventListener('click', () => fileInput.click());
tableReadBtn.addEventListener('click', () => tableFileInput.click());
gcsRefreshBtn.addEventListener('click', refreshGCSFiles);

tableFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  activeGCSName = '';
  await openReaderFile(file, file.name, { tableNav: true });
  recordRecentFile('local:' + file.name);
  tableFileInput.value = '';
});

// ---- Recently opened files (re-openable GCS paths only) ----
const RECENT_KEY = 'lexica.recentFiles';
const RECENT_MAX = 10;

function getRecentFiles() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch { return []; }
}

function recordRecentFile(name) {
  if (!name) return;
  const list = getRecentFiles().filter(n => n !== name);
  list.unshift(name);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}

function toggleRecentMenu(force) {
  const show = force !== undefined ? force : recentMenu.classList.contains('hidden');
  if (show) { renderRecentMenu(); recentMenu.classList.remove('hidden'); }
  else recentMenu.classList.add('hidden');
}

function renderRecentMenu() {
  const list = getRecentFiles();
  recentMenu.innerHTML = '';

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = '暂无最近打开';
    recentMenu.appendChild(empty);
    return;
  }

  list.forEach(name => {
    const isLocal = name.startsWith('local:');
    const displayName = isLocal ? name.slice(6) : name;
    const item = document.createElement('button');
    item.className = 'recent-item';
    item.title = displayName;
    item.innerHTML =
      `<span class="recent-name">${escapeHTML(baseName(displayName))}</span>` +
      `<span class="recent-path">${isLocal ? '📁 本地文件' : escapeHTML(dirName(displayName) || '/')}</span>`;
    item.addEventListener('click', () => {
      toggleRecentMenu(false);
      if (isLocal) {
        flash('本地文件请通过「打开文件」按钮重新打开');
      } else {
        openGCSFile(name);
      }
    });
    recentMenu.appendChild(item);
  });

  const clear = document.createElement('button');
  clear.className = 'recent-clear';
  clear.textContent = '清空最近';
  clear.addEventListener('click', () => { localStorage.removeItem(RECENT_KEY); renderRecentMenu(); });
  recentMenu.appendChild(clear);
}

recentBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleRecentMenu(); });
document.addEventListener('click', (e) => {
  if (!recentMenu.classList.contains('hidden') &&
      !recentMenu.contains(e.target) && e.target !== recentBtn) {
    toggleRecentMenu(false);
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleRecentMenu(false); });

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  activeGCSName = '';
  renderGCSList(gcsFiles);
  await openReaderFile(file, file.name);
  recordRecentFile('local:' + file.name);
  fileInput.value = '';
});

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMarkdown(text, sourceName) {
  if (window.marked) {
    marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });
    const rendered = marked.parse(text);
    const safeHTML = window.DOMPurify ? DOMPurify.sanitize(rendered) : rendered;
    return rewriteMarkdownLinks(safeHTML, sourceName);
  }

  const blocks = [];
  let inCode = false;
  let code = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('```')) {
      if (inCode) {
        blocks.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push(`<h${heading[1].length}>${escapeHTML(heading[2])}</h${heading[1].length}>`);
    } else if (line.trim()) {
      blocks.push(`<p>${escapeHTML(line)}</p>`);
    }
  }
  if (code.length) blocks.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
  return rewriteMarkdownLinks(blocks.join('\n'), sourceName);
}

function rewriteMarkdownLinks(html, sourceName) {
  const baseDir = dirName(sourceName || '');
  if (!baseDir) return html;

  const template = document.createElement('template');
  template.innerHTML = html;

  template.content.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src');
    if (!isRelativeURL(src)) return;
    img.src = `${apiBase()}/gcs/download?name=${encodeURIComponent(joinGCSPath(baseDir, stripURLSuffix(src)))}`;
  });

  template.content.querySelectorAll('a[href]').forEach(link => {
    const href = link.getAttribute('href');
    if (!isRelativeURL(href)) return;

    const gcsName = joinGCSPath(baseDir, stripURLSuffix(href));
    if (isReaderSupported(gcsName)) {
      link.href = '#';
      link.dataset.gcsName = gcsName;
    } else {
      link.href = `${apiBase()}/gcs/download?name=${encodeURIComponent(gcsName)}`;
      link.target = '_blank';
      link.rel = 'noopener';
    }
  });

  return template.innerHTML;
}

function isRelativeURL(value) {
  if (!value) return false;
  return !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(value);
}

function stripURLSuffix(value) {
  const idx = String(value).search(/[?#]/);
  return idx === -1 ? value : value.slice(0, idx);
}

function joinGCSPath(baseDir, relPath) {
  const parts = (baseDir + relPath).split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function isReaderSupported(name) {
  return ['txt', 'csv', 'md', 'markdown', 'pdf', 'docx', 'epub'].includes(fileExt(name));
}

function fileExt(name) {
  return (name.split('.').pop() || '').toLowerCase();
}

async function readFileAsHTML(file, sourceName) {
  const ext = fileExt(file.name);
  let html = '', mode = 'rich';

  if (ext === 'txt') {
    html = escapeHTML(await file.text());
    mode = 'plain';
  } else if (ext === 'md' || ext === 'markdown') {
    html = renderMarkdown(await file.text(), sourceName);
    mode = 'markdown';
  } else if (ext === 'csv') {
    html = csvToTable(await file.text());
  } else if (ext === 'pdf') {
    html = await loadPDF(file);
    mode = 'plain';
  } else if (ext === 'docx') {
    html = await loadDocx(file);
  } else if (ext === 'epub') {
    html = await loadEpub(file);
  } else {
    throw new Error(`不支持的格式: .${ext}`);
  }

  return { html, mode };
}

// Opens a file into the floating reader panel. The home-screen background
// (#status) stays visible behind it. With { tableNav:true } the rendered table
// becomes arrow-key navigable with auto-read (Markdown table reader).
async function openReaderFile(file, label, opts = {}) {
  const tableNav = !!opts.tableNav;
  exitTableNav();

  // Show the panel over the background; other mode panels step aside.
  dictPanel.classList.remove('visible');
  learnPanel.classList.remove('visible');
  recogPanel.classList.remove('visible');
  studyPanel.classList.remove('visible');
  readerPanel.classList.add('visible');
  readerTablebar.classList.toggle('hidden', !tableNav);
  $('reader-title').textContent = label;
  contentEl.style.display = 'block';
  contentEl.removeAttribute('data-mode');
  contentEl.innerHTML = `<p class="reader-loading">读取中  ${escapeHTML(label)}</p>`;

  try {
    const result = await readFileAsHTML(file, label);
    contentEl.dataset.mode = result.mode;
    contentEl.innerHTML = result.html;
    readerBody.scrollTop = 0;
    if (tableNav) enterTableNav();
  } catch (err) {
    console.error(err);
    contentEl.removeAttribute('data-mode');
    contentEl.innerHTML = `<p class="reader-loading error">读取失败: ${escapeHTML(err.message)}</p>`;
  }
}

readerCloseBtn.addEventListener('click', () => {
  exitTableNav();
  readerPanel.classList.remove('visible');
});

// Drag support for reader panel (same pattern as the other panels)
let readerDrag = null;

function readerPlacePanel(left, top, width, height) {
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  readerPanel.style.left = `${clamp(left, margin, maxLeft)}px`;
  readerPanel.style.top = `${clamp(top, margin, maxTop)}px`;
  readerPanel.style.right = 'auto';
  readerPanel.style.bottom = 'auto';
  readerPanel.style.transform = 'none';
}

readerHeader.addEventListener('pointerdown', (e) => {
  if ((e.button !== undefined && e.button !== 0) || e.target.closest('button')) return;
  const rect = readerPanel.getBoundingClientRect();
  readerDrag = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, width: rect.width, height: rect.height };
  readerPanel.classList.add('dragging');
  readerPanel.style.width = `${rect.width}px`;
  readerPanel.style.height = `${rect.height}px`;
  readerHeader.setPointerCapture(e.pointerId);
  e.preventDefault();
});

readerHeader.addEventListener('pointermove', (e) => {
  if (!readerDrag) return;
  readerPlacePanel(e.clientX - readerDrag.offsetX, e.clientY - readerDrag.offsetY, readerDrag.width, readerDrag.height);
  e.preventDefault();
});

function endReaderDrag(e) {
  if (!readerDrag) return;
  readerDrag = null;
  readerPanel.classList.remove('dragging');
  if (readerHeader.hasPointerCapture(e.pointerId)) readerHeader.releasePointerCapture(e.pointerId);
}

readerHeader.addEventListener('pointerup', endReaderDrag);
readerHeader.addEventListener('pointercancel', endReaderDrag);

// ---- Markdown table reader: arrow-key cursor box + auto-read English cells ----
let tableNavState = null;

function exitTableNav() {
  if (!tableNavState) return;
  window.removeEventListener('keydown', tableNavState.keyHandler);
  tableNavState.cells.forEach(r => r.forEach(c => c.classList.remove('tr-cell-active')));
  tableNavState = null;
  readerTablebar.classList.add('hidden');
}

function enterTableNav() {
  exitTableNav();
  const table = contentEl.querySelector('table');
  if (!table) {
    flash('没找到表格', true);
    readerTablebar.classList.add('hidden');
    return;
  }
  const cells = Array.from(table.rows).map(r => Array.from(r.cells));
  if (!cells.length || !cells[0].length) return;

  const state = { cells, row: 0, col: 0, keyHandler: null };
  tableNavState = state;
  readerTablebar.classList.remove('hidden');

  function highlight(read) {
    state.cells.forEach(r => r.forEach(c => c.classList.remove('tr-cell-active')));
    const cell = state.cells[state.row] && state.cells[state.row][state.col];
    if (!cell) return;
    cell.classList.add('tr-cell-active');
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (read) {
      const txt = (cell.textContent || '').trim();
      if (/[A-Za-z]/.test(txt)) dictPlayTTS(txt); // English cells only; 中文/空格不读
    }
  }

  function move(dr, dc) {
    const row = clamp(state.row + dr, 0, state.cells.length - 1);
    const col = clamp(state.col + dc, 0, state.cells[row].length - 1);
    state.row = row;
    state.col = col;
    highlight(true);
  }

  state.keyHandler = (e) => {
    if (!readerPanel.classList.contains('visible')) return;
    if (isEditableTarget(e.target)) return;
    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); move(-1, 0); break;
      case 'ArrowDown':  e.preventDefault(); move(1, 0); break;
      case 'ArrowLeft':  e.preventDefault(); move(0, -1); break;
      case 'ArrowRight': e.preventDefault(); move(0, 1); break;
      // Extra shortcuts: Space = down, Enter = up
      case ' ':          e.preventDefault(); move(1, 0); break;
      case 'Enter':      e.preventDefault(); move(-1, 0); break;
      // Vim keys: h/j/k/l = left/down/up/right
      case 'h': case 'H': e.preventDefault(); move(0, -1); break;
      case 'j': case 'J': e.preventDefault(); move(1, 0); break;
      case 'k': case 'K': e.preventDefault(); move(-1, 0); break;
      case 'l': case 'L': e.preventDefault(); move(0, 1); break;
      case 'Escape':     e.preventDefault(); exitTableNav(); break;
      case 'r': case 'R': e.preventDefault(); highlight(true); break;
      default: break;
    }
  };
  window.addEventListener('keydown', state.keyHandler);
  highlight(true);
}

contentEl.addEventListener('click', (e) => {
  if (!e.target.closest) return;
  const link = e.target.closest('a[data-gcs-name]');
  if (!link) return;
  e.preventDefault();
  openGCSFile(link.dataset.gcsName);
});

function setGCSStatus(msg, isError) {
  gcsStatusEl.textContent = msg;
  gcsStatusEl.classList.toggle('error', Boolean(isError));
}

async function refreshGCSFiles() {
  setGCSStatus('加载中...');
  gcsListEl.innerHTML = '';

  try {
    const res = await fetch(`${apiBase()}/gcs/list`);
    if (!res.ok) {
      const body = (await res.text()).trim();
      throw new Error(body || `HTTP ${res.status}`);
    }

    const payload = await res.json();
    gcsFiles = Array.isArray(payload) ? payload : (payload.files || []);
    if (!Array.isArray(payload) && payload.prefix) {
      gcsPrefixEl.textContent = payload.prefix;
      gcsPrefixEl.title = payload.prefix;
    }

    renderGCSList(gcsFiles);
    setGCSStatus(gcsFiles.length ? `${gcsFiles.length} 个文件` : '没有文件');
  } catch (err) {
    console.error(err);
    gcsFiles = [];
    renderGCSList(gcsFiles);
    setGCSStatus(`读取失败: ${err.message}`, true);
  }
}

function renderGCSList(files) {
  gcsListEl.innerHTML = '';
  const tree = buildGCSFileTree(files);
  renderGCSNode(tree, gcsListEl, 0);
}

function buildGCSFileTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = String(file.name || '').split('/').filter(Boolean);
    if (!parts.length) continue;

    let node = root;
    let path = '';
    for (const part of parts.slice(0, -1)) {
      path += part + '/';
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { name: part, path, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  return root;
}

function renderGCSNode(node, container, depth) {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const dir of dirs) {
    const details = document.createElement('details');
    details.className = 'library-folder';
    details.open = depth === 0 || openGCSFolders.has(dir.path) || hasActiveDescendant(dir);

    const summary = document.createElement('summary');
    summary.title = dir.path;
    summary.innerHTML = `
  <span class="library-folder-name">${escapeHTML(dir.name)}</span>
  <span class="library-count">${countFiles(dir)}</span>
`;

    const children = document.createElement('div');
    children.className = 'library-folder-children';
    renderGCSNode(dir, children, depth + 1);

    details.addEventListener('toggle', () => {
      if (details.open) openGCSFolders.add(dir.path);
      else openGCSFolders.delete(dir.path);
      localStorage.setItem('lexica.gcs.openFolders', JSON.stringify([...openGCSFolders]));
    });

    details.append(summary, children);
    container.appendChild(details);
  }

  const nodeFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const file of nodeFiles) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'library-item' + (file.name === activeGCSName ? ' active' : '');
    item.title = file.name;
    item.innerHTML = `
  <span class="library-name">${escapeHTML(baseName(file.name))}</span>
  <span class="library-meta">${formatSize(file.size)}</span>
`;
    item.addEventListener('click', () => openGCSFile(file.name));
    container.appendChild(item);
  }
}

function countFiles(node) {
  let count = node.files.length;
  for (const child of node.dirs.values()) count += countFiles(child);
  return count;
}

function hasActiveDescendant(node) {
  if (!activeGCSName) return false;
  if (node.files.some(file => file.name === activeGCSName)) return true;
  for (const child of node.dirs.values()) {
    if (hasActiveDescendant(child)) return true;
  }
  return false;
}

function baseName(path) {
  const parts = String(path).split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function dirName(path) {
  const idx = String(path).lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx + 1) : '';
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let unit = units.shift();
  while (size >= 1024 && units.length) {
    size /= 1024;
    unit = units.shift();
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}

async function openGCSFile(name) {
  activeGCSName = name;
  renderGCSList(gcsFiles);

  // Show the reader panel with a loading state while the blob downloads.
  exitTableNav();
  readerPanel.classList.add('visible');
  readerTablebar.classList.add('hidden');
  $('reader-title').textContent = name;
  contentEl.removeAttribute('data-mode');
  contentEl.style.display = 'block';
  contentEl.innerHTML = `<p class="reader-loading">读取中  ${escapeHTML(name)}</p>`;

  try {
    const res = await fetch(`${apiBase()}/gcs/download?name=${encodeURIComponent(name)}`);
    if (!res.ok) {
      const body = (await res.text()).trim();
      throw new Error(body || `HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const file = new File([blob], baseName(name), { type: blob.type || 'application/octet-stream' });
    await openReaderFile(file, name);
    recordRecentFile(name);
  } catch (err) {
    console.error(err);
    contentEl.removeAttribute('data-mode');
    contentEl.innerHTML = `<p class="reader-loading error">读取失败: ${escapeHTML(err.message)}</p>`;
  }
}



// ---- CSV ----
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function csvToTable(text) {
  const rows = parseCSV(text);
  if (!rows.length) return '<p><em>(空文件)</em></p>';
  let html = '<table class="csv-table"><tbody>';
  for (const r of rows) {
    html += '<tr>' + r.map(c => `<td>${escapeHTML(c)}</td>`).join('') + '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// ---- PDF ----
async function loadPDF(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    // Reconstruct line breaks based on Y position
    let lastY = null, text = '';
    for (const it of tc.items) {
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 4) text += '\n';
      text += it.str + (it.hasEOL ? '\n' : ' ');
      lastY = y;
    }
    out += `<div class="page-break">page ${i} / ${pdf.numPages}</div>\n${escapeHTML(text)}\n\n`;
  }
  return out;
}

// ---- DOCX ----
async function loadDocx(file) {
  const buf = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  return result.value;
}

// ---- EPUB ----
async function loadEpub(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('Invalid EPUB (no container.xml)');
  const containerXml = await containerFile.async('string');
  const opfMatch = containerXml.match(/full-path="([^"]+)"/);
  if (!opfMatch) throw new Error('Invalid EPUB (no rootfile)');
  const opfPath = opfMatch[1];
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  const opf = await zip.file(opfPath).async('string');
  const parser = new DOMParser();
  const opfDoc = parser.parseFromString(opf, 'application/xml');

  const items = {};
  opfDoc.querySelectorAll('manifest item').forEach(it => {
    items[it.getAttribute('id')] = it.getAttribute('href');
  });
  const spine = [...opfDoc.querySelectorAll('spine itemref')]
    .map(ir => items[ir.getAttribute('idref')])
    .filter(Boolean);

  let out = '';
  for (const href of spine) {
    const fullPath = (opfDir + href).replace(/\/\.\//g, '/');
    const f = zip.file(fullPath);
    if (!f) continue;
    const html = await f.async('string');
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, link').forEach(n => n.remove());
    // Strip inline styles to let our CSS dictate
    doc.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
    out += (doc.body ? doc.body.innerHTML : '') +
      '<div class="page-break">·</div>';
  }
  return out;
}

// ========================================================
//  Selection → play + translate popup
// ========================================================
const popup = $('popup');
const popupHeader = $('popup-header');
const popupFrame = $('popup-frame');
const popupWord = $('popup-word');
const popupLoad = $('popup-loading');
const closeBtn = $('close-btn');
const saveBtn = $('save-btn');
const replayBtn = $('replay-btn');

let selectionTimer = null;
let currentWord = '';
let currentSl = 'en';

function detectLang(text) {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en';
}

function isInPopup(el) {
  while (el) {
    if (el === popup) return true;
    el = el.parentNode;
  }
  return false;
}

function isReaderChrome(el) {
  return el && el.closest && el.closest('header, .library, #popup');
}

let popupDrag = null;

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function placePopup(left, top, width, height) {
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  popup.style.left = `${clamp(left, margin, maxLeft)}px`;
  popup.style.top = `${clamp(top, margin, maxTop)}px`;
  popup.style.right = 'auto';
  popup.style.bottom = 'auto';
}

popupHeader.addEventListener('pointerdown', (e) => {
  if ((e.button !== undefined && e.button !== 0) || e.target.closest('button')) return;

  const rect = popup.getBoundingClientRect();
  popupDrag = {
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    width: rect.width,
    height: rect.height,
  };

  popup.classList.add('dragging');
  popup.style.width = `${rect.width}px`;
  popup.style.height = `${rect.height}px`;
  popupHeader.setPointerCapture(e.pointerId);
  e.preventDefault();
});

popupHeader.addEventListener('pointermove', (e) => {
  if (!popupDrag) return;
  placePopup(
    e.clientX - popupDrag.offsetX,
    e.clientY - popupDrag.offsetY,
    popupDrag.width,
    popupDrag.height
  );
  e.preventDefault();
});

function endPopupDrag(e) {
  if (!popupDrag) return;
  popupDrag = null;
  popup.classList.remove('dragging');
  if (popupHeader.hasPointerCapture(e.pointerId)) {
    popupHeader.releasePointerCapture(e.pointerId);
  }
}

popupHeader.addEventListener('pointerup', endPopupDrag);
popupHeader.addEventListener('pointercancel', endPopupDrag);

window.addEventListener('resize', () => {
  if (!popup.classList.contains('visible') || !popup.style.left || !popup.style.top) return;
  const rect = popup.getBoundingClientRect();
  placePopup(rect.left, rect.top, rect.width, rect.height);
});

function normalizeSelectedWord(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';

  let word = trimmed.replace(
    /^[\s"'“”‘’([{<]+|[\s"'“”‘’)\]}>.,;:!?，。！？、；：]+$/g,
    ''
  );
  if (!word || /\s/.test(word)) return '';

  // Commas, slashes, brackets, and sentence punctuation usually mean the user
  // selected more than one token or a fragment that should not trigger lookup.
  if (/[,，;；:：.!?！？。、《》\/\\|()[\]{}<>]/.test(word)) return '';

  // Ignore selection if it contains Chinese characters
  if (/[\u4e00-\u9fa5]/.test(word)) return '';

  return word;
}

document.addEventListener('mouseup', (e) => {
  if (isInPopup(e.target) || isReaderChrome(e.target)) return;

  clearTimeout(selectionTimer);
  const delay = parseInt(delayInput.value, 10) || 0;

  selectionTimer = setTimeout(() => {
    if (!autoplayChk.checked) return;

    const sel = window.getSelection();
    const text = (sel ? sel.toString() : '').trim();
    const word = normalizeSelectedWord(text);
    if (!word) return;
    if (word === currentWord) return;
    handleSelection(word);
  }, delay);
});

function handleSelection(text) {
  currentWord = text;
  currentSl = detectLang(text);
  const tl = currentSl === 'en' ? 'zh-CN' : 'en';
  const params = new URLSearchParams({
    text,
    sl: currentSl,
    tl,
  });

  // Translation iframe — never needs CORS. The translate endpoint also triggers TTS.
  popupWord.textContent = text;
  popupLoad.classList.add('show');
  popupFrame.onload = () => popupLoad.classList.remove('show');
  popupFrame.src = `${apiBase()}/?${params.toString()}`;

  popup.classList.add('visible');
}

closeBtn.addEventListener('click', () => {
  popup.classList.remove('visible');
  popupFrame.src = 'about:blank';
  currentWord = '';
  window.getSelection().removeAllRanges();
});

function playCurrentWord() {
  if (!currentWord) return;
  fetch(`${apiBase()}/play?text=${encodeURIComponent(currentWord)}`, { mode: 'no-cors' })
    .catch(err => console.warn('play failed', err));
}

replayBtn.addEventListener('click', playCurrentWord);

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Esc to close · R to replay (only while the selection popup is showing,
// mirroring the R-to-replay shortcut in the dictation modes).
document.addEventListener('keydown', (e) => {
  if (!popup.classList.contains('visible')) return;
  if (e.key === 'Escape') {
    closeBtn.click();
  } else if ((e.key === 'r' || e.key === 'R') && !isEditableTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    playCurrentWord();
  }
});

// ========================================================
//  Save to wrong-book
// ========================================================
saveBtn.addEventListener('click', async () => {
  if (!currentWord) return;

  // Try to read translation text from iframe (works if same-origin)
  let translated = '';
  try {
    const doc = popupFrame.contentDocument;
    if (doc && doc.body) {
      translated = (doc.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    }
  } catch (_) { /* cross-origin */ }

  const url = `${apiBase()}/save?text=${encodeURIComponent(currentWord)}` +
    `&translated=${encodeURIComponent(translated)}` +
    `&sl=${currentSl}`;

  // Try with CORS first (so we can read "ok" / "exists"); fall back to no-cors
  try {
    const res = await fetch(url);
    const txt = (await res.text()).trim();
    flash(txt === 'exists' ? '已在错题本' : '已收藏 ✓');
  } catch (err) {
    // CORS error path — fire blind and assume success
    try {
      await fetch(url, { mode: 'no-cors' });
      flash('已发送 (无 CORS 头, 无法确认结果)');
    } catch (e2) {
      flash('保存失败: ' + e2.message, true);
    }
  }
});

function flash(msg, isError) {
  const el = document.createElement('div');
  el.className = 'flash' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

// ========================================================
//  Dictation Module
// ========================================================
const dictPanel = $('dictation-panel');
const dictHeader = $('dict-header');
const dictBody = $('dict-body');
const dictCloseBtn = $('dict-close-btn');

// Sidebar tabs
const tabFiles = $('tab-files');
const tabDictStrict = $('tab-dict-strict');
const tabDictAdvanced = $('tab-dict-advanced');
const tabDictUltimate = $('tab-dict-ultimate');
const tabLearn = $('tab-learn');
const tabRecog = $('tab-recog');
const tabStudy = $('tab-study');
const tabCleaner = $('tab-cleaner');
const tabProgress = $('tab-progress');
const sidebarFiles = $('sidebar-files');
const sidebarDictInfo = $('sidebar-dict-info');
const sidebarLearnInfo = $('sidebar-learn-info');
const sidebarRecogInfo = $('sidebar-recog-info');
const sidebarStudyInfo = $('sidebar-study-info');
const sidebarCleaner = $('sidebar-cleaner');
const sidebarProgress = $('sidebar-progress');
const sidebarDictLabel = $('sidebar-dict-mode-label');
const sidebarDictDesc = $('sidebar-dict-mode-desc');

// Three dictation variants share one panel + one dictState, differing mainly in
// the question screen:
//   basic    — 看中文，拼英文（程序判分）
//   advanced — 听音频，拼英文（程序判分，不显示中文）
//   ultimate — 听音频，写中文意思（自己判定对错：空格=错，回车=对）
const DICT_VARIANTS = {
  basic:    { title: '听写·基础', label: '听写·基础', desc: '看中文，拼出英文单词。',                mode: 'dictation_strict',   histModes: ['dictation_strict', 'dictation_skip'], goodLabel: '正确', badLabel: '错误', goodTitle: '🌟 一次拼对', badTitle: '⚠️ 需要重点复习' },
  advanced: { title: '听写·进阶', label: '听写·进阶', desc: '听音频，拼出英文单词（不显示中文）。',   mode: 'dictation_advanced', histModes: ['dictation_advanced'],                  goodLabel: '正确', badLabel: '错误', goodTitle: '🌟 一次拼对', badTitle: '⚠️ 需要重点复习' },
  ultimate: { title: '听写·终极', label: '听写·终极', desc: '听音频，写出中文意思，自己判定对错。',   mode: 'dictation_ultimate', histModes: ['dictation_ultimate'],                  goodLabel: '记对了', badLabel: '记错了', goodTitle: '✓ 记对了', badTitle: '✗ 记错了' },
};
let dictVariant = 'basic';
function dictVariantMeta() { return DICT_VARIANTS[dictVariant] || DICT_VARIANTS.basic; }

let dictState = {
  words: [],
  shuffled: [],
  currentIdx: 0,
  correctWords: [],
  incorrectWords: [],
  errorCount: 0,
  isFirstTry: true,
  dayName: '',
  attempts: [],
  allWords: [],
  baseDayName: '',
  variant: 'basic',
};

function setActiveTab(tab) {
  [tabFiles, tabDictStrict, tabDictAdvanced, tabDictUltimate, tabLearn, tabRecog, tabStudy, tabCleaner, tabProgress].forEach(t => t.classList.remove('active'));
  if (tab) tab.classList.add('active');
}

function showSidebarContent(which) {
  sidebarFiles.classList.toggle('hidden', which !== 'files');
  sidebarDictInfo.classList.toggle('hidden', which !== 'dict');
  sidebarLearnInfo.classList.toggle('hidden', which !== 'learn');
  sidebarRecogInfo.classList.toggle('hidden', which !== 'recog');
  sidebarStudyInfo.classList.toggle('hidden', which !== 'study');
  sidebarCleaner.classList.toggle('hidden', which !== 'cleaner');
  sidebarProgress.classList.toggle('hidden', which !== 'progress');
}

const dictTabFor = { basic: tabDictStrict, advanced: tabDictAdvanced, ultimate: tabDictUltimate };

function openDictation(variant = 'basic') {
  if (!DICT_VARIANTS[variant]) variant = 'basic';
  const changed = dictVariant !== variant;
  dictVariant = variant;
  const meta = dictVariantMeta();

  setActiveTab(dictTabFor[variant]);
  showSidebarContent('dict');
  sidebarDictLabel.textContent = meta.label;
  sidebarDictDesc.textContent = meta.desc;

  dictPanel.classList.add('visible');
  learnPanel.classList.remove('visible');
  recogPanel.classList.remove('visible');
  studyPanel.classList.remove('visible');
  exitTableNav();
  readerPanel.classList.remove('visible');

  // Switching to a different variant starts a fresh session.
  if (changed) dictResetState();
  if (changed || !dictState.words.length) {
    $('dict-title').textContent = meta.title;
    dictShowSetup();
  }
}

let gcsLoaded = false;

tabFiles.addEventListener('click', () => {
  setActiveTab(tabFiles);
  showSidebarContent('files');
  dictPanel.classList.remove('visible');
  if (!gcsLoaded) {
    gcsLoaded = true;
    refreshGCSFiles();
  }
});

tabDictStrict.addEventListener('click', () => openDictation('basic'));
tabDictAdvanced.addEventListener('click', () => openDictation('advanced'));
tabDictUltimate.addEventListener('click', () => openDictation('ultimate'));
tabLearn.addEventListener('click', () => openLearn());
tabRecog.addEventListener('click', () => openRecognition());
tabStudy.addEventListener('click', () => openStudy());

tabCleaner.addEventListener('click', () => {
  setActiveTab(tabCleaner);
  showSidebarContent('cleaner');
  dictPanel.classList.remove('visible');
});


// Parse cleaner input: supports both comma-separated words ("apple, banana")
// and CSV format copied from dictation/recognition result pages:
//   English,Chinese
//   "word","翻译"
//   ...
function parseCleanerInput(raw) {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return '';

  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Detect CSV format: first line is header "English,Chinese" (case-insensitive),
  // or every line looks like "word","translation"
  const headerRe = /^english\s*,\s*chinese$/i;
  const quotedRowRe = /^"([^"]*)"(?:\s*,\s*"[^"]*")*$/;

  let isCSV = false;
  let startIdx = 0;

  if (lines.length >= 2 && headerRe.test(lines[0])) {
    isCSV = true;
    startIdx = 1; // skip header
  } else if (lines.length >= 1 && lines.every(l => quotedRowRe.test(l))) {
    isCSV = true;
    startIdx = 0;
  }

  if (isCSV) {
    const words = [];
    for (let i = startIdx; i < lines.length; i++) {
      const match = lines[i].match(quotedRowRe);
      if (match && match[1].trim()) {
        words.push(match[1].trim());
      } else {
        // Fallback: try unquoted first field
        const first = lines[i].split(',')[0].replace(/"/g, '').trim();
        if (first && first.toLowerCase() !== 'english') {
          words.push(first);
        }
      }
    }
    return words.join(',');
  }

  // Not CSV — treat as comma-separated words (original behavior)
  return trimmed;
}

// One click cleans locally, then immediately syncs the change to the cloud.
$('cleaner-btn').addEventListener('click', async () => {
  const raw = $('cleaner-input').value.trim();
  if (!raw) return;
  const input = parseCleanerInput(raw);
  if (!input) return;

  const btn = $('cleaner-btn');
  btn.disabled = true;
  btn.textContent = '清理中...';
  $('cleaner-status').textContent = '';

  try {
    const res = await fetch('/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: input })
    });
    if (!res.ok) throw new Error('本地清理失败');
    const data = await res.json();
    $('cleaner-input').value = '';
    $('cleaner-status').textContent = `本地清理 ${data.cleaned} 个单词，同步云端中...`;

    const syncRes = await fetch('/clean/sync', { method: 'POST' });
    if (!syncRes.ok) throw new Error('云端同步失败');
    const syncData = await syncRes.json();
    $('cleaner-status').textContent = `✅ 本地清理 ${data.cleaned} 个单词，云端同步了 ${syncData.synced} 个文件。`;
  } catch (err) {
    $('cleaner-status').textContent = `❌ ${err.message}，请重试。`;
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = '确认清理（本地 + 云端）';
  }
});

// ---- Progress (Sankey) sidebar: list of tracked wordlists ----
// Each entry opens its own standalone page /progress/<uuid> in a new tab.
function progressOpen(id) {
  window.open(`/progress/${encodeURIComponent(id)}`, '_blank', 'noopener');
}

function progressFmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return iso || '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return iso || ''; }
}

async function refreshProgressList() {
  const host = $('progress-list');
  host.innerHTML = '<div class="library-status">加载中…</div>';
  try {
    const res = await fetch('/progress/list');
    if (!res.ok) throw new Error('加载失败');
    const items = await res.json();
    if (!items.length) {
      host.innerHTML = '<div class="library-status">还没有进度，点上面「新建」开始。</div>';
      return;
    }
    host.innerHTML = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'progress-item';
      const shortId = it.id.slice(0, 8);
      const stat = it.roundCount
        ? `${it.roundCount} 轮 · ${it.totalWords}→${it.remaining}`
        : '空 · 还没粘过';
      row.innerHTML = `
        <button class="progress-open" title="在新标签页打开">
          <span class="progress-uuid">${shortId}…</span>
          <span class="progress-sub">${stat} · ${progressFmtDate(it.createdAt)}</span>
        </button>
        <button class="progress-del" title="删除这个进度">✕</button>`;
      row.querySelector('.progress-open').addEventListener('click', () => progressOpen(it.id));
      row.querySelector('.progress-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`删除进度 ${shortId}…？此操作不可撤销。`)) return;
        await fetch(`/progress/delete?id=${encodeURIComponent(it.id)}`, { method: 'POST' });
        refreshProgressList();
      });
      host.appendChild(row);
    }
  } catch (err) {
    host.innerHTML = `<div class="library-status error">${err.message}</div>`;
  }
}

tabProgress.addEventListener('click', () => {
  setActiveTab(tabProgress);
  showSidebarContent('progress');
  dictPanel.classList.remove('visible');
  learnPanel.classList.remove('visible');
  recogPanel.classList.remove('visible');
  refreshProgressList();
});

$('progress-new').addEventListener('click', async () => {
  const btn = $('progress-new');
  btn.disabled = true;
  try {
    const res = await fetch('/progress/create', { method: 'POST' });
    if (!res.ok) throw new Error('创建失败');
    const data = await res.json();
    progressOpen(data.id);
    refreshProgressList();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('progress-refresh').addEventListener('click', refreshProgressList);

dictCloseBtn.addEventListener('click', () => {
  dictPanel.classList.remove('visible');
  setActiveTab(null);
  showSidebarContent(null);
});

// ========================================================
//  Learn Module (same as Recognition, but in original order)
// ========================================================
const learnPanel = $('learn-panel');
const learnHeader = $('learn-header');
const learnBody = $('learn-body');
const learnCloseBtn = $('learn-close-btn');

let learnState = {
  words: [],
  ordered: [],
  currentIdx: 0,
  knownWords: [],
  unknownWords: [],
  dayName: '',
  allWords: [],
  baseDayName: '',
};

learnCloseBtn.addEventListener('click', () => {
  learnPanel.classList.remove('visible');
  setActiveTab(null);
  showSidebarContent(null);
});

// Drag support for learn panel
let learnDrag = null;

function learnPlacePanel(left, top, width, height) {
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  learnPanel.style.left = `${clamp(left, margin, maxLeft)}px`;
  learnPanel.style.top = `${clamp(top, margin, maxTop)}px`;
  learnPanel.style.right = 'auto';
  learnPanel.style.bottom = 'auto';
  learnPanel.style.transform = 'none';
}

learnHeader.addEventListener('pointerdown', (e) => {
  if ((e.button !== undefined && e.button !== 0) || e.target.closest('button')) return;
  const rect = learnPanel.getBoundingClientRect();
  learnDrag = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, width: rect.width, height: rect.height };
  learnPanel.classList.add('dragging');
  learnPanel.style.width = `${rect.width}px`;
  learnPanel.style.height = `${rect.height}px`;
  learnHeader.setPointerCapture(e.pointerId);
  e.preventDefault();
});

learnHeader.addEventListener('pointermove', (e) => {
  if (!learnDrag) return;
  learnPlacePanel(e.clientX - learnDrag.offsetX, e.clientY - learnDrag.offsetY, learnDrag.width, learnDrag.height);
  e.preventDefault();
});

function endLearnDrag(e) {
  if (!learnDrag) return;
  learnDrag = null;
  learnPanel.classList.remove('dragging');
  if (learnHeader.hasPointerCapture(e.pointerId)) learnHeader.releasePointerCapture(e.pointerId);
}

learnHeader.addEventListener('pointerup', endLearnDrag);
learnHeader.addEventListener('pointercancel', endLearnDrag);

function openLearn() {
  setActiveTab(tabLearn);
  showSidebarContent('learn');
  learnPanel.classList.add('visible');
  dictPanel.classList.remove('visible');
  recogPanel.classList.remove('visible');
  studyPanel.classList.remove('visible');
  exitTableNav();
  readerPanel.classList.remove('visible');
  $('learn-title').textContent = '学习新词';
  if (!learnState.words.length) {
    learnShowSetup();
  }
}

// ---- Learn Setup Screen ----
function learnShowSetup() {
  learnBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-source-tabs">
    <button class="dict-source-tab active" id="learn-tab-daily">21天</button>
    <button class="dict-source-tab" id="learn-tab-alpha">字母表</button>
  </div>
  <div id="learn-day-panel">
    <div class="dict-setup-label">学哪一天？</div>
    <div class="dict-day-grid" id="learn-day-grid"></div>
  </div>
  <div id="learn-alpha-panel" style="display:none">
    <div class="dict-setup-label">选择字母</div>
    <div class="dict-day-grid" id="learn-alpha-grid"></div>
  </div>
  <div class="setup-aux-row">
    <button class="dict-back-btn" id="learn-custom-btn">📂 自定义路径</button>
    <button class="dict-back-btn" id="learn-paste-csv-btn">📋 粘贴 CSV</button>
  </div>
  <div class="dict-loading" id="learn-load-msg"></div>
</div>
  `;

  // Tab switching
  const tabDaily = $('learn-tab-daily');
  const tabAlpha = $('learn-tab-alpha');
  const dayPanel = $('learn-day-panel');
  const alphaPanel = $('learn-alpha-panel');
  tabDaily.addEventListener('click', () => {
    tabDaily.classList.add('active'); tabAlpha.classList.remove('active');
    dayPanel.style.display = ''; alphaPanel.style.display = 'none';
  });
  tabAlpha.addEventListener('click', () => {
    tabAlpha.classList.add('active'); tabDaily.classList.remove('active');
    alphaPanel.style.display = ''; dayPanel.style.display = 'none';
    renderAlphabetGrid($('learn-alpha-grid'), $('learn-load-msg'), (words, label) => learnShowPortionPicker(words, label));
  });

  const grid = $('learn-day-grid');
  const loadMsg = $('learn-load-msg');

  for (let i = 1; i <= 21; i++) {
    const num = i;
    const dayName = `day${String(num).padStart(2, '0')}`;
    const btn = document.createElement('button');
    btn.className = 'dict-day-btn';
    btn.textContent = String(num);
    btn.addEventListener('click', async () => {
      Array.from(grid.children).forEach(b => b.disabled = true);
      loadMsg.textContent = `正在加载 ${dayName}.txt ...`;
      try {
        let res = await fetch(`${apiBase()}/dictation/words?day=${encodeURIComponent(dayName)}`);
        let label = dayName;
        if (!res.ok) {
          res = await fetch(`${apiBase()}/dictation/words?day=${encodeURIComponent('day' + num)}`);
          if (!res.ok) throw new Error(`找不到 day${num} 的单词文件`);
          label = 'day' + num;
        }
        const words = await res.json();
        learnShowPortionPicker(words, label);
      } catch (err) {
        loadMsg.textContent = `❌ ${err.message}`;
        Array.from(grid.children).forEach(b => b.disabled = false);
      }
    });
    grid.appendChild(btn);
  }

  $('learn-custom-btn').addEventListener('click', () => {
    showCustomPathScreen(learnBody, learnShowSetup, (words, label) => learnShowPortionPicker(words, label));
  });
  $('learn-paste-csv-btn').addEventListener('click', () => {
    showPasteCSVScreen(learnBody, learnShowSetup, (words, label) => learnShowPortionPicker(words, label));
  });
}

// ---- Learn Portion Picker ----
function learnShowPortionPicker(allWords, dayName) {
  const total = (allWords || []).length;
  if (total === 0) {
    flash('该文件中没有找到单词', true);
    learnShowSetup();
    return;
  }
  const q1 = Math.floor(total / 4);
  const q2 = Math.floor(total / 2);
  const q3 = Math.floor(3 * total / 4);

  const portions = [
    { label: '第 1/4', range: [0, q1] },
    { label: '第 2/4', range: [q1, q2] },
    { label: '第 3/4', range: [q2, q3] },
    { label: '第 4/4', range: [q3, total] },
    { label: '前 1/2', range: [0, q2] },
    { label: '后 1/2', range: [q2, total] },
    { label: '全部',  range: [0, total], full: true },
  ];

  let html = '';
  for (const p of portions) {
    const count = p.range[1] - p.range[0];
    html += `<button class="dict-portion-btn${p.full ? ' full' : ''}">
      <span>${p.label}</span>
      <span class="dict-portion-count">${count} 词</span>
    </button>`;
  }

  learnBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">${escapeHTML(dayName)} · 选择学习范围</div>
  <div class="dict-portion-grid" id="learn-portion-grid">${html}</div>
  <button class="dict-back-btn" id="learn-back-btn">← 返回选择天数</button>
</div>
  `;

  const grid = $('learn-portion-grid');
  for (let i = 0; i < portions.length; i++) {
    const p = portions[i];
    grid.children[i].addEventListener('click', () => {
      const slice = allWords.slice(p.range[0], p.range[1]);
      learnStartSession(slice, `${dayName} · ${p.label}`, allWords, dayName);
    });
  }
  $('learn-back-btn').addEventListener('click', learnShowSetup);
}

// ---- Learn Start Session (NO SHUFFLE — original order) ----
function learnStartSession(words, dayName, allWords, baseDayName) {
  if (!words || !words.length) {
    flash('该文件中没有找到单词', true);
    learnShowSetup();
    return;
  }

  // Keep original order — no shuffle!
  const ordered = [...words];

  learnState = {
    words,
    ordered,
    currentIdx: 0,
    knownWords: [],
    unknownWords: [],
    dayName,
    allWords: allWords || words,
    baseDayName: baseDayName || dayName,
  };

  $('learn-title').textContent = `学习 · ${dayName}`;
  flash(`已加载 ${words.length} 个新词，按顺序学习！`);
  preloadTTSBatch(ordered);
  learnShowQuestion();
}

// ---- Learn Question Screen ----
function learnShowQuestion() {
  const s = learnState;
  if (s.currentIdx >= s.ordered.length) {
    learnShowSummary();
    return;
  }

  const word = s.ordered[s.currentIdx];
  const total = s.ordered.length;
  const current = s.currentIdx + 1;
  const pct = ((current - 1) / total * 100).toFixed(1);

  learnBody.innerHTML = `
<div class="recog-question">
  <div class="recog-progress">${current} / ${total}</div>
  <div class="recog-progress-bar">
    <div class="recog-progress-fill" style="width: ${pct}%"></div>
  </div>
  <div class="recog-english">${escapeHTML(word.english)}</div>
  <button class="dict-play-btn recog-replay-btn" id="learn-replay-btn">🔊 重听</button>
  <div class="recog-reveal-row" id="learn-reveal-row" style="visibility:hidden">
    <span class="recog-chinese-reveal" id="learn-chinese">${escapeHTML(word.chinese)}</span>
    <button class="recog-edit-btn" id="learn-edit-btn" title="修改翻译">✎</button>
  </div>
  <div class="recog-btn-row" id="learn-btn-row">
    <button class="recog-no-btn" id="learn-no-btn">✗</button>
    <button class="recog-yes-btn" id="learn-yes-btn">✓</button>
  </div>
  <div class="recog-hint" id="learn-hint">回车=认识 · 空格=不认识 · R=重听 · Esc=提前退出</div>
  <button class="recog-exit-btn" id="learn-exit-btn">⏏ 提前退出</button>
</div>
  `;

  dictPlayTTS(word.english);

  let revealed = false;
  let graded = false;
  let firstKnown = null;

  const revealRow = $('learn-reveal-row');
  const btnRow = $('learn-btn-row');
  const hintEl = $('learn-hint');
  const replayBtn = $('learn-replay-btn');
  const editBtn = $('learn-edit-btn');
  const chineseEl = $('learn-chinese');

  function reveal(claimedKnown) {
    if (revealed) return;
    revealed = true;
    firstKnown = claimedKnown;
    revealRow.style.visibility = '';
    btnRow.innerHTML = `
      <button class="recog-no-btn" id="learn-wrong-btn">✗</button>
      <button class="recog-yes-btn" id="learn-right-btn">✓</button>
    `;
    $('learn-right-btn').addEventListener('click', () => grade(true));
    $('learn-wrong-btn').addEventListener('click', () => grade(false));
    hintEl.textContent = '回车=认对 · 空格=认错 · R=重听 · Esc=提前退出';
  }

  function grade(gotRight) {
    if (!revealed || graded) return;
    graded = true;
    window.removeEventListener('keydown', onKey);
    if (firstKnown && gotRight) s.knownWords.push(word);
    else s.unknownWords.push(word);
    s.currentIdx++;
    learnShowQuestion();
  }

  function earlyExit() {
    window.removeEventListener('keydown', onKey);
    if (revealed && !graded) {
      s.unknownWords.push(word);
    }
    learnShowSummary();
  }

  async function editTranslation() {
    const current = chineseEl.textContent;
    const next = prompt(`修改 "${word.english}" 的翻译：`, current);
    if (next == null) return;
    const trimmed = next.trim();
    if (trimmed === '' || trimmed === current) return;
    try {
      const res = await fetch(`${apiBase()}/dictation/update-word`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: learnState.dayName.split(' ')[0], english: word.english, chinese: trimmed }),
      });
      if (!res.ok) throw new Error(await res.text());
      word.chinese = trimmed;
      chineseEl.textContent = trimmed;
      flash('翻译已更新');
    } catch (err) {
      flash(`修改失败：${err.message || err}`, true);
    }
  }

  $('learn-yes-btn').addEventListener('click', () => reveal(true));
  $('learn-no-btn').addEventListener('click',  () => reveal(false));
  $('learn-exit-btn').addEventListener('click', earlyExit);
  replayBtn.addEventListener('click', () => dictPlayTTS(word.english));
  editBtn.addEventListener('click', editTranslation);

  function onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!revealed) reveal(true); else grade(true);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (!revealed) reveal(false); else grade(false);
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      dictPlayTTS(word.english);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      earlyExit();
    }
  }
  window.addEventListener('keydown', onKey);
}

// ---- Learn Summary Screen ----
function learnShowSummary() {
  const s = learnState;
  const total = s.knownWords.length + s.unknownWords.length;

  let knownHTML = '';
  if (s.knownWords.length > 0) {
    knownHTML = `<h4 style="color:#86efac;margin:8px 0 4px;">✓ 认识 (${s.knownWords.length})</h4>`;
    for (const w of s.knownWords) {
      knownHTML += `<div class="dict-word-item"><span class="dict-word-en">${escapeHTML(w.english)}</span><span class="dict-word-zh">${escapeHTML(w.chinese)}</span></div>`;
    }
  }

  let unknownHTML = '';
  if (s.unknownWords.length > 0) {
    unknownHTML = `<h4 style="color:#fca5a5;margin:8px 0 4px;">✗ 不认识 (${s.unknownWords.length})</h4>`;
    for (const w of s.unknownWords) {
      unknownHTML += `<div class="dict-word-item"><span class="dict-word-en">${escapeHTML(w.english)}</span><span class="dict-word-zh">${escapeHTML(w.chinese)}</span></div>`;
    }
  }

  let csvBtns = '<div class="dict-csv-row">';
  if (s.knownWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="learn-cp-known">📋 复制认识的</button>`;
  if (s.unknownWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="learn-cp-unknown">📋 复制不认识的</button>`;
  csvBtns += '</div>';

  learnBody.innerHTML = `
<div class="recog-summary">
  <h3 class="recog-summary-title">学习总结 · ${escapeHTML(s.dayName)}</h3>
  <div class="dict-stats">
    <div><span class="dict-stat-num">${total}</span> TOTAL</div>
    <div><span class="dict-stat-num good">${s.knownWords.length}</span> 认识</div>
    <div><span class="dict-stat-num bad">${s.unknownWords.length}</span> 不认识</div>
  </div>
  ${summaryRevealToggleHTML()}
  <div class="dict-word-list">
    ${unknownHTML}
    ${knownHTML}
  </div>
  ${csvBtns}
  <div class="recog-summary-actions">
    <button class="dict-start-btn" id="learn-redo">↻ 重新本课</button>
    <button class="dict-start-btn" id="learn-repick">✂ 换段落</button>
    <button class="dict-back-btn"  id="learn-home">⌂ 回主页</button>
  </div>
</div>
  `;

  const cpKnown   = $('learn-cp-known');
  const cpUnknown = $('learn-cp-unknown');
  if (cpKnown)   cpKnown.addEventListener('click', () => dictCopyCSV(s.knownWords, '认识的单词'));
  if (cpUnknown) cpUnknown.addEventListener('click', () => dictCopyCSV(s.unknownWords, '不认识的单词'));

  $('learn-redo').addEventListener('click', () => learnStartSession(s.words, s.dayName, s.allWords, s.baseDayName));
  $('learn-repick').addEventListener('click', () => {
    if (s.allWords && s.allWords.length) learnShowPortionPicker(s.allWords, s.baseDayName || s.dayName);
    else learnShowSetup();
  });
  $('learn-home').addEventListener('click', learnReset);
  $('learn-title').textContent = '学习新词';
  setupSummaryReveal(learnBody);
}

function learnReset() {
  learnState = { words: [], ordered: [], currentIdx: 0, knownWords: [], unknownWords: [], dayName: '', allWords: [], baseDayName: '' };
  $('learn-title').textContent = '学习新词';
  learnShowSetup();
}

// ========================================================
//  Recognition Module
// ========================================================
const recogPanel = $('recognition-panel');
const recogHeader = $('recog-header');
const recogBody = $('recog-body');
const recogCloseBtn = $('recog-close-btn');

let recogState = {
  words: [],
  shuffled: [],
  currentIdx: 0,
  knownWords: [],
  unknownWords: [],
  dayName: '',
  allWords: [],
  baseDayName: '',
};

recogCloseBtn.addEventListener('click', () => {
  recogPanel.classList.remove('visible');
  setActiveTab(null);
  showSidebarContent(null);
});

// Drag support for recognition panel
let recogDrag = null;

function recogPlacePanel(left, top, width, height) {
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  recogPanel.style.left = `${clamp(left, margin, maxLeft)}px`;
  recogPanel.style.top = `${clamp(top, margin, maxTop)}px`;
  recogPanel.style.right = 'auto';
  recogPanel.style.bottom = 'auto';
  recogPanel.style.transform = 'none';
}

recogHeader.addEventListener('pointerdown', (e) => {
  if ((e.button !== undefined && e.button !== 0) || e.target.closest('button')) return;
  const rect = recogPanel.getBoundingClientRect();
  recogDrag = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, width: rect.width, height: rect.height };
  recogPanel.classList.add('dragging');
  recogPanel.style.width = `${rect.width}px`;
  recogPanel.style.height = `${rect.height}px`;
  recogHeader.setPointerCapture(e.pointerId);
  e.preventDefault();
});

recogHeader.addEventListener('pointermove', (e) => {
  if (!recogDrag) return;
  recogPlacePanel(e.clientX - recogDrag.offsetX, e.clientY - recogDrag.offsetY, recogDrag.width, recogDrag.height);
  e.preventDefault();
});

function endRecogDrag(e) {
  if (!recogDrag) return;
  recogDrag = null;
  recogPanel.classList.remove('dragging');
  if (recogHeader.hasPointerCapture(e.pointerId)) recogHeader.releasePointerCapture(e.pointerId);
}

recogHeader.addEventListener('pointerup', endRecogDrag);
recogHeader.addEventListener('pointercancel', endRecogDrag);

function openRecognition() {
  setActiveTab(tabRecog);
  showSidebarContent('recog');
  recogPanel.classList.add('visible');
  dictPanel.classList.remove('visible');
  learnPanel.classList.remove('visible');
  studyPanel.classList.remove('visible');
  exitTableNav();
  readerPanel.classList.remove('visible');
  $('recog-title').textContent = '认词模式';
  if (!recogState.words.length) {
    recogShowSetup();
  }
}

// ---- CSV-path loading helpers (shared by recognition + dictation) ----
async function loadWordsFromCSVPath(path) {
  const res = await fetch(`${apiBase()}/dictation/load-csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = (await res.text()).trim();
    throw new Error(body || `HTTP ${res.status}`);
  }
  return res.json();
}

function csvLabelFromPath(path) {
  const base = (path.split(/[/\\]/).pop() || path).trim();
  return base.replace(/\.csv$/i, '');
}

// Renders a "paste CSV path" form into the given body element.
// onLoaded(words, label) is called once the CSV is parsed.
function showCustomPathScreen(bodyEl, onBack, onLoaded) {
  bodyEl.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">粘贴 CSV 文件路径</div>
  <input type="text" id="custom-path-input" class="custom-path-input" placeholder="/Users/.../xxx.csv" autocomplete="off" spellcheck="false" />
  <div class="recog-summary-actions">
    <button class="dict-back-btn" id="custom-path-back">← 返回</button>
    <button class="dict-start-btn" id="custom-path-load">加载</button>
  </div>
  <div class="dict-loading" id="custom-path-msg"></div>
</div>
  `;
  const input = bodyEl.querySelector('#custom-path-input');
  const loadMsg = bodyEl.querySelector('#custom-path-msg');
  setTimeout(() => input.focus(), 50);

  bodyEl.querySelector('#custom-path-back').addEventListener('click', onBack);

  async function go() {
    let path = input.value.trim();
    // Mac Finder sometimes wraps copied paths in single quotes — strip them
    if (path.startsWith("'") && path.endsWith("'") && path.length >= 2) {
      path = path.slice(1, -1).trim();
    }
    if (!path) {
      loadMsg.textContent = '❌ 请粘贴 CSV 文件路径';
      return;
    }
    loadMsg.textContent = `正在加载 ${path} ...`;
    try {
      const words = await loadWordsFromCSVPath(path);
      if (!words || !words.length) throw new Error('CSV 文件中没有单词');
      onLoaded(words, csvLabelFromPath(path));
    } catch (err) {
      loadMsg.textContent = `❌ ${err.message}`;
    }
  }
  bodyEl.querySelector('#custom-path-load').addEventListener('click', go);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(); }
  });
}

// Parses pasted CSV text (format: English,Chinese\n"word","翻译") into [{english, chinese}].
function parseCSVText(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const words = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip header row
    if (i === 0 && /^\uFEFF?english/i.test(line)) continue;
    // Try quoted CSV: "en","zh"
    const quotedMatch = line.match(/^"(.+?)"\s*,\s*"(.+?)"$/);
    if (quotedMatch) {
      words.push({ english: quotedMatch[1].replace(/""/g, '"'), chinese: quotedMatch[2].replace(/""/g, '"') });
      continue;
    }
    // Try unquoted CSV: en,zh
    const parts = line.split(',');
    if (parts.length >= 2) {
      const en = parts[0].trim();
      const zh = parts.slice(1).join(',').trim();
      if (en && zh) {
        words.push({ english: en, chinese: zh });
      }
    }
  }
  return words;
}

// Renders a "paste CSV content" form into the given body element.
// onLoaded(words, label) is called once the CSV is parsed.
function showPasteCSVScreen(bodyEl, onBack, onLoaded) {
  bodyEl.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">粘贴 CSV 内容</div>
  <textarea id="paste-csv-textarea" class="paste-csv-textarea" rows="8" placeholder="English,Chinese&#10;&quot;apple&quot;,&quot;苹果&quot;&#10;&quot;banana&quot;,&quot;香蕉&quot;" spellcheck="false"></textarea>
  <div class="recog-summary-actions">
    <button class="dict-back-btn" id="paste-csv-back">← 返回</button>
    <button class="dict-start-btn" id="paste-csv-load">加载</button>
  </div>
  <div class="dict-loading" id="paste-csv-msg"></div>
</div>
  `;
  const textarea = bodyEl.querySelector('#paste-csv-textarea');
  const loadMsg = bodyEl.querySelector('#paste-csv-msg');
  setTimeout(() => textarea.focus(), 50);

  bodyEl.querySelector('#paste-csv-back').addEventListener('click', onBack);

  function go() {
    const text = textarea.value.trim();
    if (!text) {
      loadMsg.textContent = '❌ 请粘贴 CSV 内容';
      return;
    }
    try {
      const words = parseCSVText(text);
      if (!words || !words.length) throw new Error('未能解析出任何单词，请检查格式');
      onLoaded(words, `粘贴(${words.length}词)`);
    } catch (err) {
      loadMsg.textContent = `❌ ${err.message}`;
    }
  }
  bodyEl.querySelector('#paste-csv-load').addEventListener('click', go);
}

// ---- Recognition Setup Screen ----
function recogShowSetup() {
  recogBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-source-tabs">
    <button class="dict-source-tab active" id="recog-tab-daily">21天</button>
    <button class="dict-source-tab" id="recog-tab-alpha">字母表</button>
  </div>
  <div id="recog-day-panel">
    <div class="dict-setup-label">认哪一天？</div>
    <div class="dict-day-grid" id="recog-day-grid"></div>
  </div>
  <div id="recog-alpha-panel" style="display:none">
    <div class="dict-setup-label">选择字母</div>
    <div class="dict-day-grid" id="recog-alpha-grid"></div>
  </div>
  <div class="setup-aux-row">
    <button class="dict-back-btn" id="recog-custom-btn">📂 自定义路径</button>
    <button class="dict-back-btn" id="recog-paste-csv-btn">📋 粘贴 CSV</button>
  </div>
  <div class="dict-loading" id="recog-load-msg"></div>
</div>
  `;

  // Tab switching
  const tabDaily = $('recog-tab-daily');
  const tabAlpha = $('recog-tab-alpha');
  const dayPanel = $('recog-day-panel');
  const alphaPanel = $('recog-alpha-panel');
  tabDaily.addEventListener('click', () => {
    tabDaily.classList.add('active'); tabAlpha.classList.remove('active');
    dayPanel.style.display = ''; alphaPanel.style.display = 'none';
  });
  tabAlpha.addEventListener('click', () => {
    tabAlpha.classList.add('active'); tabDaily.classList.remove('active');
    alphaPanel.style.display = ''; dayPanel.style.display = 'none';
    renderAlphabetGrid($('recog-alpha-grid'), $('recog-load-msg'), (words, label) => recogShowPortionPicker(words, label));
  });

  const grid = $('recog-day-grid');
  const loadMsg = $('recog-load-msg');

  for (let i = 1; i <= 21; i++) {
    const num = i;
    const dayName = `day${String(num).padStart(2, '0')}`;
    const btn = document.createElement('button');
    btn.className = 'dict-day-btn';
    btn.textContent = String(num);
    btn.addEventListener('click', async () => {
      Array.from(grid.children).forEach(b => b.disabled = true);
      loadMsg.textContent = `正在加载 ${dayName}.txt ...`;
      try {
        let res = await fetch(`${apiBase()}/dictation/words?day=${encodeURIComponent(dayName)}`);
        let label = dayName;
        if (!res.ok) {
          res = await fetch(`${apiBase()}/dictation/words?day=${encodeURIComponent('day' + num)}`);
          if (!res.ok) throw new Error(`找不到 day${num} 的单词文件`);
          label = 'day' + num;
        }
        const words = await res.json();
        recogShowPortionPicker(words, label);
      } catch (err) {
        loadMsg.textContent = `❌ ${err.message}`;
        Array.from(grid.children).forEach(b => b.disabled = false);
      }
    });
    grid.appendChild(btn);
  }

  $('recog-custom-btn').addEventListener('click', () => {
    showCustomPathScreen(recogBody, recogShowSetup, (words, label) => recogShowPortionPicker(words, label));
  });
  $('recog-paste-csv-btn').addEventListener('click', () => {
    showPasteCSVScreen(recogBody, recogShowSetup, (words, label) => recogShowPortionPicker(words, label));
  });
}

// ---- Recognition Portion Picker ----
function recogShowPortionPicker(allWords, dayName) {
  const total = (allWords || []).length;
  if (total === 0) {
    flash('该文件中没有找到单词', true);
    recogShowSetup();
    return;
  }
  const q1 = Math.floor(total / 4);
  const q2 = Math.floor(total / 2);
  const q3 = Math.floor(3 * total / 4);

  const portions = [
    { label: '第 1/4', range: [0, q1] },
    { label: '第 2/4', range: [q1, q2] },
    { label: '第 3/4', range: [q2, q3] },
    { label: '第 4/4', range: [q3, total] },
    { label: '前 1/2', range: [0, q2] },
    { label: '后 1/2', range: [q2, total] },
    { label: '全部',  range: [0, total], full: true },
  ];

  let html = '';
  for (const p of portions) {
    const count = p.range[1] - p.range[0];
    html += `<button class="dict-portion-btn${p.full ? ' full' : ''}">` +
      `<span>${p.label}</span>` +
      `<span class="dict-portion-count">${count} 词</span>` +
      `</button>`;
  }

  recogBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">${escapeHTML(dayName)} · 选择认词范围</div>
  <div class="dict-portion-grid" id="recog-portion-grid">${html}</div>
  <button class="dict-back-btn" id="recog-back-btn">← 返回选择天数</button>
</div>
  `;

  const grid = $('recog-portion-grid');
  for (let i = 0; i < portions.length; i++) {
    const p = portions[i];
    grid.children[i].addEventListener('click', () => {
      const slice = allWords.slice(p.range[0], p.range[1]);
      recogStartSession(slice, `${dayName} · ${p.label}`, allWords, dayName);
    });
  }
  $('recog-back-btn').addEventListener('click', recogShowSetup);
}

// ---- Recognition Start Session ----
function recogStartSession(words, dayName, allWords, baseDayName) {
  if (!words || !words.length) {
    flash('该文件中没有找到单词', true);
    recogShowSetup();
    return;
  }

  const shuffled = [...words];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  recogState = {
    words,
    shuffled,
    currentIdx: 0,
    knownWords: [],
    unknownWords: [],
    dayName,
    allWords: allWords || words,
    baseDayName: baseDayName || dayName,
  };

  $('recog-title').textContent = `认词 · ${dayName}`;
  flash(`已加载 ${words.length} 个单词，开始认词！`);
  preloadTTSBatch(shuffled);
  recogShowQuestion();
}

// ---- Recognition Question Screen ----
function recogShowQuestion() {
  const s = recogState;
  if (s.currentIdx >= s.shuffled.length) {
    recogShowSummary();
    return;
  }

  const word = s.shuffled[s.currentIdx];
  const total = s.shuffled.length;
  const current = s.currentIdx + 1;
  const pct = ((current - 1) / total * 100).toFixed(1);

  recogBody.innerHTML = `
<div class="recog-question">
  <div class="recog-progress">${current} / ${total}</div>
  <div class="recog-progress-bar">
    <div class="recog-progress-fill" style="width: ${pct}%"></div>
  </div>
  <div class="recog-english">${escapeHTML(word.english)}</div>
  <button class="dict-play-btn recog-replay-btn" id="recog-replay-btn">🔊 重听</button>
  <div class="recog-reveal-row" id="recog-reveal-row" style="visibility:hidden">
    <span class="recog-chinese-reveal" id="recog-chinese">${escapeHTML(word.chinese)}</span>
    <button class="recog-edit-btn" id="recog-edit-btn" title="修改翻译">✎</button>
  </div>
  <div class="recog-btn-row" id="recog-btn-row">
    <button class="recog-no-btn" id="recog-no-btn">✗</button>
    <button class="recog-yes-btn" id="recog-yes-btn">✓</button>
  </div>
  <div class="recog-hint" id="recog-hint">回车=认识 · 空格=不认识 · R=重听 · Esc=提前退出</div>
  <button class="recog-exit-btn" id="recog-exit-btn">⏏ 提前退出</button>
</div>
  `;

  dictPlayTTS(word.english);

  let revealed = false;
  let graded = false;
  let firstKnown = null;

  const revealRow = $('recog-reveal-row');
  const btnRow = $('recog-btn-row');
  const hintEl = $('recog-hint');
  const replayBtn = $('recog-replay-btn');
  const editBtn = $('recog-edit-btn');
  const chineseEl = $('recog-chinese');

  function reveal(claimedKnown) {
    if (revealed) return;
    revealed = true;
    firstKnown = claimedKnown;
    revealRow.style.visibility = '';
    btnRow.innerHTML = `
      <button class="recog-no-btn" id="recog-wrong-btn">✗</button>
      <button class="recog-yes-btn" id="recog-right-btn">✓</button>
    `;
    $('recog-right-btn').addEventListener('click', () => grade(true));
    $('recog-wrong-btn').addEventListener('click', () => grade(false));
    hintEl.textContent = '回车=认对 · 空格=认错 · R=重听 · Esc=提前退出';
  }

  function grade(gotRight) {
    if (!revealed || graded) return;
    graded = true;
    window.removeEventListener('keydown', onKey);
    // Only counts as known if user claimed "认识" AND self-graded as "认对"
    if (firstKnown && gotRight) s.knownWords.push(word);
    else s.unknownWords.push(word);
    s.currentIdx++;
    recogShowQuestion();
  }

  function earlyExit() {
    window.removeEventListener('keydown', onKey);
    if (revealed && !graded) {
      // revealed but not graded: conservative — count as unknown
      s.unknownWords.push(word);
    }
    recogShowSummary();
  }

  async function editTranslation() {
    const current = chineseEl.textContent;
    const next = prompt(`修改 "${word.english}" 的翻译：`, current);
    if (next == null) return;
    const trimmed = next.trim();
    if (trimmed === '' || trimmed === current) return;
    try {
      const res = await fetch(`${apiBase()}/dictation/update-word`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: recogState.dayName.split(' ')[0], english: word.english, chinese: trimmed }),
      });
      if (!res.ok) throw new Error(await res.text());
      word.chinese = trimmed;
      chineseEl.textContent = trimmed;
      flash('翻译已更新');
    } catch (err) {
      flash(`修改失败：${err.message || err}`, true);
    }
  }

  $('recog-yes-btn').addEventListener('click', () => reveal(true));
  $('recog-no-btn').addEventListener('click',  () => reveal(false));
  $('recog-exit-btn').addEventListener('click', earlyExit);
  replayBtn.addEventListener('click', () => dictPlayTTS(word.english));
  editBtn.addEventListener('click', editTranslation);

  function onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!revealed) reveal(true); else grade(true);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (!revealed) reveal(false); else grade(false);
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      dictPlayTTS(word.english);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      earlyExit();
    }
  }
  window.addEventListener('keydown', onKey);
}

// ---- Recognition Summary Screen ----
function recogShowSummary() {
  const s = recogState;
  const total = s.knownWords.length + s.unknownWords.length;

  let knownHTML = '';
  if (s.knownWords.length > 0) {
    knownHTML = `<h4 style="color:#86efac;margin:8px 0 4px;">✓ 认识 (${s.knownWords.length})</h4>`;
    for (const w of s.knownWords) {
      knownHTML += `<div class="dict-word-item"><span class="dict-word-en">${escapeHTML(w.english)}</span><span class="dict-word-zh">${escapeHTML(w.chinese)}</span></div>`;
    }
  }

  let unknownHTML = '';
  if (s.unknownWords.length > 0) {
    unknownHTML = `<h4 style="color:#fca5a5;margin:8px 0 4px;">✗ 不认识 (${s.unknownWords.length})</h4>`;
    for (const w of s.unknownWords) {
      unknownHTML += `<div class="dict-word-item"><span class="dict-word-en">${escapeHTML(w.english)}</span><span class="dict-word-zh">${escapeHTML(w.chinese)}</span></div>`;
    }
  }

  let csvBtns = '<div class="dict-csv-row">';
  if (s.knownWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="recog-cp-known">📋 复制认识的</button>`;
  if (s.unknownWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="recog-cp-unknown">📋 复制不认识的</button>`;
  csvBtns += '</div>';

  recogBody.innerHTML = `
<div class="recog-summary">
  <h3 class="recog-summary-title">认词总结 · ${escapeHTML(s.dayName)}</h3>
  <div class="dict-stats">
    <div><span class="dict-stat-num">${total}</span> TOTAL</div>
    <div><span class="dict-stat-num good">${s.knownWords.length}</span> 认识</div>
    <div><span class="dict-stat-num bad">${s.unknownWords.length}</span> 不认识</div>
  </div>
  ${summaryRevealToggleHTML()}
  <div class="dict-word-list">
    ${unknownHTML}
    ${knownHTML}
  </div>
  ${csvBtns}
  <div class="recog-summary-actions">
    <button class="dict-start-btn" id="recog-redo">↻ 重新本课</button>
    <button class="dict-start-btn" id="recog-repick">✂ 换段落</button>
    <button class="dict-back-btn"  id="recog-home">⌂ 回主页</button>
  </div>
</div>
  `;

  const cpKnown   = $('recog-cp-known');
  const cpUnknown = $('recog-cp-unknown');
  if (cpKnown)   cpKnown.addEventListener('click', () => dictCopyCSV(s.knownWords, '认识的单词'));
  if (cpUnknown) cpUnknown.addEventListener('click', () => dictCopyCSV(s.unknownWords, '不认识的单词'));

  $('recog-redo').addEventListener('click', () => recogStartSession(s.words, s.dayName, s.allWords, s.baseDayName));
  $('recog-repick').addEventListener('click', () => {
    if (s.allWords && s.allWords.length) recogShowPortionPicker(s.allWords, s.baseDayName || s.dayName);
    else recogShowSetup();
  });
  $('recog-home').addEventListener('click', recogReset);
  $('recog-title').textContent = '认词模式';
  setupSummaryReveal(recogBody);
}

function recogReset() {
  recogState = { words: [], shuffled: [], currentIdx: 0, knownWords: [], unknownWords: [], dayName: '', allWords: [], baseDayName: '' };
  $('recog-title').textContent = '认词模式';
  recogShowSetup();
}

// ========================================================
//  Study Module — browse words with English + Chinese shown
//  together. Space/Enter advances, R reads aloud. No scoring,
//  no know/don't-know tracking. Setup mirrors the learn module.
// ========================================================
const studyPanel = $('study-panel');
const studyHeader = $('study-header');
const studyBody = $('study-body');
const studyCloseBtn = $('study-close-btn');

let studyState = {
  words: [],
  ordered: [],
  currentIdx: 0,
  knownWords: [],
  unknownWords: [],
  dayName: '',
  allWords: [],
  baseDayName: '',
};

// Single shared keydown handler so closing the panel never leaves a dangling
// global listener intercepting space/enter elsewhere.
let studyKeyHandler = null;
function studyBindKeys(handler) {
  if (studyKeyHandler) window.removeEventListener('keydown', studyKeyHandler);
  studyKeyHandler = handler;
  if (handler) window.addEventListener('keydown', handler);
}

studyCloseBtn.addEventListener('click', () => {
  studyBindKeys(null);
  studyPanel.classList.remove('visible');
  setActiveTab(null);
  showSidebarContent(null);
});

// Drag support for study panel
let studyDrag = null;

function studyPlacePanel(left, top, width, height) {
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  studyPanel.style.left = `${clamp(left, margin, maxLeft)}px`;
  studyPanel.style.top = `${clamp(top, margin, maxTop)}px`;
  studyPanel.style.right = 'auto';
  studyPanel.style.bottom = 'auto';
  studyPanel.style.transform = 'none';
}

studyHeader.addEventListener('pointerdown', (e) => {
  if ((e.button !== undefined && e.button !== 0) || e.target.closest('button')) return;
  const rect = studyPanel.getBoundingClientRect();
  studyDrag = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, width: rect.width, height: rect.height };
  studyPanel.classList.add('dragging');
  studyPanel.style.width = `${rect.width}px`;
  studyPanel.style.height = `${rect.height}px`;
  studyHeader.setPointerCapture(e.pointerId);
  e.preventDefault();
});

studyHeader.addEventListener('pointermove', (e) => {
  if (!studyDrag) return;
  studyPlacePanel(e.clientX - studyDrag.offsetX, e.clientY - studyDrag.offsetY, studyDrag.width, studyDrag.height);
  e.preventDefault();
});

function endStudyDrag(e) {
  if (!studyDrag) return;
  studyDrag = null;
  studyPanel.classList.remove('dragging');
  if (studyHeader.hasPointerCapture(e.pointerId)) studyHeader.releasePointerCapture(e.pointerId);
}

studyHeader.addEventListener('pointerup', endStudyDrag);
studyHeader.addEventListener('pointercancel', endStudyDrag);

function openStudy() {
  setActiveTab(tabStudy);
  showSidebarContent('study');
  studyPanel.classList.add('visible');
  dictPanel.classList.remove('visible');
  learnPanel.classList.remove('visible');
  recogPanel.classList.remove('visible');
  exitTableNav();
  readerPanel.classList.remove('visible');
  $('study-title').textContent = '学词';
  if (!studyState.words.length) {
    studyShowSetup();
  }
}

// ---- Study Setup Screen ----
function studyShowSetup() {
  studyBindKeys(null);
  studyBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-source-tabs">
    <button class="dict-source-tab active" id="study-tab-daily">21天</button>
    <button class="dict-source-tab" id="study-tab-alpha">字母表</button>
  </div>
  <div id="study-day-panel">
    <div class="dict-setup-label">学哪一天？</div>
    <div class="dict-day-grid" id="study-day-grid"></div>
  </div>
  <div id="study-alpha-panel" style="display:none">
    <div class="dict-setup-label">选择字母</div>
    <div class="dict-day-grid" id="study-alpha-grid"></div>
  </div>
  <div class="setup-aux-row">
    <button class="dict-back-btn" id="study-custom-btn">📂 自定义路径</button>
    <button class="dict-back-btn" id="study-paste-csv-btn">📋 粘贴 CSV</button>
  </div>
  <div class="dict-loading" id="study-load-msg"></div>
</div>
  `;

  // Tab switching
  const tabDaily = $('study-tab-daily');
  const tabAlpha = $('study-tab-alpha');
  const dayPanel = $('study-day-panel');
  const alphaPanel = $('study-alpha-panel');
  tabDaily.addEventListener('click', () => {
    tabDaily.classList.add('active'); tabAlpha.classList.remove('active');
    dayPanel.style.display = ''; alphaPanel.style.display = 'none';
  });
  tabAlpha.addEventListener('click', () => {
    tabAlpha.classList.add('active'); tabDaily.classList.remove('active');
    alphaPanel.style.display = ''; dayPanel.style.display = 'none';
    renderAlphabetGrid($('study-alpha-grid'), $('study-load-msg'), (words, label) => studyShowPortionPicker(words, label));
  });

  const grid = $('study-day-grid');
  const loadMsg = $('study-load-msg');

  for (let i = 1; i <= 21; i++) {
    const num = i;
    const dayName = `day${String(num).padStart(2, '0')}`;
    const btn = document.createElement('button');
    btn.className = 'dict-day-btn';
    btn.textContent = String(num);
    btn.addEventListener('click', async () => {
      Array.from(grid.children).forEach(b => b.disabled = true);
      loadMsg.textContent = `正在加载 ${dayName}.txt ...`;
      try {
        let res = await fetch(`${apiBase()}/dictation/words?day=${encodeURIComponent(dayName)}`);
        let label = dayName;
        if (!res.ok) {
          res = await fetch(`${apiBase()}/dictation/words?day=${encodeURIComponent('day' + num)}`);
          if (!res.ok) throw new Error(`找不到 day${num} 的单词文件`);
          label = 'day' + num;
        }
        const words = await res.json();
        studyShowPortionPicker(words, label);
      } catch (err) {
        loadMsg.textContent = `❌ ${err.message}`;
        Array.from(grid.children).forEach(b => b.disabled = false);
      }
    });
    grid.appendChild(btn);
  }

  $('study-custom-btn').addEventListener('click', () => {
    showCustomPathScreen(studyBody, studyShowSetup, (words, label) => studyShowPortionPicker(words, label));
  });
  $('study-paste-csv-btn').addEventListener('click', () => {
    showPasteCSVScreen(studyBody, studyShowSetup, (words, label) => studyShowPortionPicker(words, label));
  });
}

// ---- Study Portion Picker ----
function studyShowPortionPicker(allWords, dayName) {
  const total = (allWords || []).length;
  if (total === 0) {
    flash('该文件中没有找到单词', true);
    studyShowSetup();
    return;
  }
  const q1 = Math.floor(total / 4);
  const q2 = Math.floor(total / 2);
  const q3 = Math.floor(3 * total / 4);

  const portions = [
    { label: '第 1/4', range: [0, q1] },
    { label: '第 2/4', range: [q1, q2] },
    { label: '第 3/4', range: [q2, q3] },
    { label: '第 4/4', range: [q3, total] },
    { label: '前 1/2', range: [0, q2] },
    { label: '后 1/2', range: [q2, total] },
    { label: '全部',  range: [0, total], full: true },
  ];

  let html = '';
  for (const p of portions) {
    const count = p.range[1] - p.range[0];
    html += `<button class="dict-portion-btn${p.full ? ' full' : ''}">` +
      `<span>${p.label}</span>` +
      `<span class="dict-portion-count">${count} 词</span>` +
      `</button>`;
  }

  studyBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">${escapeHTML(dayName)} · 选择学词范围</div>
  <div class="dict-portion-grid" id="study-portion-grid">${html}</div>
  <button class="dict-back-btn" id="study-back-btn">← 返回选择天数</button>
</div>
  `;

  const grid = $('study-portion-grid');
  for (let i = 0; i < portions.length; i++) {
    const p = portions[i];
    grid.children[i].addEventListener('click', () => {
      const slice = allWords.slice(p.range[0], p.range[1]);
      studyStartSession(slice, `${dayName} · ${p.label}`, allWords, dayName);
    });
  }
  $('study-back-btn').addEventListener('click', studyShowSetup);
}

// ---- Study Start Session (original order, no shuffle) ----
function studyStartSession(words, dayName, allWords, baseDayName) {
  if (!words || !words.length) {
    flash('该文件中没有找到单词', true);
    studyShowSetup();
    return;
  }

  studyState = {
    words,
    ordered: [...words],
    currentIdx: 0,
    knownWords: [],
    unknownWords: [],
    dayName,
    allWords: allWords || words,
    baseDayName: baseDayName || dayName,
  };

  $('study-title').textContent = `学词 · ${dayName}`;
  flash(`已加载 ${words.length} 个单词，开始学词！`);
  preloadTTSBatch(words);
  studyShowCard();
}

// ---- Study Card Screen (English + Chinese shown together, single-key grade) ----
function studyShowCard() {
  studyBindKeys(null);
  const s = studyState;
  if (s.currentIdx >= s.ordered.length) {
    studyShowSummary();
    return;
  }

  const word = s.ordered[s.currentIdx];
  const total = s.ordered.length;
  const current = s.currentIdx + 1;
  const pct = ((current - 1) / total * 100).toFixed(1);

  studyBody.innerHTML = `
<div class="recog-question">
  <div class="recog-progress">${current} / ${total}</div>
  <div class="recog-progress-bar">
    <div class="recog-progress-fill" style="width: ${pct}%"></div>
  </div>
  <div class="recog-english">${escapeHTML(word.english)}</div>
  <div class="study-chinese">${escapeHTML(word.chinese)}</div>
  <button class="dict-play-btn recog-replay-btn" id="study-replay-btn">🔊 朗读</button>
  <div class="recog-btn-row">
    <button class="recog-no-btn" id="study-no-btn">✗ 不认识</button>
    <button class="recog-yes-btn" id="study-yes-btn">✓ 认识</button>
  </div>
  <div class="recog-hint">回车 = 认识 · 空格 = 不认识 · R = 朗读 · Esc = 退出</div>
  <button class="recog-exit-btn" id="study-exit-btn">⏏ 退出</button>
</div>
  `;

  dictPlayTTS(word.english);

  let graded = false;
  function grade(known) {
    if (graded) return;
    graded = true;
    studyBindKeys(null);
    (known ? s.knownWords : s.unknownWords).push(word);
    s.currentIdx++;
    studyShowCard();
  }
  function earlyExit() {
    studyBindKeys(null);
    studyShowSummary();
  }

  $('study-replay-btn').addEventListener('click', () => dictPlayTTS(word.english));
  $('study-yes-btn').addEventListener('click', () => grade(true));
  $('study-no-btn').addEventListener('click', () => grade(false));
  $('study-exit-btn').addEventListener('click', earlyExit);

  function onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      grade(true);
    } else if (e.key === ' ') {
      e.preventDefault();
      grade(false);
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      dictPlayTTS(word.english);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      earlyExit();
    }
  }
  studyBindKeys(onKey);
}

// ---- Study Summary Screen (known / unknown + copy buttons) ----
function studyShowSummary() {
  studyBindKeys(null);
  const s = studyState;
  const total = s.knownWords.length + s.unknownWords.length;

  let knownHTML = '';
  if (s.knownWords.length > 0) {
    knownHTML = `<h4 style="color:#86efac;margin:8px 0 4px;">✓ 认识 (${s.knownWords.length})</h4>`;
    for (const w of s.knownWords) {
      knownHTML += `<div class="dict-word-item"><span class="dict-word-en">${escapeHTML(w.english)}</span><span class="dict-word-zh">${escapeHTML(w.chinese)}</span></div>`;
    }
  }

  let unknownHTML = '';
  if (s.unknownWords.length > 0) {
    unknownHTML = `<h4 style="color:#fca5a5;margin:8px 0 4px;">✗ 不认识 (${s.unknownWords.length})</h4>`;
    for (const w of s.unknownWords) {
      unknownHTML += `<div class="dict-word-item"><span class="dict-word-en">${escapeHTML(w.english)}</span><span class="dict-word-zh">${escapeHTML(w.chinese)}</span></div>`;
    }
  }

  let csvBtns = '<div class="dict-csv-row">';
  if (s.knownWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="study-cp-known">📋 复制认识的</button>`;
  if (s.unknownWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="study-cp-unknown">📋 复制不认识的</button>`;
  csvBtns += '</div>';

  studyBody.innerHTML = `
<div class="recog-summary">
  <h3 class="recog-summary-title">学词总结 · ${escapeHTML(s.dayName)}</h3>
  <div class="dict-stats">
    <div><span class="dict-stat-num">${total}</span> TOTAL</div>
    <div><span class="dict-stat-num good">${s.knownWords.length}</span> 认识</div>
    <div><span class="dict-stat-num bad">${s.unknownWords.length}</span> 不认识</div>
  </div>
  ${summaryRevealToggleHTML()}
  <div class="dict-word-list">
    ${unknownHTML}
    ${knownHTML}
  </div>
  ${csvBtns}
  <div class="recog-summary-actions">
    <button class="dict-start-btn" id="study-redo">↻ 重新本课</button>
    <button class="dict-start-btn" id="study-repick">✂ 换段落</button>
    <button class="dict-back-btn"  id="study-home">⌂ 回主页</button>
  </div>
</div>
  `;

  const cpKnown   = $('study-cp-known');
  const cpUnknown = $('study-cp-unknown');
  if (cpKnown)   cpKnown.addEventListener('click', () => dictCopyCSV(s.knownWords, '认识的单词'));
  if (cpUnknown) cpUnknown.addEventListener('click', () => dictCopyCSV(s.unknownWords, '不认识的单词'));

  $('study-redo').addEventListener('click', () => studyStartSession(s.words, s.dayName, s.allWords, s.baseDayName));
  $('study-repick').addEventListener('click', () => {
    if (s.allWords && s.allWords.length) studyShowPortionPicker(s.allWords, s.baseDayName || s.dayName);
    else studyShowSetup();
  });
  $('study-home').addEventListener('click', studyReset);
  $('study-title').textContent = '学词';
  setupSummaryReveal(studyBody);
}

function studyReset() {
  studyState = { words: [], ordered: [], currentIdx: 0, knownWords: [], unknownWords: [], dayName: '', allWords: [], baseDayName: '' };
  $('study-title').textContent = '学词';
  studyShowSetup();
}

// Drag support for dictation panel (same pattern as popup)
let dictDrag = null;

function dictPlacePanel(left, top, width, height) {
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  dictPanel.style.left = `${clamp(left, margin, maxLeft)}px`;
  dictPanel.style.top = `${clamp(top, margin, maxTop)}px`;
  dictPanel.style.right = 'auto';
  dictPanel.style.bottom = 'auto';
  dictPanel.style.transform = 'none';
}

dictHeader.addEventListener('pointerdown', (e) => {
  if ((e.button !== undefined && e.button !== 0) || e.target.closest('button')) return;
  const rect = dictPanel.getBoundingClientRect();
  dictDrag = {
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    width: rect.width,
    height: rect.height,
  };
  dictPanel.classList.add('dragging');
  dictPanel.style.width = `${rect.width}px`;
  dictPanel.style.height = `${rect.height}px`;
  dictHeader.setPointerCapture(e.pointerId);
  e.preventDefault();
});

dictHeader.addEventListener('pointermove', (e) => {
  if (!dictDrag) return;
  dictPlacePanel(
    e.clientX - dictDrag.offsetX,
    e.clientY - dictDrag.offsetY,
    dictDrag.width,
    dictDrag.height
  );
  e.preventDefault();
});

function endDictDrag(e) {
  if (!dictDrag) return;
  dictDrag = null;
  dictPanel.classList.remove('dragging');
  if (dictHeader.hasPointerCapture(e.pointerId)) {
    dictHeader.releasePointerCapture(e.pointerId);
  }
}

dictHeader.addEventListener('pointerup', endDictDrag);
dictHeader.addEventListener('pointercancel', endDictDrag);

// ---- Shared alphabet grid renderer ----
// Renders 26 a-z buttons into `gridEl`, fetches from /dictation/alphabet-words,
// and calls `onLoaded(words, label)` on success.
let _alphabetGridRendered = new WeakSet();
function renderAlphabetGrid(gridEl, loadMsgEl, onLoaded) {
  if (_alphabetGridRendered.has(gridEl)) return;
  _alphabetGridRendered.add(gridEl);
  gridEl.innerHTML = '';
  for (let c = 97; c <= 122; c++) {
    const letter = String.fromCharCode(c);
    const btn = document.createElement('button');
    btn.className = 'dict-day-btn';
    btn.textContent = letter.toUpperCase();
    btn.addEventListener('click', async () => {
      Array.from(gridEl.children).forEach(b => b.disabled = true);
      loadMsgEl.textContent = `正在加载 ${letter}.txt ...`;
      try {
        const res = await fetch(`${apiBase()}/dictation/alphabet-words?letter=${encodeURIComponent(letter)}`);
        if (!res.ok) throw new Error(`找不到字母 ${letter} 的单词文件`);
        const words = await res.json();
        if (!words || !words.length) throw new Error(`字母 ${letter} 没有单词`);
        onLoaded(words, `字母 ${letter.toUpperCase()}`);
      } catch (err) {
        loadMsgEl.textContent = `❌ ${err.message}`;
        Array.from(gridEl.children).forEach(b => b.disabled = false);
      }
    });
    gridEl.appendChild(btn);
  }
}

// ---- Setup Screen ----
function dictShowSetup() {
  dictBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-source-tabs">
    <button class="dict-source-tab active" id="dict-tab-daily">21天</button>
    <button class="dict-source-tab" id="dict-tab-alpha">字母表</button>
  </div>
  <div id="dict-day-panel">
    <div class="dict-setup-label">听写哪一天？</div>
    <div class="dict-day-grid" id="dict-day-grid"></div>
  </div>
  <div id="dict-alpha-panel" style="display:none">
    <div class="dict-setup-label">选择字母</div>
    <div class="dict-day-grid" id="dict-alpha-grid"></div>
  </div>
  <div class="setup-aux-row">
    <button class="dict-back-btn" id="dict-custom-btn">📂 自定义路径</button>
    <button class="dict-back-btn" id="dict-paste-csv-btn">📋 粘贴 CSV</button>
  </div>
  <div class="dict-loading" id="dict-load-msg"></div>
</div>
  `;

  // Tab switching
  const tabDaily = $('dict-tab-daily');
  const tabAlpha = $('dict-tab-alpha');
  const dayPanel = $('dict-day-panel');
  const alphaPanel = $('dict-alpha-panel');
  tabDaily.addEventListener('click', () => {
    tabDaily.classList.add('active'); tabAlpha.classList.remove('active');
    dayPanel.style.display = ''; alphaPanel.style.display = 'none';
  });
  tabAlpha.addEventListener('click', () => {
    tabAlpha.classList.add('active'); tabDaily.classList.remove('active');
    alphaPanel.style.display = ''; dayPanel.style.display = 'none';
    renderAlphabetGrid($('dict-alpha-grid'), $('dict-load-msg'), (words, label) => dictShowPortionPicker(words, label));
  });

  const grid = $('dict-day-grid');
  const loadMsg = $('dict-load-msg');

  for (let i = 1; i <= 21; i++) {
    const num = i;
    const dayName = `day${String(num).padStart(2, '0')}`;
    const btn = document.createElement('button');
    btn.className = 'dict-day-btn';
    btn.textContent = String(num);
    btn.addEventListener('click', async () => {
      Array.from(grid.children).forEach(b => b.disabled = true);
      loadMsg.textContent = `正在加载 ${dayName}.txt ...`;
      try {
        let res = await fetch(`${apiBase()}/dictation/words?day=${encodeURIComponent(dayName)}`);
        let label = dayName;
        if (!res.ok) {
          // Try unpadded format (day1, day2, ...)
          res = await fetch(`${apiBase()}/dictation/words?day=${encodeURIComponent('day' + num)}`);
          if (!res.ok) {
            throw new Error(`找不到 day${num} 的单词文件`);
          }
          label = 'day' + num;
        }
        const words = await res.json();
        dictShowPortionPicker(words, label);
      } catch (err) {
        loadMsg.textContent = `❌ ${err.message}`;
        Array.from(grid.children).forEach(b => b.disabled = false);
      }
    });
    grid.appendChild(btn);
  }

  $('dict-custom-btn').addEventListener('click', () => {
    showCustomPathScreen(dictBody, dictShowSetup, (words, label) => dictShowPortionPicker(words, label));
  });
  $('dict-paste-csv-btn').addEventListener('click', () => {
    showPasteCSVScreen(dictBody, dictShowSetup, (words, label) => dictShowPortionPicker(words, label));
  });
}

// ---- Portion Picker ----
function dictShowPortionPicker(allWords, dayName) {
  const total = (allWords || []).length;
  if (total === 0) {
    flash('该文件中没有找到单词', true);
    dictShowSetup();
    return;
  }
  const q1 = Math.floor(total / 4);
  const q2 = Math.floor(total / 2);
  const q3 = Math.floor(3 * total / 4);

  const portions = [
    { label: '第 1/4', range: [0, q1] },
    { label: '第 2/4', range: [q1, q2] },
    { label: '第 3/4', range: [q2, q3] },
    { label: '第 4/4', range: [q3, total] },
    { label: '前 1/2', range: [0, q2] },
    { label: '后 1/2', range: [q2, total] },
    { label: '全部',  range: [0, total], full: true },
  ];

  let html = '';
  for (const p of portions) {
    const count = p.range[1] - p.range[0];
    html += `<button class="dict-portion-btn${p.full ? ' full' : ''}">` +
      `<span>${p.label}</span>` +
      `<span class="dict-portion-count">${count} 词</span>` +
      `</button>`;
  }

  dictBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">${escapeHTML(dayName)} · 选择听写范围</div>
  <div class="dict-portion-grid" id="dict-portion-grid">${html}</div>
  <button class="dict-back-btn" id="dict-back-btn">← 返回选择天数</button>
</div>
  `;

  const grid = $('dict-portion-grid');
  for (let i = 0; i < portions.length; i++) {
    const p = portions[i];
    grid.children[i].addEventListener('click', () => {
      const slice = allWords.slice(p.range[0], p.range[1]);
      dictStartSession(slice, `${dayName} · ${p.label}`, allWords, dayName);
    });
  }
  $('dict-back-btn').addEventListener('click', dictShowSetup);
}

// ---- Start Session ----
function dictStartSession(words, dayName, allWords, baseDayName) {
  if (!words || !words.length) {
    flash('该文件中没有找到单词', true);
    dictShowSetup();
    return;
  }

  // Shuffle
  const shuffled = [...words];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  dictState = {
    words: words,
    shuffled: shuffled,
    currentIdx: 0,
    correctWords: [],
    incorrectWords: [],
    errorCount: 0,
    isFirstTry: true,
    dayName: dayName,
    attempts: [],
    allWords: allWords || words,
    baseDayName: baseDayName || dayName,
    variant: dictVariant,
  };

  $('dict-title').textContent = `${dictVariantMeta().title} · ${dayName}`;
  flash(`已加载 ${words.length} 个单词，开始听写！`);
  preloadTTSBatch(shuffled);
  dictShowQuestion();
}

// ---- TTS cache (browser-side, populated by preload) ----
// text → { url: blobURL, loading: Promise } so concurrent requests dedupe
const ttsBlobCache = new Map();

function ttsURLFor(text) {
  return `${apiBase()}/dictation/tts?text=${encodeURIComponent(text)}`;
}

// Fetches the MP3 once and stores a blob URL in ttsBlobCache. No-op if cached.
function preloadTTS(text) {
  if (!text) return Promise.resolve(null);
  const existing = ttsBlobCache.get(text);
  if (existing) return existing.loading || Promise.resolve(existing.url);

  const entry = { url: null, loading: null };
  ttsBlobCache.set(text, entry);
  entry.loading = (async () => {
    try {
      const res = await fetch(ttsURLFor(text));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      entry.url = URL.createObjectURL(blob);
      entry.loading = null;
      return entry.url;
    } catch (err) {
      ttsBlobCache.delete(text);
      console.warn('preload TTS failed:', text, err);
      return null;
    }
  })();
  return entry.loading;
}

// Preload an array of {english} entries with bounded concurrency
async function preloadTTSBatch(words, concurrency = 4) {
  if (!words || !words.length) return;
  const queue = words.map(w => w.english).filter(Boolean);
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const i = idx++;
      await preloadTTS(queue[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

function dictPlayTTS(text) {
  const cached = ttsBlobCache.get(text);
  const src = (cached && cached.url) ? cached.url : ttsURLFor(text);
  const audio = new Audio(src);
  audio.play().catch(err => console.warn('TTS play failed:', err));
  // Kick off preload if not in cache so future plays are instant
  if (!cached) preloadTTS(text);
  return audio;
}

// ---- Question Screen ----
function dictShowQuestion() {
  const s = dictState;
  if (s.variant === 'ultimate') { dictShowQuestionUltimate(); return; }

  if (s.currentIdx >= s.shuffled.length) {
    dictShowSummary();
    return;
  }

  // advanced = 听音频拼英文：不显示中文，进入即自动播放
  const isAdv = s.variant === 'advanced';

  const word = s.shuffled[s.currentIdx];
  const total = s.shuffled.length;
  const current = s.currentIdx + 1;
  const pct = ((current - 1) / total * 100).toFixed(1);

  s.errorCount = 0;
  s.isFirstTry = true;
  let awaitingNextEnter = false;

  // Per-word trace (recorded into dictState.attempts when the word is settled)
  const wordStartTime = Date.now();
  let lastAttemptTime = wordStartTime;
  const currentTrace = {
    english: word.english,
    chinese: word.chinese,
    attempts: [],
    attemptMs: [],
    skipped: false,
    firstTryOK: false,
    errorCount: 0,
    totalMs: 0,
  };
  let peeked = false;

  dictBody.innerHTML = `
<div class="dict-question">
  <div class="dict-progress">${current} / ${total}</div>
  <div class="dict-progress-bar">
    <div class="dict-progress-fill" style="width: ${pct}%"></div>
  </div>
  <div class="dict-chinese">${isAdv ? '🎧 听音频，拼出单词' : escapeHTML(word.chinese)}</div>
  <div class="dict-hint" id="dict-hint"></div>
  <div class="dict-input-row">
    <input type="text" class="dict-answer-input" id="dict-answer" autocomplete="off" autocapitalize="none" spellcheck="false" autofocus>
  </div>
  <div class="dict-prev-wrong" id="dict-prev-wrong"></div>
  <div class="dict-feedback" id="dict-feedback"></div>
  <div class="dict-reveal" id="dict-reveal"></div>
  <button class="dict-play-btn" id="dict-play-btn" style="display:${isAdv ? '' : 'none'}">🔊 再听一次</button>
</div>
  `;

  const answerInput = $('dict-answer');
  const feedbackEl = $('dict-feedback');
  const revealEl = $('dict-reveal');
  const hintEl = $('dict-hint');
  const playBtn = $('dict-play-btn');
  const prevWrongEl = $('dict-prev-wrong');

  setTimeout(() => answerInput.focus(), 100);
  // advanced: play the word as soon as the question appears
  if (isAdv) dictPlayTTS(word.english);

  answerInput.addEventListener('keydown', (e) => {
    // On the "✅ 回答正确" screen the input is read-only, so R safely replays
    // the audio without clashing with typing.
    if (awaitingNextEnter && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      dictPlayTTS(word.english);
      return;
    }

    if (e.key !== 'Enter') return;

    // After skip reveal, second Enter advances to next word
    if (awaitingNextEnter) {
      s.currentIdx++;
      dictShowQuestion();
      return;
    }

    const ans = answerInput.value.trim();

    // Empty enter → reveal the answer, require user to type it to continue
    if (!ans) {
      feedbackEl.textContent = '❌ 请输入单词';
      feedbackEl.className = 'dict-feedback wrong';
      revealEl.textContent = word.english;
      hintEl.textContent = '请照着打一遍以继续';
      playBtn.style.display = '';
      if (s.isFirstTry) {
        s.incorrectWords.push(word);
        s.isFirstTry = false;
      }
      // Count the empty-enter as a peek attempt so trace data stays consistent
      const peekNow = Date.now();
      currentTrace.attempts.push('');
      currentTrace.attemptMs.push(peekNow - lastAttemptTime);
      lastAttemptTime = peekNow;
      currentTrace.errorCount++;
      peeked = true;
      dictPlayTTS(word.english);
      return;
    }

    if (ans.toLowerCase() === 'bye') {
      dictShowSummary();
      return;
    }

    if (ans.toLowerCase() === word.english.toLowerCase()) {
      // Correct!
      answerInput.classList.add('correct');
      answerInput.classList.remove('wrong');
      feedbackEl.textContent = '✅ 回答正确！按回车继续 · R 重听';
      feedbackEl.className = 'dict-feedback correct';
      revealEl.textContent = `${word.english} : ${word.chinese}`;
      playBtn.style.display = '';
      answerInput.readOnly = true;

      if (s.isFirstTry) {
        s.correctWords.push(word);
      }

      const correctNow = Date.now();
      currentTrace.attempts.push(ans);
      currentTrace.attemptMs.push(correctNow - lastAttemptTime);
      currentTrace.firstTryOK = (currentTrace.errorCount === 0);
      currentTrace.totalMs = correctNow - wordStartTime;
      s.attempts.push(currentTrace);

      dictPlayTTS(word.english);
      awaitingNextEnter = true;
    } else {
      // Wrong
      answerInput.classList.add('wrong');
      answerInput.classList.remove('correct');

      if (s.isFirstTry) {
        s.incorrectWords.push(word);
        s.isFirstTry = false;
      }
      s.errorCount++;
      const wrongNow = Date.now();
      currentTrace.attempts.push(ans);
      currentTrace.attemptMs.push(wrongNow - lastAttemptTime);
      lastAttemptTime = wrongNow;
      currentTrace.errorCount++;

      if (s.errorCount >= 2) {
        feedbackEl.textContent = '❌ 再错了！';
        feedbackEl.className = 'dict-feedback wrong';
        revealEl.textContent = word.english;
        hintEl.textContent = '请照着打一遍以继续';
        prevWrongEl.innerHTML = `上次输入: <span class="dict-prev-wrong-text">${escapeHTML(ans)}</span>`;
        playBtn.style.display = '';
        dictPlayTTS(word.english);
      } else {
        feedbackEl.textContent = '❌ 回答错误，请重试';
        feedbackEl.className = 'dict-feedback wrong';
      }

      answerInput.value = '';
      answerInput.focus();
    }
  });

  playBtn.addEventListener('click', () => {
    dictPlayTTS(word.english);
  });
}

// ---- Ultimate Question Screen (听音频写中文，自己判定对错) ----
function dictShowQuestionUltimate() {
  const s = dictState;
  if (s.currentIdx >= s.shuffled.length) {
    dictShowSummary();
    return;
  }

  const word = s.shuffled[s.currentIdx];
  const total = s.shuffled.length;
  const current = s.currentIdx + 1;
  const pct = ((current - 1) / total * 100).toFixed(1);
  const wordStartTime = Date.now();

  dictBody.innerHTML = `
<div class="dict-question">
  <div class="dict-progress">${current} / ${total}</div>
  <div class="dict-progress-bar">
    <div class="dict-progress-fill" style="width: ${pct}%"></div>
  </div>
  <div class="dict-chinese">🧠 听音频，写出中文意思</div>
  <div class="dict-hint" id="dict-hint">输入中文后按回车揭晓答案</div>
  <div class="dict-input-row">
    <input type="text" class="dict-answer-input" id="dict-answer" autocomplete="off" spellcheck="false" autofocus>
  </div>
  <div class="dict-feedback" id="dict-feedback"></div>
  <div class="dict-reveal" id="dict-reveal"></div>
  <div class="recog-btn-row" id="dict-grade-row" style="display:none">
    <button class="recog-no-btn" id="dict-wrong-btn">✗ 记错了</button>
    <button class="recog-yes-btn" id="dict-right-btn">✓ 记对了</button>
  </div>
  <button class="dict-play-btn" id="dict-play-btn">🔊 再听一次</button>
</div>
  `;

  const answerInput = $('dict-answer');
  const feedbackEl = $('dict-feedback');
  const revealEl = $('dict-reveal');
  const hintEl = $('dict-hint');
  const playBtn = $('dict-play-btn');
  const gradeRow = $('dict-grade-row');

  setTimeout(() => answerInput.focus(), 100);
  dictPlayTTS(word.english);

  let phase = 'answer';   // answer → grade → done
  let typedAnswer = '';

  // Reveal the answer; the program does NOT judge — the user self-grades next.
  function reveal() {
    if (phase !== 'answer') return;
    phase = 'grade';
    typedAnswer = answerInput.value.trim();
    answerInput.readOnly = true;
    revealEl.innerHTML = `<span class="dict-word-en">${escapeHTML(word.english)}</span> — <span class="recog-chinese-reveal">${escapeHTML(word.chinese)}</span>`;
    feedbackEl.textContent = typedAnswer ? `你的答案：${typedAnswer}` : '（未作答）';
    feedbackEl.className = 'dict-feedback';
    hintEl.textContent = '空格=记错了 · 回车=记对了 · R=重听';
    gradeRow.style.display = '';
  }

  function grade(gotRight) {
    if (phase !== 'grade') return;
    phase = 'done';
    if (gotRight) s.correctWords.push(word);
    else s.incorrectWords.push(word);
    const now = Date.now();
    s.attempts.push({
      english: word.english,
      chinese: word.chinese,
      attempts: [typedAnswer],
      attemptMs: [now - wordStartTime],
      skipped: false,
      firstTryOK: gotRight,
      errorCount: gotRight ? 0 : 1,
      totalMs: now - wordStartTime,
    });
    s.currentIdx++;
    dictShowQuestion();
  }

  answerInput.addEventListener('keydown', (e) => {
    // Don't treat Enter that confirms an IME (pinyin) candidate as "submit".
    if (e.isComposing || e.keyCode === 229) return;
    if (phase === 'answer') {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (answerInput.value.trim().toLowerCase() === 'bye') { dictShowSummary(); return; }
        reveal();
      }
      return;
    }
    // Grading phase: the input is read-only, so these keys are safe.
    if (e.key === 'Enter') { e.preventDefault(); grade(true); }
    else if (e.key === ' ') { e.preventDefault(); grade(false); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); dictPlayTTS(word.english); }
  });

  $('dict-right-btn').addEventListener('click', () => grade(true));
  $('dict-wrong-btn').addEventListener('click', () => grade(false));
  playBtn.addEventListener('click', () => dictPlayTTS(word.english));
}

// ---- CSV helpers ----
function dictWordsToCSV(words) {
  let csv = '\uFEFFEnglish,Chinese\n';
  for (const w of words) {
    const en = w.english.replace(/"/g, '""');
    const zh = w.chinese.replace(/"/g, '""');
    csv += `"${en}","${zh}"\n`;
  }
  return csv;
}

async function dictCopyCSV(words, label) {
  try {
    await navigator.clipboard.writeText(dictWordsToCSV(words));
    flash(`已复制 ${label}（${words.length} 词）到剪贴板`);
  } catch (err) {
    flash('复制失败: ' + err.message, true);
  }
}

// ---- Summary translation reveal ----
// On every summary screen the Chinese translations start hidden (masked bars).
// Click a single bar to peek at just that word, or use the toggle to flip all.
function summaryRevealToggleHTML() {
  return `<div class="dict-csv-row"><button class="dict-csv-btn zh-reveal-toggle">👁 显示全部翻译</button></div>`;
}

function setupSummaryReveal(rootEl) {
  const list = rootEl.querySelector('.dict-word-list');
  if (!list) return;
  list.classList.add('zh-hidden');
  list.addEventListener('click', (e) => {
    const zh = e.target.closest('.dict-word-zh');
    if (!zh || !list.classList.contains('zh-hidden')) return;
    zh.classList.toggle('revealed');
  });
  const toggle = rootEl.querySelector('.zh-reveal-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const hidden = list.classList.toggle('zh-hidden');
      if (hidden) list.querySelectorAll('.dict-word-zh.revealed').forEach(el => el.classList.remove('revealed'));
      toggle.textContent = hidden ? '👁 显示全部翻译' : '🙈 隐藏全部翻译';
    });
  }
}

// ---- Summary Screen ----
function dictShowSummary() {
  const s = dictState;
  const meta = DICT_VARIANTS[s.variant] || DICT_VARIANTS.basic;
  const practiced = s.correctWords.length + s.incorrectWords.length;

  if (practiced === 0) {
    dictBody.innerHTML = `
  <div class="dict-summary">
    <h3 class="dict-summary-title">还没有完成任何单词 😅</h3>
    <div style="text-align:center;margin-top:16px">
      <button class="dict-start-btn" id="dict-retry">重新开始</button>
    </div>
  </div>
`;
    $('dict-retry').addEventListener('click', dictReset);
    return;
  }

  let correctHTML = '';
  if (s.correctWords.length > 0) {
    correctHTML = `<h4>${meta.goodTitle} (${s.correctWords.length})</h4>`;
    for (const w of s.correctWords) {
      correctHTML += `<div class="dict-word-item"><span class="dict-word-en">${escapeHTML(w.english)}</span><span class="dict-word-zh">${escapeHTML(w.chinese)}</span></div>`;
    }
  }

  let incorrectHTML = '';
  if (s.incorrectWords.length > 0) {
    incorrectHTML = `<h4>${meta.badTitle} (${s.incorrectWords.length})</h4>`;
    for (const w of s.incorrectWords) {
      incorrectHTML += `<div class="dict-word-item"><span class="dict-word-en">${escapeHTML(w.english)}</span><span class="dict-word-zh">${escapeHTML(w.chinese)}</span></div>`;
    }
  }

  const perfectMsg = s.incorrectWords.length === 0
    ? '<div style="text-align:center;margin:8px 0;font-size:1em;color:#4ade80">🎉 完美通关！没有任何错题！</div>'
    : '';

  let csvBtns = '<div class="dict-csv-row">';
  if (s.correctWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="dict-cp-correct">📋 复制正确单词</button>`;
  if (s.incorrectWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="dict-cp-incorrect">📋 复制错误单词</button>`;
  csvBtns += '</div>';

  dictBody.innerHTML = `
<div class="dict-summary">
  <h3 class="dict-summary-title">${escapeHTML(meta.title)}总结 · ${escapeHTML(s.dayName)}</h3>
  <div class="dict-stats">
    <div>
      <span class="dict-stat-num">${practiced}</span>
      TOTAL
    </div>
    <div>
      <span class="dict-stat-num good">${s.correctWords.length}</span>
      CORRECT
    </div>
    <div>
      <span class="dict-stat-num bad">${s.incorrectWords.length}</span>
      WRONG
    </div>
  </div>
  ${perfectMsg}
  ${summaryRevealToggleHTML()}
  <div class="dict-word-list">
    ${incorrectHTML}
    ${correctHTML}
  </div>
  ${csvBtns}
  <div class="recog-summary-actions">
    <button class="dict-start-btn" id="dict-retry">↻ 重新本课</button>
    <button class="dict-start-btn" id="dict-repick">✂ 换段落</button>
    <button class="dict-back-btn"  id="dict-home">⌂ 回主页</button>
  </div>
</div>
  `;

  const cpCorrect = $('dict-cp-correct');
  const cpIncorrect = $('dict-cp-incorrect');
  if (cpCorrect)   cpCorrect.addEventListener('click', () => dictCopyCSV(s.correctWords, '正确单词'));
  if (cpIncorrect) cpIncorrect.addEventListener('click', () => dictCopyCSV(s.incorrectWords, '错误单词'));

  $('dict-retry').addEventListener('click', () => dictStartSession(s.words, s.dayName, s.allWords, s.baseDayName));
  $('dict-repick').addEventListener('click', () => {
    if (s.allWords && s.allWords.length) dictShowPortionPicker(s.allWords, s.baseDayName || s.dayName);
    else dictShowSetup();
  });
  $('dict-home').addEventListener('click', dictReset);
  $('dict-title').textContent = meta.title;
  setupSummaryReveal(dictBody);
}

// Clears the session but keeps the active variant.
function dictResetState() {
  dictState = {
    words: [],
    shuffled: [],
    currentIdx: 0,
    correctWords: [],
    incorrectWords: [],
    errorCount: 0,
    isFirstTry: true,
    dayName: '',
    attempts: [],
    allWords: [],
    baseDayName: '',
    variant: dictVariant,
  };
}

function dictReset() {
  dictResetState();
  $('dict-title').textContent = dictVariantMeta().title;
  dictShowSetup();
}

// Initialize setup screen
dictShowSetup();

// ========================================================
//  Sidebar resize + collapse
// ========================================================
const appShell = document.querySelector('.app-shell');
const sidebarDivider = $('sidebar-divider');
const sidebarToggle = $('sidebar-toggle');

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 292;

const savedWidth = parseInt(localStorage.getItem('lexica.sidebarW') || '', 10);
if (!isNaN(savedWidth) && savedWidth >= SIDEBAR_MIN && savedWidth <= SIDEBAR_MAX) {
  appShell.style.setProperty('--sidebar-w', savedWidth + 'px');
}
if (localStorage.getItem('lexica.sidebarCollapsed') === '1') {
  appShell.classList.add('sidebar-collapsed');
  sidebarToggle.textContent = '›';
}

let resizing = false;
sidebarDivider.addEventListener('pointerdown', (e) => {
  if (e.target === sidebarToggle) return;
  if (appShell.classList.contains('sidebar-collapsed')) return;
  resizing = true;
  sidebarDivider.classList.add('dragging');
  sidebarDivider.setPointerCapture(e.pointerId);
  e.preventDefault();
});

sidebarDivider.addEventListener('pointermove', (e) => {
  if (!resizing) return;
  const w = clamp(e.clientX, SIDEBAR_MIN, SIDEBAR_MAX);
  appShell.style.setProperty('--sidebar-w', w + 'px');
});

const endResize = (e) => {
  if (!resizing) return;
  resizing = false;
  sidebarDivider.classList.remove('dragging');
  if (sidebarDivider.hasPointerCapture(e.pointerId)) {
    sidebarDivider.releasePointerCapture(e.pointerId);
  }
  const cur = appShell.style.getPropertyValue('--sidebar-w');
  const px = parseInt(cur, 10);
  if (!isNaN(px)) localStorage.setItem('lexica.sidebarW', String(px));
};
sidebarDivider.addEventListener('pointerup', endResize);
sidebarDivider.addEventListener('pointercancel', endResize);

sidebarToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const collapsed = appShell.classList.toggle('sidebar-collapsed');
  sidebarToggle.textContent = collapsed ? '›' : '‹';
  localStorage.setItem('lexica.sidebarCollapsed', collapsed ? '1' : '0');
});

// ========================================================
//  ResizeObserver – scale fonts when panels are resized
// ========================================================
function scalePanel(panel, baseWidth, baseFontSize) {
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const w = entry.contentRect.width;
      const scale = Math.max(0.6, Math.min(1.4, w / baseWidth));
      panel.style.fontSize = (baseFontSize * scale) + 'px';
    }
  });
  ro.observe(panel);
}

// Popup: base 420px → 16px font
scalePanel(popup, 420, 16);
// Dictation: base 460px → 18px font, allow up to 2.5x scaling
{
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const w = entry.contentRect.width;
      const scale = Math.max(0.6, Math.min(2.5, w / 460));
      dictPanel.style.fontSize = (18 * scale) + 'px';
    }
  });
  ro.observe(dictPanel);
}
// Recognition panel: base 460px → 18px font
{
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const w = entry.contentRect.width;
      const scale = Math.max(0.6, Math.min(2.5, w / 460));
      recogPanel.style.fontSize = (18 * scale) + 'px';
    }
  });
  ro.observe(recogPanel);
}

// Learn panel: base 460px → 18px font
{
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const w = entry.contentRect.width;
      const scale = Math.max(0.6, Math.min(2.5, w / 460));
      learnPanel.style.fontSize = (18 * scale) + 'px';
    }
  });
  ro.observe(learnPanel);
}

// Study panel: base 460px → 18px font
{
  const ro = new ResizeObserver(entries => {
    for (const entry of entries) {
      const w = entry.contentRect.width;
      const scale = Math.max(0.6, Math.min(2.5, w / 460));
      studyPanel.style.fontSize = (18 * scale) + 'px';
    }
  });
  ro.observe(studyPanel);
}

// ========================================================
//  Sunrise / Sunset Wallpaper — ECharts-powered background board
//  Sun trajectory from civil dawn → dusk (so we get a bit of
//  pre-dawn and post-sunset), with colored phase bands at the bottom.
// ========================================================
function renderSunBackground() {
  if (typeof echarts === 'undefined') {
    console.warn('[sun-wallpaper] ECharts not loaded');
    return;
  }
  const host = $('status');
  const mainEl = document.querySelector('main');
  if (!host || !mainEl) return;

  mainEl.classList.add('sun-bleed');
  host.classList.add('sun-host');
  host.innerHTML = `
    <div class="sun-wallpaper">
      <div class="sun-wallpaper-overlay">
        <div class="sun-wallpaper-meta">
          <span class="sun-wallpaper-date" id="sun-wallpaper-date">—</span>
          <span class="sun-wallpaper-status" id="sun-wallpaper-status">—</span>
        </div>
      </div>
      <div class="sun-wallpaper-chart" id="sun-wallpaper-chart"></div>
      <div class="sun-wallpaper-footer">
        <span class="sun-wallpaper-hint">选中文字即朗读 · 翻译自动弹出 · 支持 txt · csv · md · pdf · docx · epub</span>
      </div>
    </div>
  `;

  const chartEl = $('sun-wallpaper-chart');
  const dateEl  = $('sun-wallpaper-date');
  const statEl  = $('sun-wallpaper-status');

  const chart = echarts.init(chartEl, null, { renderer: 'canvas' });
  window.addEventListener('resize', () => chart.resize());

  let sunData = null;
  let rerenderTimer = null;

  async function load() {
    // Bail if the user has since switched to another background — the host
    // element may have been replaced, so painting would be wasted or error.
    if (currentBackground !== 'sun') return;
    try {
      const res = await fetch(`${apiBase()}/sun/today`);
      if (res && res.ok) sunData = await res.json();
      paint();
    } catch (err) {
      console.warn('[sun-wallpaper] load failed', err);
    }
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtTime(ms) {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function fmtMinutes(ms) {
    const min = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分钟`;
  }
  function midnightUTC8(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 0, 0, 0) - 8 * 3600 * 1000;
  }

  // Map an instant to its y on the sun arc.
  // sin(t·π) where t = (ms - sunrise) / (sunset - sunrise).
  // y = 0 at sunrise/sunset, y = 1 at solar noon, y < 0 below the horizon
  // (during civil twilight). Caller is responsible for clipping the x-range.
  function arcY(ms, sunriseMs, sunsetMs) {
    const t = (ms - sunriseMs) / (sunsetMs - sunriseMs);
    return Math.sin(t * Math.PI);
  }

  function paint() {
    if (!sunData) return;

    const sunriseMs       = sunData.sunriseMs;
    const sunsetMs        = sunData.sunsetMs;
    const dawnMs          = sunData.dawnMs || (sunriseMs - 30 * 60 * 1000);
    const duskMs          = sunData.duskMs || (sunsetMs  + 30 * 60 * 1000);
    const goldenMorningMs = sunData.goldenMorningMs || sunriseMs;
    const goldenEveningMs = sunData.goldenEveningMs || sunsetMs;
    const solarNoonMs     = sunData.solarNoonMs    || (sunriseMs + (sunsetMs - sunriseMs) / 2);

    const nowMs       = Date.now();
    const dateStr     = sunData.date;
    const todayStartMs = midnightUTC8(dateStr);
    const todayEndMs   = todayStartMs + 24 * 3600 * 1000;

    // ---- Sun arc samples (dawn → dusk) ----
    const arcSamples = [];
    const steps = 120;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ms = dawnMs + t * (duskMs - dawnMs);
      arcSamples.push([ms, arcY(ms, sunriseMs, sunsetMs)]);
    }

    // ---- Current sun position (visible whenever between dawn and dusk) ----
    let sunPoint = null;
    if (nowMs >= dawnMs && nowMs <= duskMs) {
      sunPoint = [nowMs, arcY(nowMs, sunriseMs, sunsetMs)];
    }

    // ---- Header / footer text ----
    dateEl.textContent = dateStr;
    if (nowMs < dawnMs) {
      statEl.textContent = `🌌 深夜 · 距黎明 ${fmtMinutes(dawnMs - nowMs)}`;
    } else if (nowMs < sunriseMs) {
      statEl.textContent = `🌌 黎明 · 距日出 ${fmtMinutes(sunriseMs - nowMs)}`;
    } else if (nowMs <= goldenMorningMs) {
      statEl.textContent = `🌅 晨光 · 距日落 ${fmtMinutes(sunsetMs - nowMs)}`;
    } else if (nowMs < goldenEveningMs) {
      statEl.textContent = `☀️ 白天 · 距日落 ${fmtMinutes(sunsetMs - nowMs)}`;
    } else if (nowMs <= sunsetMs) {
      statEl.textContent = `🌇 黄昏 · 距日落 ${fmtMinutes(sunsetMs - nowMs)}`;
    } else if (nowMs <= duskMs) {
      statEl.textContent = `🌆 暮光 · 日落于 ${fmtTime(sunsetMs)}`;
    } else {
      statEl.textContent = `🌌 入夜 · 日落于 ${fmtTime(sunsetMs)}`;
    }

    // Y-axis layout: arc peak at y=1, but we open the scale up to y=3 so the
    // arc only takes the upper third → looks short and flat, leaving plenty
    // of space below for the phase bands.
    const Y_MIN = -0.55;
    const Y_MAX = 3.0;
    // Y-band for the phase color strip (below horizon)
    const PHASE_Y_TOP = -0.18;
    const PHASE_Y_BOT = -0.46;

    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 50, bottom: 70, left: 28, right: 28, containLabel: false },
      tooltip: { show: false },
      xAxis: {
        type: 'time',
        min: todayStartMs,
        max: todayEndMs,
        interval: 3 * 3600 * 1000,
        axisLine: { lineStyle: { color: 'rgba(15,12,41,0.6)', width: 1.5 } },
        axisTick: { lineStyle: { color: 'rgba(15,12,41,0.6)', width: 1.5 }, length: 6 },
        axisLabel: {
          color: '#111827',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 15,
          fontWeight: 600,
          margin: 12,
          formatter: (val) => {
            const d = new Date(val);
            return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
          }
        },
        splitLine: { show: true, lineStyle: { color: 'rgba(15,12,41,0.08)' } }
      },
      yAxis: { type: 'value', min: Y_MIN, max: Y_MAX, show: false },
      series: [
        // ---- Phase color bands (markArea on an invisible scatter) ----
        {
          type: 'scatter',
          symbolSize: 0,
          data: [[sunriseMs, 0]],
          silent: true,
          markArea: {
            silent: true,
            label: { show: false },
            itemStyle: { opacity: 0.78 },
            data: [
              // Night / astro twilight (before dawn)
              [{ xAxis: todayStartMs, yAxis: PHASE_Y_BOT,
                 itemStyle: { color: 'rgba(11,16,41,0.55)' } },
               { xAxis: dawnMs,       yAxis: PHASE_Y_TOP }],
              // Civil dawn
              [{ xAxis: dawnMs,    yAxis: PHASE_Y_BOT,
                 itemStyle: { color: 'rgba(76,29,149,0.55)' } },
               { xAxis: sunriseMs, yAxis: PHASE_Y_TOP }],
              // Golden morning
              [{ xAxis: sunriseMs,       yAxis: PHASE_Y_BOT,
                 itemStyle: { color: 'rgba(251,146,60,0.55)' } },
               { xAxis: goldenMorningMs, yAxis: PHASE_Y_TOP }],
              // Day
              [{ xAxis: goldenMorningMs, yAxis: PHASE_Y_BOT,
                 itemStyle: { color: 'rgba(125,211,252,0.45)' } },
               { xAxis: goldenEveningMs, yAxis: PHASE_Y_TOP }],
              // Golden evening
              [{ xAxis: goldenEveningMs, yAxis: PHASE_Y_BOT,
                 itemStyle: { color: 'rgba(249,115,22,0.55)' } },
               { xAxis: sunsetMs,        yAxis: PHASE_Y_TOP }],
              // Civil dusk
              [{ xAxis: sunsetMs, yAxis: PHASE_Y_BOT,
                 itemStyle: { color: 'rgba(124,45,18,0.55)' } },
               { xAxis: duskMs,   yAxis: PHASE_Y_TOP }],
              // Night again
              [{ xAxis: duskMs,      yAxis: PHASE_Y_BOT,
                 itemStyle: { color: 'rgba(11,16,41,0.55)' } },
               { xAxis: todayEndMs,  yAxis: PHASE_Y_TOP }]
            ]
          },
          z: 1
        },
        // ---- Sun arc ----
        {
          name: 'Sun path',
          type: 'line',
          smooth: true,
          symbol: 'none',
          z: 3,
          lineStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0,    color: 'rgba(167,139,250,0.85)' },
              { offset: 0.15, color: 'rgba(252,211,77,1)' },
              { offset: 0.5,  color: 'rgba(254,243,199,1)' },
              { offset: 0.85, color: 'rgba(251,146,60,1)' },
              { offset: 1,    color: 'rgba(167,139,250,0.85)' }
            ]),
            width: 4,
            shadowBlur: 8,
            shadowColor: 'rgba(254,243,199,0.5)'
          },
          areaStyle: {
            origin: 'start',
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(254,243,199,0.18)' },
              { offset: 1, color: 'rgba(254,243,199,0)' }
            ])
          },
          data: arcSamples,
          markLine: sunPoint ? {
            symbol: 'none',
            silent: true,
            lineStyle: { color: 'rgba(251,191,36,0.55)', type: 'dashed', width: 1 },
            label: { show: false },
            data: [{ xAxis: nowMs }]
          } : undefined,
          markPoint: sunPoint ? {
            symbol: 'circle',
            symbolSize: 38,
            silent: true,
            itemStyle: {
              color: new echarts.graphic.RadialGradient(0.5, 0.5, 0.5, [
                { offset: 0,    color: '#fef9c3' },
                { offset: 0.55, color: '#fbbf24' },
                { offset: 1,    color: '#f97316' }
              ]),
              shadowBlur: 32,
              shadowColor: 'rgba(251,191,36,0.85)'
            },
            label: { show: false },
            data: [{ coord: sunPoint }]
          } : undefined
        },
        // ---- Phase markers (chip-style, Chinese text, staggered to avoid overlap) ----
        // Sunrise & sunset chips sit ABOVE the horizon; dawn & dusk chips BELOW.
        {
          type: 'scatter', symbolSize: 9, silent: true, z: 5,
          itemStyle: { color: '#fbbf24', shadowBlur: 10, shadowColor: '#fbbf24' },
          label: {
            show: true, position: 'top', distance: 14,
            color: '#111827', fontSize: 16, fontWeight: 700,
            fontFamily: '"Newsreader", "Segoe UI", system-ui, sans-serif',
            backgroundColor: 'rgba(255,250,240,0.95)',
            borderColor: 'rgba(180,83,9,0.5)',
            borderWidth: 1, borderRadius: 6,
            padding: [5, 10],
            formatter: `日出 ${fmtTime(sunriseMs)}`
          },
          data: [[sunriseMs, 0]]
        },
        {
          type: 'scatter', symbolSize: 9, silent: true, z: 5,
          itemStyle: { color: '#fb923c', shadowBlur: 10, shadowColor: '#fb923c' },
          label: {
            show: true, position: 'top', distance: 14,
            color: '#111827', fontSize: 16, fontWeight: 700,
            fontFamily: '"Newsreader", "Segoe UI", system-ui, sans-serif',
            backgroundColor: 'rgba(255,250,240,0.95)',
            borderColor: 'rgba(180,83,9,0.5)',
            borderWidth: 1, borderRadius: 6,
            padding: [5, 10],
            formatter: `日落 ${fmtTime(sunsetMs)}`
          },
          data: [[sunsetMs, 0]]
        },
        {
          type: 'scatter', symbolSize: 7, silent: true, z: 5,
          itemStyle: { color: 'rgba(196,181,253,0.95)', shadowBlur: 6, shadowColor: '#c4b5fd' },
          label: {
            show: true, position: 'bottom', distance: 14,
            color: '#111827', fontSize: 14, fontWeight: 600,
            fontFamily: '"Newsreader", "Segoe UI", system-ui, sans-serif',
            backgroundColor: 'rgba(241,232,255,0.95)',
            borderColor: 'rgba(124,58,237,0.5)',
            borderWidth: 1, borderRadius: 6,
            padding: [4, 9],
            formatter: `黎明 ${fmtTime(dawnMs)}`
          },
          data: [[dawnMs, 0]]
        },
        {
          type: 'scatter', symbolSize: 7, silent: true, z: 5,
          itemStyle: { color: 'rgba(196,181,253,0.95)', shadowBlur: 6, shadowColor: '#c4b5fd' },
          label: {
            show: true, position: 'bottom', distance: 14,
            color: '#111827', fontSize: 14, fontWeight: 600,
            fontFamily: '"Newsreader", "Segoe UI", system-ui, sans-serif',
            backgroundColor: 'rgba(241,232,255,0.95)',
            borderColor: 'rgba(124,58,237,0.5)',
            borderWidth: 1, borderRadius: 6,
            padding: [4, 9],
            formatter: `黄昏 ${fmtTime(duskMs)}`
          },
          data: [[duskMs, 0]]
        }
      ]
    });

    if (rerenderTimer) clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(load, 60 * 1000);
  }

  setTimeout(() => chart.resize(), 50);
  load();
}

// ========================================================
//  Home-screen background switcher
//  Two boards render into #status (the empty-state area in <main>):
//    'sun'     — sunrise/sunset wallpaper (default)
//    'letters' — 26-letter check-in progress tracker
//  Choice persists in localStorage; a sidebar button switches between them.
// ========================================================
const BG_KEY = 'lexica-bg';
let currentBackground = 'sun';

const BG_OPTIONS = [
  { id: 'sun',     icon: '🌅', label: '日出日落' },
  { id: 'letters', icon: '🔤', label: '字母进度' },
];

function applyBackground(name) {
  currentBackground = (name === 'letters') ? 'letters' : 'sun';
  try { localStorage.setItem(BG_KEY, currentBackground); } catch (_) {}

  const host = $('status');
  const mainEl = document.querySelector('main');
  if (!host || !mainEl) return;

  // Files now open in the floating reader panel, so the background board in
  // #status is always visible (behind any panel).
  host.style.display = 'block';

  if (currentBackground === 'letters') {
    mainEl.classList.add('sun-bleed');
    host.classList.remove('sun-host');
    host.classList.add('letter-host');
    renderLetterBackground(host);
  } else {
    host.classList.remove('letter-host');
    renderSunBackground(); // re-adds sun-bleed + sun-host and paints
  }
  updateBgPickerLabel();
}

// ---- Letter check-in tracker (ported 1:1 from the React artifact) ----
const LETTER_DATA = [
  { letter: 'A', words: 377 }, { letter: 'B', words: 184 },
  { letter: 'C', words: 530 }, { letter: 'D', words: 344 },
  { letter: 'E', words: 283 }, { letter: 'F', words: 204 },
  { letter: 'G', words: 114 }, { letter: 'H', words: 156 },
  { letter: 'I', words: 299 }, { letter: 'J', words: 22 },
  { letter: 'K', words: 12 },  { letter: 'L', words: 122 },
  { letter: 'M', words: 234 }, { letter: 'N', words: 67 },
  { letter: 'O', words: 124 }, { letter: 'P', words: 334 },
  { letter: 'Q', words: 14 },  { letter: 'R', words: 253 },
  { letter: 'S', words: 500 }, { letter: 'T', words: 197 },
  { letter: 'U', words: 80 },  { letter: 'V', words: 91 },
  { letter: 'W', words: 74 },  { letter: 'X', words: 0 },
  { letter: 'Y', words: 4 },   { letter: 'Z', words: 6 },
];

const LT_TOTAL = LETTER_DATA.reduce((sum, item) => sum + item.words, 0);

const LT_ICON_CHECK = '<svg class="lt-icon checked" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>';
const LT_ICON_CIRCLE = '<svg class="lt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle></svg>';

function renderLetterBackground(host) {
  let checked = {};
  try { checked = JSON.parse(localStorage.getItem('wordTrackerProgress') || '{}') || {}; } catch (_) { checked = {}; }

  function save() {
    try { localStorage.setItem('wordTrackerProgress', JSON.stringify(checked)); } catch (_) {}
  }

  function paint() {
    const done = LETTER_DATA.reduce((sum, item) => sum + (checked[item.letter] ? item.words : 0), 0);
    const pct = LT_TOTAL === 0 ? '0' : ((done / LT_TOTAL) * 100).toFixed(1);

    const cards = LETTER_DATA.map(({ letter, words }) => {
      const isChecked = !!checked[letter];
      const isZero = words === 0;
      const icon = isZero ? '' : (isChecked ? LT_ICON_CHECK : LT_ICON_CIRCLE);
      const cls = 'lt-card' + (isChecked ? ' checked' : '') + (isZero ? ' zero' : '');
      return `<div class="${cls}" data-letter="${letter}">
        <div class="lt-card-top">
          <span class="lt-letter">${letter}</span>
          ${icon}
        </div>
        <div class="lt-count">${words} 词</div>
      </div>`;
    }).join('');

    host.innerHTML = `
<div class="lt-board">
  <div class="lt-header-card">
    <div class="lt-header-row">
      <div>
        <h1 class="lt-title">9天单词通关打卡</h1>
        <p class="lt-sub">每日精准卡点，彻底消灭字母尾巴</p>
      </div>
      <button class="lt-reset" id="lt-reset">重置进度</button>
    </div>
    <div class="lt-progress-row">
      <div class="lt-pct">${pct}%</div>
      <div class="lt-fraction">已完成 ${done} / <span class="lt-total">${LT_TOTAL} 词</span></div>
    </div>
    <div class="lt-bar"><div class="lt-bar-fill" style="width:${pct}%"></div></div>
  </div>
  <div class="lt-grid">${cards}</div>
  <div class="lt-footer">点击上方字母卡片进行打卡，进度将自动保存。</div>
</div>
    `;

    host.querySelectorAll('.lt-card').forEach(el => {
      el.addEventListener('click', () => {
        const L = el.dataset.letter;
        const item = LETTER_DATA.find(x => x.letter === L);
        if (!item || item.words === 0) return;
        checked[L] = !checked[L];
        save();
        paint();
      });
    });
    const resetBtn = host.querySelector('#lt-reset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      if (window.confirm('确定要清空所有进度重新开始吗？')) { checked = {}; save(); paint(); }
    });
  }

  paint();
}

// ---- Sidebar background picker ----
function updateBgPickerLabel() {
  const labelEl = $('bg-picker-label');
  if (labelEl) {
    const opt = BG_OPTIONS.find(o => o.id === currentBackground) || BG_OPTIONS[0];
    labelEl.textContent = opt.label;
  }
  document.querySelectorAll('.bg-picker-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.bg === currentBackground);
  });
}

function setupBackgroundPicker() {
  const btn = $('bg-picker-btn');
  const menu = $('bg-picker-menu');
  if (!btn || !menu) return;

  function closeMenu() { menu.classList.add('hidden'); }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  menu.querySelectorAll('.bg-picker-opt').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      applyBackground(opt.dataset.bg);
      closeMenu();
    });
  });
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn) closeMenu();
  });

  // Initial background from saved choice (default: sun).
  let saved = 'sun';
  try { saved = localStorage.getItem(BG_KEY) || 'sun'; } catch (_) {}
  applyBackground(saved);
}

setupBackgroundPicker();
