# Daily Top 5 (AI Assisted)

## What It Does
- Reads booster output files:
  - `urls_priority_sorted.txt`
  - `urls_ok.txt`
  - `urls_bad.txt`
  - `urls_skipped_duplicates.txt`
- Builds top candidates (up to 50) with score, lastmod, status, and topic bucket.
- Selects 5 URLs for manual Search Console `Request indexing`.
- Writes `seo/data/daily_top5.json`.

## Selection Logic
- Primary: OpenAI API selection (`OPENAI_API_KEY`) with strict JSON output.
- Priorities:
  - prefer `OK` URLs
  - higher score
  - fresher `lastmod`
  - bucket diversity (avoid all 5 from same topic)
- Fallback mode:
  - if key missing or API fails, deterministic local rules are used.
  - script still writes output and does not fail workflow.

## Configure GitHub Secret
1. Open repository on GitHub.
2. Go to `Settings` -> `Secrets and variables` -> `Actions`.
3. Click `New repository secret`.
4. Name: `OPENAI_API_KEY`
5. Value: your OpenAI API key.

## Workflow Behavior
- Workflow runs only on `schedule` and `workflow_dispatch`.
- It runs:
  1. `scripts/indexing-booster.js`
  2. `scripts/generate-seo-json.js`
  3. `scripts/pick-daily-top5.js`
- Then commits:
  - `seo/data/latest.json`
  - `seo/data/daily_top5.json`

## If AI Call Fails
- Check workflow logs for `OpenAI selection failed; using fallback`.
- Verify `OPENAI_API_KEY` secret exists and is valid.
- Confirm outbound API access from GitHub Actions is available.
- Even on failure, deterministic top 5 is still generated.
