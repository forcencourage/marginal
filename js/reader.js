import {
  fetchBook,
  deleteBook,
  publicEpubUrl,
  fetchHighlights,
  insertHighlight,
  deleteHighlight,
  updateBookProgress,
  flushBookProgress,
} from './supabaseClient.js';
import { requireAuth } from './auth.js';

const HIGHLIGHT_FILL = '#a9dcf5';
const HIGHLIGHT_FILL_STRONG = '#7cc6ec';

const SEARCH_STYLE        = { fill: '#ffd93b', 'fill-opacity': '0.55', 'mix-blend-mode': 'multiply' };
const SEARCH_STYLE_ACTIVE = { fill: '#ffbf00', 'fill-opacity': '0.85', 'mix-blend-mode': 'multiply' };
const SEARCH_MIN_CHARS = 2;
const SEARCH_MAX_MATCHES = 2000;

const params = new URLSearchParams(window.location.search);
const bookId = params.get('id');

const titleEl = document.getElementById('book-title');
const authorEl = document.getElementById('book-author');
// const progressPill = document.getElementById('progress-pill');
const loadingEl = document.getElementById('reader-loading');
const deleteBtn = document.getElementById('delete-book');
const toast = document.getElementById('selection-toast');

const confirmBar = document.getElementById('confirm-bar');
const confirmText = document.getElementById('confirm-text');
const confirmSaveBtn = document.getElementById('confirm-save');
const confirmCancelBtn = document.getElementById('confirm-cancel');

const highlightList = document.getElementById('highlight-list');
const highlightEmpty = document.getElementById('highlight-empty');
const highlightCount = document.getElementById('highlight-count');

const panel = document.getElementById('highlights-panel');
const panelToggle = document.getElementById('panel-toggle');
const panelClose = document.getElementById('panel-close');
const panelScrim = document.getElementById('panel-scrim');

const tocToggle = document.getElementById('toc-toggle');
const tocClose = document.getElementById('toc-close');
const tocScrim = document.getElementById('toc-scrim');
const tocPanel = document.getElementById('toc-panel');
const tocList = document.getElementById('toc-list');
const tocEmpty = document.getElementById('toc-empty');

const searchToggle = document.getElementById('search-toggle');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const searchSpinner = document.getElementById('search-spinner');
const searchClear = document.getElementById('search-clear');
const searchPrev = document.getElementById('search-prev');
const searchNext = document.getElementById('search-next');
const searchClose = document.getElementById('search-close');

const REMOVE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

let bookRow = null;
let book = null;
let rendition = null;
let locationsReady = false;
let saveProgressTimer = null;
let pendingSelection = null; // { cfiRange, contents, text } awaiting user confirmation
let latestCfi = null;
let latestPercent = 0;

// Ranges of the user's saved highlights, so search hits never overwrite them.
const userHighlightCfis = new Set();

const search = {
  query: '',          // the query the current results belong to
  matches: [],        // [{ cfi, painted }] in reading order
  active: -1,         // index of the match the reader is "on"
  capped: false,
  busy: false,
  runId: 0,           // bumped on every new search so stale runs stop
  timer: null,
  jumpWhenDone: false,
};

if (!bookId) {
  window.location.href = 'index.html';
} else {
  init();
}

async function init() {

  const session = await requireAuth();
  if (!session) return;

  try {
    bookRow = await fetchBook(bookId);
  } catch (err) {
    console.error(err);
    titleEl.textContent = 'Book not found';
    loadingEl.classList.add('hidden');
    return;
  }

  titleEl.textContent = bookRow.title;
  authorEl.textContent = bookRow.author || 'Unknown author';
  document.title = `${bookRow.title} — Marginal`;

  bindHeaderControls();

  // Fetch the book file and the saved highlights in parallel, but only paint
  // highlights into the page once the rendition actually exists.
  const [, rows] = await Promise.all([openBook(), fetchHighlights(bookId).catch((err) => { console.error(err); return []; })]);
  renderHighlightList(rows);

  const hlParam = params.get('hl');
  if (hlParam) {
    const row = rows.find(r => String(r.id) === hlParam);
    const card = highlightList.querySelector(`.highlight-card[data-id="${hlParam}"]`);
    if (row && card) {
      await waitForNextPaint();
      goToHighlight(row.cfi_range, card);
    }
  }
}

// ---------------------------------------------------------------------------
// Header controls
// ---------------------------------------------------------------------------

function bindHeaderControls() {
  deleteBtn.addEventListener('click', async () => {
    const ok = confirm(`Delete "${bookRow.title}"? This also removes its highlights. This can't be undone.`);
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      await deleteBook(bookRow);
      window.location.href = 'index.html';
    } catch (err) {
      console.error(err);
      alert('Could not delete the book. See console for details.');
      deleteBtn.disabled = false;
    }
  });

  panelToggle.addEventListener('click', () => {
    closeTocPanel();
    openPanel();
  });
  panelScrim.addEventListener('click', closePanel);
  panelClose.addEventListener('click', closePanel);

  tocToggle.addEventListener('click', () => {
    closePanel();
    openTocPanel();
  });
  tocClose.addEventListener('click', closeTocPanel);
  tocScrim.addEventListener('click', closeTocPanel);

  confirmSaveBtn.addEventListener('click', confirmPendingHighlight);
  confirmCancelBtn.addEventListener('click', cancelPendingHighlight);

  bindReaderNavigation();
  bindSearchControls();

  // The debounced save (see scheduleProgressSave) can miss the very last
  // position if the reader navigates away before it fires. Flush
  // immediately — with keepalive so it survives the navigation — on every
  // path that leaves the reader.
  document.getElementById('back-link').addEventListener('click', () => flushProgress());
  window.addEventListener('pagehide', () => flushProgress());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushProgress();
  });
}

function flushProgress() {
  clearTimeout(saveProgressTimer);
  if (latestCfi) {
    flushBookProgress(bookId, { locationCfi: latestCfi, progressPercent: latestPercent });
  }
}

function openPanel() {
  panel.classList.add('open');
  panelScrim.classList.add('open');
  panelToggle.setAttribute('aria-expanded', 'true');
}

function closePanel() {
  panel.classList.remove('open');
  panelScrim.classList.remove('open');
  panelToggle.setAttribute('aria-expanded', 'false');
}

function openTocPanel() {
  tocPanel.classList.add('open');
  tocScrim.classList.add('open');
  tocToggle.setAttribute('aria-expanded', 'true');
}

function closeTocPanel() {
  tocPanel.classList.remove('open');
  tocScrim.classList.remove('open');
  tocToggle.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------------
// Navigation (guarded against overlapping calls)
// ---------------------------------------------------------------------------

let isNavigating = false;

async function goNext() {
  if (isNavigating) return;
  isNavigating = true;
  try {
    await rendition.next();
  } catch (err) {
    console.error(err);
  } finally {
    isNavigating = false;
  }
}

async function goPrev() {
  if (isNavigating) return;
  isNavigating = true;
  try {
    await rendition.prev();
  } catch (err) {
    console.error(err);
  } finally {
    isNavigating = false;
  }
}

// ---------------------------------------------------------------------------
// EPUB rendering
// ---------------------------------------------------------------------------

async function openBook() {
  const url = publicEpubUrl(bookRow.file_path);
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();

  book = ePub(arrayBuffer);

  rendition = book.renderTo('viewer', {
    width: '100%',
    height: '100%',
    flow: 'paginated',
    spread: 'none',
  });

  rendition.themes.default({
    body: {
      'font-family': "Georgia, 'Iowan Old Style', serif !important",
      'line-height': '1.65 !important',
      color: '#131315 !important',
    },
    '::selection': { background: 'rgba(169, 220, 245, 0.7)' },
    '.epubjs-hl': { 'mix-blend-mode': 'multiply', cursor: 'pointer' },
  });

  rendition.on('rendered', () => {
    loadingEl.classList.add('hidden');
  });

  rendition.on('relocated', (location) => {
    scheduleProgressSave(location);
  });

  rendition.on('selected', onTextSelected);

  rendition.on('keydown', (e) => {
    if (isFindShortcut(e)) { e.preventDefault(); openSearch(); }
  });

  rendition.on('click', (event, contents) => {
    const hasSelection = contents.window.getSelection?.().toString().trim();
    if (hasSelection) return;

    const width = contents.window.innerWidth;
    const x = event.clientX;
    if (x < width * 0.3) goPrev();
    else if (x > width * 0.7) goNext();
  });

  await book.ready;

  if (bookRow.location_cfi) {
    await rendition.display(bookRow.location_cfi);
  } else {
    await rendition.display();
  }

  book.loaded.navigation
  .then((nav) => renderToc(nav.toc))
  .catch((err) => {
    console.error('Could not load table of contents', err);
    tocEmpty.textContent = 'Contents unavailable for this book.';
  });

  // Generate locations in the background so percentage-through-book works.
  // Not required for the reader to function, so failures are non-fatal.
  book.locations.generate(1600).then(() => { locationsReady = true; }).catch(() => {});
}

function scheduleProgressSave(location) {
  const cfi = location?.start?.cfi;
  if (!cfi) return;

  updateActiveTocLink(location?.start?.href);

  let percent = bookRow.progress_percent || 0;
  if (locationsReady && book.locations.length()) {
    percent = Math.round(book.locations.percentageFromCfi(cfi) * 100);
  }
  // progressPill.textContent = percent > 0 ? `${percent}% read` : 'Just started';

  // Track the latest position outside the debounce so it's always available
  // for an immediate flush (see flushProgress) if the reader navigates away
  // before the debounced save below gets a chance to fire.
  latestCfi = cfi;
  latestPercent = percent;

  clearTimeout(saveProgressTimer);
  saveProgressTimer = setTimeout(async () => {
    try {
      await updateBookProgress(bookId, { locationCfi: cfi, progressPercent: percent });
      bookRow.location_cfi = cfi;
      bookRow.progress_percent = percent;
    } catch (err) {
      console.error('Could not save reading progress', err);
    }
  }, 800);
}

// ---------------------------------------------------------------------------
// Highlight capture (selection -> confirm -> save -> render in book)
// ---------------------------------------------------------------------------

async function onTextSelected(cfiRange, contents) {
  let text = '';
  try {
    // book.getRange() is asynchronous in epub.js — it resolves to a Range,
    // so it must be awaited before calling .toString() on it.
    const range = await book.getRange(cfiRange);
    text = range.toString().trim();
  } catch (err) {
    console.error(err);
  }
  if (!text) return;

  pendingSelection = { cfiRange, contents, text };
  showConfirmBar(text);
}

function showConfirmBar(text) {
  confirmText.textContent = text.length > 140 ? `${text.slice(0, 140)}…` : text;
  confirmBar.classList.add('show');
}

function hideConfirmBar() {
  confirmBar.classList.remove('show');
}

async function confirmPendingHighlight() {
  if (!pendingSelection) return;
  const { cfiRange, contents, text } = pendingSelection;
  pendingSelection = null;
  hideConfirmBar();

  paintHighlight(cfiRange);
  clearSelection(contents);

  try {
    const row = await insertHighlight({ bookId, cfiRange, textSnippet: text });
    addHighlightCard(row);
    updateHighlightCount();
    showToast();
  } catch (err) {
    console.error('Could not save highlight', err);
    rendition.annotations.remove(cfiRange, 'highlight');
    alert('Could not save the highlight. See console for details.');
  }
}

function cancelPendingHighlight() {
  if (!pendingSelection) return;
  clearSelection(pendingSelection.contents);
  pendingSelection = null;
  hideConfirmBar();
}

function clearSelection(contents) {
  const selection = contents?.window?.getSelection?.();
  selection?.removeAllRanges?.();
}

function paintHighlight(cfiRange) {
  userHighlightCfis.add(cfiRange);
  rendition.annotations.remove(cfiRange, 'highlight'); // replaces a search hit on the exact same text, if any
  rendition.annotations.add(
    'highlight',
    cfiRange,
    {},
    undefined,
    'epubjs-hl',
    { fill: HIGHLIGHT_FILL, 'fill-opacity': '0.6' }
  );
}

function unpaintHighlight(cfiRange) {
  userHighlightCfis.delete(cfiRange);
  rendition.annotations.remove(cfiRange, 'highlight');
}

function showToast() {
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 1600);
}

// ---------------------------------------------------------------------------
// Highlights panel
// ---------------------------------------------------------------------------

function renderHighlightList(rows) {
  updateHighlightCount(rows.length);
  highlightEmpty.style.display = rows.length ? 'none' : 'block';

  for (const row of rows) {
    addHighlightCard(row);
    paintHighlight(row.cfi_range);
  }
  // epub.js re-attaches known annotations to each section automatically as
  // it's (re)rendered while scrolling — no need to re-add them ourselves.
  // Doing so on every 'rendered' event stacked duplicate highlight overlays
  // on top of each other and eventually obscured the underlying text.
}

function addHighlightCard(row) {
  highlightEmpty.style.display = 'none';

  const card = document.createElement('div');
  card.className = 'highlight-card';
  card.dataset.id = row.id;
  card.dataset.cfi = row.cfi_range;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.innerHTML = `
    <p class="highlight-text">${escapeHtml(row.text_snippet || '')}</p>
    <span class="highlight-date">${formatDate(row.created_at)}</span>
    <button class="highlight-remove" type="button" aria-label="Remove highlight">${REMOVE_SVG}</button>
  `;

  card.addEventListener('click', (e) => {
    if (e.target.closest('.highlight-remove')) return;
    goToHighlight(row.cfi_range, card);
  });
  card.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('.highlight-remove')) {
      e.preventDefault();
      goToHighlight(row.cfi_range, card);
    }
  });

  card.querySelector('.highlight-remove').addEventListener('click', async (e) => {
    e.stopPropagation();
    card.style.opacity = '0.5';
    try {
      await deleteHighlight(row.id);
      rendition.annotations.remove(row.cfi_range, 'highlight');
      card.remove();
      updateHighlightCount();
      highlightEmpty.style.display = highlightList.querySelectorAll('.highlight-card').length ? 'none' : 'block';
    } catch (err) {
      console.error(err);
      alert('Could not remove the highlight. See console for details.');
      card.style.opacity = '1';
    }
  });

  highlightList.appendChild(card);
}

async function goToHighlight(cfiRange, card) {
  closePanel();
  try {
    const cfiObj = new ePub.CFI(cfiRange);
    cfiObj.collapse(true);
    const startCfi = cfiObj.toString();
    await rendition.display(startCfi);
  } catch (err) {
    console.error(err);
    return;
  }

  await waitForNextPaint();
  flashInBook(cfiRange);
  document.querySelectorAll('.highlight-card.flash').forEach((el) => el.classList.remove('flash'));
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1200);
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function bindReaderNavigation() {
  document.addEventListener('keydown', (e) => {
    if (isFindShortcut(e)) { e.preventDefault(); openSearch(); return; }

    if (e.key === 'Escape') {
      const panelOpen = panel.classList.contains('open') || tocPanel.classList.contains('open');
      closePanel();
      closeTocPanel();
      if (!panelOpen) closeSearch();
      return;
    }

    const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]');
    if (typing) return;

    if (e.key === 'ArrowRight') goNext();
    if (e.key === 'ArrowLeft') goPrev();
  });

  const viewerEl = document.getElementById('viewer');
  viewerEl.addEventListener('click', (e) => {
    const { left, width } = viewerEl.getBoundingClientRect();
    const x = e.clientX - left;
    if (x < width * 0.3) goPrev();
    else if (x > width * 0.7) goNext();
  });

  let touchStartX = null;
  viewerEl.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; });
  viewerEl.addEventListener('touchend', (e) => {
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) dx > 0 ? goPrev() : goNext();
    touchStartX = null;
  });
}

// Best-effort brighten-then-restore pulse on the highlighted text itself.
function flashInBook(cfiRange) {
  try {
    for (const contents of rendition.getContents()) {
      const el = contents.document.querySelector(`[data-epubjs-cfi="${cssEscape(cfiRange)}"]`);
      if (!el) continue;
      const originalFill = el.style.fill;
      el.style.fill = HIGHLIGHT_FILL_STRONG;
      setTimeout(() => { el.style.fill = originalFill || HIGHLIGHT_FILL; }, 900);
    }
  } catch {
    // Non-critical visual flourish — safe to ignore if epub.js internals differ.
  }
}

function updateHighlightCount(explicit) {
  const count = explicit ?? highlightList.querySelectorAll('.highlight-card').length;
  highlightCount.textContent = count;
}

function cssEscape(str) {
  return window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

function renderToc(toc) {
  if (!toc || !toc.length) {
    tocEmpty.textContent = 'No table of contents in this book.';
    return;
  }
  tocEmpty.style.display = 'none';
  tocList.appendChild(buildTocLevel(toc, false));
}

function buildTocLevel(items, isSub) {
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = isSub ? 'toc-link sub' : 'toc-link';
    link.textContent = item.label.trim();
    link.dataset.href = item.href;
    link.addEventListener('click', async () => {
      try {
        await rendition.display(item.href);
      } catch (err) {
        console.error(err);
        return;
      }
      closeTocPanel();
    });
    frag.appendChild(link);
    if (item.subitems && item.subitems.length) {
      frag.appendChild(buildTocLevel(item.subitems, true));
    }
  }
  return frag;
}

function updateActiveTocLink(href) {
  if (!href) return;
  const base = href.split('#')[0];
  tocList.querySelectorAll('.toc-link').forEach((el) => {
    const elBase = (el.dataset.href || '').split('#')[0];
    el.classList.toggle('active', elBase === base);
  });
}


// ---------------------------------------------------------------------------
// In-book search
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const BLOCK_BREAK = '\u0001'; // stops a phrase from matching across two paragraphs

function isFindShortcut(e) {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'f';
}

function bindSearchControls() {
  searchToggle.addEventListener('click', () => (searchBar.hidden ? openSearch() : closeSearch()));
  searchClose.addEventListener('click', closeSearch);
  searchPrev.addEventListener('click', () => stepMatch(-1));
  searchNext.addEventListener('click', () => stepMatch(1));

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    clearTimeout(search.timer);
    runSearch('');
    searchInput.focus();
  });

  // Live search: highlight while typing, without moving the reader.
  searchInput.addEventListener('input', () => {
    clearTimeout(search.timer);
    const q = searchInput.value.trim();
    searchClear.hidden = !searchInput.value;
    if (!q) { runSearch(''); return; }
    search.timer = setTimeout(() => runSearch(q), 300);
  });

  // Enter: run right away and jump to the first hit, or step to the next one.
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q !== search.query) {
      clearTimeout(search.timer);
      runSearch(q, { jump: true });
    } else if (search.busy) {
      search.jumpWhenDone = true;
    } else {
      stepMatch(e.shiftKey ? -1 : 1);
    }
  });
}

function openSearch() {
  closePanel();
  closeTocPanel();
  if (searchBar.hidden) {
    searchBar.hidden = false;
    searchToggle.setAttribute('aria-expanded', 'true');
    reflowReader();
  }
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  if (searchBar.hidden) return;
  clearTimeout(search.timer);
  search.runId++;          // cancels a scan that may still be running
  search.busy = false;
  clearSearchResults();
  search.query = '';
  searchInput.value = '';
  searchClear.hidden = true;
  renderSearchStatus();
  searchBar.hidden = true;
  searchToggle.setAttribute('aria-expanded', 'false');
  reflowReader();
}

// The bar changes the height available to the book, so let epub.js re-paginate.
function reflowReader() {
  requestAnimationFrame(() => {
    try { rendition?.resize(); } catch (err) { console.error(err); }
  });
}

// --- Running a search ------------------------------------------------------

async function runSearch(query, { jump = false } = {}) {
  if (!book || !rendition) return;

  const runId = ++search.runId;
  clearSearchResults();
  search.query = query;
  search.jumpWhenDone = jump;
  search.busy = false;
  renderSearchStatus();

  const regex = query.length >= SEARCH_MIN_CHARS ? buildSearchRegex(query) : null;
  if (!regex) return;

  search.busy = true;
  renderSearchStatus();
  await book.ready;

  for (const item of book.spine.spineItems) {
    if (runId !== search.runId) return;

    let cfis = [];
    try {
      cfis = await searchSection(item, regex, SEARCH_MAX_MATCHES - search.matches.length);
    } catch (err) {
      console.warn('Search skipped a section', item.href, err);
    }
    if (runId !== search.runId) return; // a newer search took over while we waited

    for (const cfi of cfis) {
      const match = { cfi, painted: false };
      paintMatch(match, false);
      search.matches.push(match);
    }
    renderSearchStatus(); // the count grows live as sections are scanned

    if (search.matches.length >= SEARCH_MAX_MATCHES) { search.capped = true; break; }
    await new Promise((resolve) => setTimeout(resolve)); // let the UI breathe
  }

  search.busy = false;
  renderSearchStatus();
  if (search.jumpWhenDone && search.matches.length) stepMatch(1);
}

// Lower-case, strip accents, straighten curly quotes: "École" and "ecole" match.
function foldChar(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return ch.toLowerCase();
  if (code === 0x2018 || code === 0x2019 || code === 0x2032) return "'";
  if (code === 0x201c || code === 0x201d) return '"';
  return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function buildSearchRegex(query) {
  const words = query.split('').map(foldChar).join('').split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(words.map(escape).join('\\s+'), 'g'); // any whitespace run matches
}

// Returns the CFI ranges of every hit in one spine section.
async function searchSection(item, regex, room) {
  const wasLoaded = Boolean(item.contents);
  const contents = await item.load(book.load.bind(book));
  try {
    const doc = contents.ownerDocument || item.document;
    const root = doc && (doc.body || doc.documentElement);
    if (!root || room <= 0) return [];

    // 1. Flatten the section into one folded string, remembering which text
    //    node + offset each character came from (so hits can span <em>, <a>…).
    let hay = '';
    const srcNode = [];
    const srcOffset = [];
    const push = (ch, node, offset) => { hay += ch; srcNode.push(node); srcOffset.push(offset); };

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 1) {
        const tag = node.localName.toLowerCase();
        if (BLOCK_TAGS.has(tag)) push(BLOCK_BREAK, null, 0);
        else if (tag === 'br') push(' ', null, 0);
        continue;
      }
      const parentTag = node.parentNode && node.parentNode.localName && node.parentNode.localName.toLowerCase();
      if (parentTag === 'script' || parentTag === 'style') continue;

      const text = node.nodeValue;
      for (let i = 0; i < text.length; i++) {
        for (const c of foldChar(text[i])) push(c, node, i);
      }
    }

    // 2. Find hits and turn each into a CFI range.
    const cfis = [];
    regex.lastIndex = 0;
    let m;
    while (cfis.length < room && (m = regex.exec(hay))) {
      const first = m.index;
      const last = m.index + m[0].length - 1;
      if (!srcNode[first] || !srcNode[last]) continue;
      const range = doc.createRange();
      range.setStart(srcNode[first], srcOffset[first]);
      range.setEnd(srcNode[last], srcOffset[last] + 1);
      cfis.push(item.cfiFromRange(range));
    }
    return cfis;
  } finally {
    if (!wasLoaded) item.unload();
  }
}

// --- Highlighting & navigation --------------------------------------------

function paintMatch(match, active) {
  if (userHighlightCfis.has(match.cfi)) return; // already covered by a saved highlight
  if (match.painted) rendition.annotations.remove(match.cfi, 'highlight');
  rendition.annotations.add(
    'highlight',
    match.cfi,
    {},
    undefined,
    'epubjs-search-hl',
    active ? SEARCH_STYLE_ACTIVE : SEARCH_STYLE
  );
  match.painted = true;
}

function clearSearchResults() {
  for (const match of search.matches) {
    if (match.painted && !userHighlightCfis.has(match.cfi)) {
      rendition.annotations.remove(match.cfi, 'highlight');
    }
  }
  search.matches = [];
  search.active = -1;
  search.capped = false;
}

// Index of the first hit at or after the given reading position.
function firstMatchFrom(cfi) {
  if (!cfi) return 0;
  const cfiTool = new ePub.CFI();
  const idx = search.matches.findIndex((m) => cfiTool.compare(m.cfi, cfi) >= 0);
  return idx === -1 ? 0 : idx;
}

async function stepMatch(dir) {
  const total = search.matches.length;
  if (!total) return;

  let next;
  if (search.active < 0) {
    // first jump: start from where the reader currently is
    const from = firstMatchFrom(latestCfi);
    next = dir > 0 ? from : (from - 1 + total) % total;
  } else {
    next = (search.active + dir + total) % total;
  }
  await activateMatch(next);
}

async function activateMatch(index) {
  const previous = search.matches[search.active];
  search.active = index;
  if (previous) paintMatch(previous, false);

  const match = search.matches[index];
  paintMatch(match, true);
  renderSearchStatus();

  try {
    const target = new ePub.CFI(match.cfi);
    target.collapse(true);
    await rendition.display(target.toString());
  } catch (err) {
    console.error(err);
  }
}

function renderSearchStatus() {
  const total = search.matches.length;
  const more = search.capped ? '+' : '';
  let text = '';
  let state = '';

  if (search.query.length >= SEARCH_MIN_CHARS) {
    if (total) {
      const n = total.toLocaleString();
      text = search.active >= 0
        ? `${(search.active + 1).toLocaleString()} / ${n}${more}`
        : `${n}${more} ${total === 1 && !more ? 'occurrence' : 'occurrences'}`;
    } else if (search.busy) {
      text = 'Searching…';
    } else {
      text = 'No occurrences';
      state = 'none';
    }
  }

  searchCount.textContent = text;
  searchCount.dataset.state = state;
  searchSpinner.hidden = !search.busy;
  searchPrev.disabled = searchNext.disabled = total === 0;
}