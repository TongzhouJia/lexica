//  Vocabulary Progress page — Sankey of a shrinking wordlist.
//  URL: /progress/<uuid> ; data persisted server-side via /progress/* API.

const $ = (id) => document.getElementById(id);
const apiBase = () => location.origin;

// The progress UUID lives in the last path segment: /progress/<uuid>
const PROGRESS_ID = decodeURIComponent(location.pathname.replace(/^\/progress\/?/, '').replace(/\/.*$/, ''));

let chart = null;
let currentDoc = null;

// ---------------------------------------------------------------------------
// CSV parsing (format: English,Chinese\n"word","翻译") → [{english, chinese}]
// ---------------------------------------------------------------------------
function parseCSVText(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const words = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0 && /^﻿?english/i.test(line)) continue; // skip header
    const quoted = line.match(/^"(.+?)"\s*,\s*"(.*?)"$/);
    if (quoted) {
      words.push({ english: quoted[1].replace(/""/g, '"'), chinese: quoted[2].replace(/""/g, '"') });
      continue;
    }
    const parts = line.split(',');
    if (parts.length >= 1 && parts[0].trim()) {
      words.push({ english: parts[0].replace(/"/g, '').trim(), chinese: parts.slice(1).join(',').replace(/"/g, '').trim() });
    }
  }
  return words;
}

// Normalise an english word for set-membership comparison.
const key = (w) => (w.english || '').trim().toLowerCase();

// Dedupe a round's words by english key, keeping first occurrence.
function dedupe(words) {
  const seen = new Set();
  const out = [];
  for (const w of words || []) {
    const k = key(w);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadDoc() {
  if (!PROGRESS_ID) {
    $('pg-id').textContent = '缺少进度 ID — 请从 Lexica 侧边栏的「进度」打开';
    return;
  }
  $('pg-id').textContent = PROGRESS_ID;
  try {
    const res = await fetch(`${apiBase()}/progress/get?id=${encodeURIComponent(PROGRESS_ID)}`);
    if (!res.ok) throw new Error('未找到该进度');
    currentDoc = await res.json();
    render();
  } catch (err) {
    $('pg-meta').textContent = '';
    $('pg-rounds').innerHTML = `<div class="pg-empty"><div class="pg-emoji">😕</div>${err.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Sankey model
//
// Each round is a set. Round 0 is the full set; later rounds are (meant to be)
// subsets. Between round i and i+1:
//   carried  — words present in both        → r{i} → r{i+1}
//   mastered — in round i but not in i+1     → r{i} → mastered{i}
//   added    — in round i+1 but not in i     → newcomers{i+1} → r{i+1}  (rare)
// ---------------------------------------------------------------------------
const CIRCLED = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮'];
const circ = (n) => CIRCLED[n] || `(${n + 1})`;

function buildSankey(rounds) {
  const sets = rounds.map(r => dedupe(r.words));
  const nodes = [];
  const links = [];
  const C = {
    round: getCSS('--accent') || '#B85C38',
    mastered: getCSS('--gcp') || '#2F6F63',
    added: getCSS('--accent-soft') || '#D89B7C',
  };

  sets.forEach((words, i) => {
    const name = i === 0 ? `${circ(0)} 全集·${words.length}` : `${circ(i)} 第${i + 1}轮·${words.length}`;
    nodes.push({ name, itemStyle: { color: C.round }, _words: words });
  });
  const roundName = (i) => nodes[i].name;

  for (let i = 0; i < sets.length - 1; i++) {
    const cur = sets[i];
    const nextKeys = new Set(sets[i + 1].map(key));
    const curKeys = new Set(cur.map(key));

    const carried = cur.filter(w => nextKeys.has(key(w)));
    const mastered = cur.filter(w => !nextKeys.has(key(w)));
    const added = sets[i + 1].filter(w => !curKeys.has(key(w)));

    if (carried.length) {
      links.push({ source: roundName(i), target: roundName(i + 1), value: carried.length, _words: carried, _kind: 'carried' });
    }
    if (mastered.length) {
      const mName = `✓ 掌握 ${circ(i)}·${mastered.length}`;
      nodes.push({ name: mName, itemStyle: { color: C.mastered }, _words: mastered });
      links.push({ source: roundName(i), target: mName, value: mastered.length, _words: mastered, _kind: 'mastered', lineStyle: { color: C.mastered } });
    }
    if (added.length) {
      const aName = `+ 新增 ${circ(i + 1)}·${added.length}`;
      nodes.push({ name: aName, itemStyle: { color: C.added }, _words: added });
      links.push({ source: aName, target: roundName(i + 1), value: added.length, _words: added, _kind: 'added', lineStyle: { color: C.added } });
    }
  }
  return { nodes, links };
}

function getCSS(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function wordsTooltip(words) {
  const max = 80;
  const shown = words.slice(0, max).map(w => `${esc(w.english)}`).join('、');
  const more = words.length > max ? ` …(共${words.length})` : '';
  return `<div style="max-width:360px;white-space:normal;line-height:1.6;font-family:'JetBrains Mono',monospace;font-size:12px">${shown}${more}</div>`;
}

function renderChart(rounds) {
  const el = $('pg-chart');
  if (!chart) chart = echarts.init(el, null, { renderer: 'svg' });
  if (!rounds.length) {
    chart.clear();
    return;
  }
  const { nodes, links } = buildSankey(rounds);
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: getCSS('--bg-elev') || '#fff',
      borderColor: getCSS('--rule') || '#ddd',
      textStyle: { color: getCSS('--ink') || '#222' },
      formatter: (p) => {
        const words = (p.data && p.data._words) || [];
        if (p.dataType === 'edge') {
          const label = { carried: '仍需复习', mastered: '已掌握', added: '新增' }[p.data._kind] || '';
          return `<b>${esc(p.data.source)} → ${esc(p.data.target)}</b><br>${label} · ${p.data.value} 词${words.length ? '<br>' + wordsTooltip(words) : ''}`;
        }
        return `<b>${esc(p.name)}</b>${words.length ? '<br>' + wordsTooltip(words) : ''}`;
      },
    },
    series: [{
      type: 'sankey',
      left: 24, right: 140, top: 24, bottom: 24,
      nodeWidth: 16,
      nodeGap: 14,
      draggable: false,
      emphasis: { focus: 'adjacency' },
      label: {
        color: getCSS('--ink') || '#222',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      },
      lineStyle: { color: 'gradient', opacity: 0.42, curveness: 0.5 },
      data: nodes,
      links,
    }],
  }, true);
}

// ---------------------------------------------------------------------------
// Rounds detail (every word, with mastered ones marked)
// ---------------------------------------------------------------------------
function renderRounds(rounds) {
  const host = $('pg-rounds');
  if (!rounds.length) {
    host.innerHTML = `<div class="pg-empty"><div class="pg-emoji">📋</div>还没有任何一轮。把听写/认词导出的 CSV 粘到上面，第一次粘的就是全集。</div>`;
    return;
  }
  const sets = rounds.map(r => dedupe(r.words));
  let html = '<div class="pg-subhead">各轮明细（✓ = 在下一轮消失 = 已掌握）</div>';
  sets.forEach((words, i) => {
    const nextKeys = i < sets.length - 1 ? new Set(sets[i + 1].map(key)) : null;
    const masteredCount = nextKeys ? words.filter(w => !nextKeys.has(key(w))).length : 0;
    const name = i === 0 ? `全集` : `第 ${i + 1} 轮`;
    const stat = nextKeys
      ? `${words.length} 词 · <span class="pg-mastered-tag">本轮后掌握 ${masteredCount}</span>`
      : `${words.length} 词 · 当前剩余`;
    const grid = words.map(w => {
      const mastered = nextKeys && !nextKeys.has(key(w));
      return `<div class="pg-word${mastered ? ' mastered' : ''}"><span class="en">${esc(w.english)}</span><span class="zh">${esc(w.chinese || '')}</span>${mastered ? '<span class="badge">✓掌握</span>' : ''}</div>`;
    }).join('');
    const when = rounds[i].pastedAt ? fmtTime(rounds[i].pastedAt) : '';
    html += `
<div class="pg-round" data-idx="${i}">
  <div class="pg-round-head" data-toggle="${i}">
    <span class="pg-round-name">${circ(i)} ${name}</span>
    <span class="pg-round-stat">${when} · ${stat}</span>
    <button class="pg-round-del" data-del="${i}">删除本轮</button>
  </div>
  <div class="pg-round-body"><div class="pg-wordgrid">${grid}</div></div>
</div>`;
  });
  host.innerHTML = html;

  host.querySelectorAll('.pg-round-head').forEach(h => {
    h.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) return;
      h.closest('.pg-round').classList.toggle('open');
    });
  });
  host.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(b.dataset.del, 10);
      if (!confirm(`删除「第 ${idx + 1} 轮」？此操作不可撤销。`)) return;
      await deleteRound(idx);
    });
  });
}

// ---------------------------------------------------------------------------
// Render everything
// ---------------------------------------------------------------------------
function render() {
  const rounds = (currentDoc && currentDoc.rounds) || [];
  const created = currentDoc && currentDoc.createdAt ? fmtTime(currentDoc.createdAt) : '';
  const total = rounds.length ? dedupe(rounds[0].words).length : 0;
  const remaining = rounds.length ? dedupe(rounds[rounds.length - 1].words).length : 0;
  $('pg-meta').innerHTML = `创建于 ${created}<br>${rounds.length} 轮 · 全集 ${total} → 剩余 ${remaining}`;
  renderChart(rounds);
  renderRounds(rounds);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function paste() {
  const raw = $('pg-input').value.trim();
  const msg = $('pg-msg');
  msg.classList.remove('error');
  if (!raw) { msg.textContent = '请先粘贴 CSV 内容'; return; }
  const words = parseCSVText(raw);
  if (!words.length) { msg.textContent = '没有解析出任何单词，请检查格式'; msg.classList.add('error'); return; }
  msg.textContent = '保存中…';
  try {
    const res = await fetch(`${apiBase()}/progress/paste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: PROGRESS_ID, words }),
    });
    if (!res.ok) throw new Error(await res.text() || '保存失败');
    currentDoc = await res.json();
    $('pg-input').value = '';
    msg.textContent = `✅ 已粘入第 ${currentDoc.rounds.length} 轮，共 ${dedupe(words).length} 词`;
    render();
  } catch (err) {
    msg.textContent = `❌ ${err.message}`;
    msg.classList.add('error');
  }
}

async function deleteRound(idx) {
  try {
    const res = await fetch(`${apiBase()}/progress/delete-round`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: PROGRESS_ID, index: idx }),
    });
    if (!res.ok) throw new Error(await res.text() || '删除失败');
    currentDoc = await res.json();
    render();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return iso; }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
$('pg-paste-btn').addEventListener('click', paste);
$('pg-input').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); paste(); }
});
window.addEventListener('resize', () => chart && chart.resize());
loadDoc();
