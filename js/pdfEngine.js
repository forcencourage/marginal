// PDF rendering engine (pdf.js). Exposes the same "shape" the EPUB reader
// needs: display / next / prev / highlights / search / toc / zoom.

const CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
const SIDE_PAD = 24;
const MAX_FIT_WIDTH = 920;
const MAX_DPR = 2;
const TOP_OFFSET = 12; // gap kept above a page when scrolling to it

export async function createPdfEngine({
  container, data, initialZoom = 1,
  onLocation, onSelection, onHighlightClick,
}) {
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = `${CDN}pdf.worker.min.js`;
  const doc = await pdfjs.getDocument({ data }).promise;
  const numPages = doc.numPages;

  const root = document.createElement('div');
  root.className = 'pdf-scroller';
  root.tabIndex = 0;
  const stack = document.createElement('div');
  stack.className = 'pdf-stack';
  root.appendChild(stack);
  container.appendChild(root);

  const proxies = new Array(numPages + 1);
  const pages = new Array(numPages + 1); // 1-based
  const textCache = new Map();
  const highlights = new Map();          // loc -> { row, byPage: Map(page -> rects) }
  const matchesByPage = new Map();       // page -> Set(match)
  let zoom = initialZoom;
  let scale = 1;
  let lastLoc = '';

  // ---- Page sizes (fetched up front so scroll positions are stable) -------
  for (let start = 1; start <= numPages; start += 40) {
    const batch = [];
    for (let n = start; n < Math.min(start + 40, numPages + 1); n++) {
      batch.push(doc.getPage(n).then((pg) => {
        proxies[n] = pg;
        const v = pg.getViewport({ scale: 1 });
        const el = document.createElement('div');
        el.className = 'pdf-page';
        el.dataset.page = n;
        const hlLayer = document.createElement('div');
        hlLayer.className = 'pdf-hl-layer';
        const textLayer = document.createElement('div');
        textLayer.className = 'textLayer';
        el.append(hlLayer, textLayer);
        pages[n] = { num: n, w: v.width, h: v.height, el, hlLayer, textLayer,
                     rendered: false, promise: null, task: null, token: 0,
                     textDivs: null, items: null };
      }));
    }
    await Promise.all(batch);
  }
  for (let n = 1; n <= numPages; n++) stack.appendChild(pages[n].el);

  // ---- Layout & lazy rendering --------------------------------------------
  function computeScale() {
    const avail = Math.min(root.clientWidth - SIDE_PAD * 2, MAX_FIT_WIDTH);
    return Math.max(0.2, avail / pages[1].w) * zoom;
  }

  function layout() {
    scale = computeScale();
    for (let n = 1; n <= numPages; n++) {
      const p = pages[n];
      unload(p);
      p.el.style.width = `${Math.floor(p.w * scale)}px`;
      p.el.style.height = `${Math.floor(p.h * scale)}px`;
      p.el.style.setProperty('--scale-factor', scale);
    }
  }

  function unload(p) {
    p.token++;
    try { p.task?.cancel(); } catch {}
    p.task = null;
    p.promise = null;
    const canvas = p.el.querySelector('canvas');
    if (canvas) { canvas.width = 0; canvas.remove(); }
    p.textLayer.textContent = '';
    p.textDivs = null;
    p.items = null;
    p.rendered = false;
    p.el.classList.remove('is-rendered');
  }

  function getTextContent(n) {
    if (!textCache.has(n)) textCache.set(n, proxies[n].getTextContent());
    return textCache.get(n);
  }

  function renderPage(p) {
    if (p.rendered) return Promise.resolve();
    if (p.promise) return p.promise;
    const token = p.token;
    p.promise = (async () => {
      try {
        const viewport = proxies[p.num].getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        p.task = proxies[p.num].render({
          canvasContext: canvas.getContext('2d'),
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        });
        await p.task.promise;
        if (token !== p.token) return;
        p.el.prepend(canvas);

        const textContent = await getTextContent(p.num);
        if (token !== p.token) return;
        const textDivs = [];
        p.textLayer.textContent = '';
        await pdfjs.renderTextLayer({
          textContentSource: textContent, container: p.textLayer, viewport, textDivs,
        }).promise;
        if (token !== p.token) return;

        p.textDivs = textDivs;
        p.items = textContent.items;
        p.rendered = true;
        p.el.classList.add('is-rendered');
        drawOverlays(p);
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') console.warn('PDF page render failed', p.num, err);
      } finally {
        if (p.token === token) p.promise = null;
      }
    })();
    return p.promise;
  }

  function updateVisible() {
    const vh = root.clientHeight, top = root.scrollTop;
    const near0 = top - vh, near1 = top + vh * 2;
    const far0 = top - vh * 3, far1 = top + vh * 4;
    for (let n = 1; n <= numPages; n++) {
      const p = pages[n];
      const y0 = p.el.offsetTop, y1 = y0 + p.el.offsetHeight;
      if (y1 >= near0 && y0 <= near1) renderPage(p);
      else if ((y1 < far0 || y0 > far1) && (p.rendered || p.promise)) unload(p);
    }
  }

  // ---- Position ------------------------------------------------------------
  function currentPosition() {
    const anchor = root.scrollTop + TOP_OFFSET;
    let cur = pages[1];
    for (let n = 1; n <= numPages; n++) {
      if (pages[n].el.offsetTop <= anchor) cur = pages[n]; else break;
    }
    const frac = Math.min(1, Math.max(0, (anchor - cur.el.offsetTop) / cur.el.offsetHeight));
    return { page: cur.num, frac };
  }

  function emitLocation() {
    const { page, frac } = currentPosition();
    const cfi = `pdf:${page}:${frac.toFixed(3)}`;
    if (cfi === lastLoc) return;
    lastLoc = cfi;
    onLocation?.({ cfi, page, numPages, percent: Math.round(((page - 1 + frac) / numPages) * 100) });
  }

  function scrollToPage(n, frac = 0, smooth = false) {
    const p = pages[Math.min(numPages, Math.max(1, n))];
    const top = p.el.offsetTop + frac * p.el.offsetHeight - TOP_OFFSET;
    root.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  function display(loc, { smooth = false } = {}) {
    const m = /^pdf:(\d+)(?::([\d.]+))?$/.exec(loc || '');
    if (!m) return false;
    scrollToPage(Number(m[1]), Number(m[2] || 0), smooth);
    return true;
  }

  function next() {
    const { page } = currentPosition();
    if (page < numPages) scrollToPage(page + 1, 0, true);
  }
  function prev() {
    const { page, frac } = currentPosition();
    scrollToPage(frac > 0.08 ? page : Math.max(1, page - 1), 0, true);
  }

  function relayout() {
    const pos = currentPosition();
    layout();
    scrollToPage(pos.page, pos.frac);
    updateVisible();
    emitLocation();
  }

  function setZoom(z) { zoom = z; relayout(); }

  // ---- Overlays (saved highlights + search hits) ---------------------------
  const dirty = new Set();
  let raf = 0;
  function scheduleOverlay(n) {
    if (!pages[n]) return;
    dirty.add(n);
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      for (const k of dirty) drawOverlays(pages[k]);
      dirty.clear();
    });
  }

  function rectEl(cls, [x, y, w, h], key) {
    const el = document.createElement('div');
    el.className = cls;
    el.style.cssText = `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%`;
    if (key) el._key = key;
    return el;
  }

  function drawOverlays(p) {
    p.hlLayer.textContent = '';
    const frag = document.createDocumentFragment();
    const set = matchesByPage.get(p.num);
    if (set) {
      for (const m of set) {
        if (!m.rects) computeMatchRects(p, m);
        for (const r of m.rects || []) frag.appendChild(rectEl(`pdf-search-hl${m.active ? ' active' : ''}`, r));
      }
    }
    for (const [key, h] of highlights) {
      const rects = h.byPage.get(p.num);
      if (rects) for (const r of rects) frag.appendChild(rectEl('pdf-hl', r, key));
    }
    p.hlLayer.appendChild(frag);
  }

  function addHighlight(loc, row) {
    let parsed;
    try { parsed = JSON.parse(loc); } catch { return; }
    if (!parsed?.parts) return;
    const byPage = new Map();
    for (const part of parsed.parts) if (pages[part.p]) byPage.set(part.p, part.r);
    const prev = highlights.get(loc);
    highlights.set(loc, { row, byPage });
    for (const n of new Set([...(prev?.byPage.keys() || []), ...byPage.keys()])) scheduleOverlay(n);
  }

  function removeHighlight(loc) {
    const h = highlights.get(loc);
    if (!h) return;
    highlights.delete(loc);
    for (const n of h.byPage.keys()) scheduleOverlay(n);
  }

  async function revealHighlight(loc) {
    const h = highlights.get(loc);
    if (!h) return;
    const [n] = h.byPage.keys();
    scrollToPage(n, Math.max(0, h.byPage.get(n)[0][1] - 0.12));
    await renderPage(pages[n]);
  }

  function flash(loc) {
    for (const el of root.querySelectorAll('.pdf-hl')) {
      if (el._key !== loc) continue;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 900);
    }
  }

  // ---- Rect helpers ---------------------------------------------------------
  function mergeRects(list) {
    const rects = list.map((r) => ({ x: r[0], y: r[1], w: r[2], h: r[3] }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const out = [];
    for (const r of rects) {
      const m = out.find((o) => {
        const overlapY = Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y);
        return overlapY > 0.5 * Math.min(o.h, r.h) && r.x <= o.x + o.w + 0.005 && r.x + r.w >= o.x - 0.005;
      });
      if (m) {
        const x0 = Math.min(m.x, r.x), y0 = Math.min(m.y, r.y);
        const x1 = Math.max(m.x + m.w, r.x + r.w), y1 = Math.max(m.y + m.h, r.y + r.h);
        Object.assign(m, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      } else out.push({ ...r });
    }
    return out.map((o) => [o.x, o.y, o.w, o.h]);
  }

  const toFractions = (r, box) => [
    (r.left - box.left) / box.width, (r.top - box.top) / box.height,
    r.width / box.width, r.height / box.height,
  ];

  // ---- Selection -> highlight location -------------------------------------
  function handleSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return;

    const boxes = pages.slice(1).filter((p) => p.rendered)
      .map((p) => ({ p, b: p.el.getBoundingClientRect() }));
    const per = new Map();
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = boxes.find(({ b }) => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom);
      if (!hit || r.height > hit.b.height * 0.08) continue; // skip container-sized boxes
      if (!per.has(hit.p.num)) per.set(hit.p.num, []);
      per.get(hit.p.num).push(toFractions(r, hit.b));
    }
    const parts = [...per].sort((a, b) => a[0] - b[0]).map(([p, rects]) => ({
      p, r: mergeRects(rects).map((q) => q.map((v) => +Math.min(1, Math.max(0, v)).toFixed(4))),
    }));
    if (!parts.length) return;
    onSelection?.({ loc: JSON.stringify({ v: 1, parts }), text });
  }

  root.addEventListener('mouseup', () => setTimeout(handleSelection, 0));
  root.addEventListener('touchend', () => setTimeout(handleSelection, 350));
  root.addEventListener('keyup', (e) => { if (e.shiftKey) handleSelection(); });

  root.addEventListener('click', (e) => {
    if (!window.getSelection()?.isCollapsed) return;
    const pageEl = e.target.closest?.('.pdf-page');
    if (!pageEl) return;
    const b = pageEl.getBoundingClientRect();
    const x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
    const n = Number(pageEl.dataset.page);
    const t = 0.003;
    for (const h of highlights.values()) {
      const rs = h.byPage.get(n);
      if (rs?.some(([rx, ry, rw, rh]) => x >= rx - t && x <= rx + rw + t && y >= ry - t && y <= ry + rh + t)) {
        if (h.row) onHighlightClick?.(h.row);
        return;
      }
    }
  });

  // ---- Search ---------------------------------------------------------------
  async function searchPage(n, regex, room, fold) {
    const { items } = await getTextContent(n);
    let hay = '';
    const mapI = [], mapO = [];
    for (let i = 0; i < items.length; i++) {
      const s = items[i].str || '';
      for (let k = 0; k < s.length; k++) {
        for (const c of fold(s[k])) { hay += c; mapI.push(i); mapO.push(k); }
      }
      if (items[i].hasEOL) { hay += ' '; mapI.push(-1); mapO.push(0); }
    }
    const out = [];
    regex.lastIndex = 0;
    let m;
    while (out.length < room && (m = regex.exec(hay))) {
      const a = m.index, b = m.index + m[0].length - 1;
      if (mapI[a] < 0 || mapI[b] < 0) continue;
      out.push({ cfi: `pdfm:${n}:${m.index}`, page: n,
                 a: [mapI[a], mapO[a]], b: [mapI[b], mapO[b] + 1], rects: null, active: false });
    }
    return out;
  }

  function computeMatchRects(p, m) {
    if (!p.textDivs) return; // not rendered yet — retried after render
    if (p.textDivs.length !== p.items.length) { m.rects = []; return; }
    const box = p.el.getBoundingClientRect();
    const range = document.createRange();
    const raw = [];
    for (let i = m.a[0]; i <= m.b[0]; i++) {
      const node = p.textDivs[i]?.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const s = i === m.a[0] ? m.a[1] : 0;
      const e = i === m.b[0] ? m.b[1] : node.length;
      range.setStart(node, Math.min(s, node.length));
      range.setEnd(node, Math.min(e, node.length));
      for (const r of range.getClientRects()) if (r.width > 0.5) raw.push(toFractions(r, box));
    }
    m.rects = mergeRects(raw);
  }

  function paintSearch(m, active) {
    m.active = active;
    let s = matchesByPage.get(m.page);
    if (!s) matchesByPage.set(m.page, (s = new Set()));
    s.add(m);
    scheduleOverlay(m.page);
  }

  function clearSearch() {
    const ns = [...matchesByPage.keys()];
    matchesByPage.clear();
    ns.forEach(scheduleOverlay);
  }

  async function revealMatch(m) {
    const p = pages[m.page];
    scrollToPage(m.page, 0);
    await renderPage(p);
    if (!m.rects) computeMatchRects(p, m);
    drawOverlays(p);
    const r = m.rects?.[0];
    if (r) {
      root.scrollTo({ top: Math.max(0, p.el.offsetTop + r[1] * p.el.offsetHeight - root.clientHeight * 0.35) });
    }
  }

  // ---- Table of contents ----------------------------------------------------
  async function getToc() {
    const outline = await doc.getOutline().catch(() => null);
    if (!outline) return [];
    async function pageOf(dest) {
      try {
        const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
        if (!Array.isArray(d)) return null;
        const ref = d[0];
        if (ref && typeof ref === 'object') return (await doc.getPageIndex(ref)) + 1;
        if (Number.isInteger(ref)) return ref + 1;
      } catch {}
      return null;
    }
    async function walk(nodes) {
      const out = [];
      for (const n of nodes) {
        const page = await pageOf(n.dest);
        out.push({ label: n.title || 'Untitled', href: page ? `pdf:${page}` : '', subitems: await walk(n.items || []) });
      }
      return out;
    }
    return walk(outline);
  }

  // ---- Boot -----------------------------------------------------------------
  let ticking = false;
  root.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; updateVisible(); emitLocation(); });
  }, { passive: true });

  let lastW = root.clientWidth, resizeTimer;
  new ResizeObserver(() => {
    const w = root.clientWidth;
    if (Math.abs(w - lastW) < 2) return;
    lastW = w;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 150);
  }).observe(root);

  layout();
  updateVisible();
  root.focus({ preventScroll: true });

  return {
    numPages, root, display, next, prev, setZoom, getToc,
    addHighlight, removeHighlight, revealHighlight, flash,
    searchPage, paintSearch, clearSearch, revealMatch,
    focus: () => root.focus({ preventScroll: true }),
    destroy: () => { doc.destroy(); root.remove(); },
  };
}