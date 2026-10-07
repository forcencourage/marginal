import {
  supabase, fetchProfile, saveProfile, uploadProfileImage, removeProfileImage,
  publicProfileMediaUrl, fetchPublicHighlights,
} from './supabaseClient.js';
import { signOut } from './auth.js';

const PAGE_SIZE = 8;

const params = new URLSearchParams(window.location.search);

const navEl = document.getElementById('pf-nav');
const coverEl = document.getElementById('pf-cover');
const avatarEl = document.getElementById('pf-avatar');
const nameEl = document.getElementById('pf-name');
const bioEl = document.getElementById('pf-bio');
const actionsEl = document.getElementById('pf-actions');

const listEl = document.getElementById('pf-list');
const loadingEl = document.getElementById('pf-loading');
const emptyEl = document.getElementById('pf-empty');
const errorEl = document.getElementById('pf-error');
const loadMoreBtn = document.getElementById('load-more');

const editOverlay = document.getElementById('edit-overlay');
const editCoverPreview = document.getElementById('edit-cover-preview');
const editAvatarPreview = document.getElementById('edit-avatar-preview');
const coverInput = document.getElementById('cover-input');
const avatarInput = document.getElementById('avatar-input');
const editName = document.getElementById('edit-name');
const editBio = document.getElementById('edit-bio');
const bioCount = document.getElementById('bio-count');
const editError = document.getElementById('edit-error');
const editSave = document.getElementById('edit-save');
const editCancel = document.getElementById('edit-cancel');

let viewer = null;
let profileUserId = null;
let isOwner = false;
let profile = null;

let offset = 0;
let hasMore = true;
let loading = false;

let pendingAvatar = null; // Blob
let pendingCover = null;  // Blob
const clampMeasurers = [];

init();

async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  viewer = session?.user ?? null;

  profileUserId = params.get('u') || viewer?.id || null;
  if (!profileUserId) { window.location.href = 'login.html'; return; }
  isOwner = viewer?.id === profileUserId;

  renderNav();
  bindEditor();
  loadMoreBtn.addEventListener('click', loadMore);

  try { profile = await fetchProfile(profileUserId); }
  catch (err) { console.error(err); profile = null; }
  renderProfile();

  await loadMore();

  document.fonts?.ready.then(remeasureClamps);
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(remeasureClamps, 150); });
}

// ---------------------------------------------------------------------------
// Header + profile header
// ---------------------------------------------------------------------------

function renderNav() {
  navEl.innerHTML = '';
  if (viewer) {
    const lib = document.createElement('a');
    lib.className = 'btn btn-ghost'; lib.href = 'index.html'; lib.textContent = 'Library';
    const out = document.createElement('button');
    out.className = 'btn btn-ghost'; out.type = 'button'; out.textContent = 'Sign out';
    out.addEventListener('click', signOut);
    navEl.append(lib, out);
  } else {
    const a = document.createElement('a');
    a.className = 'btn'; a.href = 'login.html'; a.textContent = 'Sign in';
    navEl.append(a);
  }
}

function displayName() {
  return (profile?.display_name || '').trim() || (isOwner ? 'Add your name' : 'Anonymous reader');
}

function renderProfile() {
  const coverUrl = publicProfileMediaUrl(profile?.cover_path);
  coverEl.style.backgroundImage = coverUrl ? `url("${coverUrl}")` : '';

  paintAvatar(avatarEl, publicProfileMediaUrl(profile?.avatar_path));

  nameEl.textContent = displayName();
  bioEl.textContent = (profile?.bio || '').trim() || (isOwner ? 'Add a short bio so readers know who you are.' : '');
  document.title = `${displayName()} — Marginal`;

  actionsEl.innerHTML = '';
  const copy = document.createElement('button');
  copy.className = 'btn btn-ghost btn-sm'; copy.type = 'button'; copy.textContent = 'Copy link';
  copy.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?u=${profileUserId}`;
    try { await navigator.clipboard.writeText(url); copy.textContent = 'Copied'; }
    catch { window.prompt('Copy this link', url); }
    setTimeout(() => (copy.textContent = 'Copy link'), 1500);
  });
  actionsEl.append(copy);

  if (isOwner) {
    const edit = document.createElement('button');
    edit.className = 'btn btn-sm'; edit.type = 'button'; edit.textContent = 'Edit profile';
    edit.addEventListener('click', openEditor);
    actionsEl.append(edit);
  }
}

function paintAvatar(el, url) {
  if (url) {
    el.style.backgroundImage = `url("${url}")`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = (profile?.display_name || '?').trim().charAt(0).toUpperCase() || '?';
  }
}

// ---------------------------------------------------------------------------
// Highlights feed
// ---------------------------------------------------------------------------

async function loadMore() {
  if (loading || !hasMore) return;
  loading = true;
  errorEl.hidden = true;
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = 'Loading…';
  if (offset === 0) loadingEl.hidden = false;

  try {
    // Ask for one extra row to know whether another page exists.
    const rows = await fetchPublicHighlights(profileUserId, { limit: PAGE_SIZE + 1, offset });
    hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);

    for (const row of page) listEl.appendChild(renderBubble(row));
    offset += page.length;

    emptyEl.hidden = offset > 0;
    if (offset === 0) emptyEl.textContent = isOwner ? 'No highlights yet. Select text while reading to create one.' : 'No highlights yet.';
  } catch (err) {
    console.error(err);
    errorEl.hidden = false;
  } finally {
    loading = false;
    loadingEl.hidden = true;
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = 'Load more';
    loadMoreBtn.hidden = !hasMore;
  }
}

function renderBubble(h) {
  const hasReaction = Boolean(h.reaction_type);
  const isComment = h.reaction_type === 'comment' && h.reaction_comment;

  const el = document.createElement('article');
  el.className = 'bubble' + (hasReaction ? '' : ' no-reaction') + (isComment ? ' has-comment' : '');

  const href = `reader.html?id=${encodeURIComponent(h.book_id)}&hl=${encodeURIComponent(h.id)}`;

  el.innerHTML = `
    ${hasReaction ? `<div class="bubble-reaction">${reactionHtml(h)}</div>` : ''}
    <div class="bubble-body">
      <div>
        <p class="hl-text clamp"><a class="hl-link" href="${href}" title="Open in ${escapeAttr(h.book_title || 'book')}">${escapeHtml(h.text_snippet || '')}</a></p>
        <button class="toggle-more" type="button" aria-expanded="false" hidden>Read more</button>
      </div>
      <span class="hl-date">${postedOn(h.created_at)}</span>
    </div>
  `;

  setupClamp(el.querySelector('.hl-text'), el.querySelector('.bubble-body .toggle-more'));

  const commentEl = el.querySelector('.reaction-comment');
  if (commentEl) {
    const btn = document.createElement('button');
    btn.className = 'toggle-more'; btn.type = 'button'; btn.hidden = true; btn.textContent = 'Read more';
    commentEl.after(btn);
    setupClamp(commentEl, btn);
  }
  return el;
}

function reactionHtml(h) {
  if (h.reaction_type === 'like') return `<img src="reactions/like.png" alt="Liked" />`;
  if (h.reaction_type === 'emoji' && h.reaction_emoji) {
    return `<img src="reactions/emojis/${encodeURIComponent(h.reaction_emoji)}" alt="Reaction" />`;
  }
  if (h.reaction_type === 'comment' && h.reaction_comment) {
    return `<div class="reaction-comment clamp">${sanitize(h.reaction_comment)}</div>`;
  }
  return '';
}

// Comments are user-written HTML shown to the public: always sanitize.
function sanitize(html) {
  if (window.DOMPurify) {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 'b', 'i', 'ul', 'ol', 'li', 'a'],
      ALLOWED_ATTR: ['href', 'target', 'rel'],
    });
  }
  return escapeHtml(html.replace(/<[^>]+>/g, ' '));
}

// ---------------------------------------------------------------------------
// Read more / read less
// ---------------------------------------------------------------------------

function setupClamp(textEl, btn) {
  const measure = () => {
    if (textEl.classList.contains('expanded')) return;
    btn.hidden = textEl.scrollHeight <= textEl.clientHeight + 1;
  };
  btn.addEventListener('click', () => {
    const open = textEl.classList.toggle('expanded');
    btn.textContent = open ? 'Read less' : 'Read more';
    btn.setAttribute('aria-expanded', String(open));
  });
  clampMeasurers.push(measure);
  requestAnimationFrame(measure);
}

function remeasureClamps() { clampMeasurers.forEach((fn) => fn()); }

// ---------------------------------------------------------------------------
// Date: "posted on October 6th 2026"
// ---------------------------------------------------------------------------

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function postedOn(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const month = d.toLocaleString('en-US', { month: 'long' });
  return `posted on ${month} ${ordinal(d.getDate())} ${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Editor (owner only)
// ---------------------------------------------------------------------------

function bindEditor() {
  editCancel.addEventListener('click', closeEditor);
  editOverlay.addEventListener('click', (e) => { if (e.target === editOverlay) closeEditor(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEditor(); });

  document.getElementById('pick-cover').addEventListener('click', () => coverInput.click());
  document.getElementById('pick-avatar').addEventListener('click', () => avatarInput.click());

  coverInput.addEventListener('change', async () => {
    const file = coverInput.files?.[0];
    if (!file) return;
    try {
      pendingCover = await resizeToBlob(file, 1600, 533);
      editCoverPreview.style.backgroundImage = `url("${URL.createObjectURL(pendingCover)}")`;
    } catch { showEditError('That image could not be read.'); }
    coverInput.value = '';
  });

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    try {
      pendingAvatar = await resizeToBlob(file, 512, 512);
      editAvatarPreview.style.backgroundImage = `url("${URL.createObjectURL(pendingAvatar)}")`;
      editAvatarPreview.textContent = '';
    } catch { showEditError('That image could not be read.'); }
    avatarInput.value = '';
  });

  editBio.addEventListener('input', updateBioCount);
  editSave.addEventListener('click', saveEditor);
}

function openEditor() {
  if (!isOwner) return;
  pendingAvatar = null; pendingCover = null;
  editError.hidden = true;

  editName.value = profile?.display_name || '';
  editBio.value = profile?.bio || '';
  updateBioCount();

  const cover = publicProfileMediaUrl(profile?.cover_path);
  editCoverPreview.style.backgroundImage = cover ? `url("${cover}")` : '';
  const avatar = publicProfileMediaUrl(profile?.avatar_path);
  paintAvatar(editAvatarPreview, avatar);

  editOverlay.classList.add('open');
  editName.focus();
}

function closeEditor() { editOverlay.classList.remove('open'); }
function updateBioCount() { bioCount.textContent = `${editBio.value.length}/280`; }
function showEditError(msg) { editError.textContent = msg; editError.hidden = false; }

async function saveEditor() {
  editError.hidden = true;
  editSave.disabled = true; editCancel.disabled = true;
  editSave.textContent = 'Saving…';

  const oldAvatar = profile?.avatar_path || null;
  const oldCover = profile?.cover_path || null;

  try {
    let avatarPath = oldAvatar;
    let coverPath = oldCover;
    if (pendingAvatar) avatarPath = await uploadProfileImage(profileUserId, 'avatar', pendingAvatar);
    if (pendingCover) coverPath = await uploadProfileImage(profileUserId, 'cover', pendingCover);

    profile = await saveProfile(profileUserId, {
      displayName: editName.value.trim() || null,
      bio: editBio.value.trim() || null,
      avatarPath,
      coverPath,
    });

    if (pendingAvatar && oldAvatar) removeProfileImage(oldAvatar);
    if (pendingCover && oldCover) removeProfileImage(oldCover);

    renderProfile();
    closeEditor();
  } catch (err) {
    console.error(err);
    showEditError('Could not save your profile. Please try again.');
  } finally {
    editSave.disabled = false; editCancel.disabled = false;
    editSave.textContent = 'Save';
  }
}

// Center-crop to w×h and re-encode as JPEG to keep uploads small.
async function resizeToBlob(file, w, h) {
  const bmp = await createImageBitmap(file);
  const scale = Math.max(w / bmp.width, h / bmp.height);
  const sw = w / scale, sh = h / scale;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, h);
  bmp.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.88));
}

// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}