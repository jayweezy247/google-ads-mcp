# Google Ads MCP Server

A read-focused MCP server for Claude Desktop that connects to your Google Ads account. Get campaign reports, performance data, and optimization recommendations — with confirmation-gated controls for making changes.

---

## What it can do

| Tool | Type | Description |
|---|---|---|
| `add_keywords` | ⚠️ Mutating | Adds keywords to an ad group — **requires `confirmed: true`** |
| `add_negative_keywords` | ⚠️ Mutating | Adds negatives at campaign or ad group level — **requires `confirmed: true`** |
| `check_enable_preflight` | Read | What would block enabling a campaign, without changing anything |
| `create_ad_group` | ⚠️ Mutating | Creates an ad group — **requires `confirmed: true`** |
| `create_assets` | ⚠️ Mutating | Creates assets (sitelinks, callouts, structured snippets) — **requires `confirmed: true`** |
| `create_campaign` | ⚠️ Mutating | Creates a campaign — **requires `confirmed: true`** |
| `create_conversion_action` | ⚠️ Mutating | Creates a website conversion action; returns the AW conversion ID + label — **requires `confirmed: true`** |
| `create_rsa` | ⚠️ Mutating | Creates a responsive search ad — **requires `confirmed: true`** |
| `create_shared_negative_list` | ⚠️ Mutating | Creates a shared negative keyword list — **requires `confirmed: true`** |
| `enable_campaign` | ⚠️ Mutating | Enables a paused campaign — **requires `confirmed: true`** |
| `explain_changes` | Read | The append-only log of writes this server executed, blocked or failed |
| `generate_keyword_ideas` | Read | Keyword ideas from seed terms |
| `get_account_summary` | Read | Spend, clicks, impressions, conversions for a date range |
| `get_ad_groups` | Read | Ad groups within a campaign |
| `get_ad_policy_details` | Read | Why an ad was disapproved or limited |
| `get_ads` | Read | Individual ads with headlines, descriptions, approval status |
| `get_campaigns` | Read | Campaigns with status, budget and metrics |
| `get_keywords` | Read | Keywords with match type, quality score and bids |
| `get_performance_report` | Read | Metrics at campaign / ad group / keyword level |
| `get_recommendations` | Read | Google's own optimization suggestions |
| `list_accounts` | Read | Every account this identity can reach, with the active one marked |
| `pause_campaign` | ⚠️ Mutating | Pauses a campaign — **requires `confirmed: true`** |
| `run_audit` | Read | Full account audit: wasted search-term spend, zero-conversion keywords, low quality score |
| `run_gaql` | Read | An arbitrary read-only GAQL SELECT, for anything the fixed tools do not cover |
| `set_active_account` | Read | Point this session at an account. Per-session — it does not move another operator's |
| `update_ad_status` | ⚠️ Mutating | Enables, pauses or removes an ad — **requires `confirmed: true`** |
| `update_campaign_budget` | ⚠️ Mutating | Changes a daily budget — **requires `confirmed: true`** |
| `update_conversion_action` | ⚠️ Mutating | Edits a conversion action (primary flag, counting, name, status) — **requires `confirmed: true`** |

**Confirmation-gated mutations:** Claude will always show you a dry-run preview before making any change. You explicitly approve it before anything touches your account.

---

## Prerequisites

- Node.js 18+ installed ([nodejs.org](https://nodejs.org))
- Claude Desktop installed ([claude.ai/download](https://claude.ai/download))
- A Google Ads account
- A Google Cloud Platform (GCP) project

---

## Step-by-Step Setup

### Step 1 — Get your Google Ads Developer Token

1. Sign in to [Google Ads](https://ads.google.com)
2. Go to **Tools & Settings → API Center**
3. Copy your **Developer Token**
   - A **Test Token** works for testing (limited to test accounts)
   - A **Basic Token** (what you've applied for) works with real accounts

### Step 2 — Create a GCP Project and OAuth Credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Enable the **Google Ads API**:
   - Navigate to **APIs & Services → Library**
   - Search "Google Ads API" → Click **Enable**
4. Create OAuth credentials:
   - Go to **APIs & Services → Credentials**
   - Click **+ Create Credentials → OAuth Client ID**
   - Application type: **Desktop app**
   - Name it anything (e.g. "Google Ads MCP")
   - Click **Create**
5. Copy your **Client ID** and **Client Secret**

> **OAuth consent screen:** If prompted, configure it. Set user type to **External**, add your email as a test user, and add the scope `https://www.googleapis.com/auth/adwords`.

### Step 3 — Clone and install this project

```bash
git clone <your-repo-url> google-ads-mcp
cd google-ads-mcp
npm install
```

Or if you downloaded the ZIP, just `cd` into the folder and run `npm install`.

### Step 4 — Create your .env file

Credentials live **outside the project directory**, so they cannot be swept into a
zip, a `git add -A`, or a `rm -rf` of the working tree:

```bash
mkdir -p ~/.config/google-ads-mcp && chmod 700 ~/.config/google-ads-mcp
cp .env.example ~/.config/google-ads-mcp/.env
chmod 600 ~/.config/google-ads-mcp/.env
```

Open `~/.config/google-ads-mcp/.env` and fill in your Developer Token, Client ID,
Client Secret, Customer ID, and **Login Customer ID** — the last is the MCC the calls are
made through, and the server refuses to start without it. Leave `REFRESH_TOKEN` blank for now.

The server resolves credentials in this order — first file that exists wins:

1. `$GOOGLE_ADS_MCP_ENV` (explicit override)
2. `~/.config/google-ads-mcp/.env` (canonical)
3. `<project>/.env` (legacy fallback; warns on stderr if used)

Your **Customer ID** is the 10-digit number in the top-right of Google Ads (e.g. `123-456-7890` → enter `1234567890` without dashes).

### Step 5 — Generate your Refresh Token

Run the one-time auth script:

```bash
npm run auth
```

This will:
1. Print a URL — open it in your browser
2. Sign in with the Google account linked to your Ads account
3. Grant access and copy the code shown
4. Paste it back in the terminal
5. Print your `GOOGLE_ADS_REFRESH_TOKEN`

Copy that token into your `.env` file.

### Step 6 — Build the server

```bash
npm run build
```

This compiles TypeScript to `dist/index.js`.

### Step 7 — Connect to Claude Desktop

1. Open Claude Desktop
2. Go to **Settings → Developer → Edit Config**
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

3. Add this block (merge into existing `mcpServers` if you have others):

```json
{
  "mcpServers": {
    "google-ads": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/google-ads-mcp/dist/index.js"]
    }
  }
}
```

> **No credentials in this file.** The server loads them from
> `~/.config/google-ads-mcp/.env`, which is mode 600 and outside the project tree.
> Claude Desktop's config is not — it is world-readable on most setups, gets pasted
> into support threads, and is easy to sync to a backup by accident. An `env` block
> here would be a second copy of your Developer Token and refresh token, and second
> copies are what leak.

> **Important:** Replace `/ABSOLUTE/PATH/TO/google-ads-mcp` with the real path on your computer.
> - macOS example: `/Users/yourname/projects/google-ads-mcp`
> - Windows example: `C:\\Users\\yourname\\projects\\google-ads-mcp`

4. **Restart Claude Desktop** completely (quit and reopen)

5. You should see a 🔌 icon in Claude — click it to verify "google-ads" is listed

---

## Using it with Claude

Once connected, just talk to Claude naturally:

```
"Give me an account summary for the last 30 days"

"Which campaigns are spending the most but converting the least?"

"Show me performance by campaign for the last 7 days"

"What recommendations does Google have for my account?"

"I want to pause campaign 12345678 — what will happen?"
  → Claude shows dry-run preview
  → You say "Yes, do it" / confirmed: true
  → Claude executes the pause
```

---

## Troubleshooting

| Error | Fix |
|---|---|
| `DEVELOPER_TOKEN_NOT_APPROVED` | Your basic token may still be pending. Test tokens only work with test accounts. |
| `OAUTH2_ERROR` or `invalid_grant` | Refresh token expired or wrong account. Re-run `npm run auth`. |
| `Missing GOOGLE_ADS_LOGIN_CUSTOMER_ID` at startup | The MCC ID is required and is easy to miss. Add it to your `.env` (no dashes). The error names the exact file it wants. |
| `CUSTOMER_NOT_FOUND` | Double-check your Customer ID (no dashes, 10 digits). |
| `REQUEST_ERROR: 403` | Make sure the Google Ads API is enabled in your GCP project. |
| Claude doesn't show the google-ads tool | Check the config path, restart Claude Desktop, and verify the `dist/` folder exists after `npm run build`. |

---

## Hosted: Sign in with Google (Cloud Run)

The same server runs on Cloud Run as a claude.ai connector (`node dist/http.js`;
deploy with `cloudbuild.yaml`, see the README
`docs/runbooks/deploy-google-ads-mcp.md`). There is no shared refresh token and no
bearer to copy:

1. Add the connector in claude.ai (Settings → Connectors) with the service URL plus `/mcp`.
2. claude.ai sends you to Google. Sign in with your Workspace account and leave the
   **Google Ads** box ticked. A sign-in without it is refused, with that reason.
3. Google returns a refresh token minted for you. It is stored in Firestore
   `ads_mcp_credentials/<your Google sub>`, and every call you make runs as you. The
   rate limit, the action log and Google's own change history all name you.

Signing in again replaces your stored token. That is also how you recover from a
revoked one. Only verified accounts on `ALLOWED_DOMAINS` get in, narrowed by
`ALLOWED_EMAILS` if you set it. Your Google account still needs access to the MCC in
Google Ads: sign-in grants the server nothing that your account does not already have.

The sign-in client is the Ads OAuth client itself (`GOOGLE_ADS_CLIENT_ID`), because a
refresh token only works with the client that minted it. Its authorised redirect URIs
must include `<PUBLIC_URL>/oauth/google/callback`.

## Security notes

- Credentials live only in `~/.config/google-ads-mcp/.env` (mode `600`, outside the project tree)
- Nothing is sent to any third-party service — the server runs entirely on your machine
- `.env` is listed in `.gitignore` as a backstop — never commit it
- Mutating tools require `confirmed: true`; without it they return a dry-run preview

  ⚠️ Note the limit of that last one: the flag makes the preview the *default*, but nothing
  in the server forces a preview to happen before an execute, and nothing can verify a human
  read it. Treat it as a guardrail against accidents, not against a mistaken model. See
  [SPEC-write-safety.md](SPEC-write-safety.md) for the hard caps that would be real enforcement.

---

## Upgrading

Developer tokens were retired by Google on 2026-09-09. `GOOGLE_ADS_DEVELOPER_TOKEN` is optional: leave it unset and the server sends no `developer-token` header. API access levels now belong to the Cloud project that owns the OAuth client.
