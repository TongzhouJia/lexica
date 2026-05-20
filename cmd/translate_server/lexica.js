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
const statusEl = $('status');
const contentEl = $('content');
const gcsPrefixEl = $('gcs-prefix');
const gcsStatusEl = $('gcs-status');
const gcsListEl = $('gcs-list');
const gcsRefreshBtn = $('gcs-refresh');

let gcsFiles = [];
let activeGCSName = '';
let openGCSFolders = new Set(JSON.parse(localStorage.getItem('lexica.gcs.openFolders') || '[]'));

loadBtn.addEventListener('click', () => fileInput.click());
gcsRefreshBtn.addEventListener('click', refreshGCSFiles);

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  activeGCSName = '';
  renderGCSList(gcsFiles);
  await openReaderFile(file, file.name);
  fileInput.value = '';
});

function showStatus(msg, isError) {
  statusEl.style.display = 'block';
  contentEl.style.display = 'none';
  statusEl.innerHTML = `
<div class="hint-ornament">${isError ? '✕' : '◐ ◓ ◑ ◒'}</div>
<h2 class="hint-title" style="${isError ? 'color: var(--accent)' : ''}">${escapeHTML(msg)}</h2>
  `;
}

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

async function openReaderFile(file, label) {
  showStatus(`读取中  ${label}`);

  try {
    const result = await readFileAsHTML(file, label);
    statusEl.style.display = 'none';
    contentEl.style.display = 'block';
    contentEl.dataset.mode = result.mode;
    contentEl.innerHTML = result.html;
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    showStatus(`读取失败: ${err.message}`, true);
  }
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
  showStatus(`读取中  ${name}`);

  try {
    const res = await fetch(`${apiBase()}/gcs/download?name=${encodeURIComponent(name)}`);
    if (!res.ok) {
      const body = (await res.text()).trim();
      throw new Error(body || `HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const file = new File([blob], baseName(name), { type: blob.type || 'application/octet-stream' });
    await openReaderFile(file, name);
  } catch (err) {
    console.error(err);
    showStatus(`读取失败: ${err.message}`, true);
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

replayBtn.addEventListener('click', () => {
  if (!currentWord) return;
  fetch(`${apiBase()}/play?text=${encodeURIComponent(currentWord)}`, { mode: 'no-cors' })
    .catch(err => console.warn('play failed', err));
});

// Esc to close
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && popup.classList.contains('visible')) {
    closeBtn.click();
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
const tabDictSkip = $('tab-dict-skip');
const tabRecog = $('tab-recog');
const tabTraces = $('tab-traces');
const tabCleaner = $('tab-cleaner');
const tabActivity = $('tab-activity');
const sidebarFiles = $('sidebar-files');
const sidebarDictInfo = $('sidebar-dict-info');
const sidebarRecogInfo = $('sidebar-recog-info');
const sidebarTraces = $('sidebar-traces');
const sidebarCleaner = $('sidebar-cleaner');
const sidebarActivity = $('sidebar-activity');
const sidebarDictLabel = $('sidebar-dict-mode-label');
const sidebarDictDesc = $('sidebar-dict-mode-desc');

// 'strict' = no skip (empty enter → reveal + must type), 'skip' = can skip
let dictMode = 'skip';

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
};

function setActiveTab(tab) {
  [tabFiles, tabDictStrict, tabDictSkip, tabRecog, tabTraces, tabCleaner, tabActivity].forEach(t => t.classList.remove('active'));
  if (tab) tab.classList.add('active');
}

function showSidebarContent(which) {
  sidebarFiles.classList.toggle('hidden', which !== 'files');
  sidebarDictInfo.classList.toggle('hidden', which !== 'dict');
  sidebarRecogInfo.classList.toggle('hidden', which !== 'recog');
  sidebarTraces.classList.toggle('hidden', which !== 'traces');
  sidebarCleaner.classList.toggle('hidden', which !== 'cleaner');
  sidebarActivity.classList.toggle('hidden', which !== 'activity');
}

function openDictation(mode) {
  dictMode = mode;
  const isStrict = mode === 'strict';
  setActiveTab(isStrict ? tabDictStrict : tabDictSkip);
  showSidebarContent('dict');
  sidebarDictLabel.textContent = isStrict ? '严格模式' : '跳过模式';
  sidebarDictDesc.textContent = isStrict
    ? '按回车不会跳过，必须正确输入单词才能继续下一题。'
    : '按回车可以跳过当前单词，直接进入下一题。';

  dictPanel.classList.add('visible');
  if (!dictState.words.length) {
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

tabDictStrict.addEventListener('click', () => openDictation('strict'));
tabDictSkip.addEventListener('click', () => openDictation('skip'));
tabRecog.addEventListener('click', () => openRecognition());
tabTraces.addEventListener('click', () => {
  setActiveTab(tabTraces);
  showSidebarContent('traces');
  dictPanel.classList.remove('visible');
  refreshTraces();
});

tabCleaner.addEventListener('click', () => {
  setActiveTab(tabCleaner);
  showSidebarContent('cleaner');
  dictPanel.classList.remove('visible');
});

tabActivity.addEventListener('click', () => {
  setActiveTab(tabActivity);
  showSidebarContent('activity');
  dictPanel.classList.remove('visible');
  refreshActivityLogs();
});

// Activity log
async function refreshActivityLogs() {
  const listEl = $('activity-list');
  listEl.innerHTML = '<div style="color:var(--ink-soft);padding:8px;">加载中...</div>';
  try {
    const res = await fetch(`${apiBase()}/activity/list`);
    const logs = await res.json();
    if (!logs || !logs.length) {
      listEl.innerHTML = '<div style="color:var(--ink-soft);padding:8px;">暂无记录</div>';
      return;
    }
    listEl.innerHTML = '';
    const typeIcons = {dictation:'📝', clean:'🧹', clean_sync:'☁️', email:'📧'};
    for (const log of logs) {
      const div = document.createElement('div');
      div.style.cssText = 'padding:6px 8px; border-bottom:1px solid var(--rule); line-height:1.5;';
      const icon = typeIcons[log.type] || '📋';
      const t = new Date(log.time);
      const timeStr = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
      const dateStr = log.time.slice(0,10);
      div.innerHTML = `<span style="color:var(--gcp);font-family:'JetBrains Mono',monospace;font-size:10px;">${dateStr} ${timeStr}</span> ${icon} <span style="color:var(--ink);">${log.summary}</span>`;
      listEl.appendChild(div);
    }
  } catch(e) {
    listEl.innerHTML = '<div style="color:var(--accent);padding:8px;">加载失败</div>';
  }
}

$('activity-refresh').addEventListener('click', refreshActivityLogs);

// Email send
$('email-send-btn').addEventListener('click', async () => {
  const to = $('email-to').value.trim();
  if (!to) { $('email-status').textContent = '请输入邮箱地址'; return; }
  const btn = $('email-send-btn');
  btn.disabled = true;
  $('email-status').textContent = '发送中...';
  try {
    const res = await fetch(`${apiBase()}/email/send`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({to})
    });
    if (res.status === 401) {
      $('email-status').innerHTML = '未授权，<a href="/gmail/auth" target="_blank" style="color:var(--accent);">点此授权Gmail</a>';
      return;
    }
    if (!res.ok) { const t = await res.text(); throw new Error(t); }
    $('email-status').textContent = '✅ 日报已发送到 ' + to;
    localStorage.setItem('lexica.emailTo', to);
  } catch(e) {
    $('email-status').textContent = '❌ ' + e.message;
  } finally { btn.disabled = false; }
});

// Restore saved email
const savedEmail = localStorage.getItem('lexica.emailTo');
if (savedEmail) $('email-to').value = savedEmail;


$('cleaner-btn').addEventListener('click', async () => {
  const input = $('cleaner-input').value.trim();
  if (!input) return;
  
  $('cleaner-btn').disabled = true;
  $('cleaner-btn').textContent = '清理中...';
  $('cleaner-status').textContent = '';
  
  try {
    const res = await fetch('/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: input })
    });
    if (!res.ok) throw new Error('API Error');
    const data = await res.json();
    $('cleaner-status').textContent = `成功本地清理 ${data.cleaned} 个单词，${data.pending_sync} 个文件待同步。`;
    $('cleaner-input').value = '';
  } catch (err) {
    $('cleaner-status').textContent = '清理失败，请重试。';
    console.error(err);
  } finally {
    $('cleaner-btn').disabled = false;
    $('cleaner-btn').textContent = '确认清理(本地)';
  }
});

$('cleaner-sync-btn').addEventListener('click', async () => {
  const btn = $('cleaner-sync-btn');
  btn.disabled = true;
  $('cleaner-status').textContent = '同步云端中...';
  
  try {
    const res = await fetch('/clean/sync', {
      method: 'POST'
    });
    if (!res.ok) throw new Error('API Error');
    const data = await res.json();
    $('cleaner-status').textContent = `云端同步完成，更新了 ${data.synced} 个文件。`;
  } catch (err) {
    $('cleaner-status').textContent = '云端同步失败，请重试。';
    console.error(err);
  } finally {
    btn.disabled = false;
  }
});

dictCloseBtn.addEventListener('click', () => {
  dictPanel.classList.remove('visible');
  setActiveTab(null);
  showSidebarContent(null);
});

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
  $('recog-title').textContent = '认词模式';
  if (!recogState.words.length) {
    recogShowSetup();
  }
}

// ---- Recognition Setup Screen ----
function recogShowSetup() {
  recogBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">认哪一天？</div>
  <div class="dict-day-grid" id="recog-day-grid"></div>
  <div class="dict-loading" id="recog-load-msg"></div>
</div>
  `;

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
      recogStartSession(slice, `${dayName} · ${p.label}`);
    });
  }
  $('recog-back-btn').addEventListener('click', recogShowSetup);
}

// ---- Recognition Start Session ----
function recogStartSession(words, dayName) {
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
  };

  $('recog-title').textContent = `认词 · ${dayName}`;
  flash(`已加载 ${words.length} 个单词，开始认词！`);
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
  <div class="recog-chinese-reveal" id="recog-chinese" style="visibility:hidden">${escapeHTML(word.chinese)}</div>
  <div class="recog-btn-row">
    <button class="recog-no-btn" id="recog-no-btn">✗ 不认识</button>
    <button class="recog-yes-btn" id="recog-yes-btn">✓ 认识</button>
  </div>
  <div class="recog-hint" id="recog-hint">回车=认识 · 空格=不认识</div>
</div>
  `;

  dictPlayTTS(word.english);

  let revealed = false;
  let pendingKnown = null;

  function reveal(known) {
    if (revealed) return;
    revealed = true;
    pendingKnown = known;
    $('recog-chinese').style.visibility = '';
    $('recog-yes-btn').textContent = '→ 下一个';
    $('recog-no-btn').textContent = '→ 下一个';
    $('recog-hint').textContent = '回车 / 空格 继续';
  }

  function advance() {
    if (!revealed) return;
    window.removeEventListener('keydown', onKey);
    if (pendingKnown) s.knownWords.push(word);
    else s.unknownWords.push(word);
    s.currentIdx++;
    recogShowQuestion();
  }

  $('recog-yes-btn').addEventListener('click', () => { if (!revealed) reveal(true); else advance(); });
  $('recog-no-btn').addEventListener('click',  () => { if (!revealed) reveal(false); else advance(); });

  function onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!revealed) reveal(true); else advance();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (!revealed) reveal(false); else advance();
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
  if (s.knownWords.length > 0) {
    csvBtns += `<button class="dict-csv-btn" id="recog-dl-known">⬇ 认识的 CSV</button>`;
  }
  if (s.unknownWords.length > 0) {
    csvBtns += `<button class="dict-csv-btn" id="recog-dl-unknown">⬇ 不认识的 CSV</button>`;
  }
  csvBtns += '</div>';

  recogBody.innerHTML = `
<div class="recog-summary">
  <h3 class="recog-summary-title">认词总结 · ${escapeHTML(s.dayName)}</h3>
  <div class="dict-stats">
    <div><span class="dict-stat-num">${total}</span> TOTAL</div>
    <div><span class="dict-stat-num good">${s.knownWords.length}</span> 认识</div>
    <div><span class="dict-stat-num bad">${s.unknownWords.length}</span> 不认识</div>
  </div>
  <div class="dict-word-list">
    ${unknownHTML}
    ${knownHTML}
  </div>
  ${csvBtns}
  <div style="text-align:center;margin-top:12px">
    <button class="dict-start-btn" id="recog-retry">再来一次</button>
  </div>
</div>
  `;

  const dlKnown = $('recog-dl-known');
  const dlUnknown = $('recog-dl-unknown');
  if (dlKnown) dlKnown.addEventListener('click', () => dictDownloadCSV(s.knownWords, `${s.dayName}_known.csv`));
  if (dlUnknown) dlUnknown.addEventListener('click', () => dictDownloadCSV(s.unknownWords, `${s.dayName}_unknown.csv`));

  $('recog-retry').addEventListener('click', recogReset);
  $('recog-title').textContent = '认词模式';
}

function recogReset() {
  recogState = { words: [], shuffled: [], currentIdx: 0, knownWords: [], unknownWords: [], dayName: '' };
  $('recog-title').textContent = '认词模式';
  recogShowSetup();
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

// ---- Setup Screen ----
function dictShowSetup() {
  dictBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">听写哪一天？</div>
  <div class="dict-day-grid" id="dict-day-grid"></div>
  <div class="dict-loading" id="dict-load-msg"></div>
</div>
  `;

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
      dictStartSession(slice, `${dayName} · ${p.label}`);
    });
  }
  $('dict-back-btn').addEventListener('click', dictShowSetup);
}

// ---- Start Session ----
function dictStartSession(words, dayName) {
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
  };

  $('dict-title').textContent = `听写 · ${dayName}`;
  flash(`已加载 ${words.length} 个单词，开始听写！`);
  dictShowQuestion();
}

// ---- Play TTS in browser ----
function dictPlayTTS(text) {
  const url = `${apiBase()}/dictation/tts?text=${encodeURIComponent(text)}`;
  const audio = new Audio(url);
  audio.play().catch(err => console.warn('TTS play failed:', err));
  return audio;
}

// ---- Question Screen ----
function dictShowQuestion() {
  const s = dictState;
  if (s.currentIdx >= s.shuffled.length) {
    dictShowSummary();
    return;
  }

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
  <div class="dict-chinese">${escapeHTML(word.chinese)}</div>
  <div class="dict-hint" id="dict-hint"></div>
  <div class="dict-input-row">
    <input type="text" class="dict-answer-input" id="dict-answer" autocomplete="off" autocapitalize="none" spellcheck="false" autofocus>
  </div>
  <div class="dict-prev-wrong" id="dict-prev-wrong"></div>
  <div class="dict-feedback" id="dict-feedback"></div>
  <div class="dict-reveal" id="dict-reveal"></div>
  <button class="dict-play-btn" id="dict-play-btn" style="display:none">🔊 再听一次</button>
</div>
  `;

  const answerInput = $('dict-answer');
  const feedbackEl = $('dict-feedback');
  const revealEl = $('dict-reveal');
  const hintEl = $('dict-hint');
  const playBtn = $('dict-play-btn');
  const prevWrongEl = $('dict-prev-wrong');

  setTimeout(() => answerInput.focus(), 100);

  answerInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;

    // After skip reveal, second Enter advances to next word
    if (awaitingNextEnter) {
      s.currentIdx++;
      dictShowQuestion();
      return;
    }

    const ans = answerInput.value.trim();

    // Empty enter behavior depends on mode
    if (!ans) {
      if (dictMode === 'skip') {
        // Skip mode: reveal answer, wait for another Enter (no countdown)
        answerInput.classList.add('wrong');
        feedbackEl.textContent = '⏩ 已显示答案，按回车继续';
        feedbackEl.className = 'dict-feedback wrong';
        revealEl.textContent = word.english;
        playBtn.style.display = '';
        answerInput.readOnly = true;
        if (s.isFirstTry) {
          s.incorrectWords.push(word);
          s.isFirstTry = false;
        }
        currentTrace.skipped = true;
        currentTrace.firstTryOK = false;
        currentTrace.totalMs = Date.now() - wordStartTime;
        s.attempts.push(currentTrace);
        dictPlayTTS(word.english);
        awaitingNextEnter = true;
      } else {
        // Strict mode: reveal answer but require typing it
        feedbackEl.textContent = '❌ 请输入单词';
        feedbackEl.className = 'dict-feedback wrong';
        revealEl.textContent = word.english;
        hintEl.textContent = '请照着打一遍以继续';
        playBtn.style.display = '';
        if (s.isFirstTry) {
          s.incorrectWords.push(word);
          s.isFirstTry = false;
        }
        // Count the empty-enter as an explicit peek attempt so data stays consistent
        const peekNow = Date.now();
        currentTrace.attempts.push('');
        currentTrace.attemptMs.push(peekNow - lastAttemptTime);
        lastAttemptTime = peekNow;
        currentTrace.errorCount++;
        peeked = true;
        dictPlayTTS(word.english);
      }
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
      feedbackEl.textContent = '✅ 回答正确！';
      feedbackEl.className = 'dict-feedback correct';
      revealEl.textContent = `${word.english} : ${word.chinese}`;
      playBtn.style.display = '';
      answerInput.disabled = true;

      if (s.isFirstTry) {
        s.correctWords.push(word);
      }

      const correctNow = Date.now();
      currentTrace.attempts.push(ans);
      currentTrace.attemptMs.push(correctNow - lastAttemptTime);
      currentTrace.firstTryOK = (currentTrace.errorCount === 0);
      currentTrace.totalMs = correctNow - wordStartTime;
      s.attempts.push(currentTrace);

      // Play TTS
      dictPlayTTS(word.english);

      // Auto-advance after 1.5s
      setTimeout(() => {
        s.currentIdx++;
        dictShowQuestion();
      }, 1500);
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

function dictDownloadCSV(words, filename) {
  const csv = dictWordsToCSV(words);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Summary Screen ----
function dictShowSummary() {
  const s = dictState;
  const practiced = s.correctWords.length + s.incorrectWords.length;

  // Persist the per-word attempts to the server (fire-and-forget)
  saveTrace();

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
    correctHTML = `<h4>🌟 一次拼对 (${s.correctWords.length})</h4>`;
    for (const w of s.correctWords) {
      correctHTML += `<div class="dict-word-item"><span class="dict-word-en">${escapeHTML(w.english)}</span><span class="dict-word-zh">${escapeHTML(w.chinese)}</span></div>`;
    }
  }

  let incorrectHTML = '';
  if (s.incorrectWords.length > 0) {
    incorrectHTML = `<h4>⚠️ 需要重点复习 (${s.incorrectWords.length})</h4>`;
    for (const w of s.incorrectWords) {
      incorrectHTML += `<div class="dict-word-item"><span class="dict-word-en">${escapeHTML(w.english)}</span><span class="dict-word-zh">${escapeHTML(w.chinese)}</span></div>`;
    }
  }

  const perfectMsg = s.incorrectWords.length === 0
    ? '<div style="text-align:center;margin:8px 0;font-size:1em;color:#4ade80">🎉 完美通关！没有任何错题！</div>'
    : '';

  // CSV download buttons
  let csvBtns = '<div class="dict-csv-row">';
  if (s.correctWords.length > 0) {
    csvBtns += `<button class="dict-csv-btn" id="dict-dl-correct">⬇ 正确单词 CSV</button>`;
  }
  if (s.incorrectWords.length > 0) {
    csvBtns += `<button class="dict-csv-btn" id="dict-dl-incorrect">⬇ 错误单词 CSV</button>`;
  }
  csvBtns += '</div>';

  dictBody.innerHTML = `
<div class="dict-summary">
  <h3 class="dict-summary-title">听写总结 · ${escapeHTML(s.dayName)}</h3>
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
  <div class="dict-word-list">
    ${incorrectHTML}
    ${correctHTML}
  </div>
  ${csvBtns}
  <div style="text-align:center;margin-top:12px">
    <button class="dict-start-btn" id="dict-retry">再来一次</button>
  </div>
</div>
  `;

  // Bind CSV download buttons
  const dlCorrect = $('dict-dl-correct');
  const dlIncorrect = $('dict-dl-incorrect');
  if (dlCorrect) {
    dlCorrect.addEventListener('click', () => {
      dictDownloadCSV(s.correctWords, `${s.dayName}_correct.csv`);
    });
  }
  if (dlIncorrect) {
    dlIncorrect.addEventListener('click', () => {
      dictDownloadCSV(s.incorrectWords, `${s.dayName}_incorrect.csv`);
    });
  }

  $('dict-retry').addEventListener('click', dictReset);
  $('dict-title').textContent = '听写模式';
}

function dictReset() {
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
  };
  $('dict-title').textContent = '听写模式';
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
//  Practice Traces (sidebar list + filters + delete)
// ========================================================
const traceStatus = $('trace-status');
const traceListEl = $('trace-list');
const traceRefreshBtn = $('trace-refresh');
const traceSelectedCount = $('trace-selected-count');
const traceOpenAIBtn = $('trace-open-ai');
const traceFilterBtns = document.querySelectorAll('.trace-filter-btn');

let traceItems = [];
let traceFilter = 'all';
const selectedTraceIds = new Set();

// Render any timestamp as YYYY-MM-DD HH:MM in UTC+8
function formatTraceTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const plus8 = new Date(d.getTime() + 8 * 3600 * 1000);
  const y = plus8.getUTCFullYear();
  const m = String(plus8.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(plus8.getUTCDate()).padStart(2, '0');
  const hh = String(plus8.getUTCHours()).padStart(2, '0');
  const mm = String(plus8.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${dd} ${hh}:${mm}`;
}

function todayYMDInPlus8() {
  const plus8 = new Date(Date.now() + 8 * 3600 * 1000);
  const y = plus8.getUTCFullYear();
  const m = String(plus8.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(plus8.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function applyFilter(items) {
  if (traceFilter === 'today') {
    const today = todayYMDInPlus8();
    return items.filter(t => formatTraceTime(t.timestamp).startsWith(today));
  }
  if (traceFilter === 'recent10') {
    return items.slice(0, 10);
  }
  return items;
}

function updateSelectedCount() {
  traceSelectedCount.textContent = `已选 ${selectedTraceIds.size} 条`;
  traceOpenAIBtn.disabled = selectedTraceIds.size === 0;
}

function renderTraceList() {
  const filtered = applyFilter(traceItems);

  if (!filtered.length) {
    const msg = traceItems.length
      ? '当前筛选下无记录'
      : '还没有练习记录';
    traceListEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--ink-soft);font-size:12px;">${msg}</div>`;
    updateSelectedCount();
    return;
  }

  traceListEl.innerHTML = '';
  for (const t of filtered) {
    const item = document.createElement('div');
    item.className = 'trace-item' + (selectedTraceIds.has(t.id) ? ' selected' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'trace-checkbox';
    cb.checked = selectedTraceIds.has(t.id);

    const info = document.createElement('div');
    info.className = 'trace-info';
    const modeLabel = t.mode === 'strict' ? '严格' : (t.mode === 'skip' ? '跳过' : t.mode || '?');
    info.innerHTML = `
      <div class="trace-day">${escapeHTML(t.dayName || '(unknown)')}</div>
      <div class="trace-meta">${escapeHTML(formatTraceTime(t.timestamp))} · ${escapeHTML(modeLabel)}</div>
      <div class="trace-stats">
        <span>共 ${t.total} 词</span> ·
        <span class="good">一遍过 ${t.firstTryCorrect}</span> ·
        <span class="bad">错 ${t.wrong}</span>
      </div>
    `;

    const delBtn = document.createElement('button');
    delBtn.className = 'trace-delete-btn';
    delBtn.textContent = '×';
    delBtn.title = '删除这条记录';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`确认删除「${t.dayName || t.id}」?`)) return;
      try {
        const res = await fetch(`${apiBase()}/trace/delete?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        selectedTraceIds.delete(t.id);
        traceItems = traceItems.filter(x => x.id !== t.id);
        traceStatus.textContent = `共 ${traceItems.length} 条记录`;
        renderTraceList();
      } catch (err) {
        flash(`删除失败：${err.message}`, true);
      }
    });

    const toggle = (e) => {
      if (e.target === delBtn || delBtn.contains(e.target)) return;
      if (e.target !== cb) cb.checked = !cb.checked;
      if (cb.checked) selectedTraceIds.add(t.id);
      else selectedTraceIds.delete(t.id);
      item.classList.toggle('selected', cb.checked);
      updateSelectedCount();
    };

    item.appendChild(cb);
    item.appendChild(info);
    item.appendChild(delBtn);
    item.addEventListener('click', toggle);
    traceListEl.appendChild(item);
  }
  updateSelectedCount();
}

async function refreshTraces() {
  traceStatus.textContent = '加载中...';
  try {
    const res = await fetch(`${apiBase()}/trace/list`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    traceItems = await res.json() || [];
    for (const id of [...selectedTraceIds]) {
      if (!traceItems.some(t => t.id === id)) selectedTraceIds.delete(id);
    }
    traceStatus.textContent = `共 ${traceItems.length} 条记录`;
    renderTraceList();
  } catch (err) {
    traceStatus.textContent = `❌ ${err.message}`;
  }
}

traceRefreshBtn.addEventListener('click', refreshTraces);

traceFilterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    traceFilterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    traceFilter = btn.dataset.filter;
    renderTraceList();
  });
});



// ========================================================
//  AI Panel (centered chat — single-shot, no context)
// ========================================================
const aiPanel = $('ai-panel');
const aiPanelClose = $('ai-panel-close');
const aiPanelMeta = $('ai-panel-meta');
const aiEmpty = $('ai-empty');
const aiUserMsg = $('ai-user-msg');
const aiBotMsg = $('ai-bot-msg');
const aiInput = $('ai-input');
const aiSend = $('ai-send');

function openAIPanel() {
  const ids = [...selectedTraceIds];
  if (!ids.length) {
    flash('请先勾选至少一条记录', true);
    return;
  }
  aiPanelMeta.textContent = `已选 ${ids.length} 条记录`;
  aiEmpty.classList.remove('hidden');
  aiUserMsg.classList.add('hidden');
  aiBotMsg.classList.add('hidden');
  aiInput.value = '';
  aiPanel.classList.remove('hidden');
  statusEl.style.display = 'none';
  contentEl.style.display = 'none';
  setTimeout(() => aiInput.focus(), 50);
}

function closeAIPanel() {
  aiPanel.classList.add('hidden');
  // Restore previous display (status only shows when no content)
  statusEl.style.display = '';
  contentEl.style.display = '';
}

aiPanelClose.addEventListener('click', closeAIPanel);
traceOpenAIBtn.addEventListener('click', openAIPanel);

async function aiSendQuestion() {
  const ids = [...selectedTraceIds];
  if (!ids.length) {
    flash('请先在左侧勾选记录', true);
    return;
  }
  const question = aiInput.value.trim();

  aiEmpty.classList.add('hidden');
  aiUserMsg.textContent = question || '(使用默认分析提示)';
  aiUserMsg.classList.remove('hidden');
  aiBotMsg.textContent = '正在思考...';
  aiBotMsg.classList.remove('hidden');
  aiBotMsg.classList.add('loading');
  aiSend.disabled = true;

  try {
    const res = await fetch(`${apiBase()}/trace/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, question }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(body || `HTTP ${res.status}`);
    const data = JSON.parse(body);
    aiBotMsg.textContent = data.answer || '(空回复)';
    aiBotMsg.classList.remove('loading');
  } catch (err) {
    aiBotMsg.textContent = `❌ ${err.message}`;
    aiBotMsg.classList.remove('loading');
  } finally {
    aiSend.disabled = false;
    aiInput.value = '';
  }
}

aiSend.addEventListener('click', aiSendQuestion);
aiInput.addEventListener('keydown', (e) => {
  // Cmd/Ctrl+Enter to send
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    aiSendQuestion();
  }
});

// Save the current session as a trace record (called from summary)
async function saveTrace() {
  if (!dictState.attempts || !dictState.attempts.length) return;
  const total = dictState.attempts.length;
  let firstTryCorrect = 0, wrong = 0;
  for (const a of dictState.attempts) {
    if (a.firstTryOK) firstTryCorrect++;
    else wrong++;
  }
  // ISO with explicit +08:00
  const now = new Date();
  const plus8 = new Date(now.getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${plus8.getUTCFullYear()}-${pad(plus8.getUTCMonth() + 1)}-${pad(plus8.getUTCDate())}` +
    `T${pad(plus8.getUTCHours())}:${pad(plus8.getUTCMinutes())}:${pad(plus8.getUTCSeconds())}+08:00`;
  const payload = {
    timestamp: ts,
    dayName: dictState.dayName,
    mode: dictMode,
    words: dictState.attempts,
    total,
    firstTryCorrect,
    wrong,
  };
  try {
    await fetch(`${apiBase()}/trace/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('trace save failed:', err);
  }
}

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

