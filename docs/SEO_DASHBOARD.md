# SEO Dashboard

## What It Is
- A static UI at `seo/index.html` that reads `seo/data/latest.json`.
- It shows:
  - daily top 5 URLs for manual indexing
  - summary counts
  - top priority URLs
  - OK URLs
  - BAD URLs
  - skipped duplicate URLs
  - skipped already indexed URLs (from GSC list)
  - removal candidates (suggested URLs to remove from indexing)
- Includes keyword search and tabbed sections for quick review.

## How Data Updates
- GitHub Actions workflow `Indexing Booster` runs daily (and on manual run).
- It runs:
  1. `scripts/indexing-booster.js`
  2. `scripts/generate-seo-json.js`
- Then it commits and pushes updated `seo/data/latest.json` back to the repo using `GITHUB_TOKEN`.

## Add Already Indexed URLs (GSC Export)
1. Export URL list from Google Search Console.
2. Put URLs into `seo/data/already_indexed_urls.txt`.
3. One URL per line is best. CSV export also works (script extracts URLs from each line).
4. Workflow/script will skip these URLs from indexing queue automatically.

## UI Upload Option (Quick Local Preview)
- Dashboard UI now has `Already Indexed Upload` control.
- You can upload TXT/CSV directly in browser to preview:
  - which top-priority URLs are already indexed
  - local skip impact with `Hide uploaded-indexed from Top Priority`
- You can download normalized list from UI and save it into `seo/data/already_indexed_urls.txt`.
- Note: UI upload is local/browser-only preview. Repo/workflow changes happen only after file is saved in repo.

## View The Dashboard
1. Open `seo/index.html`.
2. The page loads data from `seo/data/latest.json`.
3. Use tabs and search to inspect URLs.

If direct `file://` load blocks JSON fetch, run a local static server and open `/seo/index.html`.

## Local Run
```bash
node scripts/indexing-booster.js \
  --sitemap https://trinityglobals.com/sitemap.xml \
  --sitemap https://trinityglobals.com/blog/sitemap.xml/ \
  --property sc-domain:trinityglobals.com \
  --top 50 \
  --indexed-file seo/data/already_indexed_urls.txt

node scripts/generate-seo-json.js \
  --sitemap https://trinityglobals.com/sitemap.xml \
  --sitemap https://trinityglobals.com/blog/sitemap.xml/ \
  --property sc-domain:trinityglobals.com
```
