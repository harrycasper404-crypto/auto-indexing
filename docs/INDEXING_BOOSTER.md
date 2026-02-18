# TrinityGlobals Auto Indexing Booster

## What It Does
- Fetches a sitemap URL (supports both `urlset` and `sitemapindex`).
- Extracts page URLs and `lastmod`.
- Skips numeric duplicate slugs where a base slug exists (example: `some-page-2` when `some-page` exists).
- Scores and sorts URLs by indexing priority:
  - Highest intent terms: `cancel`, `refund`, `refundable`, `change`, `modify`, `reschedule`, `rebook`, `basic-economy`, `fees`
  - Medium route/destination terms: `routes`, `destinations`, `us-to-uk`, `london`, `dubai`, `uae`, `mexico`, `africa`, `europe`, `paris`, `hong-kong`
  - Normal commercial terms: `cheap`, `best`, `deals`, `discount`, `book`, `domestic`, `international`, `nonstop`, `price-comparison`
- Pings Google and Bing with the sitemap URL.
- Validates the top N URLs by HTTP status (2xx/3xx = ok).
- Produces output text files for review and manual indexing workflow.

## What It Does Not Do
- It does **not** call an official Google API to force indexing requests for arbitrary pages.
- Google does not offer a generic public "request indexing for any URL" API for normal websites.
- The script prepares high-priority inspect links so you can do controlled manual requests in Search Console.

## Local Run
```bash
node scripts/indexing-booster.js \
  --sitemap https://trinityglobals.com/sitemap.xml \
  --property sc-domain:trinityglobals.com \
  --top 50
```

If `package.json` includes the npm script:
```bash
npm run indexing:booster
```

## Output Files
- `urls_all.txt`
- `urls_skipped_duplicates.txt`
- `urls_priority_sorted.txt`
- `urls_priority_top50.txt`
- `urls_ok.txt`
- `urls_bad.txt`
- `inspect_links_priority_top50.txt`

## GitHub Actions Artifacts
1. Open the repository on GitHub.
2. Go to `Actions` -> `Indexing Booster`.
3. Open a run (scheduled or manually triggered).
4. Download artifact: `indexing-booster-output`.

## How To Use `inspect_links_priority_top50.txt`
1. Open the file and take the top 10 links for the day.
2. Open each inspect URL in a browser logged into Search Console.
3. For each URL, click **Request indexing** manually.
4. Repeat daily from the next batch.
