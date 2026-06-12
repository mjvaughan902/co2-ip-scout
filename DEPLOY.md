# CO₂ Utilisation IP Scout — Deploy Guide
==========================================

## What you need before starting
- Your EPO Consumer Key and Consumer Secret (from developers.epo.org)
- Your Anthropic API Key (from console.anthropic.com — same account that powers Claude)
- Node.js installed (you have this)
- A Vercel account (you have this)

---

## Step 1 — Install the Vercel CLI

Open a terminal and run:

    npm install -g vercel

---

## Step 2 — Navigate to the project folder

    cd co2-ip-scout

---

## Step 3 — Install dependencies

    npm install

---

## Step 4 — Deploy to Vercel

Run:

    vercel

On first run it will ask you a few questions:
- "Set up and deploy?" → Y
- "Which scope?" → select your account
- "Link to existing project?" → N
- "Project name?" → co2-ip-scout (or anything you like)
- "In which directory is your code?" → ./ (just press Enter)
- "Override settings?" → N

Vercel will deploy and give you a preview URL like:
    https://co2-ip-scout-abc123.vercel.app

---

## Step 5 — Add your API keys (critical)

Go to: https://vercel.com/dashboard
→ Click your project (co2-ip-scout)
→ Settings → Environment Variables
→ Add these three variables:

| Name                  | Value                          |
|-----------------------|--------------------------------|
| EPO_CONSUMER_KEY      | your key from developers.epo.org |
| EPO_CONSUMER_SECRET   | your secret from developers.epo.org |
| ANTHROPIC_API_KEY     | your key from console.anthropic.com |

Set each one for "Production", "Preview", and "Development" environments.

---

## Step 6 — Redeploy to pick up the environment variables

    vercel --prod

Your live URL will be shown — something like:
    https://co2-ip-scout.vercel.app

---

## Step 7 — Test it

Open the URL and:
1. Select the "Cyclic & linear carbonates" family
2. Type: "propylene carbonate synthesis CO₂ organocatalyst"
3. Click Analyse

You should see the green "📡 Live EPO data" badge appear with real patent counts.

---

## Local development

To run locally with live API calls:

    vercel dev

This starts a local server at http://localhost:3000 that runs the serverless
functions exactly as they will in production.

Create a .env.local file (never commit this) with your keys:

    EPO_CONSUMER_KEY=your_key
    EPO_CONSUMER_SECRET=your_secret
    ANTHROPIC_API_KEY=your_key

---

## Troubleshooting

**"EPO credentials not configured"**
→ Check that environment variables are set in Vercel dashboard and you've redeployed.

**"EPO auth failed: 401"**
→ Double-check your Consumer Key and Secret are copied correctly with no spaces.

**"No live EPO data retrieved"**
→ The query may not match any patents in the EPO database with those CPC codes.
   Try a broader query or check the CPC codes are correct.

**AI analysis works but no EPO data**
→ This is fine — the tool degrades gracefully to AI estimates when EPO returns
   no results. The badge will show "AI estimate" instead of "Live EPO data".

---

## Architecture overview

    Browser (public/index.html)
        │
        ├── POST /api/epo-search   → api/epo-search.js
        │       │                       ↓
        │       │                   EPO OPS API (ops.epo.org)
        │       │                   Returns: real patent records, assignees, counts
        │       │
        └── POST /api/ai-analyse   → api/ai-analyse.js
                │                       ↓
                │                   Anthropic API (api.anthropic.com)
                │                   Input: query + real EPO data
                │                   Returns: landscape analysis, white space, strategy
                │
                └── Combined result rendered in browser

Your API keys never leave the server. The browser only talks to /api/*.
