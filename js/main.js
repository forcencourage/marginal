import {
  fetchBooks, insertBook, deleteBook, uploadEpubFile, uploadCoverBlob,
  publicCoverUrl, bookFormat,
  localBookIds, localCoverUrl, saveBookOffline, removeBookOffline,
} from './supabaseClient.js';
import { registerSW } from './offline.js';
import { requireAuth, signOut } from './auth.js';

registerSW();

const grid = document.getElementById('grid');
const emptyState = document.getElementById('empty-state');

const overlay = document.getElementById('import-overlay');
const importTrigger = document.getElementById('import-trigger');
const importCancel = document.getElementById('import-cancel');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const importStatus = document.getElementById('import-status');
const importStatusText = document.getElementById('import-status-text');

const BOOK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;

const DL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
let coverObjectUrls = [];

init();

async function init() {
  const session = await requireAuth();
  if (!session) return; // requireAuth already redirected to login.html

  await renderGrid();

  document.getElementById('logout-btn').addEventListener('click', signOut);

  window.addEventListener('online', renderGrid);
  window.addEventListener('offline', renderGrid);

  importTrigger.addEventListener('click', openOverlay);
  importCancel.addEventListener('click', closeOverlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
  });
}

async function renderGrid() {
  let books;
  try {
    books = await fetchBooks();
  } catch (err) {
    console.error(err);
    grid.innerHTML = `<p style="color:#c4554b">Couldn't load your library.</p>`;
    return;
  }

  coverObjectUrls.forEach((u) => URL.revokeObjectURL(u));
  coverObjectUrls = [];
  const localIds = await localBookIds();
  const localCovers = new Map();
  for (const id of localIds) {
    const u = await localCoverUrl(id);
    if (u) { localCovers.set(id, u); coverObjectUrls.push(u); }
  }

  grid.innerHTML = '';
  emptyState.hidden = books.length > 0;

  for (const book of books) {
    grid.appendChild(renderTile(book, {
      isLocal: localIds.has(book.id),
      localCover: localCovers.get(book.id),
    }));
  }
}

function setOfflineState(btn, saved) {
  btn.classList.toggle('saved', saved);
  btn.setAttribute('aria-pressed', String(saved));
  btn.title = saved ? 'Saved on this device — click to remove' : 'Save for offline reading';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = saved ? CHECK_SVG : DL_SVG;
}

function renderTile(book, { isLocal = false, localCover = null } = {}) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'book-tile';
  tile.setAttribute('aria-label', `Open ${book.title}`);

  const coverUrl = localCover || publicCoverUrl(book.cover_path);
  const progress = Math.max(0, Math.min(100, book.progress_percent || 0));
  const unavailable = !navigator.onLine && !isLocal;
  tile.classList.toggle('unavailable', unavailable);

  tile.innerHTML = `
    <div class="cover-frame">
      ${coverUrl
        ? `<img src="${coverUrl}" alt="" loading="lazy" />`
        : `<div class="cover-fallback">${BOOK_SVG}</div>`}
      <span class="format-badge">${bookFormat(book) === 'pdf' ? 'PDF' : 'EPUB'}</span>
      <button class="book-offline" type="button"></button>
      ${progress > 0 ? `<div class="progress-rail"><span style="width:${progress}%"></span></div>` : ''}
    </div>
    <button class="book-delete" type="button" aria-label="Delete ${escapeHtml(book.title)}">${TRASH_SVG}</button>
    <div class="book-meta">
      <p class="book-title">${escapeHtml(book.title)}</p>
      <p class="book-author">${escapeHtml(book.author || 'Unknown author')}</p>
    </div>
  `;

  // Cover can't load offline unless saved locally: fall back to the placeholder.
  tile.querySelector('.cover-frame img')?.addEventListener('error', (e) => {
    const fb = document.createElement('div');
    fb.className = 'cover-fallback';
    fb.innerHTML = BOOK_SVG;
    e.target.replaceWith(fb);
  });

  tile.addEventListener('click', () => {
    if (!navigator.onLine && !tile.querySelector('.book-offline.saved')) {
      alert('This book is not saved on this device. Reconnect, or save it for offline reading first.');
      return;
    }
    window.location.href = `reader.html?id=${book.id}`;
  });

  const offBtn = tile.querySelector('.book-offline');
  setOfflineState(offBtn, isLocal);
  offBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const wasSaved = offBtn.classList.contains('saved');
    if (wasSaved && !confirm('Remove the offline copy from this device? Your highlights are kept.')) return;
    offBtn.disabled = true;
    offBtn.classList.add('busy');
    try {
      if (wasSaved) await removeBookOffline(book.id);
      else await saveBookOffline(book);
      setOfflineState(offBtn, !wasSaved);
    } catch (err) {
      console.error(err);
      alert(navigator.onLine
        ? 'Could not save the book for offline reading.'
        : 'You need to be online to save a book for offline reading.');
    } finally {
      offBtn.disabled = false;
      offBtn.classList.remove('busy');
    }
  });

  const deleteBtn = tile.querySelector('.book-delete');
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = confirm(`Delete "${book.title}"? This also removes its highlights. This can't be undone.`);
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      await deleteBook(book);
      await renderGrid();
    } catch (err) {
      console.error(err);
      alert(navigator.onLine
        ? 'Could not delete the book. See console for details.'
        : 'Deleting a book requires an internet connection.');
      deleteBtn.disabled = false;
    }
  });

  return tile;
}

function openOverlay() {
  if (!navigator.onLine) { alert('Importing a book requires an internet connection.'); return; }
  overlay.classList.add('open');
  resetImportUi();
}
function closeOverlay() {
  overlay.classList.remove('open');
}

function resetImportUi() {
  fileInput.value = '';
  importStatus.classList.remove('active');
  dropzone.style.display = '';
  importCancel.disabled = false;
}

async function handleFile(file) {
  const lower = file.name.toLowerCase();
  const isPdf = lower.endsWith('.pdf');
  if (!isPdf && !lower.endsWith('.epub')) {
    alert('Please choose an .epub or .pdf file.');
    return;
  }

  dropzone.style.display = 'none';
  importStatus.classList.add('active');
  importCancel.disabled = true;
  setStatus(isPdf ? 'Reading PDF…' : 'Reading EPUB metadata…');

  try {
    const arrayBuffer = await file.arrayBuffer();
    const { title, author, coverBlob } = isPdf
      ? await readPdfInfo(arrayBuffer, file)
      : await readEpubInfo(arrayBuffer, file);

    setStatus('Uploading to your library…');
    const tempId = crypto.randomUUID();
    const filePath = await uploadEpubFile(tempId, file);
    const coverPath = coverBlob ? await uploadCoverBlob(tempId, coverBlob) : null;

    setStatus('Saving…');
    await insertBook({ title, author, filePath, coverPath });

    closeOverlay();
    await renderGrid();
  } catch (err) {
    console.error(err);
    setStatus('Something went wrong — check the console for details.');
    importCancel.disabled = false;
  }
}

async function readEpubInfo(arrayBuffer, file) {
  const book = ePub(arrayBuffer.slice(0));
  await book.ready;
  const metadata = await book.loaded.metadata;
  const title = (metadata.title || file.name.replace(/\.epub$/i, '')).trim();
  const author = (metadata.creator || 'Unknown author').trim();

  let coverBlob = null;
  try {
    const coverUrl = await book.coverUrl();
    if (coverUrl) coverBlob = await (await fetch(coverUrl)).blob();
  } catch { coverBlob = null; }
  return { title, author, coverBlob };
}

async function readPdfInfo(arrayBuffer, file) {
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)) }).promise;
  try {
    const meta = await doc.getMetadata().catch(() => ({ info: {} }));
    const title = (meta.info?.Title || file.name.replace(/\.pdf$/i, '')).trim();
    const author = (meta.info?.Author || 'Unknown author').trim();

    // Cover = first page rendered to a JPEG thumbnail.
    let coverBlob = null;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 520 / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      coverBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    } catch { coverBlob = null; }
    return { title, author, coverBlob };
  } finally {
    doc.destroy();
  }
}

function setStatus(text) {
  importStatusText.textContent = text;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
