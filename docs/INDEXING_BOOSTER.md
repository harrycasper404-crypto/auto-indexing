# TrinityGlobals Indexing Booster

## What This Automation Does
- Fetches sitemap XML (`https://trinityglobals.com/sitemap.xml` by default in workflow).
- Parses all `<url>` entries and extracts `loc` and `lastmod` (if present).
- Skips numeric duplicate slugs ending with `-<number>` (for example `.../cheap-flights-usa-2/`).
- Scores and sorts URLs by priority:
  - Highest: cancel/cancellation/refundable/refund/change/modify/reschedule/rebook/basic-economy/fee(s)
  - Medium: route and destination patterns (uk, paris, dubai, uae, mexico, africa, europe, hong-kong, toronto, etc.)
  - Normal: cheap/best/deals/discount/book/booking/domestic/international/nonstop/price-comparison
- Checks HTTP status for top N URLs (default 50) with concurrency limit 10.
- Generates output files:
  - `urls_all.txt`
  - `urls_skipped_duplicates.txt`
  - `urls_priority_sorted.txt`
  - `urls_priority_top50.txt`
  - `urls_ok.txt`
  - `urls_bad.txt`
  - `inspect_links_priority_top50.txt`

## What It Does Not Do
- It does not call an official API to auto-submit generic blog/article URLs for indexing.
- For normal websites, there is no public "request indexing for any URL" API.

## Run Locally
```bash
node scripts/indexing-booster.js \
  --sitemap https://trinityglobals.com/sitemap.xml \
  --property sc-domain:trinityglobals.com \
  --top 50
```

Or:
```bash
npm run indexing:booster
```

## GitHub Actions Artifacts
1. Open repository on GitHub.
2. Click `Actions`.
3. Click workflow `Indexing Booster`.
4. Open a run and download artifact `indexing-booster-output`.

## Daily Routine
1. Open `inspect_links_priority_top50.txt` from artifact.
2. Open top 5 to 10 inspect links in Search Console.
3. Use `Request indexing` manually for those URLs.
4. Repeat daily with the next batch.
