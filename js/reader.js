import {
  fetchBook,
  deleteBook,
  publicEpubUrl,
  fetchHighlights,
  insertHighlight,
  deleteHighlight,
  updateBookProgress,
  flushBookProgress,
  fetchReactionsForBook,
  upsertReaction,
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

const toastText = document.getElementById('toast-text');

const reactionOverlay = document.getElementById('reaction-overlay');
const reactionModalClose = document.getElementById('reaction-modal-close');
const reactionTabs = document.querySelectorAll('.reaction-tab');
const reactionPanels = document.querySelectorAll('.reaction-panel');
const likeBigBtn = document.getElementById('like-big-btn');
const emojiGrid = document.getElementById('emoji-grid');
const reactSubmitBtn = document.getElementById('react-submit-btn');

const reactionViewOverlay = document.getElementById('reaction-view-overlay');
const reactionViewClose = document.getElementById('reaction-view-close');
const reactionViewBody = document.getElementById('reaction-view-body');
const reactionViewEditBtn = document.getElementById('reaction-view-edit-btn');

const REMOVE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

let bookRow = null;
let book = null;
let rendition = null;
let locationsReady = false;
let saveProgressTimer = null;
let pendingSelection = null; // { cfiRange, contents, text } awaiting user confirmation
let latestCfi = null;
let latestPercent = 0;

let reactionsByHighlight = new Map(); // highlightId -> reaction row
let currentReactionHighlight = null;
let activeReactionTab = 'like';
let selectedEmojiFile = null;
let quill = null;

// Rename the files here to match whatever you put in reactions/emojis/
const EMOJI_OPTIONS = [
  { file: '1F60A.svg', label: 'Smile' },
  { file: '1F60B.svg', label: 'Yum' },
  { file: '1F60C.svg', label: 'Relieved' },
  { file: '1F60D.svg', label: 'Love' },
  { file: '1F60E.svg', label: 'Cool' },
  { file: '1F60F.svg', label: 'Smirk' },
  { file: '1F61A.svg', label: 'Kiss' },
  { file: '1F61B.svg', label: 'Tongue' },
  { file: '1F61C.svg', label: 'Wink Tongue' },
  { file: '1F61D.svg', label: 'Laughing' },
  { file: '1F61E.svg', label: 'Disappointed' },
  { file: '1F61F.svg', label: 'Worried' },
  { file: '1F62A.svg', label: 'Sleepy' },

  { file: '1F62B.svg', label: 'Tired' },
  { file: '1F62C.svg', label: 'Grimace' },
  { file: '1F62D.svg', label: 'Crying' },
  { file: '1F62E.svg', label: 'Open Mouth' },
  { file: '1F62E-200D-1F4A8.svg', label: 'Exhale' },
  { file: '1F62F.svg', label: 'Surprised' },
  { file: '1F92A.svg', label: 'Crazy' },
  { file: '1F92B.svg', label: 'Shushing' },
  { file: '1F92D.svg', label: 'Hand Over Mouth' },
  { file: '1F92E.svg', label: 'Vomiting' },
  { file: '1F92F.svg', label: 'Exploding Head' },
  { file: '1F97A.svg', label: 'Pleading' },
  { file: '1F600.svg', label: 'Grinning' },

  { file: '1F601.svg', label: 'Beaming' },
  { file: '1F602.svg', label: 'Tears of Joy' },
  { file: '1F603.svg', label: 'Happy' },
  { file: '1F604.svg', label: 'Big Smile' },
  { file: '1F605.svg', label: 'Nervous Laugh' },
  { file: '1F606.svg', label: 'Squint Laugh' },
  { file: '1F607.svg', label: 'Angel' },
  { file: '1F608.svg', label: 'Devil' },
  { file: '1F609.svg', label: 'Wink' },
  { file: '1F610.svg', label: 'Neutral' },
  { file: '1F611.svg', label: 'Expressionless' },
  { file: '1F612.svg', label: 'Unamused' },
  { file: '1F613.svg', label: 'Sweat' },

  { file: '1F614.svg', label: 'Pensive' },
  { file: '1F615.svg', label: 'Confused' },
  { file: '1F616.svg', label: 'Scrunched' },
  { file: '1F617.svg', label: 'Kissing' },
  { file: '1F618.svg', label: 'Kiss Love' },
  { file: '1F619.svg', label: 'Kiss Smile' },
  { file: '1F620.svg', label: 'Angry' },
  { file: '1F621.svg', label: 'Pouting' },
  { file: '1F622.svg', label: 'Sad' },
  { file: '1F623.svg', label: 'Persevering' },
  { file: '1F624.svg', label: 'Frustrated' },
  { file: '1F625.svg', label: 'Relieved Cry' },
  { file: '1F626.svg', label: 'Frowning' },

  { file: '1F627.svg', label: 'Concerned' },
  { file: '1F628.svg', label: 'Fearful' },
  { file: '1F629.svg', label: 'Weary' },
  { file: '1F630.svg', label: 'Anxious' },
  { file: '1F631.svg', label: 'Scream' },
  { file: '1F632.svg', label: 'Astonished' },
  { file: '1F633.svg', label: 'Flushed' },
  { file: '1F634.svg', label: 'Sleeping' },
  { file: '1F635.svg', label: 'Dizzy' },
  { file: '1F635-200D-1F4AB.svg', label: 'Spiral Eyes' },
  { file: '1F636.svg', label: 'No Mouth' },
  { file: '1F636-200D-1F32B-FE0F.svg', label: 'Hidden Face' },
  { file: '1F637.svg', label: 'Mask' },

  { file: '1F641.svg', label: 'Slightly Sad' },
  { file: '1F642.svg', label: 'Slight Smile' },
  { file: '1F643.svg', label: 'Upside Down' },
  { file: '1F644.svg', label: 'Eye Roll' },
  { file: '1F910.svg', label: 'Zipper Mouth' },
  { file: '1F911.svg', label: 'Money' },
  { file: '1F912.svg', label: 'Sick' },
  { file: '1F913.svg', label: 'Nerd' },
  { file: '1F914.svg', label: 'Thinking' },
  { file: '1F915.svg', label: 'Injured' },
  { file: '1F917.svg', label: 'Hug' },
  { file: '1F920.svg', label: 'Cowboy' },
  { file: '1F921.svg', label: 'Clown' },

  { file: '1F922.svg', label: 'Nauseous' },
  { file: '1F923.svg', label: 'Rolling Laugh' },
  { file: '1F924.svg', label: 'Drooling' },
  { file: '1F925.svg', label: 'Liar' },
  { file: '1F927.svg', label: 'Sneezing' },
  { file: '1F928.svg', label: 'Raised Eyebrow' },
  { file: '1F929.svg', label: 'Star Eyes' },
  { file: '1F970.svg', label: 'Hearts' },
  { file: '1F971.svg', label: 'Yawn' },
  { file: '1F972.svg', label: 'Happy Tear' },
  { file: '1F973.svg', label: 'Party' },
  { file: '1F974.svg', label: 'Woozy' },
  { file: '1F975.svg', label: 'Hot' },

  { file: '1F976.svg', label: 'Cold' },
  { file: '1F978.svg', label: 'Disguise' },
  { file: '263A.svg', label: 'Classic Smile' },
  { file: '2639.svg', label: 'Classic Sad' },
  { file: 'E280.svg', label: 'Annoyed' },
  { file: 'E281.svg', label: 'Whistle' },
  { file: 'E282.svg', label: 'Speechless' },
  { file: 'E283.svg', label: 'Playful' }
];

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

  const [, rows, reactionRows] = await Promise.all([
    openBook(),
    fetchHighlights(bookId).catch((err) => { console.error(err); return []; }),
    fetchReactionsForBook(bookId).catch((err) => { console.error(err); return []; }),
  ]);
  reactionsByHighlight = new Map(reactionRows.map((r) => [r.highlight_id, r]));
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
  bindReactionControls();

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

  paintHighlight(cfiRange); // optimistic paint, no click handler yet (no id)
  clearSelection(contents);

  try {
    const row = await insertHighlight({ bookId, cfiRange, textSnippet: text });
    paintHighlight(cfiRange, row); // repaint now that we have an id, wiring the click handler
    addHighlightCard(row);
    updateHighlightCount();
    showToast('Highlight saved');
    openReactionModal(row);
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

function paintHighlight(cfiRange, row) {
  userHighlightCfis.add(cfiRange);
  rendition.annotations.remove(cfiRange, 'highlight'); // replaces a search hit on the exact same text, if any
  rendition.annotations.add(
    'highlight',
    cfiRange,
    {},
    row ? () => handleHighlightClick(row) : undefined,
    'epubjs-hl',
    { fill: HIGHLIGHT_FILL, 'fill-opacity': '0.6' }
  );
}

function unpaintHighlight(cfiRange) {
  userHighlightCfis.delete(cfiRange);
  rendition.annotations.remove(cfiRange, 'highlight');
}

function showToast(message = 'Highlight saved') {
  toastText.textContent = message;
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
    paintHighlight(row.cfi_range, row);
    const reaction = reactionsByHighlight.get(row.id);
    if (reaction) updateHighlightBadge(row.id, reaction);
  }
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
      reactionsByHighlight.delete(row.id);
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
// Reactions
// ---------------------------------------------------------------------------

function buildEmojiGrid() {
  emojiGrid.innerHTML = '';
  for (const { file, label } of EMOJI_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-option';
    btn.dataset.file = file;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<img src="reactions/emojis/${file}" alt="${label}" />`;
    btn.addEventListener('click', () => selectEmoji(file));
    emojiGrid.appendChild(btn);
  }
}

function selectEmoji(file) {
  selectedEmojiFile = file;
  emojiGrid.querySelectorAll('.emoji-option').forEach((el) => {
    el.classList.toggle('selected', el.dataset.file === file);
  });
}

function ensureQuill() {
  if (quill) return quill;
  quill = new Quill('#comment-editor', {
    theme: 'snow',
    placeholder: 'Write a comment about this passage…',
    modules: {
      toolbar: [['bold', 'italic', 'underline'], [{ list: 'ordered' }, { list: 'bullet' }], ['link'], ['clean']],
    },
  });
  return quill;
}

function switchReactionTab(tab) {
  activeReactionTab = tab;
  reactionTabs.forEach((btn) => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  reactionPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  });
  if (tab === 'comment') ensureQuill();
}

function resetReactionModal(existing) {
  switchReactionTab(existing?.type || 'like');
  likeBigBtn.setAttribute('aria-pressed', 'true');

  selectedEmojiFile = existing?.type === 'emoji' ? existing.emoji : null;
  buildEmojiGrid();
  if (selectedEmojiFile) selectEmoji(selectedEmojiFile);

  const editor = ensureQuill();
  editor.setContents([]);
  if (existing?.type === 'comment' && existing.comment) {
    editor.clipboard.dangerouslyPasteHTML(existing.comment);
  }
}

function openReactionModal(highlightRow, existingReaction = null) {
  currentReactionHighlight = highlightRow;
  resetReactionModal(existingReaction);
  reactionOverlay.classList.add('open');
}

function closeReactionModal() {
  reactionOverlay.classList.remove('open');
  currentReactionHighlight = null;
}

async function submitReaction() {
  if (!currentReactionHighlight) return;

  const payload = { type: activeReactionTab, emoji: null, comment: null };

  if (activeReactionTab === 'emoji') {
    if (!selectedEmojiFile) {
      emojiGrid.classList.add('shake');
      setTimeout(() => emojiGrid.classList.remove('shake'), 400);
      return;
    }
    payload.emoji = selectedEmojiFile;
  } else if (activeReactionTab === 'comment') {
    const isEmpty = quill.getText().trim().length === 0;
    if (isEmpty) { quill.focus(); return; }
    payload.comment = quill.root.innerHTML;
  }

  reactSubmitBtn.disabled = true;
  try {
    const row = await upsertReaction({ highlightId: currentReactionHighlight.id, ...payload });
    reactionsByHighlight.set(currentReactionHighlight.id, row);
    updateHighlightBadge(currentReactionHighlight.id, row);
    closeReactionModal();
    showToast('Reaction saved');
  } catch (err) {
    console.error('Could not save reaction', err);
    alert('Could not save the reaction. See console for details.');
  } finally {
    reactSubmitBtn.disabled = false;
  }
}

function handleHighlightClick(highlightRow) {
  const reaction = reactionsByHighlight.get(highlightRow.id);
  if (reaction) {
    openReactionViewModal(highlightRow, reaction);
  } else {
    openReactionModal(highlightRow);
  }
}

function openReactionViewModal(highlightRow, reaction) {
  currentReactionHighlight = highlightRow;
  reactionViewBody.innerHTML = renderReactionView(reaction);
  reactionViewOverlay.classList.add('open');
}

function closeReactionViewModal() {
  reactionViewOverlay.classList.remove('open');
}

function renderReactionView(reaction) {
  if (reaction.type === 'like') {
    return `
      <img class="view-like-img" src="reactions/like.png" alt="Like" />
      <span class="view-label">Liked this passage</span>
    `;
  }
  if (reaction.type === 'emoji') {
    return `<img class="view-emoji-img" src="reactions/emojis/${escapeHtml(reaction.emoji)}" alt="Reaction" />`;
  }
  return `<div class="view-comment">${reaction.comment || ''}</div>`;
}

function updateHighlightBadge(highlightId, reaction) {
  const card = highlightList.querySelector(`.highlight-card[data-id="${highlightId}"]`);
  if (!card) return;
  const textEl = card.querySelector('.highlight-text');
  if (!textEl) return;

  let badge = textEl.querySelector('.highlight-reaction-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'highlight-reaction-badge';
    textEl.prepend(badge); // must be the first node so the text after it wraps around it
  }

  if (reaction.type === 'like') {
    badge.innerHTML = `<img src="reactions/like.png" alt="Like" />`;
  } else if (reaction.type === 'emoji') {
    badge.innerHTML = `<img src="reactions/emojis/${escapeHtml(reaction.emoji)}" alt="" />`;
  } else {
    badge.textContent = '💬';
  }
}

function bindReactionControls() {
  reactionTabs.forEach((btn) => btn.addEventListener('click', () => switchReactionTab(btn.dataset.tab)));

  likeBigBtn.addEventListener('click', () => {
    likeBigBtn.classList.add('bump');
    setTimeout(() => likeBigBtn.classList.remove('bump'), 180);
  });

  reactSubmitBtn.addEventListener('click', submitReaction);
  reactionModalClose.addEventListener('click', closeReactionModal);
  reactionOverlay.addEventListener('click', (e) => { if (e.target === reactionOverlay) closeReactionModal(); });

  reactionViewClose.addEventListener('click', closeReactionViewModal);
  reactionViewOverlay.addEventListener('click', (e) => { if (e.target === reactionViewOverlay) closeReactionViewModal(); });
  reactionViewEditBtn.addEventListener('click', () => {
    const reaction = reactionsByHighlight.get(currentReactionHighlight.id);
    const row = currentReactionHighlight;
    closeReactionViewModal();
    openReactionModal(row, reaction);
  });
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