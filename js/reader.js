import {
  fetchBook,
  deleteBook,
  publicEpubUrl,
  fetchHighlights,
  insertHighlight,
  deleteHighlight,
  updateBookProgress,
} from './supabaseClient.js';

const HIGHLIGHT_FILL = '#a9dcf5';
const HIGHLIGHT_FILL_STRONG = '#7cc6ec';

const params = new URLSearchParams(window.location.search);
const bookId = params.get('id');

const titleEl = document.getElementById('book-title');
const authorEl = document.getElementById('book-author');
const progressPill = document.getElementById('progress-pill');
const loadingEl = document.getElementById('reader-loading');
const deleteBtn = document.getElementById('delete-book');
const toast = document.getElementById('selection-toast');

const highlightList = document.getElementById('highlight-list');
const highlightEmpty = document.getElementById('highlight-empty');
const highlightCount = document.getElementById('highlight-count');

const panel = document.getElementById('highlights-panel');
const panelToggle = document.getElementById('panel-toggle');
const panelScrim = document.getElementById('panel-scrim');

const REMOVE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

let bookRow = null;
let book = null;
let rendition = null;
let locationsReady = false;
let saveProgressTimer = null;

if (!bookId) {
  window.location.href = 'index.html';
} else {
  init();
}

async function init() {
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
    panel.classList.add('open');
    panelScrim.classList.add('open');
  });
  panelScrim.addEventListener('click', closePanel);
}

function closePanel() {
  panel.classList.remove('open');
  panelScrim.classList.remove('open');
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
    flow: 'scrolled-doc',
    manager: 'continuous',
    spread: 'none',
  });

  rendition.themes.default({
    body: {
      'font-family': "Georgia, 'Iowan Old Style', serif !important",
      'line-height': '1.65 !important',
      color: '#131315 !important',
      padding: '6% 9% !important',
      'max-width': '640px',
      margin: '0 auto !important',
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

  await book.ready;

  if (bookRow.location_cfi) {
    await rendition.display(bookRow.location_cfi);
  } else {
    await rendition.display();
  }

  // Generate locations in the background so percentage-through-book works.
  // Not required for the reader to function, so failures are non-fatal.
  book.locations.generate(1600).then(() => { locationsReady = true; }).catch(() => {});
}

function scheduleProgressSave(location) {
  const cfi = location?.start?.cfi;
  if (!cfi) return;

  let percent = bookRow.progress_percent || 0;
  if (locationsReady && book.locations.length()) {
    percent = Math.round(book.locations.percentageFromCfi(cfi) * 100);
  }
  progressPill.textContent = percent > 0 ? `${percent}% read` : 'Just started';

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
// Highlight capture (selection -> save -> render in book)
// ---------------------------------------------------------------------------

async function onTextSelected(cfiRange, contents) {
  let text = '';
  try {
    text = book.getRange(cfiRange).toString().trim();
  } catch (err) {
    console.error(err);
  }
  if (!text) return;

  paintHighlight(cfiRange);
  clearSelection(contents);

  try {
    const row = await insertHighlight({ bookId, cfiRange, textSnippet: text });
    addHighlightCard(row, { prepend: false });
    updateHighlightCount();
    showToast();
  } catch (err) {
    console.error('Could not save highlight', err);
    rendition.annotations.remove(cfiRange, 'highlight');
  }
}

function clearSelection(contents) {
  const selection = contents?.window?.getSelection?.();
  selection?.removeAllRanges?.();
}

function paintHighlight(cfiRange) {
  rendition.annotations.add(
    'highlight',
    cfiRange,
    {},
    undefined,
    'epubjs-hl',
    { fill: HIGHLIGHT_FILL, 'fill-opacity': '0.6' }
  );
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

  // The scrolled-doc manager lazily mounts sections as the reader scrolls,
  // so re-paint whenever a new section is rendered in case it contains one
  // of these highlights.
  rendition.on('rendered', () => {
    rows.forEach((row) => paintHighlight(row.cfi_range));
  });
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
  if (window.innerWidth <= 860) closePanel();
  try {
    await rendition.display(cfiRange);
  } catch (err) {
    console.error(err);
    return;
  }
  flashInBook(cfiRange);
  document.querySelectorAll('.highlight-card.flash').forEach((el) => el.classList.remove('flash'));
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1200);
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
