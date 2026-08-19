import {
  fetchBooks,
  insertBook,
  deleteBook,
  uploadEpubFile,
  uploadCoverBlob,
  publicCoverUrl,
} from './supabaseClient.js';

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

init();

async function init() {
  await renderGrid();

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
    grid.innerHTML = `<p style="color:#c4554b">Couldn't reach Supabase. Check js/config.js has your project URL and anon key.</p>`;
    return;
  }

  grid.innerHTML = '';
  emptyState.hidden = books.length > 0;

  for (const book of books) {
    grid.appendChild(renderTile(book));
  }
}

function renderTile(book) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'book-tile';
  tile.setAttribute('aria-label', `Open ${book.title}`);

  const coverUrl = publicCoverUrl(book.cover_path);
  const progress = Math.max(0, Math.min(100, book.progress_percent || 0));

  tile.innerHTML = `
    <div class="cover-frame">
      ${coverUrl
        ? `<img src="${coverUrl}" alt="" loading="lazy" />`
        : `<div class="cover-fallback">${BOOK_SVG}</div>`}
      ${progress > 0 ? `<div class="progress-rail"><span style="width:${progress}%"></span></div>` : ''}
    </div>
    <button class="book-delete" type="button" aria-label="Delete ${escapeHtml(book.title)}">${TRASH_SVG}</button>
    <div class="book-meta">
      <p class="book-title">${escapeHtml(book.title)}</p>
      <p class="book-author">${escapeHtml(book.author || 'Unknown author')}</p>
    </div>
  `;

  tile.addEventListener('click', () => {
    window.location.href = `reader.html?id=${book.id}`;
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
      alert('Could not delete the book. See console for details.');
      deleteBtn.disabled = false;
    }
  });

  return tile;
}

function openOverlay() {
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
  if (!file.name.toLowerCase().endsWith('.epub')) {
    alert('Please choose an .epub file.');
    return;
  }

  dropzone.style.display = 'none';
  importStatus.classList.add('active');
  importCancel.disabled = true;
  setStatus('Reading EPUB metadata…');

  try {
    const arrayBuffer = await file.arrayBuffer();

    // Parse with epub.js purely to pull title / author / cover — the file
    // itself is uploaded as-is right after.
    const book = ePub(arrayBuffer.slice(0));
    await book.ready;
    const metadata = await book.loaded.metadata;
    const title = (metadata.title || file.name.replace(/\.epub$/i, '')).trim();
    const author = (metadata.creator || 'Unknown author').trim();

    let coverBlob = null;
    try {
      const coverUrl = await book.coverUrl();
      if (coverUrl) {
        const res = await fetch(coverUrl);
        coverBlob = await res.blob();
      }
    } catch {
      coverBlob = null;
    }

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

function setStatus(text) {
  importStatusText.textContent = text;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
