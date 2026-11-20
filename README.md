# UK Daily Job Bot

A free, zero-dependency, cloud-hosted UK job search bot powered by **GitHub Actions**, **Reed.co.uk** & **Adzuna UK** APIs, and **Gmail SMTP**.

Runs automatically every morning at **8:00 AM UK time** (GMT/BST aware) — even when your laptop is off — deduplicates listings across days, and delivers a clean HTML digest straight to your inbox.

## Features
- **Zero npm dependencies** — pure Node.js built-ins (`fetch`, `tls`, `fs`).
- **100% config-driven** — edit `profile.json` only (no code edits required).
- **Multi-source UK search** — queries Reed.co.uk and/or Adzuna UK (which aggregates Totaljobs, CV-Library, Indeed, Monster, and direct company sites).
- **Smart ranking & category balancing** — scores titles, locations, freshness, and listed salary using weights in `profile.json`.
- **Automatic deduplication** — tracks jobs sent over the last 60 days in `seen-jobs.json` so you never get repeat emails.
- **100% free** — runs on GitHub Actions free tier + free API tiers.

---

## Quick Start (5 Minutes)

### 1. Create Your Own Copy
Click the green **Use this template** → **Create a new repository** button at the top of this page.
- Set visibility to **Private** so your personal email and job history stay private.

### 2. Customise `profile.json`
Open `profile.json` in your new repo and update:
- `recipient`: your name and email address
- `email_subtitle`: short location header shown in the email (e.g. `"Bristol & Remote"`)
- `search_queries`: keywords, UK city/town, search radius in miles, and category label
- `scoring_keywords` & `priority_locations`: terms and points to push your ideal roles to the top
- `penalised_title_terms` & `excluded_keywords`: roles or buzzwords to downrank or filter out

> **AI Tip:** Paste `profile.json` and your CV into your favourite AI assistant and ask it to generate a tailored `profile.json` with targeted search queries, scoring keywords, and exclusions for your exact background.

### 3. Get Your Free Keys
You'll need a Gmail App Password + at least one free UK job API key (using both Reed & Adzuna gives the best coverage):

1. **Gmail App Password:** Go to [Google App Passwords](https://myaccount.google.com/apppasswords) (requires 2-Step Verification), create one named `Daily Job Bot`, and copy the 16-character code.
2. **Reed.co.uk API (free, instant):** Sign up at [Reed Jobseeker API](https://www.reed.co.uk/developers/jobseeker) for `REED_API_KEY`.
3. **Adzuna UK API (free tier):** Sign up at [Adzuna Developer Portal](https://developer.adzuna.com/) for `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`.

### 4. Add GitHub Actions Secrets
In your new repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
| --- | --- |
| `GMAIL_USER` | Your Gmail address |
| `GMAIL_APP_PASSWORD` | Your 16-character Google App Password |
| `FROM_NAME` | Sender name shown in inbox (e.g. `Daily Job Bot`) |
| `REED_API_KEY` | Your Reed API key *(required if not using Adzuna)* |
| `ADZUNA_APP_ID` | Your Adzuna App ID *(optional, recommended)* |
| `ADZUNA_APP_KEY` | Your Adzuna App Key *(optional, recommended)* |

### 5. Run a Test Email
1. Open the **Actions** tab in your repo → select **Daily Job Bot**.
2. Click **Run workflow** → optionally enter your email in `test_recipient` (leaves `seen-jobs.json` untouched) → click **Run workflow**.
3. Check your inbox! Once you're happy with the results, leave it alone — it will run automatically every morning at **8:00 AM UK time**.

---

## Local Testing (Optional)
Copy `.env.example` to `.env`, fill in your keys, and run:

```bash
node fetch-jobs.mjs                           # Fetch & rank fresh UK jobs into pending-jobs.json
node send-digest.mjs --dry-run                # Generate last-digest-preview.html without emailing
node send-digest.mjs --to you@example.com     # Send a test email without updating seen-jobs.json
node send-digest.mjs --test-auth              # Verify Gmail SMTP credentials
```

## Changing the Schedule Time
Edit the `cron` lines in `.github/workflows/daily-job-bot.yml` (times are in UTC; the built-in `GMT`/`BST` guard automatically handles UK clocks changing).
