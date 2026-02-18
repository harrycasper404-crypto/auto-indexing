#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import zlib from "node:zlib";

const DEFAULT_PROPERTY = "sc-domain:trinityglobals.com";
const DEFAULT_TOP = 50;
const FETCH_TIMEOUT_MS = 15000;
const MAX_CONCURRENCY = 10;
const MAX_SITEMAPS_TO_FETCH = 2000;

const HIGH_PRIORITY_TERMS = [
  "cancel",
  "cancellation",
  "refundable",
  "refund",
  "change",
  "modify",
  "reschedule",
  "rebook",
  "basic-economy",
  "fees",
  "fee",
];

const MEDIUM_PRIORITY_TERMS = [
  "us-to-uk",
  "usa-to-uk",
  "london",
  "uk",
  "paris",
  "france",
  "dubai",
  "uae",
  "mexico",
  "africa",
  "europe",
  "hong-kong",
  "vancouver",
  "toronto",
  "montreal",
  "calgary",
  "bogota",
  "orlando",
  "denver",
  "new-york",
  "los-angeles",
  "san-francisco",
  "seattle",
  "dallas",
];

const NORMAL_PRIORITY_TERMS = [
  "cheap",
  "best",
  "deals",
  "discount",
  "book",
  "booking",
  "domestic",
  "international",
  "nonstop",
  "price-comparison",
];

const OUTPUT_FILES = {
  all: "urls_all.txt",
  skipped: "urls_skipped_duplicates.txt",
  sorted: "urls_priority_sorted.txt",
  top: "urls_priority_top50.txt",
  ok: "urls_ok.txt",
  bad: "urls_bad.txt",
  inspect: "inspect_links_priority_top50.txt",
};

function usage() {
  return [
    "Usage:",
    "  node scripts/indexing-booster.js --sitemap <url> [--sitemap <url> ...] [--property <gsc-property>] [--top <N>]",
    "",
    "Example:",
    "  node scripts/indexing-booster.js --sitemap https://trinityglobals.com/sitemap.xml --sitemap https://trinityglobals.com/blog/sitemap.xml/ --property sc-domain:trinityglobals.com --top 50",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    sitemaps: [],
    property: DEFAULT_PROPERTY,
    top: DEFAULT_TOP,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === "--help" || key === "-h") {
      console.log(usage());
      process.exit(0);
    }

    if (key === "--sitemap") {
      if (!value) {
        throw new Error("Missing value for --sitemap");
      }
      args.sitemaps.push(value.trim());
      i += 1;
      continue;
    }

    if (key === "--property") {
      if (!value) {
        throw new Error("Missing value for --property");
      }
      args.property = value.trim();
      i += 1;
      continue;
    }

    if (key === "--top") {
      if (!value) {
        throw new Error("Missing value for --top");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--top must be a positive integer");
      }
      args.top = parsed;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${key}`);
  }

  if (args.sitemaps.length === 0) {
    throw new Error("At least one --sitemap is required");
  }

  for (const sitemap of args.sitemaps) {
    try {
      new URL(sitemap);
    } catch {
      throw new Error(`Invalid --sitemap URL: ${sitemap}`);
    }
  }

  return args;
}

function decodeXmlEntities(input) {
  if (!input) {
    return "";
  }

  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, dec) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    );
}

function extractTagValue(block, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = block.match(pattern);
  return decodeXmlEntities(match?.[1]?.trim() ?? "");
}

function parseSitemapXml(xmlText) {
  const text = xmlText.replace(/^\uFEFF/, "");
  const isIndex = /<sitemapindex\b/i.test(text);
  const isUrlset = /<urlset\b/i.test(text);

  if (isIndex) {
    const entries = [];
    const regex = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
    let match = regex.exec(text);
    while (match) {
      const loc = extractTagValue(match[1], "loc");
      const lastmod = extractTagValue(match[1], "lastmod");
      if (loc) {
        entries.push({ loc, lastmod });
      }
      match = regex.exec(text);
    }
    return { type: "sitemapindex", entries };
  }

  if (isUrlset) {
    const entries = [];
    const regex = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
    let match = regex.exec(text);
    while (match) {
      const loc = extractTagValue(match[1], "loc");
      const lastmod = extractTagValue(match[1], "lastmod");
      if (loc) {
        entries.push({ loc, lastmod });
      }
      match = regex.exec(text);
    }
    return { type: "urlset", entries };
  }

  return { type: "unknown", entries: [] };
}

function normalizeAbsoluteUrl(input) {
  try {
    const url = new URL(String(input).trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return "";
  }
}

function safeDateMillis(lastmod) {
  if (!lastmod) {
    return 0;
  }
  const parsed = Date.parse(lastmod);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function decodeResponseBuffer(buffer, sourceUrl, contentEncoding) {
  const encoding = String(contentEncoding || "").toLowerCase();
  const isGzip = encoding.includes("gzip") || sourceUrl.toLowerCase().endsWith(".gz");
  const isDeflate = encoding.includes("deflate");
  const isBrotli = encoding.includes("br");

  if (isGzip) {
    try {
      return zlib.gunzipSync(buffer).toString("utf8");
    } catch {
      return buffer.toString("utf8");
    }
  }

  if (isDeflate) {
    try {
      return zlib.inflateSync(buffer).toString("utf8");
    } catch {
      return buffer.toString("utf8");
    }
  }

  if (isBrotli) {
    try {
      return zlib.brotliDecompressSync(buffer).toString("utf8");
    } catch {
      return buffer.toString("utf8");
    }
  }

  return buffer.toString("utf8");
}

async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      redirect: "follow",
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "TrinityGlobalsIndexingBooster/1.0",
        ...init.headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching ${url}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  return decodeResponseBuffer(body, url, res.headers.get("content-encoding"));
}

async function asyncPool(limit, items, task) {
  const results = new Array(items.length);
  const running = new Set();

  for (let i = 0; i < items.length; i += 1) {
    const promise = Promise.resolve().then(() => task(items[i], i));
    results[i] = promise;
    running.add(promise);
    promise.finally(() => running.delete(promise));

    if (running.size >= limit) {
      await Promise.race(running);
    }
  }

  return Promise.all(results);
}

async function crawlSitemaps(rootSitemapUrl) {
  const queue = [normalizeAbsoluteUrl(rootSitemapUrl)];
  const seenSitemaps = new Set();
  const urlEntries = [];
  const errors = [];

  while (queue.length > 0 && seenSitemaps.size < MAX_SITEMAPS_TO_FETCH) {
    const batch = queue.splice(0, MAX_CONCURRENCY).filter(Boolean);
    if (batch.length === 0) {
      break;
    }

    const results = await asyncPool(MAX_CONCURRENCY, batch, async (sitemapUrl) => {
      if (seenSitemaps.has(sitemapUrl)) {
        return { type: "seen", sitemapUrl };
      }
      seenSitemaps.add(sitemapUrl);

      try {
        const xml = await fetchText(sitemapUrl);
        return { sitemapUrl, ...parseSitemapXml(xml) };
      } catch (error) {
        return {
          type: "error",
          sitemapUrl,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    for (const result of results) {
      if (result.type === "error") {
        errors.push(`${result.sitemapUrl}\t${result.error}`);
        continue;
      }

      if (result.type === "sitemapindex") {
        for (const item of result.entries) {
          const nested = normalizeAbsoluteUrl(item.loc);
          if (nested && !seenSitemaps.has(nested)) {
            queue.push(nested);
          }
        }
        continue;
      }

      if (result.type === "urlset") {
        for (const item of result.entries) {
          const loc = normalizeAbsoluteUrl(item.loc);
          if (loc) {
            urlEntries.push({ url: loc, lastmod: item.lastmod || "" });
          }
        }
        continue;
      }

      if (result.type !== "seen") {
        errors.push(`${result.sitemapUrl}\tUnsupported XML structure`);
      }
    }
  }

  if (seenSitemaps.size >= MAX_SITEMAPS_TO_FETCH && queue.length > 0) {
    errors.push(`Stopped at safety limit (${MAX_SITEMAPS_TO_FETCH} sitemap files)`);
  }

  return {
    urls: urlEntries,
    fetchedSitemaps: seenSitemaps.size,
    errors,
  };
}

function dedupeByLatestLastmod(entries) {
  const map = new Map();

  for (const entry of entries) {
    const existing = map.get(entry.url);
    if (!existing) {
      map.set(entry.url, entry);
      continue;
    }

    if (safeDateMillis(entry.lastmod) > safeDateMillis(existing.lastmod)) {
      map.set(entry.url, entry);
    }
  }

  return [...map.values()];
}

function hasNumericSuffixSlug(urlString) {
  try {
    const url = new URL(urlString);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0) {
      return false;
    }
    const lastSegment = segments[segments.length - 1].toLowerCase();
    return /-\d+$/.test(lastSegment);
  } catch {
    return false;
  }
}

function splitDuplicateSuffixUrls(entries) {
  const kept = [];
  const skipped = [];

  for (const entry of entries) {
    if (hasNumericSuffixSlug(entry.url)) {
      skipped.push({
        ...entry,
        reason: "Numeric slug suffix (-<number>)",
      });
      continue;
    }
    kept.push(entry);
  }

  return { kept, skipped };
}

function safeLowerDecoded(url) {
  try {
    return decodeURIComponent(url).toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

function computePriority(url) {
  const value = safeLowerDecoded(url);

  const highHits = HIGH_PRIORITY_TERMS.filter((term) => value.includes(term));
  if (highHits.length > 0) {
    return { tier: "highest", score: 300 + highHits.length };
  }

  const mediumHits = MEDIUM_PRIORITY_TERMS.filter((term) => value.includes(term));
  if (mediumHits.length > 0) {
    return { tier: "medium", score: 200 + mediumHits.length };
  }

  const normalHits = NORMAL_PRIORITY_TERMS.filter((term) => value.includes(term));
  if (normalHits.length > 0) {
    return { tier: "normal", score: 100 + normalHits.length };
  }

  return { tier: "none", score: 0 };
}

function sortByPriority(entries) {
  return [...entries]
    .map((entry) => ({
      ...entry,
      ...computePriority(entry.url),
      lastmodMillis: safeDateMillis(entry.lastmod),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (b.lastmodMillis !== a.lastmodMillis) {
        return b.lastmodMillis - a.lastmodMillis;
      }
      return a.url.localeCompare(b.url);
    });
}

async function checkUrlReachability(url) {
  const attempt = async (method) => {
    const res = await fetchWithTimeout(url, { method });
    return {
      status: res.status,
      method,
      ok: res.status >= 200 && res.status < 400,
      finalUrl: res.url || url,
    };
  };

  try {
    const head = await attempt("HEAD");
    if ([403, 405, 501].includes(head.status)) {
      return await attempt("GET");
    }
    return head;
  } catch {
    try {
      return await attempt("GET");
    } catch (error) {
      return {
        status: -1,
        method: "GET",
        ok: false,
        finalUrl: url,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

async function writeLines(filePath, lines) {
  const content = lines.length ? `${lines.join("\n")}\n` : "";
  await writeFile(filePath, content, "utf8");
}

function formatDate(value) {
  return value || "-";
}

function formatPriorityLine(entry) {
  return `${entry.score}\t${entry.tier}\t${formatDate(entry.lastmod)}\t${entry.url}`;
}

function formatOkLine(entry) {
  return `${entry.status}\t${entry.method}\t${entry.url}\t${entry.finalUrl}`;
}

function formatBadLine(entry) {
  const status = entry.status >= 0 ? String(entry.status) : "ERR";
  const error = entry.error ? entry.error.replace(/\s+/g, " ").trim() : "";
  return `${status}\t${entry.method}\t${entry.url}\t${error}`;
}

async function main() {
  const startMs = Date.now();
  const args = parseArgs(process.argv.slice(2));

  const inputSitemaps = [
    ...new Set(args.sitemaps.map((sitemap) => normalizeAbsoluteUrl(sitemap)).filter(Boolean)),
  ];
  if (inputSitemaps.length === 0) {
    throw new Error("No valid sitemap URLs provided");
  }

  const crawlResults = await asyncPool(
    Math.min(MAX_CONCURRENCY, inputSitemaps.length),
    inputSitemaps,
    async (sitemap) => {
      const crawl = await crawlSitemaps(sitemap);
      return { sitemap, ...crawl };
    },
  );

  const allUrls = [];
  const allWarnings = [];
  let fetchedSitemapFiles = 0;

  for (const result of crawlResults) {
    allUrls.push(...result.urls);
    fetchedSitemapFiles += result.fetchedSitemaps;
    allWarnings.push(...result.errors.map((error) => `[${result.sitemap}] ${error}`));
  }

  const deduped = dedupeByLatestLastmod(allUrls);
  const split = splitDuplicateSuffixUrls(deduped);
  const ranked = sortByPriority(split.kept);
  const top = ranked.slice(0, args.top);

  const topStatuses = await asyncPool(MAX_CONCURRENCY, top, async (entry) => {
    const status = await checkUrlReachability(entry.url);
    return { ...status, url: entry.url };
  });

  const ok = topStatuses.filter((x) => x.ok);
  const bad = topStatuses.filter((x) => !x.ok);

  const inspectLinks = top.map(
    (entry) =>
      `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(
        args.property,
      )}&url=${encodeURIComponent(entry.url)}`,
  );

  await writeLines(
    OUTPUT_FILES.all,
    ["url\tlastmod", ...deduped.map((entry) => `${entry.url}\t${formatDate(entry.lastmod)}`)],
  );
  await writeLines(
    OUTPUT_FILES.skipped,
    [
      "url\tlastmod\treason",
      ...split.skipped.map(
        (entry) => `${entry.url}\t${formatDate(entry.lastmod)}\t${entry.reason}`,
      ),
    ],
  );
  await writeLines(
    OUTPUT_FILES.sorted,
    ["score\ttier\tlastmod\turl", ...ranked.map((entry) => formatPriorityLine(entry))],
  );
  await writeLines(
    OUTPUT_FILES.top,
    ["score\ttier\tlastmod\turl", ...top.map((entry) => formatPriorityLine(entry))],
  );
  await writeLines(
    OUTPUT_FILES.ok,
    ["status\tmethod\turl\tfinal_url", ...ok.map((entry) => formatOkLine(entry))],
  );
  await writeLines(
    OUTPUT_FILES.bad,
    ["status\tmethod\turl\terror", ...bad.map((entry) => formatBadLine(entry))],
  );
  await writeLines(OUTPUT_FILES.inspect, inspectLinks);

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const tierCounts = ranked.reduce(
    (acc, entry) => {
      acc[entry.tier] = (acc[entry.tier] || 0) + 1;
      return acc;
    },
    { highest: 0, medium: 0, normal: 0, none: 0 },
  );

  console.log("Indexing Booster Summary");
  console.log("========================");
  console.log(`Input sitemap count: ${inputSitemaps.length}`);
  for (const sitemap of inputSitemaps) {
    console.log(`- ${sitemap}`);
  }
  console.log(`Property: ${args.property}`);
  console.log(`Sitemap files fetched: ${fetchedSitemapFiles}`);
  console.log(`Raw URL rows found: ${allUrls.length}`);
  console.log(`Unique URLs after de-duplication: ${deduped.length}`);
  console.log(`Skipped numeric suffix URLs: ${split.skipped.length}`);
  console.log(`URLs scored: ${ranked.length}`);
  console.log(
    `Tier counts: highest=${tierCounts.highest}, medium=${tierCounts.medium}, normal=${tierCounts.normal}, none=${tierCounts.none}`,
  );
  console.log(`Top URLs checked: ${top.length}`);
  console.log(`Reachable (2xx/3xx): ${ok.length}`);
  console.log(`Bad/Failed: ${bad.length}`);
  console.log(`Sitemap parse warnings: ${allWarnings.length}`);
  console.log(`Output files: ${Object.values(OUTPUT_FILES).join(", ")}`);
  console.log(`Done in ${elapsed}s`);

  if (allWarnings.length > 0) {
    console.warn("\nWarnings:");
    for (const warning of allWarnings.slice(0, 10)) {
      console.warn(`- ${warning}`);
    }
    if (allWarnings.length > 10) {
      console.warn(`- ... ${allWarnings.length - 10} more`);
    }
  }
}

main().catch((error) => {
  console.error("Indexing booster failed.");
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage());
  process.exit(1);
});
