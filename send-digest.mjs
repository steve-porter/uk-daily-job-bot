#!/usr/bin/env node
/**
 * UK Daily Job Bot — Deduplicator, HTML Digest Builder & Gmail SMTPS Mailer
 * Zero external dependencies (uses Node.js built-in tls, fs, path, crypto).
 *
 * Usage:
 *   node send-digest.mjs                       # Deduplicate pending-jobs.json & email recipient in profile.json
 *   node send-digest.mjs --dry-run             # Build last-digest-preview.html without emailing
 *   node send-digest.mjs --to you@example.com  # Send a test copy to another address (does not update seen-jobs.json)
 *   node send-digest.mjs --test-auth           # Verify Gmail SMTP credentials without sending an email
 */

import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENV_PATH = path.join(__dirname, ".env");
const PROFILE_PATH = path.join(__dirname, "profile.json");
const SEEN_PATH = path.join(__dirname, "seen-jobs.json");
const DEFAULT_INPUT_PATH = path.join(__dirname, "pending-jobs.json");

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT_PATH,
    dryRun: false,
    testAuth: false,
    toOverride: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--test-auth") {
      args.testAuth = true;
    } else if (token === "--input" && argv[i + 1]) {
      args.input = path.resolve(__dirname, argv[++i]);
    } else if (token === "--to" && argv[i + 1]) {
      args.toOverride = argv[++i].trim();
    }
  }
  return args;
}

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

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatUkDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(date);
}

function formatShortUkDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(date);
}

function formatIsoUkDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Europe/London",
  }).format(date);
}

function filterAndDeduplicate(candidates, seenData, profile) {
  const seenUrls = new Set();
  const seenKeys = new Set();

  for (const item of seenData.jobs || []) {
    if (item.url_norm) seenUrls.add(item.url_norm);
    if (item.key) seenKeys.add(item.key);
  }

  const excluded = (profile.excluded_keywords || []).map((k) => k.toLowerCase());
  const maxJobs = Number(profile.max_jobs_per_email) || 12;

  const fresh = [];
  const skipped = { invalid: 0, duplicate: 0, excluded: 0 };

  for (const job of candidates) {
    if (!job || !job.title || !job.url) {
      skipped.invalid++;
      continue;
    }

    const combinedText = `${job.title} ${job.company || ""} ${job.summary || ""}`.toLowerCase();
    if (excluded.some((kw) => kw && combinedText.includes(kw))) {
      skipped.excluded++;
      continue;
    }

    const urlNorm = normalizeUrl(job.url);
    const key = normalizeJobKey(job.title, job.company || "");

    if (seenUrls.has(urlNorm) || (job.company && seenKeys.has(key))) {
      skipped.duplicate++;
      continue;
    }

    seenUrls.add(urlNorm);
    if (job.company) seenKeys.add(key);

    fresh.push({
      title: String(job.title).trim(),
      company: String(job.company || "Company listed on site").trim(),
      location: String(job.location || "UK").trim(),
      salary: job.salary ? String(job.salary).trim() : "",
      category: job.category ? String(job.category).trim() : "",
      source: job.source ? String(job.source).trim() : "",
      posted: job.posted ? String(job.posted).trim() : "",
      summary: job.summary ? String(job.summary).trim() : "",
      url: String(job.url).trim(),
      url_norm: urlNorm,
      key,
    });

    if (fresh.length >= maxJobs) break;
  }

  return { fresh, skipped };
}

function buildEmailContent(jobs, profile, date = new Date()) {
  const fullDate = formatUkDate(date);
  const shortDate = formatShortUkDate(date);
  const firstName = (profile.recipient?.name || "there").split(" ")[0];
  const subtitle =
    profile.email_subtitle ||
    (Array.isArray(profile.locations) && profile.locations.length
      ? profile.locations.join(" & ")
      : "UK");
  const rolesText =
    Array.isArray(profile.roles) && profile.roles.length
      ? profile.roles.join(", ")
      : "Configured roles in profile.json";
  const count = jobs.length;

  const subject = `${count} new job match${count === 1 ? "" : "es"} for you — ${shortDate}`;

  const textLines = [
    `Morning ${firstName},`,
    "",
    `Here ${count === 1 ? "is" : "are"} ${count} fresh job match${count === 1 ? "" : "es"} found today (${fullDate}) for ${subtitle}:`,
    "",
  ];

  jobs.forEach((job, idx) => {
    textLines.push(`${idx + 1}. ${job.title} — ${job.company}`);
    const meta = [job.location, job.salary, job.posted, job.source].filter(Boolean);
    if (meta.length) textLines.push(`   ${meta.join(" | ")}`);
    if (job.summary) textLines.push(`   ${job.summary}`);
    textLines.push(`   Apply / Details: ${job.url}`);
    textLines.push("");
  });

  textLines.push(
    "---",
    `Criteria: ${subtitle} | ${rolesText}`,
    "Update profile.json in your GitHub repo anytime to adjust locations, roles, or keywords."
  );

  const jobCardsHtml = jobs
    .map((job) => {
      const badges = [
        job.location ? `📍 ${escapeHtml(job.location)}` : "",
        job.salary ? `💷 ${escapeHtml(job.salary)}` : "",
        job.posted ? `🕒 ${escapeHtml(job.posted)}` : "",
        job.source ? `🔗 ${escapeHtml(job.source)}` : "",
      ]
        .filter(Boolean)
        .map(
          (b) =>
            `<span style="display:inline-block;background:#f1f5f9;color:#334155;font-size:12px;padding:4px 9px;border-radius:999px;margin:0 6px 6px 0;">${b}</span>`
        )
        .join("");

      const categoryPill = job.category
        ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#2563eb;margin-bottom:4px;">${escapeHtml(job.category)}</div>`
        : "";

      const summaryHtml = job.summary
        ? `<p style="margin:8px 0 14px 0;font-size:14px;line-height:1.5;color:#475569;">${escapeHtml(job.summary)}</p>`
        : `<div style="height:10px;"></div>`;

      return `
      <tr>
        <td style="padding:0 0 14px 0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;">
            <tr>
              <td style="padding:18px 20px;">
                ${categoryPill}
                <div style="font-size:17px;font-weight:700;color:#0f172a;line-height:1.3;">
                  <a href="${escapeHtml(job.url)}" style="color:#0f172a;text-decoration:none;">${escapeHtml(job.title)}</a>
                </div>
                <div style="font-size:14px;font-weight:600;color:#475569;margin:3px 0 10px 0;">${escapeHtml(job.company)}</div>
                <div style="margin-bottom:4px;">${badges}</div>
                ${summaryHtml}
                <a href="${escapeHtml(job.url)}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;padding:9px 16px;border-radius:6px;">View &amp; Apply &rarr;</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;">
          <tr>
            <td style="background:#0f172a;color:#ffffff;padding:24px 26px;border-radius:12px 12px 0 0;">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#93c5fd;font-weight:700;">Daily Job Digest</div>
              <h1 style="margin:6px 0 6px 0;font-size:22px;line-height:1.25;color:#ffffff;">Morning ${escapeHtml(firstName)} — ${count} fresh match${count === 1 ? "" : "es"}</h1>
              <div style="font-size:13px;color:#cbd5e1;">${escapeHtml(fullDate)} &middot; ${escapeHtml(subtitle)}</div>
            </td>
          </tr>
          <tr>
            <td style="background:#f1f5f9;padding:20px 18px 8px 18px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                ${jobCardsHtml}
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;padding:16px 22px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;font-size:12px;line-height:1.5;color:#64748b;">
              <strong>Current criteria:</strong> ${escapeHtml(subtitle)} &middot; ${escapeHtml(rolesText)}.<br>
              Edit <code>profile.json</code> in your repository anytime to tweak locations, roles, or filters.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text: textLines.join("\n"), html };
}

function encodeHeaderUtf8(str) {
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`;
}

function wrapBase64(str) {
  const b64 = Buffer.from(str, "utf8").toString("base64");
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function buildMimeMessage({ fromName, fromEmail, toEmail, replyTo, subject, text, html }) {
  const boundary = `----=_JobBot_${crypto.randomBytes(12).toString("hex")}`;
  const msgId = `<${crypto.randomBytes(12).toString("hex")}@gmail.com>`;
  const dateHeader = new Date().toUTCString();
  const safeFromName = encodeHeaderUtf8(fromName).replace(/"/g, "");

  const headers = [
    `From: "${safeFromName}" <${fromEmail}>`,
    `To: ${toEmail}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeaderUtf8(subject)}`,
    `Date: ${dateHeader}`,
    `Message-ID: ${msgId}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  const parts = [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    wrapBase64(text),
    "",
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    wrapBase64(html),
    "",
    `--${boundary}--`,
    "",
  ];

  return parts
    .join("\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function smtpSend({ host, port, user, pass, to, rawMessage, testAuthOnly = false }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: true },
      () => {}
    );
    socket.setTimeout(30000);
    socket.setEncoding("utf8");

    let buffer = "";
    let pending = null;

    const readResponse = () =>
      new Promise((res, rej) => {
        pending = { res, rej };
        processBuffer();
      });

    const processBuffer = () => {
      if (!pending) return;
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        if (/^\d{3} /.test(line)) {
          const code = Number(line.slice(0, 3));
          const { res } = pending;
          pending = null;
          res({ code, line });
          return;
        }
      }
    };

    const fail = (err) => {
      if (pending) {
        const { rej } = pending;
        pending = null;
        rej(err);
      } else {
        reject(err);
      }
      socket.destroy();
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      processBuffer();
    });
    socket.on("timeout", () => fail(new Error("SMTP connection timed out after 30s")));
    socket.on("error", (err) => fail(err));

    const sendCmd = async (cmd, expectedCodes) => {
      socket.write(`${cmd}\r\n`);
      const resp = await readResponse();
      if (!expectedCodes.includes(resp.code)) {
        throw new Error(`SMTP error (${resp.code}): ${resp.line}`);
      }
      return resp;
    };

    (async () => {
      try {
        const greeting = await readResponse();
        if (greeting.code !== 220) {
          throw new Error(`Unexpected SMTP greeting (${greeting.code}): ${greeting.line}`);
        }
        await sendCmd("EHLO localhost", [250]);

        const authToken = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
        await sendCmd(`AUTH PLAIN ${authToken}`, [235]);

        if (!testAuthOnly) {
          await sendCmd(`MAIL FROM:<${user}>`, [250]);
          await sendCmd(`RCPT TO:<${to}>`, [250, 251]);
          await sendCmd("DATA", [354]);
          socket.write(`${rawMessage}\r\n.\r\n`);
          const dataResp = await readResponse();
          if (dataResp.code !== 250) {
            throw new Error(`SMTP DATA rejected (${dataResp.code}): ${dataResp.line}`);
          }
        }

        try {
          await sendCmd("QUIT", [221]);
        } catch {
          // Ignore close-time errors after accepted delivery
        }
        socket.end();
        resolve();
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    })();
  });
}

function updateSeenJobs(seenData, sentJobs) {
  const cutoffMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const kept = (seenData.jobs || []).filter((item) => {
    const ts = Date.parse(item.sent_at || "");
    return Number.isNaN(ts) || ts >= cutoffMs;
  });

  const nowIso = new Date().toISOString();
  for (const job of sentJobs) {
    kept.push({
      title: job.title,
      company: job.company,
      url: job.url,
      url_norm: job.url_norm,
      key: job.key,
      sent_at: nowIso,
    });
  }

  fs.writeFileSync(
    SEEN_PATH,
    JSON.stringify({ last_sent_uk_date: formatIsoUkDate(), jobs: kept }, null, 2) + "\n",
    "utf8"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...loadEnv(ENV_PATH), ...process.env };
  const profile = readJson(PROFILE_PATH, null);

  if (!profile) {
    console.error(`ERROR: Missing ${PROFILE_PATH}`);
    process.exit(1);
  }

  const gmailUser = (env.GMAIL_USER || "").trim();
  const gmailPass = (env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "").trim();
  const fromName = (env.FROM_NAME || "Daily Job Bot").trim();

  if (args.testAuth) {
    if (!gmailUser || !gmailPass) {
      console.error("ERROR: Set GMAIL_USER and GMAIL_APP_PASSWORD in .env first.");
      process.exit(1);
    }
    await smtpSend({
      host: "smtp.gmail.com",
      port: 465,
      user: gmailUser,
      pass: gmailPass,
      testAuthOnly: true,
    });
    console.log(`OK: Authenticated to smtp.gmail.com as ${gmailUser}.`);
    return;
  }

  if (!fs.existsSync(args.input)) {
    console.error(`ERROR: Input jobs file not found: ${args.input}`);
    process.exit(1);
  }

  const rawInput = readJson(args.input, []);
  const candidates = Array.isArray(rawInput) ? rawInput : rawInput.jobs || [];
  const seenData = readJson(SEEN_PATH, { jobs: [] });
  const isOverride = Boolean(args.toOverride || (env.TEST_RECIPIENT || "").trim());

  if (env.ONCE_PER_DAY === "true" && !args.dryRun && !isOverride) {
    const todayUk = formatIsoUkDate();
    const alreadySentToday =
      seenData.last_sent_uk_date === todayUk ||
      (seenData.jobs || []).some((j) => {
        if (!j.sent_at) return false;
        const d = new Date(j.sent_at);
        return !Number.isNaN(d.getTime()) && formatIsoUkDate(d) === todayUk;
      });
    if (alreadySentToday) {
      console.log(`Already sent today's digest (${todayUk} UK). Skipping backup slot.`);
      return;
    }
  }

  const { fresh, skipped } = filterAndDeduplicate(candidates, seenData, profile);
  console.log(
    `Processed ${candidates.length} candidate(s): ${fresh.length} fresh, ${skipped.duplicate} duplicate, ${skipped.excluded} excluded, ${skipped.invalid} invalid.`
  );

  if (fresh.length === 0) {
    console.log("No new jobs to send today. Skipping email.");
    return;
  }

  const { subject, text, html } = buildEmailContent(fresh, profile);

  const recipient =
    args.toOverride ||
    (env.TEST_RECIPIENT || "").trim() ||
    profile.recipient?.email;

  if (!recipient || recipient === "you@example.com") {
    console.error("ERROR: Update recipient.email in profile.json before sending.");
    process.exit(1);
  }

  if (args.dryRun) {
    const previewPath = path.join(__dirname, "last-digest-preview.html");
    fs.writeFileSync(previewPath, html, "utf8");
    console.log(`DRY RUN: Would email ${recipient}`);
    console.log(`Subject: ${subject}`);
    console.log(`Preview saved to: ${previewPath}`);
    return;
  }

  if (!gmailUser || !gmailPass) {
    console.error(
      "ERROR: GMAIL_USER or GMAIL_APP_PASSWORD is missing.\n" +
        "1. Visit https://myaccount.google.com/apppasswords\n" +
        "2. Create an App Password named 'Daily Job Bot'\n" +
        "3. Save it in .env locally or as GMAIL_APP_PASSWORD in GitHub Secrets"
    );
    process.exit(1);
  }

  const rawMessage = buildMimeMessage({
    fromName,
    fromEmail: gmailUser,
    toEmail: recipient,
    replyTo: gmailUser,
    subject,
    text,
    html,
  });

  await smtpSend({
    host: "smtp.gmail.com",
    port: 465,
    user: gmailUser,
    pass: gmailPass,
    to: recipient,
    rawMessage,
  });

  const sentCopyPath = path.join(__dirname, "last-digest.html");
  fs.writeFileSync(sentCopyPath, html, "utf8");

  if (!isOverride) {
    updateSeenJobs(seenData, fresh);
    console.log(`SENT: Emailed ${fresh.length} job(s) to ${recipient} and updated seen-jobs.json.`);
  } else {
    console.log(
      `SENT (test recipient): Emailed ${fresh.length} job(s) to ${recipient} (seen-jobs.json left unchanged).`
    );
  }
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
