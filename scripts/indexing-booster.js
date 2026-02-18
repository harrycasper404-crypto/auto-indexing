#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import zlib from "node:zlib";

const DEFAULT_PROPERTY = "sc-domain:trinityglobals.com";
const DEFAULT_TOP = 50;
const FETCH_TIMEOUT_MS = 15000;
const MAX_CONCURRENCY = 10;
const MAX_SITEMAPS_TO_FETCH = 5000;

const HIGH_PRIORITY_TERMS = [
  "cancel",
  "refund",
  "refundable",
  "change",
  "modify",
  "reschedule",
  "rebook",
  "basic-economy",
  "fees",
];

const MEDIUM_PRIORITY_TERMS = [
  "routes",
  "destinations",
  "us-to-uk",
  "london",
  "dubai",
  "uae",
  "mexico",
  "africa",
  "europe",
  "paris",
  "hong-kong",
  "hongkong",
];

const NORMAL_PRIORITY_TERMS = [
  "cheap",
  "best",
  "deals",
  "discount",
  "book",
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
  const script = "node scripts/indexing-booster.js";
  return [
    "Usage:",
    `  ${script} --sitemap <sitemap-url> [--sitemap <sitemap-url> ...] [--property <gsc-property>] [--top <N>]`,
    "",
    "Example:",
    `  ${script} --sitemap https://trinityglobals.com/sitemap.xml --sitemap https://trinityglobals.com/blog/sitemap.xml/ --property ${DEFAULT_PROPERTY} --top 50`,
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
      const parsedTop = Number.parseInt(value, 10);
      if (!Number.isInteger(parsedTop) || parsedTop <= 0) {
        throw new Error("--top must be a positive integer");
      }
      args.top = parsedTop;
      i += 1;
      continue;
    }

    if (key === "--help" || key === "-h") {
      console.log(usage());
      process.exit(0);
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
  const trimmed = xmlText.replace(/^\uFEFF/, "");
  const isIndex = /<sitemapindex\b/i.test(trimmed);
  const isUrlset = /<urlset\b/i.test(trimmed);

  if (isIndex) {
    const sitemaps = [];
    const regex = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
    let match = regex.exec(trimmed);

    while (match) {
      const loc = extractTagValue(match[1], "loc");
      const lastmod = extractTagValue(match[1], "lastmod");
      if (loc) {
        sitemaps.push({ loc, lastmod });
      }
      match = regex.exec(trimmed);
    }

    return { type: "sitemapindex", entries: sitemaps };
  }

  if (isUrlset) {
    const urls = [];
    const regex = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
    let match = regex.exec(trimmed);

    while (match) {
      const loc = extractTagValue(match[1], "loc");
      const lastmod = extractTagValue(match[1], "lastmod");
      if (loc) {
        urls.push({ loc, lastmod });
      }
      match = regex.exec(trimmed);
    }

    return { type: "urlset", entries: urls };
  }

  return { type: "unknown", entries: [] };
}

function normalizeAbsoluteUrl(input) {
  try {
    const url = new URL(input.trim());
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

function getTextFromResponseBuffer(buffer, sourceUrl, contentEncoding) {
  const encoding = String(contentEncoding || "").toLowerCase();
  const looksGzip = encoding.includes("gzip") || sourceUrl.toLowerCase().endsWith(".gz");
  const looksDeflate = encoding.includes("deflate");
  const looksBr = encoding.includes("br");

  if (looksGzip) {
    try {
      return zlib.gunzipSync(buffer).toString("utf8");
    } catch {
      return buffer.toString("utf8");
    }
  }

  if (looksDeflate) {
    try {
      return zlib.inflateSync(buffer).toString("utf8");
    } catch {
      return buffer.toString("utf8");
    }
  }

  if (looksBr) {
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
  const res = await fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching ${url}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  return getTextFromResponseBuffer(body, url, res.headers.get("content-encoding"));
}

async function asyncPool(limit, items, task) {
  const results = new Array(items.length);
  const executing = new Set();

  for (let i = 0; i < items.length; i += 1) {
    const promise = Promise.resolve().then(() => task(items[i], i));
    results[i] = promise;
    executing.add(promise);
    promise.finally(() => executing.delete(promise));

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

async function crawlSitemaps(rootSitemapUrl) {
  const sitemapQueue = [normalizeAbsoluteUrl(rootSitemapUrl)];
  const seenSitemaps = new Set();
  const errors = [];
  const collected = [];

  while (sitemapQueue.length > 0 && seenSitemaps.size < MAX_SITEMAPS_TO_FETCH) {
    const batch = sitemapQueue.splice(0, MAX_CONCURRENCY).filter(Boolean);
    if (batch.length === 0) {
      break;
    }

    const results = await asyncPool(MAX_CONCURRENCY, batch, async (sitemapUrl) => {
      if (seenSitemaps.has(sitemapUrl)) {
        return { sitemapUrl, type: "seen", entries: [] };
      }

      seenSitemaps.add(sitemapUrl);

      try {
        const xml = await fetchText(sitemapUrl);
        const parsed = parseSitemapXml(xml);
        return { sitemapUrl, ...parsed };
      } catch (error) {
        return {
          sitemapUrl,
          type: "error",
          entries: [],
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
        for (const entry of result.entries) {
          const normalized = normalizeAbsoluteUrl(entry.loc);
          if (normalized && !seenSitemaps.has(normalized)) {
            sitemapQueue.push(normalized);
          }
        }
        continue;
      }

      if (result.type === "urlset") {
        for (const entry of result.entries) {
          const normalized = normalizeAbsoluteUrl(entry.loc);
          if (normalized) {
            collected.push({ url: normalized, lastmod: entry.lastmod || "" });
          }
        }
        continue;
      }

      errors.push(`${result.sitemapUrl}\tUnsupported XML structure`);
    }
  }

  if (seenSitemaps.size >= MAX_SITEMAPS_TO_FETCH && sitemapQueue.length > 0) {
    errors.push(`Stopped after ${MAX_SITEMAPS_TO_FETCH} sitemap files (safety limit)`);
  }

  return {
    rawUrls: collected,
    sitemapCount: seenSitemaps.size,
    fetchErrors: errors,
  };
}

function dedupeByLatestLastmod(entries) {
  const map = new Map();

  for (const entry of entries) {
    const current = map.get(entry.url);
    if (!current) {
      map.set(entry.url, { ...entry });
      continue;
    }

    const currentTime = safeDateMillis(current.lastmod);
    const nextTime = safeDateMillis(entry.lastmod);

    if (nextTime > currentTime) {
      map.set(entry.url, { ...entry });
    }
  }

  return [...map.values()];
}

function normalizePathKey(urlString) {
  const url = new URL(urlString);
  const cleanPath =
    url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
  return `${url.origin}${cleanPath}`;
}

function getNumericSuffixDuplicateBase(urlString) {
  const url = new URL(urlString);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }

  const last = segments[segments.length - 1];
  const match = last.match(/^(.*)-(\d{1,3})$/);
  if (!match) {
    return "";
  }

  const suffix = Number.parseInt(match[2], 10);
  if (!Number.isInteger(suffix) || suffix < 2) {
    return "";
  }

  const baseSegments = [...segments];
  baseSegments[baseSegments.length - 1] = match[1];
  url.pathname = `/${baseSegments.join("/")}${url.pathname.endsWith("/") ? "/" : ""}`;
  return normalizePathKey(url.toString());
}

function splitDuplicateSuffixUrls(entries) {
  const pathKeySet = new Set(entries.map((entry) => normalizePathKey(entry.url)));
  const kept = [];
  const skipped = [];

  for (const entry of entries) {
    const basePathKey = getNumericSuffixDuplicateBase(entry.url);
    if (basePathKey && pathKeySet.has(basePathKey)) {
      skipped.push({
        ...entry,
        reason: "Numeric suffix duplicate",
      });
      continue;
    }
    kept.push(entry);
  }

  return { kept, skipped };
}

function computePriority(url) {
  let lower = url.toLowerCase();
  try {
    lower = decodeURIComponent(url).toLowerCase();
  } catch {
    lower = url.toLowerCase();
  }

  const highHits = HIGH_PRIORITY_TERMS.filter((term) => lower.includes(term));
  if (highHits.length > 0) {
    return { tier: "highest", score: 300 + highHits.length, terms: highHits };
  }

  const mediumHits = MEDIUM_PRIORITY_TERMS.filter((term) => lower.includes(term));
  if (mediumHits.length > 0) {
    return { tier: "medium", score: 200 + mediumHits.length, terms: mediumHits };
  }

  const normalHits = NORMAL_PRIORITY_TERMS.filter((term) => lower.includes(term));
  if (normalHits.length > 0) {
    return { tier: "normal", score: 100 + normalHits.length, terms: normalHits };
  }

  return { tier: "none", score: 0, terms: [] };
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
    const res = await fetchWithTimeout(url, { method }, FETCH_TIMEOUT_MS);
    return {
      method,
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      finalUrl: res.url || url,
    };
  };

  try {
    const headResult = await attempt("HEAD");
    if (
      headResult.status === 405 ||
      headResult.status === 501 ||
      headResult.status === 403
    ) {
      return await attempt("GET");
    }
    return headResult;
  } catch {
    try {
      return await attempt("GET");
    } catch (error) {
      return {
        method: "GET",
        ok: false,
        status: -1,
        finalUrl: url,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

async function pingSearchEngine(name, endpoint) {
  try {
    const res = await fetchWithTimeout(endpoint, { method: "GET" }, FETCH_TIMEOUT_MS);
    return {
      name,
      endpoint,
      status: res.status,
      ok: res.status >= 200 && res.status < 400,
    };
  } catch (error) {
    return {
      name,
      endpoint,
      status: -1,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeLines(file, lines) {
  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  await writeFile(file, content, "utf8");
}

function formatDate(lastmod) {
  return lastmod || "-";
}

function formatPriorityLine(item) {
  return `${item.score}\t${item.tier}\t${formatDate(item.lastmod)}\t${item.url}`;
}

function formatOkLine(result) {
  return `${result.status}\t${result.method}\t${result.url}\t${result.finalUrl}`;
}

function formatBadLine(result) {
  const statusPart = result.status >= 0 ? String(result.status) : "ERR";
  const message = result.error ? result.error.replace(/\s+/g, " ").trim() : "";
  return `${statusPart}\t${result.method}\t${result.url}\t${message}`;
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));

  const inputSitemaps = [...new Set(args.sitemaps.map((sitemap) => normalizeAbsoluteUrl(sitemap)).filter(Boolean))];
  if (inputSitemaps.length === 0) {
    throw new Error("No valid input sitemap URLs provided");
  }

  const crawlResults = await asyncPool(
    Math.min(MAX_CONCURRENCY, inputSitemaps.length),
    inputSitemaps,
    async (sitemap) => {
      const result = await crawlSitemaps(sitemap);
      return { rootSitemap: sitemap, ...result };
    },
  );

  const rawUrls = [];
  let sitemapCount = 0;
  const fetchErrors = [];
  for (const result of crawlResults) {
    rawUrls.push(...result.rawUrls);
    sitemapCount += result.sitemapCount;
    fetchErrors.push(
      ...result.fetchErrors.map((err) => `[${result.rootSitemap}] ${err}`),
    );
  }

  const deduped = dedupeByLatestLastmod(rawUrls);
  const { kept, skipped } = splitDuplicateSuffixUrls(deduped);
  const ranked = sortByPriority(kept);
  const top = ranked.slice(0, args.top);

  const topStatus = await asyncPool(MAX_CONCURRENCY, top, async (item) => {
    const status = await checkUrlReachability(item.url);
    return { ...status, url: item.url };
  });

  const okStatuses = topStatus.filter((item) => item.ok);
  const badStatuses = topStatus.filter((item) => !item.ok);

  const inspectLinks = top.map((item) => {
    const inspectUrl = `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(
      args.property,
    )}&id=${encodeURIComponent(item.url)}`;
    return inspectUrl;
  });

  const pingTasks = [];
  for (const sitemap of inputSitemaps) {
    const sitemapEncoded = encodeURIComponent(sitemap);
    pingTasks.push(
      pingSearchEngine(
        `Google [${sitemap}]`,
        `https://www.google.com/ping?sitemap=${sitemapEncoded}`,
      ),
    );
    pingTasks.push(
      pingSearchEngine(
        `Bing [${sitemap}]`,
        `https://www.bing.com/ping?sitemap=${sitemapEncoded}`,
      ),
    );
  }
  const pingResults = await Promise.all(pingTasks);

  await writeLines(
    OUTPUT_FILES.all,
    ["url\tlastmod", ...deduped.map((item) => `${item.url}\t${formatDate(item.lastmod)}`)],
  );

  await writeLines(
    OUTPUT_FILES.skipped,
    [
      "url\tlastmod\treason",
      ...skipped.map(
        (item) => `${item.url}\t${formatDate(item.lastmod)}\t${item.reason ?? "Skipped"}`,
      ),
    ],
  );

  await writeLines(
    OUTPUT_FILES.sorted,
    ["score\ttier\tlastmod\turl", ...ranked.map((item) => formatPriorityLine(item))],
  );

  await writeLines(
    OUTPUT_FILES.top,
    ["score\ttier\tlastmod\turl", ...top.map((item) => formatPriorityLine(item))],
  );

  await writeLines(
    OUTPUT_FILES.ok,
    ["status\tmethod\turl\tfinal_url", ...okStatuses.map((item) => formatOkLine(item))],
  );

  await writeLines(
    OUTPUT_FILES.bad,
    ["status\tmethod\turl\terror", ...badStatuses.map((item) => formatBadLine(item))],
  );

  await writeLines(OUTPUT_FILES.inspect, inspectLinks);

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const tierCounts = ranked.reduce(
    (acc, item) => {
      acc[item.tier] = (acc[item.tier] || 0) + 1;
      return acc;
    },
    { highest: 0, medium: 0, normal: 0, none: 0 },
  );

  const pingSummary = pingResults
    .map((p) => `${p.name}: ${p.ok ? "OK" : "FAIL"} (${p.status >= 0 ? p.status : p.error})`)
    .join(" | ");

  console.log("Indexing Booster Summary");
  console.log("========================");
  console.log(`Input sitemap count: ${inputSitemaps.length}`);
  for (const sitemap of inputSitemaps) {
    console.log(`- ${sitemap}`);
  }
  console.log(`Property: ${args.property}`);
  console.log(`Sitemaps fetched (including nested): ${sitemapCount}`);
  console.log(`Raw URLs found: ${rawUrls.length}`);
  console.log(`Unique URLs after de-duplication: ${deduped.length}`);
  console.log(`Skipped numeric duplicate slugs: ${skipped.length}`);
  console.log(`Prioritized URLs considered: ${ranked.length}`);
  console.log(`Tier counts: highest=${tierCounts.highest}, medium=${tierCounts.medium}, normal=${tierCounts.normal}, none=${tierCounts.none}`);
  console.log(`Top URLs checked: ${top.length}`);
  console.log(`Reachable (2xx/3xx): ${okStatuses.length}`);
  console.log(`Bad/Failed: ${badStatuses.length}`);
  console.log(`Search engine ping results: ${pingSummary}`);
  console.log(`Sitemap parse fetch warnings: ${fetchErrors.length}`);
  console.log(`Output files: ${Object.values(OUTPUT_FILES).join(", ")}`);
  console.log(`Done in ${elapsedSeconds}s`);

  if (fetchErrors.length > 0) {
    console.warn("\nWarnings:");
    for (const error of fetchErrors.slice(0, 10)) {
      console.warn(`- ${error}`);
    }
    if (fetchErrors.length > 10) {
      console.warn(`- ... ${fetchErrors.length - 10} more`);
    }
  }
}

main().catch((error) => {
  console.error("Indexing booster failed.");
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  console.error(usage());
  process.exit(1);
});
