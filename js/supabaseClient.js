import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import * as local from './offline.js';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export function bookFormat(book) {
  return /\.pdf$/i.test(book?.file_path || '') ? 'pdf' : 'epub';
}

const EPUB_BUCKET = 'epub-files';
const COVER_BUCKET = 'book-covers';
const timeout = () => AbortSignal.timeout(8000);

// Re-export so pages only import from one place.
export const { localBookIds } = local;
export const localCoverUrl = local.getCoverBlobUrl;
export const removeBookOffline = local.removeLocalBook;

async function currentUserId() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user?.id) return session.user.id;
  } catch {}
  return localStorage.getItem('marginal:userId');
}

// ---------------------------------------------------------------------------
// Sync engine: replays queued changes against Supabase, in order
// ---------------------------------------------------------------------------

let syncing = null;
let rerun = false;

export function syncQueue() {
  if (syncing) { rerun = true; return syncing; }
  syncing = doSync().finally(() => {
    syncing = null;
    if (rerun) { rerun = false; syncQueue(); }
  });
  return syncing;
}

async function doSync() {
  if (!navigator.onLine) return;
  try {
    const { data: { session } } = await supabase.auth.getSession(); // refreshes expired token
    if (!session) return;

    await syncProgress();

    for (const op of await local.getQueue()) {
      const err = await runOp(op);
      if (!err) { await local.removeQueued(op.seq); continue; }
      // 5-digit codes are Postgres errors (FK/RLS violations…): retrying never helps.
      if (/^\d{5}$/.test(err.code || '')) {
        console.warn('Dropping unsyncable change', op, err);
        await local.removeQueued(op.seq);
        continue;
      }
      break; // network / auth hiccup: keep the queue and retry later
    }
  } catch (err) {
    console.warn('Sync failed, will retry', err);
  }
}

async function runOp(op) {
  switch (op.type) {
    case 'insertHighlight': {
      const { error } = await supabase.from('highlights').insert(op.row);
      return error?.code === '23505' ? null : error; // already inserted = success
    }
    case 'deleteHighlight':
      return (await supabase.from('highlights').delete().eq('id', op.id)).error;
    case 'upsertReaction':
      return (await supabase.from('highlight_reactions')
        .upsert(op.row, { onConflict: 'highlight_id' })).error;
  }
  return null;
}

async function syncProgress() {
  for (const [id, p] of Object.entries(local.getPendingProgress())) {
    const { error } = await supabase.from('books')
      .update({ location_cfi: p.locationCfi, progress_percent: p.progressPercent })
      .eq('id', id);
    if (!error) local.clearPendingProgress(id, p.locationCfi);
  }
}

window.addEventListener('online', () => syncQueue());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncQueue();
});

const withPendingProgress = (book) => {
  const p = local.getPendingProgress()[book.id];
  return p ? { ...book, location_cfi: p.locationCfi, progress_percent: p.progressPercent } : book;
};

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

export async function fetchBooks() {
  await Promise.race([syncQueue(), new Promise((r) => setTimeout(r, 4000))]);
  if (navigator.onLine) {
    try {
      const { data, error } = await supabase
        .from('books').select('*')
        .order('created_at', { ascending: false })
        .abortSignal(timeout());
      if (error) throw error;
      await local.replaceAll('books', data);
      return data.map(withPendingProgress);
    } catch (err) { console.warn('Using cached library', err); }
  }
  const rows = await local.idb.getAll('books');
  rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return rows.map(withPendingProgress);
}

export async function fetchBook(id) {
  if (navigator.onLine) {
    try {
      const { data, error } = await supabase
        .from('books').select('*').eq('id', id).single()
        .abortSignal(timeout());
      if (error) throw error;
      await local.idb.put('books', data);
      return withPendingProgress(data);
    } catch (err) { console.warn('Using cached book row', err); }
  }
  const cached = await local.idb.get('books', id);
  if (!cached) throw new Error('Book not available offline');
  return withPendingProgress(cached);
}

export async function insertBook({ title, author, filePath, coverPath }) {
  const { data, error } = await supabase
    .from('books')
    .insert({ title, author, file_path: filePath, cover_path: coverPath })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateBookProgress(id, { locationCfi, progressPercent }) {
  local.setPendingProgress(id, { locationCfi, progressPercent });
  const cached = await local.idb.get('books', id);
  if (cached) {
    await local.idb.put('books', { ...cached, location_cfi: locationCfi, progress_percent: progressPercent });
  }
  if (!navigator.onLine) return;
  const { error } = await supabase
    .from('books')
    .update({ location_cfi: locationCfi, progress_percent: progressPercent })
    .eq('id', id);
  if (!error) local.clearPendingProgress(id, locationCfi);
  // on error it simply stays pending and is retried by syncQueue()
}

export function flushBookProgress(id, { locationCfi, progressPercent }) {
  if (!locationCfi) return;
  local.setPendingProgress(id, { locationCfi, progressPercent }); // synchronous, always survives
  if (!navigator.onLine) return;
  try {
    fetch(`${SUPABASE_URL}/rest/v1/books?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ location_cfi: locationCfi, progress_percent: progressPercent }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

export async function deleteBook(book) {
  if (!navigator.onLine) throw new Error('Deleting a book requires an internet connection');

  await supabase.storage.from(EPUB_BUCKET).remove([book.file_path]);
  if (book.cover_path) {
    await supabase.storage.from(COVER_BUCKET).remove([book.cover_path]);
  }
  const { error } = await supabase.from('books').delete().eq('id', book.id);
  if (error) throw error;

  await local.removeLocalBook(book.id);
  await local.idb.del('books', book.id);
  await local.replaceByIndex('highlights', 'book_id', book.id, []);
  await local.replaceByIndex('reactions', 'book_id', book.id, []);
}

// ---------------------------------------------------------------------------
// Offline ebook copies
// ---------------------------------------------------------------------------

// Local copy if there is one, otherwise download.
export async function getBookBuffer(book) {
  const f = await local.getBookFile(book.id);
  if (f) return f.buffer;
  const res = await fetch(publicEpubUrl(book.file_path));
  if (!res.ok) throw new Error(`Could not download book (${res.status})`);
  return res.arrayBuffer();
}

export async function saveBookOffline(book) {
  const res = await fetch(publicEpubUrl(book.file_path));
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buffer = await res.arrayBuffer();
  await local.saveBookFile(book.id, buffer, res.headers.get('content-type') || '');

  if (book.cover_path) {
    try {
      const c = await fetch(publicCoverUrl(book.cover_path));
      if (c.ok) await local.saveCover(book.id, await c.arrayBuffer(), c.headers.get('content-type') || 'image/jpeg');
    } catch {}
  }
  await local.idb.put('books', book);
  navigator.storage?.persist?.(); // ask the browser not to evict it
}

// ---------------------------------------------------------------------------
// Storage uploads
// ---------------------------------------------------------------------------

export async function uploadEpubFile(id, file) {
  const path = `${id}/${sanitizeFilename(file.name)}`;
  const isPdf = /\.pdf$/i.test(file.name);
  const { error } = await supabase.storage.from(EPUB_BUCKET).upload(path, file, {
    contentType: isPdf ? 'application/pdf' : 'application/epub+zip',
    upsert: true,
  });
  if (error) throw error;
  return path;
}

export async function uploadCoverBlob(id, blob) {
  if (!blob) return null;
  const ext = blob.type === 'image/png' ? 'png' : 'jpg';
  const path = `${id}/cover.${ext}`;
  const { error } = await supabase.storage.from(COVER_BUCKET).upload(path, blob, {
    contentType: blob.type || 'image/jpeg',
    upsert: true,
  });
  if (error) throw error;
  return path;
}

export function publicEpubUrl(path) {
  return supabase.storage.from(EPUB_BUCKET).getPublicUrl(path).data.publicUrl;
}

export function publicCoverUrl(path) {
  if (!path) return null;
  return supabase.storage.from(COVER_BUCKET).getPublicUrl(path).data.publicUrl;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

// ---------------------------------------------------------------------------
// Highlights (local-first; synced in the background)
// ---------------------------------------------------------------------------

export async function fetchHighlights(bookId) {
  await Promise.race([syncQueue(), new Promise((r) => setTimeout(r, 4000))]);
  const pending = (await local.getQueue()).length;

  // Only trust the server when nothing local is waiting to be uploaded.
  if (navigator.onLine && !pending) {
    try {
      const { data, error } = await supabase
        .from('highlights').select('*').eq('book_id', bookId)
        .order('created_at', { ascending: true })
        .abortSignal(timeout());
      if (error) throw error;
      await local.replaceByIndex('highlights', 'book_id', bookId, data);
      return data;
    } catch (err) { console.warn('Using cached highlights', err); }
  }
  const rows = await local.idb.getAllByIndex('highlights', 'book_id', bookId);
  return rows.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}

export async function insertHighlight({ bookId, cfiRange, textSnippet, color = 'lightblue' }) {
  const row = {
    id: crypto.randomUUID(),
    book_id: bookId,
    cfi_range: cfiRange,
    text_snippet: textSnippet,
    color,
    created_at: new Date().toISOString(),
  };
  await local.idb.put('highlights', row);
  await local.enqueue({ type: 'insertHighlight', row });
  syncQueue(); // fire and forget — UI never waits on the network
  return row;
}

export async function deleteHighlight(id) {
  // Drop anything still queued for this highlight, then queue the delete.
  for (const op of await local.getQueue()) {
    if ((op.type === 'insertHighlight' && op.row.id === id) ||
        (op.type === 'upsertReaction' && op.row.highlight_id === id)) {
      await local.removeQueued(op.seq);
    }
  }
  await local.idb.del('highlights', id);
  await local.idb.del('reactions', id);
  await local.enqueue({ type: 'deleteHighlight', id });
  syncQueue();
}

export async function countHighlights(bookId) {
  const { count, error } = await supabase
    .from('highlights')
    .select('id', { count: 'exact', head: true })
    .eq('book_id', bookId);
  if (error) throw error;
  return count ?? 0;
}

// Reactions ------------------------------------------------------------

export async function fetchReactionsForBook(bookId) {
  const pending = (await local.getQueue()).length;
  if (navigator.onLine && !pending) {
    try {
      const { data, error } = await supabase
        .from('highlight_reactions')
        .select('*, highlights!inner(book_id)')
        .eq('highlights.book_id', bookId)
        .abortSignal(timeout());
      if (error) throw error;
      const rows = data.map(({ highlights, ...r }) => ({ ...r, book_id: highlights.book_id }));
      await local.replaceByIndex('reactions', 'book_id', bookId, rows);
      return rows;
    } catch (err) { console.warn('Using cached reactions', err); }
  }
  return local.idb.getAllByIndex('reactions', 'book_id', bookId);
}

export async function upsertReaction({ highlightId, type, emoji = null, comment = null }) {
  const userId = await currentUserId();
  const row = { highlight_id: highlightId, user_id: userId, type, emoji, comment };

  const hl = await local.idb.get('highlights', highlightId);
  await local.idb.put('reactions', { ...row, book_id: hl?.book_id });

  for (const op of await local.getQueue()) { // only the latest reaction per highlight matters
    if (op.type === 'upsertReaction' && op.row.highlight_id === highlightId) {
      await local.removeQueued(op.seq);
    }
  }
  await local.enqueue({ type: 'upsertReaction', row });
  syncQueue();
  return row;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const PROFILE_BUCKET = 'profile-media';

export async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data; // null if the user never saved a profile
}

export async function saveProfile(userId, { displayName, bio, avatarPath, coverPath }) {
  const { data, error } = await supabase
    .from('profiles')
    .upsert({
      id: userId,
      display_name: displayName,
      bio,
      avatar_path: avatarPath,
      cover_path: coverPath,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Unique filename per upload => no stale CDN/browser cache after changing a picture.
export async function uploadProfileImage(userId, kind, blob) {
  const path = `${userId}/${kind}-${Date.now()}.jpg`;
  const { error } = await supabase.storage.from(PROFILE_BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
  });
  if (error) throw error;
  return path;
}

export async function removeProfileImage(path) {
  if (!path) return;
  await supabase.storage.from(PROFILE_BUCKET).remove([path]); // best effort
}

export function publicProfileMediaUrl(path) {
  if (!path) return null;
  return supabase.storage.from(PROFILE_BUCKET).getPublicUrl(path).data.publicUrl;
}

export async function fetchPublicHighlights(userId, { limit = 8, offset = 0 } = {}) {
  const { data, error } = await supabase.rpc('get_public_highlights', {
    p_user: userId,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  return data || [];
}