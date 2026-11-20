#!/usr/bin/env node
/**
 * UK Daily Job Bot — Cloud Job Fetcher (Reed.co.uk + Adzuna UK APIs)
 * Zero external dependencies (uses Node.js built-in fetch, fs, path).
 *
 * Reads profile.json and seen-jobs.json, queries configured UK job APIs
 * (REED_API_KEY and/or ADZUNA_APP_ID + ADZUNA_APP_KEY), scores & balances
 * matches using the rules in profile.json, and writes pending-jobs.json.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENV_PATH = path.join(__dirname, ".env");
const PROFILE_PATH = path.join(__dirname, "profile.json");
const SEEN_PATH = path.join(__dirname, "seen-jobs.json");
const OUTPUT_PATH = path.join(__dirname, "pending-jobs.json");

function loadEnv(envPath) {
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    const dropPrefixes = ["utm_", "fbclid", "gclid", "mc_", "ref", "source"];
    for (const key of [...u.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (dropPrefixes.some((p) => lower === p || lower.startsWith(p))) {
        u.searchParams.delete(key);
      }
    }
    u.hash = "";
    const pathname = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${pathname}${u.search}`;
  } catch {
    return String(rawUrl || "").trim().toLowerCase();
  }
}

function normalizeJobKey(title, company) {
  const clean = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return `${clean(title)}||${clean(company)}`;
}

function stripHtmlAndTrim(text, maxLen = 220) {
  const cleaned = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&pound;/gi, "£")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  const cut = cleaned.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

function formatGbp(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}

function formatSalary(min, max) {
  const minStr = formatGbp(min);
  const maxStr = formatGbp(max);
  if (minStr && maxStr && minStr !== maxStr) return `${minStr} - ${maxStr}`;
  if (minStr) return `${minStr}`;
  if (maxStr) return `Up to ${maxStr}`;
  return "";
}

function parseReedDate(dateStr) {
  const m = String(dateStr || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseIsoDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ageInDays(dateObj) {
  if (!dateObj) return null;
  const diffMs = Date.now() - dateObj.getTime();
  return Math.max(0, diffMs / (1000 * 60 * 60 * 24));
}

function formatPostedLabel(dateObj) {
  const days = ageInDays(dateObj);
  if (days === null) return "";
  if (days < 1) return "Posted today";
  if (days < 2) return "Posted yesterday";
  return `Posted ${Math.floor(days)}d ago`;
}

async function fetchReedQuery(apiKey, q) {
  const url = new URL("https://www.reed.co.uk/api/1.0/search");
  url.searchParams.set("keywords", q.keywords);
  if (q.location) url.searchParams.set("locationName", q.location);
  if (q.radius_miles != null) {
    url.searchParams.set("distanceFromLocation", String(q.radius_miles));
  }
  url.searchParams.set("resultsToTake", "20");

  const auth = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Reed API HTTP ${res.status} for "${q.keywords}" in ${q.location}`);
  }

  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];

  return results.map((r) => {
    const postedDate = parseReedDate(r.date);
    return {
      title: String(r.jobTitle || "").trim(),
      company: String(r.employerName || "Employer on Reed").trim(),
      location: String(r.locationName || q.location || "UK").trim(),
      salary: formatSalary(r.minimumSalary, r.maximumSalary),
      category: q.category || "",
      source: "Reed",
      posted: formatPostedLabel(postedDate),
      postedDate,
      summary: stripHtmlAndTrim(r.jobDescription || ""),
      url: String(r.jobUrl || "").trim(),
    };
  });
}

async function fetchAdzunaQuery(appId, appKey, q, maxAgeDays) {
  const url = new URL("https://api.adzuna.com/v1/api/jobs/gb/search/1");
  url.searchParams.set("app_id", appId);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("what", q.keywords);
  if (q.location) url.searchParams.set("where", q.location);
  if (q.radius_miles != null) {
    url.searchParams.set("distance", String(Math.round(q.radius_miles * 1.609)));
  }
  url.searchParams.set("max_days_old", String(maxAgeDays));
  url.searchParams.set("results_per_page", "20");
  url.searchParams.set("sort_by", "date");

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Adzuna API HTTP ${res.status} for "${q.keywords}" in ${q.location}`);
  }

  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];

  return results.map((r) => {
    const postedDate = parseIsoDate(r.created);
    return {
      title: String(r.title || "").trim(),
      company: String(r.company?.display_name || "Employer via Adzuna").trim(),
      location: String(r.location?.display_name || q.location || "UK").trim(),
      salary: formatSalary(r.salary_min, r.salary_max),
      category: q.category || r.category?.label || "",
      source: "Adzuna",
      posted: formatPostedLabel(postedDate),
      postedDate,
      summary: stripHtmlAndTrim(r.description || ""),
      url: String(r.redirect_url || "").trim(),
    };
  });
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scoreJob(job, profile) {
  let score = 0;
  const title = job.title.toLowerCase();
  const text = `${job.title} ${job.company} ${job.summary}`.toLowerCase();
  const loc = job.location.toLowerCase();

  // Score keyword matches configured in profile.json
  const keywordSignals = Array.isArray(profile.scoring_keywords)
    ? profile.scoring_keywords
    : (profile.roles || []).map((r) => ({ term: r, points: 12 }));

  for (const item of keywordSignals) {
    const term = String(item?.term || "").toLowerCase().trim();
    const pts = Number(item?.points) || 10;
    if (!term) continue;
    if (title.includes(term)) score += pts;
    else if (text.includes(term)) score += Math.floor(pts / 3);
  }

  // Score priority locations configured in profile.json
  const locationSignals = Array.isArray(profile.priority_locations)
    ? profile.priority_locations
    : (profile.locations || []).map((l) => ({ place: l, points: 10 }));

  for (const item of locationSignals) {
    const place = String(item?.place || "").toLowerCase().trim();
    const pts = Number(item?.points) || 10;
    if (!place) continue;
    if (loc.includes(place) || text.includes(place)) {
      score += pts;
      break;
    }
  }

  // Freshness boost
  const days = ageInDays(job.postedDate);
  if (days !== null) {
    if (days <= 1) score += 8;
    else if (days <= 3) score += 5;
    else if (days <= 7) score += 2;
  }

  // Transparency boost when salary is listed
  if (job.salary) score += 3;

  // Penalise unwanted seniority/title terms configured in profile.json
  const penalised = Array.isArray(profile.penalised_title_terms)
    ? profile.penalised_title_terms
    : [];
  for (const term of penalised) {
    const clean = String(term || "").trim();
    if (!clean) continue;
    const re = new RegExp(`\\b${escapeRegex(clean)}\\b`, "i");
    if (re.test(title)) {
      score -= 15;
      break;
    }
  }

  return score;
}

async function main() {
  const fileEnv = loadEnv(ENV_PATH);
  const env = { ...fileEnv, ...process.env };
  const profile = readJson(PROFILE_PATH, null);
  if (!profile) {
    console.error(`ERROR: Missing ${PROFILE_PATH}`);
    process.exit(1);
  }

  const reedKey = (env.REED_API_KEY || "").trim();
  const adzunaId = (env.ADZUNA_APP_ID || "").trim();
  const adzunaKey = (env.ADZUNA_APP_KEY || "").trim();
  const hasReed = Boolean(reedKey);
  const hasAdzuna = Boolean(adzunaId && adzunaKey);

  if (!hasReed && !hasAdzuna) {
    console.error(
      "ERROR: No UK job API keys configured.\n" +
        "Set REED_API_KEY (free at https://www.reed.co.uk/developers/jobseeker)\n" +
        "and/or ADZUNA_APP_ID + ADZUNA_APP_KEY (free at https://developer.adzuna.com/)."
    );
    process.exit(1);
  }

  const queries = Array.isArray(profile.search_queries) ? profile.search_queries : [];
  const maxAgeDays = Number(profile.max_age_days) || 7;
  const maxJobs = Number(profile.max_jobs_per_email) || 12;
  const maxPerCategory = Number(profile.max_per_category) || 4;
  const excluded = (profile.excluded_keywords || []).map((k) => k.toLowerCase());

  const seenData = readJson(SEEN_PATH, { jobs: [] });
  const seenUrls = new Set((seenData.jobs || []).map((j) => j.url_norm).filter(Boolean));
  const seenKeys = new Set((seenData.jobs || []).map((j) => j.key).filter(Boolean));

  console.log(
    `Fetching jobs across ${queries.length} queries (sources: ${[
      hasReed ? "Reed" : null,
      hasAdzuna ? "Adzuna" : null,
    ]
      .filter(Boolean)
      .join(" + ")})...`
  );

  const allRaw = [];
  let reedCount = 0;
  let adzunaCount = 0;

  for (const q of queries) {
    if (hasReed) {
      try {
        const items = await fetchReedQuery(reedKey, q);
        reedCount += items.length;
        allRaw.push(...items);
      } catch (err) {
        console.warn(`WARN: ${err.message}`);
      }
    }
    if (hasAdzuna) {
      try {
        const items = await fetchAdzunaQuery(adzunaId, adzunaKey, q, maxAgeDays);
        adzunaCount += items.length;
        allRaw.push(...items);
      } catch (err) {
        console.warn(`WARN: ${err.message}`);
      }
    }
  }

  console.log(
    `Collected ${allRaw.length} raw listing(s) (Reed: ${reedCount}, Adzuna: ${adzunaCount}). Filtering & ranking...`
  );

  const batchUrls = new Set();
  const batchKeys = new Set();
  const candidates = [];

  for (const job of allRaw) {
    if (!job.title || !job.url) continue;

    const days = ageInDays(job.postedDate);
    if (days !== null && days > maxAgeDays) continue;

    const combined = `${job.title} ${job.company} ${job.summary}`.toLowerCase();
    if (excluded.some((kw) => kw && combined.includes(kw))) continue;

    const urlNorm = normalizeUrl(job.url);
    const key = normalizeJobKey(job.title, job.company);

    if (seenUrls.has(urlNorm) || seenKeys.has(key)) continue;
    if (batchUrls.has(urlNorm) || batchKeys.has(key)) continue;

    batchUrls.add(urlNorm);
    batchKeys.add(key);

    candidates.push({
      ...job,
      score: scoreJob(job, profile),
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const selected = [];
  const catCounts = new Map();

  for (const job of candidates) {
    if (selected.length >= maxJobs) break;
    const cat = job.category || "General";
    const count = catCounts.get(cat) || 0;
    if (count >= maxPerCategory) continue;
    catCounts.set(cat, count + 1);
    selected.push({
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary,
      category: job.category,
      source: job.source,
      posted: job.posted,
      summary: job.summary,
      url: job.url,
    });
  }

  if (selected.length < maxJobs) {
    const pickedUrls = new Set(selected.map((j) => j.url));
    for (const job of candidates) {
      if (selected.length >= maxJobs) break;
      if (pickedUrls.has(job.url)) continue;
      selected.push({
        title: job.title,
        company: job.company,
        location: job.location,
        salary: job.salary,
        category: job.category,
        source: job.source,
        posted: job.posted,
        summary: job.summary,
        url: job.url,
      });
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(selected, null, 2) + "\n", "utf8");
  console.log(`Wrote ${selected.length} curated new job(s) to pending-jobs.json.`);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
