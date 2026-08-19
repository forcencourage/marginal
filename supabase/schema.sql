-- ============================================================================
-- Marginal — Supabase schema
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query)
-- ============================================================================

-- Extension needed for gen_random_uuid()
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table if not exists public.books (
  id               uuid primary key default gen_random_uuid(),
  title            text not null default 'Untitled',
  author           text default 'Unknown author',
  file_path        text not null,           -- path inside the "epub-files" storage bucket
  cover_path       text,                    -- path inside the "book-covers" storage bucket, null if no cover
  location_cfi     text,                    -- last-read EPUB CFI, used to resume reading
  progress_percent numeric default 0,       -- 0–100, updated as the reader scrolls
  created_at       timestamptz not null default now()
);

create table if not exists public.highlights (
  id            uuid primary key default gen_random_uuid(),
  book_id       uuid not null references public.books(id) on delete cascade,
  cfi_range     text not null,              -- EPUB CFI range for the selection
  text_snippet  text,                       -- the highlighted text, for display in the side panel
  color         text not null default 'lightblue',
  created_at    timestamptz not null default now()
);

create index if not exists highlights_book_id_idx on public.highlights (book_id);

-- ----------------------------------------------------------------------------
-- Row Level Security
--
-- This app has no login screen — every visitor reads/writes with the Supabase
-- anon key directly from the browser, which is the simplest thing that works
-- for a personal, single-user GitHub Pages deployment. The policies below
-- simply allow the anon role to do everything on these two tables.
--
-- If you ever plan to share the deployed URL with anyone else, add Supabase
-- Auth and swap these for per-user policies (e.g. `user_id = auth.uid()`)
-- before you do — as written, anyone with the URL can read/edit/delete
-- every book and highlight.
-- ----------------------------------------------------------------------------

alter table public.books enable row level security;
alter table public.highlights enable row level security;

drop policy if exists "anon full access books" on public.books;
create policy "anon full access books"
  on public.books for all
  to anon
  using (true)
  with check (true);

drop policy if exists "anon full access highlights" on public.highlights;
create policy "anon full access highlights"
  on public.highlights for all
  to anon
  using (true)
  with check (true);

-- ----------------------------------------------------------------------------
-- Storage buckets
--
-- Run this section too — it creates two public buckets:
--   epub-files   the raw .epub files
--   book-covers  extracted cover images (jpg/png)
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('epub-files', 'epub-files', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('book-covers', 'book-covers', true)
on conflict (id) do nothing;

drop policy if exists "anon full access epub-files" on storage.objects;
create policy "anon full access epub-files"
  on storage.objects for all
  to anon
  using (bucket_id = 'epub-files')
  with check (bucket_id = 'epub-files');

drop policy if exists "anon full access book-covers" on storage.objects;
create policy "anon full access book-covers"
  on storage.objects for all
  to anon
  using (bucket_id = 'book-covers')
  with check (bucket_id = 'book-covers');
