#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_PROPERTY = "sc-domain:trinityglobals.com";
const DEFAULT_SITEMAP = "https://trinityglobals.com/sitemap.xml";

const INPUT_FILES = {
  all: "urls_all.txt",
  skipped: "urls_skipped_duplicates.txt",
  skippedIndexed: "urls_skipped_already_indexed.txt",
  sorted: "urls_priority_sorted.txt",
  top: "urls_priority_top50.txt",
  ok: "urls_ok.txt",
  bad: "urls_bad.txt",
  inspect: "inspect_links_priority_top50.txt",
  remove: "urls_remove_candidates.txt",
};

const OUTPUT_FILE = path.join("seo", "data", "latest.json");

function usage() {
  return [
    "Usage:",
    "  node scripts/generate-seo-json.js [--sitemap <url> ...] [--property <gsc-property>]",
    "",
    "Example:",
    "  node scripts/generate-seo-json.js --sitemap https://trinityglobals.com/sitemap.xml --sitemap https://trinityglobals.com/blog/sitemap.xml/ --property sc-domain:trinityglobals.com",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    property: DEFAULT_PROPERTY,
    sitemaps: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === "--help" || key === "-h") {
      console.log(usage());
      process.exit(0);
    }

    if (key === "--property") {
      if (!value) {
        throw new Error("Missing value for --property");
      }
      args.property = value.trim();
      i += 1;
      continue;
    }

    if (key === "--sitemap") {
      if (!value) {
        throw new Error("Missing value for --sitemap");
      }
      args.sitemaps.push(value.trim());
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${key}`);
  }

  if (args.sitemaps.length === 0) {
    args.sitemaps.push(DEFAULT_SITEMAP);
  }

  return args;
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function splitNonEmptyLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function splitTabLine(line, expectedColumns) {
  const parts = line.split("\t");
  if (parts.length <= expectedColumns) {
    return parts;
  }

  const compact = parts.slice(0, expectedColumns - 1);
  compact.push(parts.slice(expectedColumns - 1).join("\t"));
  return compact;
}

function parseTabFile(text) {
  const lines = splitNonEmptyLines(text);
  if (lines.length === 0) {
    return [];
  }

  const headers = lines[0].split("\t").map((header) => header.trim());
  const rows = [];

  for (const line of lines.slice(1)) {
    const cells = splitTabLine(line, headers.length);
    const row = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = cells[i] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

function parseInspectLinks(text) {
  return splitNonEmptyLines(text).filter((line) => /^https?:\/\//i.test(line));
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildTopPriority(topRows, inspectLinks, property) {
  return topRows
    .map((row, index) => {
      const url = String(row.url ?? "").trim();
      if (!url) {
        return null;
      }

      const inspect =
        inspectLinks[index] ||
        `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(
          property,
        )}&url=${encodeURIComponent(url)}`;

      return {
        url,
        score: toInt(row.score, 0),
        tier: String(row.tier ?? "").trim(),
        lastmod: String(row.lastmod ?? "").trim() || "",
        inspect,
      };
    })
    .filter(Boolean);
}

function buildOkRows(okRows) {
  return okRows
    .map((row) => {
      const url = String(row.url ?? "").trim();
      if (!url) {
        return null;
      }
      return {
        url,
        status: String(row.status ?? "").trim(),
        method: String(row.method ?? "").trim(),
        final_url: String(row.final_url ?? "").trim(),
      };
    })
    .filter(Boolean);
}

function buildBadRows(badRows) {
  return badRows
    .map((row) => {
      const url = String(row.url ?? "").trim();
      if (!url) {
        return null;
      }
      return {
        url,
        status: String(row.status ?? "").trim(),
        method: String(row.method ?? "").trim(),
        error: String(row.error ?? "").trim(),
      };
    })
    .filter(Boolean);
}

function buildSkippedRows(skippedRows) {
  return skippedRows
    .map((row) => {
      const url = String(row.url ?? "").trim();
      if (!url) {
        return null;
      }
      return {
        url,
        lastmod: String(row.lastmod ?? "").trim(),
        reason: String(row.reason ?? "").trim(),
      };
    })
    .filter(Boolean);
}

function buildRemoveRows(removeRows) {
  return removeRows
    .map((row) => {
      const url = String(row.url ?? "").trim();
      if (!url) {
        return null;
      }
      return {
        url,
        reason: String(row.reason ?? "").trim(),
        source: String(row.source ?? "").trim(),
      };
    })
    .filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [allText, skippedText, skippedIndexedText, sortedText, topText, okText, badText, inspectText, removeText] =
    await Promise.all([
      readTextIfExists(INPUT_FILES.all),
      readTextIfExists(INPUT_FILES.skipped),
      readTextIfExists(INPUT_FILES.skippedIndexed),
      readTextIfExists(INPUT_FILES.sorted),
      readTextIfExists(INPUT_FILES.top),
      readTextIfExists(INPUT_FILES.ok),
      readTextIfExists(INPUT_FILES.bad),
      readTextIfExists(INPUT_FILES.inspect),
      readTextIfExists(INPUT_FILES.remove),
    ]);

  const allRows = parseTabFile(allText);
  const skippedRowsRaw = parseTabFile(skippedText);
  const skippedIndexedRowsRaw = parseTabFile(skippedIndexedText);
  const sortedRows = parseTabFile(sortedText);
  const topRowsRaw = parseTabFile(topText);
  const okRowsRaw = parseTabFile(okText);
  const badRowsRaw = parseTabFile(badText);
  const inspectLinks = parseInspectLinks(inspectText);
  const removeRowsRaw = parseTabFile(removeText);

  const topRows = topRowsRaw.length > 0 ? topRowsRaw : sortedRows.slice(0, 50);
  const topPriority = buildTopPriority(topRows, inspectLinks, args.property);
  const ok = buildOkRows(okRowsRaw);
  const bad = buildBadRows(badRowsRaw);
  const skippedDuplicates = buildSkippedRows(skippedRowsRaw);
  const skippedAlreadyIndexed = buildSkippedRows(skippedIndexedRowsRaw);
  const removeCandidates = buildRemoveRows(removeRowsRaw);

  const counts = {
    total_urls: allRows.length,
    kept_urls: Math.max(
      allRows.length - skippedDuplicates.length - skippedAlreadyIndexed.length,
      0,
    ),
    skipped_duplicates: skippedDuplicates.length,
    skipped_already_indexed: skippedAlreadyIndexed.length,
    ok_count: ok.length,
    bad_count: bad.length,
    remove_candidates: removeCandidates.length,
  };

  const payload = {
    generated_at: new Date().toISOString(),
    property: args.property,
    sitemap: args.sitemaps[0] || DEFAULT_SITEMAP,
    sitemaps: args.sitemaps,
    counts,
    top_priority: topPriority,
    ok,
    bad,
    skipped_duplicates: skippedDuplicates,
    skipped_already_indexed: skippedAlreadyIndexed,
    remove_candidates: removeCandidates,
  };

  await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log("SEO JSON generated.");
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log(
    `Counts: total=${counts.total_urls}, kept=${counts.kept_urls}, skipped_duplicates=${counts.skipped_duplicates}, skipped_indexed=${counts.skipped_already_indexed}, ok=${counts.ok_count}, bad=${counts.bad_count}, remove_candidates=${counts.remove_candidates}`,
  );
}

main().catch((error) => {
  console.error("Failed to generate SEO JSON.");
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage());
  process.exit(1);
});
