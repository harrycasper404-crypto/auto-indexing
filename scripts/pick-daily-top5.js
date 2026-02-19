#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_PROPERTY = "sc-domain:trinityglobals.com";
const DEFAULT_MODEL = "gpt-4.1-mini";
const OUTPUT_FILE = path.join("seo", "data", "daily_top5.json");

const FILES = {
  sorted: "urls_priority_sorted.txt",
  ok: "urls_ok.txt",
  bad: "urls_bad.txt",
  skipped: "urls_skipped_duplicates.txt",
};

const BUCKETS = {
  cancel_refund: {
    label: "cancellation/refund",
    terms: ["cancel", "cancellation", "refund", "refundable"],
  },
  change_fees: {
    label: "change/modify/basic economy/fees",
    terms: ["change", "modify", "reschedule", "rebook", "basic-economy", "fee", "fees"],
  },
  usa_deals: {
    label: "USA deals/cheap/general",
    terms: ["usa", "us-", "us-to", "cheap", "deals", "discount", "book", "booking", "domestic"],
  },
  canada: {
    label: "Canada",
    terms: ["canada", "toronto", "vancouver", "montreal", "calgary"],
  },
  routes_destinations: {
    label: "routes/destinations",
    terms: [
      "route",
      "destination",
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
      "bogota",
      "orlando",
      "denver",
      "new-york",
      "los-angeles",
      "san-francisco",
      "seattle",
      "dallas",
    ],
  },
};

const BUCKET_ORDER = [
  "cancel_refund",
  "change_fees",
  "routes_destinations",
  "canada",
  "usa_deals",
  "other",
];

function usage() {
  return [
    "Usage:",
    "  node scripts/pick-daily-top5.js [--property <gsc-property>] [--model <openai-model>]",
    "",
    "Environment:",
    "  OPENAI_API_KEY=<key>",
    "  OPENAI_MODEL=<optional override>",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    property: DEFAULT_PROPERTY,
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
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

    if (key === "--model") {
      if (!value) {
        throw new Error("Missing value for --model");
      }
      args.model = value.trim();
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${key}`);
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
  const headers = lines[0].split("\t");
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

function normalizeUrl(input) {
  try {
    const url = new URL(String(input).trim());
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function parseDateMillis(value) {
  const t = Date.parse(String(value || "").trim());
  return Number.isNaN(t) ? 0 : t;
}

function bucketForUrl(url) {
  const lower = decodeURIComponent(String(url || "")).toLowerCase();
  for (const key of BUCKET_ORDER) {
    if (key === "other") {
      continue;
    }
    const spec = BUCKETS[key];
    if (spec.terms.some((term) => lower.includes(term))) {
      return key;
    }
  }
  return "other";
}

function tagsForUrl(url) {
  const lower = decodeURIComponent(String(url || "")).toLowerCase();
  const tags = [];
  for (const [key, spec] of Object.entries(BUCKETS)) {
    if (spec.terms.some((term) => lower.includes(term))) {
      tags.push(key);
    }
  }
  if (tags.length === 0) {
    tags.push("other");
  }
  return tags;
}

function buildCandidates({ sortedRows, okRows, badRows }) {
  const okSet = new Set(okRows.map((row) => normalizeUrl(row.url)).filter(Boolean));
  const badSet = new Set(badRows.map((row) => normalizeUrl(row.url)).filter(Boolean));

  const candidates = [];
  let idx = 1;
  for (const row of sortedRows.slice(0, 50)) {
    const rawUrl = String(row.url || "").trim();
    if (!rawUrl) {
      continue;
    }
    const normalized = normalizeUrl(rawUrl);
    const isOk = normalized ? okSet.has(normalized) : false;
    const isBad = normalized ? badSet.has(normalized) : false;
    const status = isOk ? "OK" : isBad ? "BAD" : "UNKNOWN";
    const score = Number.parseInt(String(row.score || "0"), 10) || 0;
    const lastmod = String(row.lastmod || "").trim();
    const lastmodMillis = parseDateMillis(lastmod);
    const bucket = bucketForUrl(rawUrl);
    const tags = tagsForUrl(rawUrl);

    candidates.push({
      id: idx,
      url: rawUrl,
      normalized,
      score,
      lastmod,
      lastmodMillis,
      status,
      bucket,
      tags,
      inspect: "",
    });
    idx += 1;
  }

  return candidates;
}

function compareCandidate(a, b) {
  if (a.status !== b.status) {
    if (a.status === "OK") return -1;
    if (b.status === "OK") return 1;
    if (a.status === "UNKNOWN") return -1;
    if (b.status === "UNKNOWN") return 1;
  }
  if (b.score !== a.score) return b.score - a.score;
  if (b.lastmodMillis !== a.lastmodMillis) return b.lastmodMillis - a.lastmodMillis;
  return a.url.localeCompare(b.url);
}

function deterministicPickTop5(candidates) {
  const byQuality = [...candidates].sort(compareCandidate);
  const preferred = byQuality.filter((c) => c.status === "OK");
  const pool = preferred.length >= 5 ? preferred : byQuality.filter((c) => c.status !== "BAD");
  const finalPool = pool.length >= 5 ? pool : byQuality;

  const byBucket = new Map();
  for (const key of BUCKET_ORDER) {
    byBucket.set(key, []);
  }
  for (const c of finalPool) {
    const arr = byBucket.get(c.bucket) || [];
    arr.push(c);
    byBucket.set(c.bucket, arr);
  }
  for (const [key, arr] of byBucket.entries()) {
    byBucket.set(key, arr.sort(compareCandidate));
  }

  const selected = [];
  const selectedIds = new Set();

  for (const bucket of BUCKET_ORDER) {
    if (selected.length >= 5) break;
    const rows = byBucket.get(bucket) || [];
    const pick = rows.find((row) => !selectedIds.has(row.id));
    if (!pick) continue;
    selected.push({
      ...pick,
      reason: `High score + freshness from ${BUCKETS[bucket]?.label || "other"} bucket (${pick.status})`,
    });
    selectedIds.add(pick.id);
  }

  for (const row of finalPool) {
    if (selected.length >= 5) break;
    if (selectedIds.has(row.id)) continue;
    selected.push({
      ...row,
      reason: `Fallback priority pick (${row.status}, score ${row.score})`,
    });
    selectedIds.add(row.id);
  }

  return selected.slice(0, 5);
}

function buildOpenAIPromptCandidates(candidates) {
  const now = Date.now();
  return candidates.map((c) => {
    const ageDays = c.lastmodMillis > 0 ? Math.floor((now - c.lastmodMillis) / 86400000) : null;
    return {
      id: c.id,
      url: c.url,
      score: c.score,
      lastmod: c.lastmod || null,
      status: c.status,
      bucket: c.bucket,
      tags: c.tags,
      age_days: ageDays,
    };
  });
}

async function pickWithOpenAI({ apiKey, model, candidates }) {
  const requestPayload = {
    model,
    temperature: 0.1,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "daily_top5_selection",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            top5: {
              type: "array",
              minItems: 5,
              maxItems: 5,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "integer" },
                  reason: { type: "string" },
                },
                required: ["id", "reason"],
              },
            },
          },
          required: ["top5"],
        },
      },
    },
    messages: [
      {
        role: "system",
        content:
          "You select exactly 5 URLs for manual Google Search Console Request Indexing. Prefer status=OK, higher score, fresher lastmod. Ensure diversity across buckets. Avoid BAD unless impossible. Return strict JSON only.",
      },
      {
        role: "user",
        content: JSON.stringify({
          instruction:
            "Pick exactly 5 candidate IDs. Keep bucket diversity (max 2 from same bucket when alternatives exist).",
          candidates: buildOpenAIPromptCandidates(candidates),
        }),
      },
    ],
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestPayload),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error ${response.status}`);
  }

  const json = await response.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("OpenAI response missing content");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenAI response was not valid JSON");
  }
  if (!parsed || !Array.isArray(parsed.top5)) {
    throw new Error("OpenAI response schema invalid");
  }
  return parsed.top5;
}

function materializeSelection({ selectionRows, candidates, property }) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const picked = [];
  const used = new Set();

  for (const row of selectionRows) {
    const id = Number.parseInt(String(row.id), 10);
    if (!Number.isInteger(id) || used.has(id)) continue;
    const candidate = byId.get(id);
    if (!candidate) continue;
    used.add(id);
    picked.push({
      ...candidate,
      reason: String(row.reason || "").trim() || `Selected from ${candidate.bucket} (${candidate.status})`,
    });
    if (picked.length >= 5) break;
  }

  if (picked.length < 5) {
    const fallback = deterministicPickTop5(candidates);
    for (const row of fallback) {
      if (picked.length >= 5) break;
      if (used.has(row.id)) continue;
      used.add(row.id);
      picked.push(row);
    }
  }

  return picked.slice(0, 5).map((row) => ({
    url: row.url,
    score: row.score,
    lastmod: row.lastmod || "",
    reason: row.reason,
    inspect: `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(
      property,
    )}&url=${encodeURIComponent(row.url)}`,
  }));
}

async function writeOutput(payload) {
  await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [sortedText, okText, badText] = await Promise.all([
    readTextIfExists(FILES.sorted),
    readTextIfExists(FILES.ok),
    readTextIfExists(FILES.bad),
  ]);

  const sortedRows = parseTabFile(sortedText);
  const okRows = parseTabFile(okText);
  const badRows = parseTabFile(badText);

  const candidates = buildCandidates({ sortedRows, okRows, badRows });
  if (candidates.length === 0) {
    const emptyPayload = {
      generated_at: new Date().toISOString(),
      mode: "empty",
      top5: [],
      note: "No candidates found from urls_priority_sorted.txt",
    };
    await writeOutput(emptyPayload);
    console.log("Daily top5 generated in empty mode (no candidates).");
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY || "";
  let mode = "fallback";
  let top5 = [];

  if (apiKey) {
    try {
      const selection = await pickWithOpenAI({
        apiKey,
        model: args.model,
        candidates,
      });
      top5 = materializeSelection({
        selectionRows: selection,
        candidates,
        property: args.property,
      });
      mode = "openai";
    } catch (error) {
      console.warn(
        `OpenAI selection failed; using fallback. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (top5.length === 0) {
    top5 = deterministicPickTop5(candidates).map((row) => ({
      url: row.url,
      score: row.score,
      lastmod: row.lastmod || "",
      reason: row.reason,
      inspect: `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(
        args.property,
      )}&url=${encodeURIComponent(row.url)}`,
    }));
  }

  const payload = {
    generated_at: new Date().toISOString(),
    mode,
    model: mode === "openai" ? args.model : "deterministic",
    top5,
  };
  await writeOutput(payload);

  console.log(`Daily top5 generated: ${OUTPUT_FILE}`);
  console.log(`Mode: ${mode}`);
  console.log(`URLs picked: ${top5.length}`);
}

main().catch(async (error) => {
  console.error("pick-daily-top5 failed; writing safe fallback output.");
  console.error(error instanceof Error ? error.message : String(error));
  try {
    const payload = {
      generated_at: new Date().toISOString(),
      mode: "error-fallback",
      top5: [],
      note: "Script error occurred before selection",
    };
    await writeOutput(payload);
  } catch {
    // do nothing
  }
  process.exit(0);
});
