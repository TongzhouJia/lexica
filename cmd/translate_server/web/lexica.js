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
const recentBtn = $('recent-btn');
const recentMenu = $('recent-menu');

let gcsFiles = [];
let activeGCSName = '';
let openGCSFolders = new Set(JSON.parse(localStorage.getItem('lexica.gcs.openFolders') || '[]'));

loadBtn.addEventListener('click', () => fileInput.click());
gcsRefreshBtn.addEventListener('click', refreshGCSFiles);

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
    const item = document.createElement('button');
    item.className = 'recent-item';
    item.title = name;
    item.innerHTML =
      `<span class="recent-name">${escapeHTML(baseName(name))}</span>` +
      `<span class="recent-path">${escapeHTML(dirName(name) || '/')}</span>`;
    item.addEventListener('click', () => { toggleRecentMenu(false); openGCSFile(name); });
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
    recordRecentFile(name);
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
const tabLoop = $('tab-loop');
const tabTasks = $('tab-tasks');
const tabTraces = $('tab-traces');
const tabCleaner = $('tab-cleaner');
const tabActivity = $('tab-activity');
const sidebarFiles = $('sidebar-files');
const sidebarDictInfo = $('sidebar-dict-info');
const sidebarLearnInfo = $('sidebar-learn-info');
const sidebarRecogInfo = $('sidebar-recog-info');
const sidebarLoop = $('sidebar-loop');
const sidebarTasks = $('sidebar-tasks');
const sidebarTraces = $('sidebar-traces');
const sidebarCleaner = $('sidebar-cleaner');
const sidebarActivity = $('sidebar-activity');
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
  [tabFiles, tabDictStrict, tabDictAdvanced, tabDictUltimate, tabLearn, tabRecog, tabLoop, tabTasks, tabTraces, tabCleaner, tabActivity].forEach(t => t.classList.remove('active'));
  if (tab) tab.classList.add('active');
}

function showSidebarContent(which) {
  sidebarFiles.classList.toggle('hidden', which !== 'files');
  sidebarDictInfo.classList.toggle('hidden', which !== 'dict');
  sidebarLearnInfo.classList.toggle('hidden', which !== 'learn');
  sidebarRecogInfo.classList.toggle('hidden', which !== 'recog');
  sidebarLoop.classList.toggle('hidden', which !== 'loop');
  sidebarTasks.classList.toggle('hidden', which !== 'tasks');
  sidebarTraces.classList.toggle('hidden', which !== 'traces');
  sidebarCleaner.classList.toggle('hidden', which !== 'cleaner');
  sidebarActivity.classList.toggle('hidden', which !== 'activity');
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
tabLoop.addEventListener('click', () => {
  setActiveTab(tabLoop);
  showSidebarContent('loop');
  dictPanel.classList.remove('visible');
});
tabTasks.addEventListener('click', () => {
  setActiveTab(tabTasks);
  showSidebarContent('tasks');
  dictPanel.classList.remove('visible');
  refreshTasks();
});
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
  $('learn-title').textContent = '学习新词';
  if (!learnState.words.length) {
    learnShowSetup();
  }
}

// ---- Learn Setup Screen ----
function learnShowSetup() {
  learnBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">学哪一天？</div>
  <div class="dict-day-grid" id="learn-day-grid"></div>
  <div class="setup-aux-row">
    <button class="dict-back-btn" id="learn-custom-btn">📂 自定义路径</button>
    <button class="dict-back-btn" id="learn-paste-csv-btn">📋 粘贴 CSV</button>
    <button class="dict-back-btn" id="learn-history-btn">📜 历史会话</button>
  </div>
  <div class="dict-loading" id="learn-load-msg"></div>
</div>
  `;

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
  $('learn-history-btn').addEventListener('click', () => {
    showSessionHistoryScreen(learnBody, (s) => s.mode === 'learn', learnShowSetup);
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

  fireStat('recog_word');
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
  if (s.knownWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="learn-lp-known">🔗 循环链接·认识</button>`;
  if (s.unknownWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="learn-lp-unknown">🔗 循环链接·不认识</button>`;
  csvBtns += '</div><div class="dict-csv-row">';
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

  const lpKnown   = $('learn-lp-known');
  const lpUnknown = $('learn-lp-unknown');
  const cpKnown   = $('learn-cp-known');
  const cpUnknown = $('learn-cp-unknown');
  if (lpKnown)   lpKnown.addEventListener('click', () => dictCopyLoopURL(s.knownWords, '认识的'));
  if (lpUnknown) lpUnknown.addEventListener('click', () => dictCopyLoopURL(s.unknownWords, '不认识的'));
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

  saveSession({
    mode: 'learn',
    dayName: s.dayName,
    goodLabel: '认识',
    badLabel: '不认识',
    goodWords: s.knownWords,
    badWords: s.unknownWords,
  });
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
  $('recog-title').textContent = '认词模式';
  if (!recogState.words.length) {
    recogShowSetup();
  }
}

// ---- Session history screen (shared by recognition + dictation) ----
async function showSessionHistoryScreen(bodyEl, modeMatcher, onBack) {
  bodyEl.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">最近 10 次记录</div>
  <div class="session-list" id="session-list">加载中...</div>
  <button class="dict-back-btn" id="session-back">← 返回</button>
</div>
  `;
  bodyEl.querySelector('#session-back').addEventListener('click', onBack);
  const listEl = bodyEl.querySelector('#session-list');
  try {
    const res = await fetch(`${apiBase()}/session/list`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = await res.json();
    const filtered = modeMatcher ? items.filter(modeMatcher) : items;
    if (!filtered.length) {
      listEl.textContent = '暂无记录';
      return;
    }
    listEl.innerHTML = filtered.map(item => {
      const ts = String(item.timestamp || '').replace('T', ' ').replace(/\+.*$/, '');
      const idEnc = encodeURIComponent(item.id);
      const dlGood = item.goodCount > 0
        ? `<a class="dict-csv-btn" href="${apiBase()}/session/csv?id=${idEnc}&kind=good" download>⬇ ${escapeHTML(item.goodLabel)} ${item.goodCount}</a>`
        : '';
      const dlBad = item.badCount > 0
        ? `<a class="dict-csv-btn" href="${apiBase()}/session/csv?id=${idEnc}&kind=bad" download>⬇ ${escapeHTML(item.badLabel)} ${item.badCount}</a>`
        : '';
      return `<div class="session-item">
  <div class="session-meta">
    <span class="session-time">${escapeHTML(ts)}</span>
    <span class="session-day">${escapeHTML(item.dayName || '')}</span>
  </div>
  <div class="dict-csv-row">${dlGood}${dlBad}</div>
</div>`;
    }).join('');
  } catch (err) {
    listEl.textContent = `❌ ${err.message}`;
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
  <div class="dict-setup-label">认哪一天？</div>
  <div class="dict-day-grid" id="recog-day-grid"></div>
  <div class="setup-aux-row">
    <button class="dict-back-btn" id="recog-custom-btn">📂 自定义路径</button>
    <button class="dict-back-btn" id="recog-paste-csv-btn">📋 粘贴 CSV</button>
    <button class="dict-back-btn" id="recog-history-btn">📜 历史会话</button>
  </div>
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

  $('recog-custom-btn').addEventListener('click', () => {
    showCustomPathScreen(recogBody, recogShowSetup, (words, label) => recogShowPortionPicker(words, label));
  });
  $('recog-paste-csv-btn').addEventListener('click', () => {
    showPasteCSVScreen(recogBody, recogShowSetup, (words, label) => recogShowPortionPicker(words, label));
  });
  $('recog-history-btn').addEventListener('click', () => {
    showSessionHistoryScreen(recogBody, (s) => s.mode === 'recognition', recogShowSetup);
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

  fireStat('recog_word');
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

  // CSV buttons: row 1 = copy a self-contained /loop URL, row 2 = copy CSV text
  let csvBtns = '<div class="dict-csv-row">';
  if (s.knownWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="recog-lp-known">🔗 循环链接·认识</button>`;
  if (s.unknownWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="recog-lp-unknown">🔗 循环链接·不认识</button>`;
  csvBtns += '</div><div class="dict-csv-row">';
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

  const lpKnown   = $('recog-lp-known');
  const lpUnknown = $('recog-lp-unknown');
  const cpKnown   = $('recog-cp-known');
  const cpUnknown = $('recog-cp-unknown');
  if (lpKnown)   lpKnown.addEventListener('click', () => dictCopyLoopURL(s.knownWords, '认识的'));
  if (lpUnknown) lpUnknown.addEventListener('click', () => dictCopyLoopURL(s.unknownWords, '不认识的'));
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

  saveSession({
    mode: 'recognition',
    dayName: s.dayName,
    goodLabel: '认识',
    badLabel: '不认识',
    goodWords: s.knownWords,
    badWords: s.unknownWords,
  });
}

function recogReset() {
  recogState = { words: [], shuffled: [], currentIdx: 0, knownWords: [], unknownWords: [], dayName: '', allWords: [], baseDayName: '' };
  $('recog-title').textContent = '认词模式';
  recogShowSetup();
}

async function saveSession(payload) {
  if (!payload.goodWords.length && !payload.badWords.length) return;
  try {
    await fetch(`${apiBase()}/session/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('session save failed:', err);
  }
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

// ---- Setup Screen ----
function dictShowSetup() {
  dictBody.innerHTML = `
<div class="dict-setup">
  <div class="dict-setup-label">听写哪一天？</div>
  <div class="dict-day-grid" id="dict-day-grid"></div>
  <div class="setup-aux-row">
    <button class="dict-back-btn" id="dict-custom-btn">📂 自定义路径</button>
    <button class="dict-back-btn" id="dict-paste-csv-btn">📋 粘贴 CSV</button>
    <button class="dict-back-btn" id="dict-history-btn">📜 历史会话</button>
  </div>
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

  $('dict-custom-btn').addEventListener('click', () => {
    showCustomPathScreen(dictBody, dictShowSetup, (words, label) => dictShowPortionPicker(words, label));
  });
  $('dict-paste-csv-btn').addEventListener('click', () => {
    showPasteCSVScreen(dictBody, dictShowSetup, (words, label) => dictShowPortionPicker(words, label));
  });
  $('dict-history-btn').addEventListener('click', () => {
    const modes = dictVariantMeta().histModes;
    showSessionHistoryScreen(dictBody, (s) => modes.includes(s.mode), dictShowSetup);
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
  fireStat('tts_play');
  return audio;
}

// Fire-and-forget daily counter bump
function fireStat(type, count) {
  try {
    fetch(`${apiBase()}/stats/inc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, count: count || 1 }),
      keepalive: true,
    }).catch(() => {});
  } catch (_) { /* silent */ }
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

  fireStat('dict_word');
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

    // Any non-empty, non-bye submission counts as one input
    fireStat('dict_input');

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

  fireStat('dict_word');
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
        fireStat('dict_input');
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

// Build a self-contained /loop URL with the CSV embedded in the hash and
// copy it to the clipboard. Paste it into any browser — the loop page reads
// the words straight from the URL, no server or localStorage needed.
async function dictCopyLoopURL(words, label) {
  if (!words || !words.length) {
    flash('没有可循环的单词', true);
    return;
  }
  let csv = dictWordsToCSV(words);
  if (csv.charCodeAt(0) === 0xFEFF) csv = csv.slice(1); // drop BOM for a cleaner URL
  const url = `${apiBase()}/loop#csv=${encodeURIComponent(csv)}`;
  try {
    await navigator.clipboard.writeText(url);
    flash(`已复制${label}循环链接（${words.length} 词），换浏览器粘贴即可`);
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

  // Persist the per-word attempts and a session record (fire-and-forget)
  saveTrace();
  saveSession({
    mode: meta.mode,
    dayName: s.dayName,
    goodLabel: meta.goodLabel,
    badLabel: meta.badLabel,
    goodWords: s.correctWords,
    badWords: s.incorrectWords,
  });

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

  // CSV buttons: row 1 = copy a self-contained /loop URL, row 2 = copy CSV text
  let csvBtns = '<div class="dict-csv-row">';
  if (s.correctWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="dict-lp-correct">🔗 循环链接·正确</button>`;
  if (s.incorrectWords.length > 0) csvBtns += `<button class="dict-csv-btn" id="dict-lp-incorrect">🔗 循环链接·错误</button>`;
  csvBtns += '</div><div class="dict-csv-row">';
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

  const lpCorrect = $('dict-lp-correct');
  const lpIncorrect = $('dict-lp-incorrect');
  const cpCorrect = $('dict-cp-correct');
  const cpIncorrect = $('dict-cp-incorrect');
  if (lpCorrect)   lpCorrect.addEventListener('click', () => dictCopyLoopURL(s.correctWords, '正确单词'));
  if (lpIncorrect) lpIncorrect.addEventListener('click', () => dictCopyLoopURL(s.incorrectWords, '错误单词'));
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
    mode: (DICT_VARIANTS[dictState.variant] || DICT_VARIANTS.basic).mode,
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


// ========================================================
//  Study Time Tracker — silent background timer
//  • Records "active" segments while the user interacts
//  • 60s of no activity → close the segment
//  • Heartbeat to backend every 30s so long sessions survive crashes
//  • Day boundary is midnight UTC+8 (handled server-side)
// ========================================================
(function setupStudyTimeTracker() {
  const IDLE_MS = 60 * 1000;
  const HEARTBEAT_MS = 30 * 1000;
  const THROTTLE_MS = 1000;

  let activeStart = null;
  let lastActivity = null;
  let idleTimer = null;
  let heartbeatTimer = null;
  let lastFire = 0;
  let paused = false;

  function postSegment(start, end, useBeacon) {
    if (!start || !end || end <= start) return;
    const body = JSON.stringify({ start, end });
    const url = `${apiBase()}/studytime/segment`;
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch (err) { /* silent */ }
  }

  function startSession() {
    activeStart = Date.now();
    lastActivity = activeStart;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (activeStart && lastActivity) postSegment(activeStart, lastActivity);
    }, HEARTBEAT_MS);
  }

  function stopSession(useBeacon) {
    if (!activeStart || !lastActivity) return;
    const start = activeStart;
    // Extend segment to cover the full idle window — any activity within 1 min
    // counts as continuous studying, so the idle cooldown is part of study time.
    const end = Math.min(lastActivity + IDLE_MS, Date.now());
    activeStart = null;
    lastActivity = null;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    postSegment(start, end, useBeacon);
  }

  function onActivity() {
    if (paused) return;
    const now = Date.now();
    if (now - lastFire < THROTTLE_MS) return;
    lastFire = now;

    lastActivity = now;
    if (!activeStart) startSession();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stopSession(false), IDLE_MS);
  }

  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, onActivity, { passive: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopSession(false);
  });
  window.addEventListener('beforeunload', () => stopSession(true));
  window.addEventListener('pagehide',     () => stopSession(true));

  window.lexicaStudyTracker = {
    pause() { paused = true; stopSession(false); },
    resume() { paused = false; onActivity(); },
  };

  // Kick off immediately — loading the page counts as activity
  onActivity();
})();

// ========================================================
//  Idle Reminder — nag email after 10 min of no activity
//  (only when the toggle is ON, a recipient email is set,
//   and the page is still open in the browser)
// ========================================================
(function setupIdleReminder() {
  const IDLE_REMINDER_MS = 10 * 60 * 1000;
  const THROTTLE_MS = 1000;
  let timer = null;
  let fired = false;
  let lastFire = 0;

  // Migrate old 'reminder-enabled' boolean key to new 'reminder-state'
  if (!localStorage.getItem('reminder-state') && localStorage.getItem('reminder-enabled') === 'false') {
    localStorage.setItem('reminder-state', 'resting');
  }

  // Public API for the bell + settings UI.
  // State: 'enabled' (on + timer), 'resting' (off + timer paused), 'elsewhere' (off + timer running)
  window.lexicaReminder = {
    getState: () => localStorage.getItem('reminder-state') || 'enabled',
    isEnabled() { return this.getState() === 'enabled'; },
    setState(state) {
      localStorage.setItem('reminder-state', state);
      if (state === 'enabled') {
        schedule();
        window.lexicaStudyTracker?.resume();
      } else if (state === 'resting') {
        cancel();
        window.lexicaStudyTracker?.pause();
      } else {
        cancel(); // elsewhere: stop reminders, keep timer running
      }
      window.dispatchEvent(new CustomEvent('lexica:reminder-changed'));
    },
    setEnabled(v) { this.setState(v ? 'enabled' : 'resting'); },
  };

  function schedule() {
    cancel();
    if (!window.lexicaReminder?.isEnabled()) return;
    fired = false;
    timer = setTimeout(trigger, IDLE_REMINDER_MS);
  }
  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }
  function trigger() {
    if (fired) return;
    if (!window.lexicaReminder?.isEnabled()) return;
    fired = true;
    try {
      fetch(`${apiBase()}/email/reminder`, {
        method: 'POST',
        keepalive: true,
      }).catch(() => {});
    } catch (_) { /* silent */ }
  }

  function bump() {
    const now = Date.now();
    if (now - lastFire < THROTTLE_MS) return;
    lastFire = now;
    schedule();
  }

  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, bump, { passive: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule();
  });
  // Closing or unloading the page → naturally stop nagging
  window.addEventListener('beforeunload', cancel);
  window.addEventListener('pagehide',     cancel);

  schedule();
})();

// ========================================================
//  Study Time Indicator — clock icon (top-right) + modal chart
// ========================================================
(function setupStudyTimeIndicator() {
  // --- Reminder bell button ---
  const bell = document.createElement('button');
  bell.id = 'reminder-bell-btn';
  bell.className = 'reminder-bell-btn';

  function updateBell() {
    const state = window.lexicaReminder.getState();
    if (state === 'enabled') {
      bell.innerHTML = '🔔';
      bell.title = '摸鱼提醒开启中 · 点击暂停';
      bell.classList.remove('off');
    } else if (state === 'resting') {
      bell.innerHTML = '🔕';
      bell.title = '休息中，不计时 · 点击恢复';
      bell.classList.add('off');
    } else {
      bell.innerHTML = '🔕';
      bell.title = '在别处学习，计时中 · 点击恢复';
      bell.classList.add('off');
    }
  }

  let bellDropdown = null;

  function closeBellDropdown() {
    if (bellDropdown) { bellDropdown.remove(); bellDropdown = null; }
  }

  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    const state = window.lexicaReminder.getState();
    if (state !== 'enabled') {
      closeBellDropdown();
      window.lexicaReminder.setState('enabled');
      return;
    }
    if (bellDropdown) { closeBellDropdown(); return; }

    bellDropdown = document.createElement('div');
    bellDropdown.className = 'reminder-dropdown';
    bellDropdown.innerHTML = `
      <button class="reminder-dropdown-opt" data-action="resting">☕ 休息了，暂停计时</button>
      <button class="reminder-dropdown-opt" data-action="elsewhere">📚 去别处学，继续计时</button>
    `;
    const r = bell.getBoundingClientRect();
    bellDropdown.style.top  = (r.bottom + 6) + 'px';
    bellDropdown.style.right = (window.innerWidth - r.right) + 'px';
    document.body.appendChild(bellDropdown);

    bellDropdown.querySelectorAll('.reminder-dropdown-opt').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        window.lexicaReminder.setState(btn.dataset.action);
        closeBellDropdown();
      });
    });

    setTimeout(() => document.addEventListener('click', closeBellDropdown, { once: true }), 0);
  });

  window.addEventListener('lexica:reminder-changed', () => { updateBell(); closeBellDropdown(); });
  updateBell();

  // --- Stats clock button ---
  const btn = document.createElement('button');
  btn.id = 'study-clock-btn';
  btn.className = 'study-clock-btn';
  btn.title = '今日学习统计';
  btn.setAttribute('aria-label', '今日学习统计');
  btn.innerHTML = '⏱';

  const ctrls = document.querySelector('header .controls');
  if (ctrls) {
    ctrls.appendChild(bell);
    ctrls.appendChild(btn);
  } else {
    document.body.appendChild(bell);
    document.body.appendChild(btn);
  }

  const modal = document.createElement('div');
  modal.id = 'study-modal';
  modal.className = 'study-modal hidden';
  modal.innerHTML = `
    <div class="study-modal-backdrop"></div>
    <div class="study-modal-card">
      <div class="study-modal-header">
        <h3 id="study-modal-title">今日学习统计</h3>
        <button class="study-modal-close" id="study-modal-close" title="关闭">✕</button>
      </div>
      <div class="study-modal-body" id="study-modal-body"></div>
    </div>
  `;
  document.body.appendChild(modal);

  function closeModal() { modal.classList.add('hidden'); }
  function openModal()  { modal.classList.remove('hidden'); }

  modal.querySelector('.study-modal-backdrop').addEventListener('click', closeModal);
  modal.querySelector('#study-modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });

  btn.addEventListener('click', async () => {
    openModal();
    const body = $('study-modal-body');
    body.innerHTML = '<div class="study-loading">加载中…</div>';
    try {
      const res = await fetch(`${apiBase()}/stats/today`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Normalize segments key (server returns studySegments)
      data.segments = data.studySegments || data.segments || [];
      data.totalMs = data.studyTimeMs || data.totalMs || 0;
      renderStudyModal(body, data);
    } catch (err) {
      body.innerHTML = `<div class="study-error">❌ ${escapeHTML(err.message || String(err))}</div>`;
    }
  });

  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtTime(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDuration(ms) {
    const totalMin = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${h} 小时 ${m} 分`;
    if (m > 0) return `${m} 分钟`;
    const sec = Math.max(0, Math.round(ms / 1000));
    return `${sec} 秒`;
  }

  // Midnight of `dateStr` (UTC+8 "YYYY-MM-DD") expressed in epoch ms
  function midnightUTC8MsFor(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 0, 0, 0) - 8 * 3600 * 1000;
  }

  function renderStudyModal(container, data) {
    const total = data.totalMs || 0;
    const segments = (data.segments || []).slice().sort((a, b) => a.start - b.start);
    const dateStr = data.date || '';
    const ttsPlays = data.ttsPlays || 0;
    const dictInputs = data.dictInputs || 0;
    const dictWords = data.dictWords || 0;
    const recogWords = data.recogWords || 0;
    const cleanedWords = data.cleanedWords || 0;

    const settingsHTML = renderReminderSettings();

    const emptyState = segments.length === 0 && ttsPlays === 0 && dictInputs === 0
      && dictWords === 0 && recogWords === 0 && cleanedWords === 0;
    if (emptyState) {
      container.innerHTML = settingsHTML + `
        <div class="study-empty">
          <div class="study-empty-icon">📭</div>
          <div>今天还没有学习记录</div>
          <div class="study-empty-hint">操作页面就会自动计时，开始学习吧～</div>
        </div>`;
      bindReminderSettings(container);
      return;
    }

    const statsGrid = `
      <div class="study-stats-grid">
        <div class="study-stat-card">
          <div class="study-stat-card-icon">⏱</div>
          <div class="study-stat-card-num">${fmtDuration(total)}</div>
          <div class="study-stat-card-label">总学习时间</div>
        </div>
        <div class="study-stat-card">
          <div class="study-stat-card-icon">🧹</div>
          <div class="study-stat-card-num">${cleanedWords}</div>
          <div class="study-stat-card-label">学会单词</div>
        </div>
        <div class="study-stat-card">
          <div class="study-stat-card-icon">🔊</div>
          <div class="study-stat-card-num">${ttsPlays}</div>
          <div class="study-stat-card-label">听音频</div>
        </div>
        <div class="study-stat-card">
          <div class="study-stat-card-icon">⌨️</div>
          <div class="study-stat-card-num">${dictInputs}</div>
          <div class="study-stat-card-label">听写输入</div>
        </div>
        <div class="study-stat-card">
          <div class="study-stat-card-icon">✍️</div>
          <div class="study-stat-card-num">${dictWords}</div>
          <div class="study-stat-card-label">听写单词</div>
        </div>
        <div class="study-stat-card">
          <div class="study-stat-card-icon">👁️</div>
          <div class="study-stat-card-num">${recogWords}</div>
          <div class="study-stat-card-label">认词数量</div>
        </div>
      </div>
    `;

    let timelineHTML = '';
    if (segments.length > 0) {
      const todayStartMs = midnightUTC8MsFor(dateStr);
      const dayMs = 24 * 3600 * 1000;
      const first = segments[0].start;
      const last = segments[segments.length - 1].end;
      const longest = segments.reduce((m, s) => Math.max(m, s.end - s.start), 0);

      const svgW = 720;
      const svgH = 64;
      const padX = 28;
      const usableW = svgW - padX * 2;

      function xFor(ms) {
        const pct = Math.max(0, Math.min(1, (ms - todayStartMs) / dayMs));
        return padX + pct * usableW;
      }

      let segRects = '';
      for (const s of segments) {
        const x = xFor(s.start);
        const w = Math.max(2, xFor(s.end) - x);
        segRects += `<rect x="${x.toFixed(2)}" y="20" width="${w.toFixed(2)}" height="22" rx="3" fill="url(#study-grad)" />`;
      }

      let hourTicks = '';
      let hourLabels = '';
      for (let h = 0; h <= 24; h += 3) {
        const x = padX + (h / 24) * usableW;
        hourTicks += `<line x1="${x.toFixed(2)}" y1="42" x2="${x.toFixed(2)}" y2="48" stroke="rgba(255,255,255,0.25)" />`;
        hourLabels += `<text x="${x.toFixed(2)}" y="60" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.55)" font-family="JetBrains Mono, monospace">${pad(h)}</text>`;
      }

      const nowMs = Date.now();
      const inToday = nowMs >= todayStartMs && nowMs <= todayStartMs + dayMs;
      const nowX = xFor(nowMs);
      const nowMarker = inToday
        ? `<line x1="${nowX.toFixed(2)}" y1="14" x2="${nowX.toFixed(2)}" y2="46" stroke="#fbbf24" stroke-width="1.5" stroke-dasharray="3,2" />
           <text x="${nowX.toFixed(2)}" y="11" text-anchor="middle" font-size="9" fill="#fbbf24" font-family="JetBrains Mono, monospace">now</text>`
        : '';

      const segmentsList = segments.map((s) => {
        const dur = s.end - s.start;
        return `<div class="study-seg-row">
          <span class="study-seg-time">${fmtTime(s.start)} → ${fmtTime(s.end)}</span>
          <span class="study-seg-dur">${fmtDuration(dur)}</span>
        </div>`;
      }).join('');

      timelineHTML = `
        <div class="study-section-divider"></div>
        <div class="study-bracket">
          <span>🟢 ${fmtTime(first)} 首次活跃</span>
          <span class="study-bracket-sep">·</span>
          <span>🔚 ${fmtTime(last)} 最后活跃</span>
          <span class="study-bracket-sep">·</span>
          <span>📈 最长一段 ${fmtDuration(longest)}</span>
        </div>
        <svg class="study-chart" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="none">
          <defs>
            <linearGradient id="study-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="#a78bfa" />
              <stop offset="100%" stop-color="#60a5fa" />
            </linearGradient>
          </defs>
          <rect x="${padX}" y="24" width="${usableW}" height="14" rx="3" fill="rgba(255,255,255,0.05)" />
          ${segRects}
          ${hourTicks}
          ${hourLabels}
          ${nowMarker}
        </svg>
        <div class="study-chart-caption">24 小时时间轴（UTC+8）· 每个色块为一次活跃段</div>
        <div class="study-seg-list">${segmentsList}</div>
      `;
    }

    container.innerHTML = settingsHTML + statsGrid + timelineHTML;
    bindReminderSettings(container);
  }

  function renderReminderSettings() {
    const enabled = window.lexicaReminder.isEnabled();
    return `
      <div class="reminder-settings">
        <div class="reminder-settings-row">
          <label class="reminder-toggle">
            <input type="checkbox" id="reminder-enabled-input" ${enabled ? 'checked' : ''}>
            <span class="reminder-toggle-track"></span>
            <span class="reminder-toggle-label">🔔 摸鱼提醒</span>
          </label>
          <span class="reminder-settings-hint">10 分钟没动作就给我自己发邮件</span>
        </div>
        <div class="reminder-settings-status" id="reminder-settings-status"></div>
      </div>
    `;
  }

  function bindReminderSettings(container) {
    const toggleInput = container.querySelector('#reminder-enabled-input');
    const statusEl = container.querySelector('#reminder-settings-status');
    if (!toggleInput) return;
    toggleInput.addEventListener('change', () => {
      window.lexicaReminder.setEnabled(toggleInput.checked);
      if (statusEl) {
        statusEl.textContent = toggleInput.checked ? '✅ 提醒已开启' : '🛑 提醒已关闭';
        statusEl.className = 'reminder-settings-status ' + (toggleInput.checked ? 'ok' : 'off');
      }
    });
  }
})();


// ========================================================
//  Sunrise / Sunset Wallpaper — ECharts-powered background board
//  Sun trajectory from civil dawn → dusk (so we get a bit of
//  pre-dawn and post-sunset), colored phase bands at the bottom,
//  and today's study segments overlaid on their own contrast strip.
// ========================================================
(function setupSunWallpaper() {
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
        <span class="sun-wallpaper-total" id="sun-wallpaper-total"></span>
        <span class="sun-wallpaper-hint">选中文字即朗读 · 翻译自动弹出 · 支持 txt · csv · md · pdf · docx · epub</span>
      </div>
    </div>
  `;

  const chartEl = $('sun-wallpaper-chart');
  const dateEl  = $('sun-wallpaper-date');
  const statEl  = $('sun-wallpaper-status');
  const totalEl = $('sun-wallpaper-total');

  const chart = echarts.init(chartEl, null, { renderer: 'canvas' });
  window.addEventListener('resize', () => chart.resize());

  let sunData = null;
  let statsData = null;
  let rerenderTimer = null;

  async function load() {
    try {
      const [sunRes, statsRes] = await Promise.all([
        fetch(`${apiBase()}/sun/today`),
        fetch(`${apiBase()}/stats/today`).catch(() => null),
      ]);
      if (sunRes && sunRes.ok) sunData = await sunRes.json();
      if (statsRes && statsRes.ok) statsData = await statsRes.json();
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

    const totalMs  = statsData ? (statsData.studyTimeMs || 0) : 0;
    const segCount = statsData ? (statsData.studySegments || []).length : 0;
    if (totalMs > 0) {
      totalEl.innerHTML = `今日学习累计 <strong>${fmtMinutes(totalMs)}</strong>` +
        (segCount ? ` · ${segCount} 段` : '');
    } else {
      totalEl.textContent = '';
    }

    const segments = (statsData && statsData.studySegments) || [];

    // Y-axis layout: arc peak at y=1, but we open the scale up to y=3 so the
    // arc only takes the upper third → looks short and flat, leaving plenty
    // of space below for the phase bands and study strip.
    const Y_MIN = -0.55;
    const Y_MAX = 3.0;
    // Y-band for phase color strip and study segments (below horizon)
    const STUDY_Y_TOP = -0.18;
    const STUDY_Y_BOT = -0.46;

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
              [{ xAxis: todayStartMs, yAxis: STUDY_Y_BOT,
                 itemStyle: { color: 'rgba(11,16,41,0.55)' } },
               { xAxis: dawnMs,       yAxis: STUDY_Y_TOP }],
              // Civil dawn
              [{ xAxis: dawnMs,    yAxis: STUDY_Y_BOT,
                 itemStyle: { color: 'rgba(76,29,149,0.55)' } },
               { xAxis: sunriseMs, yAxis: STUDY_Y_TOP }],
              // Golden morning
              [{ xAxis: sunriseMs,       yAxis: STUDY_Y_BOT,
                 itemStyle: { color: 'rgba(251,146,60,0.55)' } },
               { xAxis: goldenMorningMs, yAxis: STUDY_Y_TOP }],
              // Day
              [{ xAxis: goldenMorningMs, yAxis: STUDY_Y_BOT,
                 itemStyle: { color: 'rgba(125,211,252,0.45)' } },
               { xAxis: goldenEveningMs, yAxis: STUDY_Y_TOP }],
              // Golden evening
              [{ xAxis: goldenEveningMs, yAxis: STUDY_Y_BOT,
                 itemStyle: { color: 'rgba(249,115,22,0.55)' } },
               { xAxis: sunsetMs,        yAxis: STUDY_Y_TOP }],
              // Civil dusk
              [{ xAxis: sunsetMs, yAxis: STUDY_Y_BOT,
                 itemStyle: { color: 'rgba(124,45,18,0.55)' } },
               { xAxis: duskMs,   yAxis: STUDY_Y_TOP }],
              // Night again
              [{ xAxis: duskMs,      yAxis: STUDY_Y_BOT,
                 itemStyle: { color: 'rgba(11,16,41,0.55)' } },
               { xAxis: todayEndMs,  yAxis: STUDY_Y_TOP }]
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
        },
        // ---- Study segments with their own dark contrast strip ----
        {
          type: 'custom',
          z: 6,
          silent: true,
          renderItem: (params, api) => {
            const start = api.value(0);
            const end   = api.value(1);
            const x0 = api.coord([start, 0])[0];
            const x1 = api.coord([end,   0])[0];
            // Sit just inside the phase band, with a hint of glow above it
            const y  = api.coord([start, STUDY_Y_TOP])[1] - 6;
            const w  = Math.max(2, x1 - x0);
            return {
              type: 'rect',
              shape: { x: x0, y, width: w, height: 12, r: 3 },
              style: {
                fill: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                  { offset: 0, color: '#e9d5ff' },
                  { offset: 1, color: '#bfdbfe' }
                ]),
                stroke: 'rgba(15,12,41,0.8)',
                lineWidth: 1,
                shadowBlur: 10,
                shadowColor: 'rgba(15,12,41,0.6)'
              }
            };
          },
          encode: { x: [0, 1] },
          data: segments.map(s => [s.start, s.end])
        }
      ]
    });

    if (rerenderTimer) clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(load, 60 * 1000);
  }

  setTimeout(() => chart.resize(), 50);
  load();
})();


// ========================================================
//  Google Tasks — My Tasks sidebar panel
//  Lists / creates / completes / edits / deletes tasks in the user's
//  default Google Tasks list ("My Tasks") via the backend OAuth proxy.
// ========================================================
const tasksAuthEl = $('tasks-auth');
const tasksMainEl = $('tasks-main');
const tasksListEl = $('tasks-list');
const tasksStatusEl = $('tasks-status');
const tasksNewInput = $('tasks-new-input');
const tasksAddBtn = $('tasks-add-btn');
const tasksRefreshBtn = $('tasks-refresh');

function setTasksStatus(msg, isError) {
  tasksStatusEl.textContent = msg || '';
  tasksStatusEl.style.color = isError ? 'var(--accent)' : '';
}

async function refreshTasks() {
  setTasksStatus('加载中...');
  // First check authorization
  let authorized = false;
  try {
    const res = await fetch(`${apiBase()}/tasks/status`);
    const data = await res.json();
    authorized = !!data.authorized;
  } catch (_) { /* treat as unauthorized */ }

  if (!authorized) {
    tasksAuthEl.classList.remove('hidden');
    tasksMainEl.classList.add('hidden');
    setTasksStatus('');
    return;
  }
  tasksAuthEl.classList.add('hidden');
  tasksMainEl.classList.remove('hidden');

  try {
    const res = await fetch(`${apiBase()}/tasks/list`);
    if (res.status === 401) {
      tasksAuthEl.classList.remove('hidden');
      tasksMainEl.classList.add('hidden');
      setTasksStatus('');
      return;
    }
    if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
    const data = await res.json();
    renderTasks(data.items || []);
  } catch (err) {
    setTasksStatus('加载失败: ' + err.message, true);
  }
}

function renderTasks(items) {
  // Incomplete first, then completed; preserve API order within each group.
  const active = items.filter(t => t.status !== 'completed');
  const done = items.filter(t => t.status === 'completed');
  const ordered = [...active, ...done];

  setTasksStatus(active.length ? `${active.length} 个待办` : (items.length ? '全部完成 🎉' : ''));

  tasksListEl.innerHTML = '';
  if (!ordered.length) {
    tasksListEl.innerHTML = '<div class="tasks-empty">还没有任务，上面加一个吧～</div>';
    return;
  }

  for (const t of ordered) {
    const item = document.createElement('div');
    item.className = 'task-item' + (t.status === 'completed' ? ' done' : '');

    const check = document.createElement('button');
    check.className = 'task-check';
    check.title = t.status === 'completed' ? '标记为未完成' : '标记为完成';
    check.textContent = '✓';
    check.addEventListener('click', () => toggleTask(t));

    const body = document.createElement('div');
    body.className = 'task-body';
    body.title = '点击编辑';
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = t.title || '(无标题)';
    body.appendChild(title);
    if (t.notes) {
      const notes = document.createElement('div');
      notes.className = 'task-notes';
      notes.textContent = t.notes;
      body.appendChild(notes);
    }
    body.addEventListener('click', () => editTask(t));

    const del = document.createElement('button');
    del.className = 'task-del';
    del.title = '删除';
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteTask(t); });

    item.append(check, body, del);
    tasksListEl.appendChild(item);
  }
}

async function addTask() {
  const title = tasksNewInput.value.trim();
  if (!title) return;
  tasksAddBtn.disabled = true;
  try {
    const res = await fetch(`${apiBase()}/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
    tasksNewInput.value = '';
    await refreshTasks();
  } catch (err) {
    flash('添加失败: ' + err.message, true);
  } finally {
    tasksAddBtn.disabled = false;
  }
}

async function toggleTask(t) {
  const next = t.status === 'completed' ? 'needsAction' : 'completed';
  try {
    const res = await fetch(`${apiBase()}/tasks/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: t.id, status: next }),
    });
    if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
    await refreshTasks();
  } catch (err) {
    flash('更新失败: ' + err.message, true);
  }
}

async function editTask(t) {
  const next = prompt('编辑任务：', t.title || '');
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === t.title) return;
  try {
    const res = await fetch(`${apiBase()}/tasks/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: t.id, title: trimmed }),
    });
    if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
    await refreshTasks();
  } catch (err) {
    flash('修改失败: ' + err.message, true);
  }
}

async function deleteTask(t) {
  if (!confirm(`删除任务「${t.title || t.id}」?`)) return;
  try {
    const res = await fetch(`${apiBase()}/tasks/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: t.id }),
    });
    if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
    await refreshTasks();
  } catch (err) {
    flash('删除失败: ' + err.message, true);
  }
}

tasksRefreshBtn.addEventListener('click', refreshTasks);
tasksAddBtn.addEventListener('click', addTask);
tasksNewInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addTask(); }
});

