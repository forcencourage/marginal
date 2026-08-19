# Marginal — a minimal EPUB library + reader on GitHub Pages

A static, no-build e-reading app. Books and highlights live in Supabase;
the site itself is plain HTML/CSS/JS you can host on GitHub Pages for free.

- **Library** (`index.html`) — grid of your books by cover, with an import button.
- **Reader** (`reader.html`) — the book on the right (2/3 width on desktop),
  your highlights for that book on the left (1/3 width). Mobile shows only
  the book.
- Select any text in the book and it's highlighted in light blue immediately
  and saved to Supabase. Click a highlight in the left panel to jump straight
  to it in the book. Both individual highlights and whole books (with all
  their highlights) can be deleted from the UI.
- Reading position is saved as you scroll, so reopening a book resumes where
  you left off.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free project.
2. Open **SQL Editor → New query**, paste in the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates:
   - `books` and `highlights` tables, with `highlights.book_id` cascading
     on delete.
   - Two **public** storage buckets: `epub-files` and `book-covers`.
   - Row Level Security policies that let the `anon` key read/write both
     tables and both buckets.
3. Go to **Project Settings → API** and copy the **Project URL** and the
   **anon / public key**.

> **Security note:** this app has no login screen — it's built for a single
> reader using their own Supabase project, with the anon key doing all the
> work directly from the browser. The RLS policies in `schema.sql` grant the
> anon role full read/write/delete access to every book and highlight. That's
> fine for a private deployment only you know the URL to. If you ever share
> the site publicly, add Supabase Auth and scope the policies to
> `auth.uid()` first.

## 2. Configure the site

Open [`js/config.js`](js/config.js) and fill in the two values:

```js
export const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

## 3. Run it locally (optional)

Any static file server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed URL. (Opening `index.html` directly via `file://` will
not work — ES modules and `fetch` both require an actual HTTP origin.)

## 4. Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch",
   pick your branch (e.g. `main`) and the root (`/`) folder.
4. Save — GitHub gives you a URL like `https://your-user.github.io/repo-name/`.

That's it — no build step, no CI, just static files.

## How it's built

- **epub.js** (via CDN) parses and renders EPUBs client-side, in a
  `scrolled-doc` continuous-scroll layout so "jump to a highlight" is a
  smooth scroll rather than a page flip.
- **Text selection → highlight**: the `selected` event from epub.js gives a
  CFI range for whatever was selected. That range is immediately painted as
  a light-blue annotation in the page and written to the `highlights` table.
- **Reading position**: the `relocated` event fires as you scroll; the
  current CFI (and, once `book.locations` has finished generating in the
  background, a percentage) is saved to `books.location_cfi` /
  `progress_percent`, debounced so it isn't hammering the database.
- **Covers**: pulled from the EPUB itself at import time via
  `book.coverUrl()` and stored as a separate image in the `book-covers`
  bucket, so the library grid doesn't need to re-parse every EPUB just to
  show a thumbnail.

## File map

```
index.html          Library — grid + import
reader.html          Reader — highlights panel + book pane
css/style.css        Design system (shared by both pages)
js/config.js          ← put your Supabase URL/key here
js/supabaseClient.js Data-access helpers (books, highlights, storage)
js/main.js            Library page logic
js/reader.js          Reader page logic
supabase/schema.sql   Tables, RLS policies, storage buckets
```
