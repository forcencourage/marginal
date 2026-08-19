import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const EPUB_BUCKET = 'epub-files';
const COVER_BUCKET = 'book-covers';

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

export async function fetchBooks() {
  const { data, error } = await supabase
    .from('books')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function fetchBook(id) {
  const { data, error } = await supabase
    .from('books')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
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
  const { error } = await supabase
    .from('books')
    .update({ location_cfi: locationCfi, progress_percent: progressPercent })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteBook(book) {
  const paths = [book.file_path];
  if (book.cover_path) paths.push(book.cover_path);

  await supabase.storage.from(EPUB_BUCKET).remove([book.file_path]);
  if (book.cover_path) {
    await supabase.storage.from(COVER_BUCKET).remove([book.cover_path]);
  }
  // highlights are removed automatically via ON DELETE CASCADE
  const { error } = await supabase.from('books').delete().eq('id', book.id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Storage uploads
// ---------------------------------------------------------------------------

export async function uploadEpubFile(id, file) {
  const path = `${id}/${sanitizeFilename(file.name)}`;
  const { error } = await supabase.storage.from(EPUB_BUCKET).upload(path, file, {
    contentType: 'application/epub+zip',
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
// Highlights
// ---------------------------------------------------------------------------

export async function fetchHighlights(bookId) {
  const { data, error } = await supabase
    .from('highlights')
    .select('*')
    .eq('book_id', bookId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function insertHighlight({ bookId, cfiRange, textSnippet, color = 'lightblue' }) {
  const { data, error } = await supabase
    .from('highlights')
    .insert({ book_id: bookId, cfi_range: cfiRange, text_snippet: textSnippet, color })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteHighlight(id) {
  const { error } = await supabase.from('highlights').delete().eq('id', id);
  if (error) throw error;
}

export async function countHighlights(bookId) {
  const { count, error } = await supabase
    .from('highlights')
    .select('id', { count: 'exact', head: true })
    .eq('book_id', bookId);
  if (error) throw error;
  return count ?? 0;
}
