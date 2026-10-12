#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleAdsApi, enums } from "google-ads-api";
import * as dotenv from "dotenv";
import { z } from "zod";
import { resolveEnvPath, warnIfLegacyEnvPresent } from "./env-path";
import { omitUnsetDeveloperToken } from "./developer-token";
import {
  CAPS, toMicros, usd, refusal, text, logAction, recordWrite,
  checkBudgetCaps, checkRateLimit, readActionLog, actionLogLocation,
  assertDeploymentIsSound, runAsActor, flushActionLog,
  configureCredentials, SingleEnvCredentialStore, refreshTokenFor, LOCAL_ACTOR,
} from "./write-safety";
import {
  BUILD_TOOLS, enablePreflight,
  handleCreateCampaign, handleCreateAdGroup, handleAddKeywords, handleCreateRsa,
  handleCreateAssets, handleCreateSharedNegativeList, handleCreateConversionAction, handleUpdateConversionAction,
  handleUpdateAdStatus, handleGetAdPolicyDetails, handleCheckEnablePreflight,
} from "./build-tools";

// Load .env from ~/.config/google-ads-mcp/, falling back to the package root.
// Resolved from an absolute path, not cwd: Claude Desktop launches this server
// with cwd="/", so a bare dotenv.config() would silently find nothing and force
// credentials to be duplicated into claude_desktop_config.json.
const ENV_PATH = resolveEnvPath();
dotenv.config({ path: ENV_PATH });
warnIfLegacyEnvPresent(ENV_PATH);

// ── Credentials ───────────────────────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    // Report ENV_PATH, not the legacy in-project path. resolveEnvPath() returns
    // the canonical ~/.config location when no file exists yet, so this names the
    // file the reader should actually create or edit.
    throw new Error(
      `Missing ${name}. Set it in ${ENV_PATH} (chmod 600).`
    );
  }
  return v.trim();
}

// Optional since Google retired developer tokens (2026-09-09). Unset, the
// header is not sent at all; see developer-token.ts.
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || undefined;
omitUnsetDeveloperToken();
const CLIENT_ID = requireEnv("GOOGLE_ADS_CLIENT_ID");
const CLIENT_SECRET = requireEnv("GOOGLE_ADS_CLIENT_SECRET");
// Optional here, required by the stdio entry below. The HTTP entry has no shared
// token at all: each operator's own token arrives through sign-in, so a
// deployment is not asked for one it must never use.
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN?.trim() ?? "";

// Local default: one identity, the .env token. A deployment replaces this with a
// per-actor store and assertDeploymentIsSound() refuses to start without one.
if (REFRESH_TOKEN) configureCredentials(new SingleEnvCredentialStore(REFRESH_TOKEN));
const CUSTOMER_ID = requireEnv("GOOGLE_ADS_CUSTOMER_ID"); // without dashes
const LOGIN_CUSTOMER_ID = requireEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
// ── Session state ─────────────────────────────────────────────────────────────
// The active account is per-session, never module-global. Under stdio there is
// exactly one session and this behaves exactly as the single global did. Over
// HTTP each client gets its own, which is the whole point: one operator calling
// set_active_account must not move another operator's next write to a different
// client. See the deployment notes.
type Session = {
  /** Who is acting. Stamps the audit log and keys the write cap. */
  actor: string;
  /** Resolved once per session: locally the shared .env token, per-actor when deployed. */
  refreshToken: string;
  activeCustomerId: string;
};
type Ctx = {
  getCustomer: () => any;
  /** The acting identity for this session. */
  actor: () => string;
  /** This session's refresh token — for calls against an account other than the active one. */
  refreshToken: () => string;
  /** Active account, dashes stripped — the form the API wants. */
  cid: () => string;
  /** Active account as set, for display. */
  raw: () => string;
  setActive: (customerId: string) => void;
};

const sessions = new Map<string, Session>();

/** Stdio is one process serving one client, so every call shares one key. */
export const STDIO_SESSION_KEY = "stdio";

export function endSession(key: string): void {
  sessions.delete(key);
}

export async function getSession(key: string, actor: string = LOCAL_ACTOR): Promise<Session> {
  let session = sessions.get(key);
  if (!session) {
    // Resolved once, here, so the rest of the server stays synchronous: under
    // stdio this is the .env token, and on a deployment it is the token minted
    // for this actor's own Google identity.
    const refreshToken = await refreshTokenFor(actor);
    // A new session starts at the configured default rather than inheriting
    // whatever the last session happened to be looking at.
    session = { actor, refreshToken, activeCustomerId: CUSTOMER_ID };
    sessions.set(key, session);
  }
  return session;
}

export function makeCtx(session: Session): Ctx {
  return {
    getCustomer: () => getCustomerFor(session.activeCustomerId, session.refreshToken),
    actor: () => session.actor,
    refreshToken: () => session.refreshToken,
    cid: () => session.activeCustomerId.replace(/-/g, ""),
    raw: () => session.activeCustomerId,
    setActive: (customerId: string) => { session.activeCustomerId = customerId; },
  };
}

function getClient() {
  return new GoogleAdsApi({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    developer_token: DEVELOPER_TOKEN,
  });
}

function getCustomerFor(activeCustomerId: string, refreshToken: string) {
  const client = getClient();
  return client.Customer({
    customer_id: activeCustomerId.replace(/-/g, ""),
    login_customer_id: LOGIN_CUSTOMER_ID.replace(/-/g, ""),
    refresh_token: refreshToken,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function microsToBudget(micros: number | string | undefined): string {
  if (micros === undefined || micros === null) return "N/A";
  return `$${(Number(micros) / 1_000_000).toFixed(2)}`;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function defaultDateRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start: formatDate(start), end: formatDate(end) };
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "list_accounts",
    description:
      "List all Google Ads client accounts accessible under the configured manager (MCC). Use this to discover account CIDs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_active_account",
    description:
      "Switch the active Google Ads account that all report tools query. Pass the client CID (with or without dashes). Persists until changed.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Client account CID to switch to, e.g. 6305730974." },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "run_gaql",
    description:
      "Run an arbitrary read-only GAQL (Google Ads Query Language) SELECT against the active account. Use this for anything the purpose-built report tools don't cover: geo/device/hour-of-day segments, asset and PMax asset-group performance, audience and demographic views, change history, budget pacing, landing page views. Only SELECT is permitted — mutations are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A complete GAQL SELECT statement, e.g. \"SELECT campaign.name, segments.device, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS\".",
        },
        limit: {
          type: "number",
          description:
            "Max rows to return. Defaults to 200, capped at 2000. Applied client-side after the query runs.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "add_negative_keywords",
    description:
      "⚠️ MUTATING — Add negative keywords at campaign or ad group level. This is the fix for wasted search-term spend surfaced by run_audit. Requires confirmed: true to execute; without it, returns a dry-run preview of exactly what would be created.",
    inputSchema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "The negative keyword texts to add, e.g. [\"free\", \"jobs\", \"diy\"].",
        },
        match_type: {
          type: "string",
          enum: ["EXACT", "PHRASE", "BROAD"],
          description:
            "Match type for the negatives. Defaults to PHRASE, which blocks the term and its variants without over-blocking.",
        },
        level: {
          type: "string",
          enum: ["CAMPAIGN", "AD_GROUP"],
          description: "Where to add the negatives. Defaults to CAMPAIGN.",
        },
        campaign_id: {
          type: "string",
          description: "Campaign ID. Required when level is CAMPAIGN.",
        },
        ad_group_id: {
          type: "string",
          description: "Ad group ID. Required when level is AD_GROUP.",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true to execute. Defaults to false (dry run).",
        },
      },
      required: ["keywords"],
    },
  },
  {
    name: "run_audit",
    description:
      "Run a full account audit on the active account: wasted search-term spend, zero-conversion keywords, low Quality Score, match-type distribution, budget-constrained campaigns, and conversion-tracking sanity. Returns prioritized findings plus estimated wasted spend. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        lookback_days: {
          type: "number",
          description: "Days of history to audit. Defaults to 90.",
        },
        wasted_spend_min: {
          type: "number",
          description:
            "Flag search terms that spent more than this (USD) with zero conversions. Defaults to 80.",
        },
        zero_conv_clicks: {
          type: "number",
          description:
            "Flag keywords with at least this many clicks and zero conversions. Defaults to 100.",
        },
        qs_threshold: {
          type: "number",
          description: "Flag keywords with Quality Score below this. Defaults to 6.",
        },
        broad_match_pct_flag: {
          type: "number",
          description:
            "Flag when broad match exceeds this share of spend (percent). Defaults to 30.",
        },
      },
    },
  },
  {
    name: "get_campaigns",
    description:
      "List all Google Ads campaigns with status, budget, and top-line metrics. Use this to get an overview of account health.",
    inputSchema: {
      type: "object",
      properties: {
        status_filter: {
          type: "string",
          enum: ["ALL", "ENABLED", "PAUSED", "REMOVED"],
          description: "Filter by campaign status. Defaults to ALL.",
        },
      },
    },
  },
  {
    name: "get_ad_groups",
    description:
      "List ad groups for a specific campaign, including status and bid info.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: {
          type: "string",
          description: "The campaign ID to get ad groups for.",
        },
      },
      required: ["campaign_id"],
    },
  },
  {
    name: "get_ads",
    description:
      "List individual ads within an ad group, including headlines, descriptions, and approval status.",
    inputSchema: {
      type: "object",
      properties: {
        ad_group_id: {
          type: "string",
          description: "The ad group ID to get ads for.",
        },
      },
      required: ["ad_group_id"],
    },
  },
  {
    name: "get_keywords",
    description:
      "List keywords in an ad group with match type, status, bids, and quality scores.",
    inputSchema: {
      type: "object",
      properties: {
        ad_group_id: {
          type: "string",
          description: "The ad group ID to get keywords for.",
        },
      },
      required: ["ad_group_id"],
    },
  },
  {
    name: "get_performance_report",
    description:
      "Fetch performance metrics (impressions, clicks, CTR, CPC, cost, conversions, ROAS) for campaigns. Great for spotting trends and identifying winners/losers.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Start date YYYYMMDD. Defaults to 30 days ago.",
        },
        end_date: {
          type: "string",
          description: "End date YYYYMMDD. Defaults to today.",
        },
        level: {
          type: "string",
          enum: ["CAMPAIGN", "AD_GROUP", "AD", "KEYWORD"],
          description: "Reporting granularity. Defaults to CAMPAIGN.",
        },
        campaign_id: {
          type: "string",
          description:
            "Optional: filter to a specific campaign ID (required for AD_GROUP/AD/KEYWORD level).",
        },
      },
    },
  },
  {
    name: "get_recommendations",
    description:
      "Fetch Google Ads optimization recommendations for this account — budget suggestions, keyword ideas, bid adjustments, etc.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_account_summary",
    description:
      "Get a high-level account summary: spend, impressions, clicks, conversions for a date range.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Start date YYYYMMDD. Defaults to last 30 days.",
        },
        end_date: {
          type: "string",
          description: "End date YYYYMMDD. Defaults to today.",
        },
      },
    },
  },
  // ── Mutating tools (confirmation-gated) ─────────────────────────────────────
  {
    name: "pause_campaign",
    description:
      "⚠️ MUTATING — Pauses an active campaign. Requires confirmed: true to execute. Without it, returns a dry-run preview of what would happen.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: {
          type: "string",
          description: "The campaign ID to pause.",
        },
        confirmed: {
          type: "boolean",
          description:
            "Must be explicitly set to true by the user to execute. Defaults to false (dry run).",
        },
      },
      required: ["campaign_id"],
    },
  },
  {
    name: "enable_campaign",
    description:
      "⚠️ MUTATING — Enables a paused campaign. Requires confirmed: true to execute.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: {
          type: "string",
          description: "The campaign ID to enable.",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true to execute. Defaults to false (dry run).",
        },
      },
      required: ["campaign_id"],
    },
  },
  {
    name: "update_campaign_budget",
    description:
      "⚠️ MUTATING — Updates the daily budget for a campaign. Requires confirmed: true to execute. Without it, shows a preview.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: {
          type: "string",
          description: "The campaign ID whose budget you want to change.",
        },
        new_daily_budget_usd: {
          type: "number",
          description: "New daily budget in USD (e.g. 50 for $50/day).",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true to execute. Defaults to false (dry run).",
        },
      },
      required: ["campaign_id", "new_daily_budget_usd"],
    },
  },
  {
    name: "generate_keyword_ideas",
    description:
      "Keyword Planner: generate keyword ideas with search volume, competition, and top-of-page bid estimates for seed keywords. Read-only (KeywordPlanIdeaService — creates no plan objects). Use for market research on terms we don't run, e.g. sizing a prospect's niche. To find location IDs, query run_gaql: SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.name LIKE '%Memphis%'.",
    inputSchema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Seed keywords, up to 20, e.g. [\"franchise attorney memphis\", \"business lawyer covington tn\"].",
        },
        location_ids: {
          type: "array",
          items: { type: "number" },
          description: "geo_target_constant IDs to scope volume to (e.g. 2840 = United States). Omit for worldwide.",
        },
        language_id: {
          type: "number",
          description: "language_constant ID. Defaults to 1000 (English).",
        },
        limit: {
          type: "number",
          description: "Max ideas to return. Defaults to 50, capped at 200.",
        },
      },
      required: ["keywords"],
    },
  },
  {
    name: "explain_changes",
    description:
      "Read the append-only action log of writes this server has executed, blocked, or failed. " +
      "Use to answer 'what did you change' without opening the log file.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many of the most recent entries to return. Defaults to 20.",
        },
      },
    },
  },
  ...BUILD_TOOLS,
];

// ── Tool handlers ─────────────────────────────────────────────────────────────
// Every handler takes the session's Ctx — the same shape build-tools.ts already
// expects — so no handler can reach a shared active account.

async function handleGetCampaigns(args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();
  const statusFilter = args.status_filter || "ALL";

  const whereClause =
    statusFilter !== "ALL"
      ? `WHERE campaign.status = '${statusFilter}'`
      : "WHERE campaign.status != 'REMOVED'";

  const campaigns = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.ctr
    FROM campaign
    ${whereClause}
    ORDER BY metrics.cost_micros DESC
    LIMIT 50
  `);

  if (!campaigns.length) return { content: [{ type: "text", text: "No campaigns found." }] };

  const rows = campaigns.map((c: any) => ({
    id: c.campaign.id,
    name: c.campaign.name,
    status: c.campaign.status,
    type: c.campaign.advertising_channel_type,
    daily_budget: microsToBudget(c.campaign_budget?.amount_micros),
    impressions: c.metrics.impressions?.toLocaleString() || "0",
    clicks: c.metrics.clicks?.toLocaleString() || "0",
    cost: microsToBudget(c.metrics.cost_micros),
    conversions: c.metrics.conversions?.toFixed(1) || "0",
    ctr: c.metrics.ctr ? `${(c.metrics.ctr * 100).toFixed(2)}%` : "0%",
  }));

  return {
    content: [
      {
        type: "text",
        text: `## Campaigns (${rows.length} found)\n\n${JSON.stringify(rows, null, 2)}`,
      },
    ],
  };
}

async function handleGetAdGroups(args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();
  const adGroups = await customer.query(`
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.type,
      ad_group.cpc_bid_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.ctr
    FROM ad_group
    WHERE campaign.id = ${args.campaign_id}
      AND ad_group.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
  `);

  if (!adGroups.length) return { content: [{ type: "text", text: "No ad groups found for this campaign." }] };

  const rows = adGroups.map((ag: any) => ({
    id: ag.ad_group.id,
    name: ag.ad_group.name,
    status: ag.ad_group.status,
    type: ag.ad_group.type,
    cpc_bid: microsToBudget(ag.ad_group.cpc_bid_micros),
    impressions: ag.metrics.impressions?.toLocaleString() || "0",
    clicks: ag.metrics.clicks?.toLocaleString() || "0",
    cost: microsToBudget(ag.metrics.cost_micros),
    conversions: ag.metrics.conversions?.toFixed(1) || "0",
    ctr: ag.metrics.ctr ? `${(ag.metrics.ctr * 100).toFixed(2)}%` : "0%",
  }));

  return {
    content: [{ type: "text", text: `## Ad Groups\n\n${JSON.stringify(rows, null, 2)}` }],
  };
}

async function handleGetAds(args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();
  const ads = await customer.query(`
    SELECT
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      ad_group_ad.status,
      ad_group_ad.ad.type,
      ad_group_ad.policy_summary.approval_status,
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.ad.final_urls,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.ctr
    FROM ad_group_ad
    WHERE ad_group.id = ${args.ad_group_id}
      AND ad_group_ad.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
  `);

  if (!ads.length) return { content: [{ type: "text", text: "No ads found." }] };

  const rows = ads.map((a: any) => {
    const rsa = a.ad_group_ad?.ad?.responsive_search_ad;
    return {
      id: a.ad_group_ad?.ad?.id,
      status: a.ad_group_ad?.status,
      approval: a.ad_group_ad?.policy_summary?.approval_status,
      type: a.ad_group_ad?.ad?.type,
      headlines: rsa?.headlines?.slice(0, 3).map((h: any) => h.text) || [],
      descriptions: rsa?.descriptions?.slice(0, 2).map((d: any) => d.text) || [],
      final_url: a.ad_group_ad?.ad?.final_urls?.[0] || "N/A",
      impressions: a.metrics.impressions?.toLocaleString() || "0",
      clicks: a.metrics.clicks?.toLocaleString() || "0",
      cost: microsToBudget(a.metrics.cost_micros),
      conversions: a.metrics.conversions?.toFixed(1) || "0",
      ctr: a.metrics.ctr ? `${(a.metrics.ctr * 100).toFixed(2)}%` : "0%",
    };
  });

  return {
    content: [{ type: "text", text: `## Ads\n\n${JSON.stringify(rows, null, 2)}` }],
  };
}

async function handleGetKeywords(args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();
  const keywords = await customer.query(`
    SELECT
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.cpc_bid_micros,
      ad_group_criterion.quality_info.quality_score,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.average_cpc
    FROM keyword_view
    WHERE ad_group.id = ${args.ad_group_id}
      AND ad_group_criterion.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 100
  `);

  if (!keywords.length) return { content: [{ type: "text", text: "No keywords found." }] };

  const rows = keywords.map((k: any) => ({
    id: k.ad_group_criterion?.criterion_id,
    keyword: k.ad_group_criterion?.keyword?.text,
    match_type: k.ad_group_criterion?.keyword?.match_type,
    status: k.ad_group_criterion?.status,
    cpc_bid: microsToBudget(k.ad_group_criterion?.cpc_bid_micros),
    quality_score: k.ad_group_criterion?.quality_info?.quality_score || "N/A",
    impressions: k.metrics.impressions?.toLocaleString() || "0",
    clicks: k.metrics.clicks?.toLocaleString() || "0",
    cost: microsToBudget(k.metrics.cost_micros),
    conversions: k.metrics.conversions?.toFixed(1) || "0",
    avg_cpc: microsToBudget(k.metrics.average_cpc),
  }));

  return {
    content: [{ type: "text", text: `## Keywords\n\n${JSON.stringify(rows, null, 2)}` }],
  };
}

async function handleGetPerformanceReport(args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();
  const dates = defaultDateRange();
  const start = (args.start_date || dates.start).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const end = (args.end_date || dates.end).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const level = args.level || "CAMPAIGN";

  let query = "";

  if (level === "CAMPAIGN") {
    query = `
      SELECT
        campaign.id, campaign.name, campaign.status,
        metrics.impressions, metrics.clicks, metrics.cost_micros,
        metrics.conversions, metrics.ctr, metrics.average_cpc,
        metrics.conversions_value, metrics.all_conversions_value
      FROM campaign
      WHERE segments.date BETWEEN '${start}' AND '${end}'
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 50
    `;
  } else if (level === "AD_GROUP") {
    const where = args.campaign_id ? `AND campaign.id = ${args.campaign_id}` : "";
    query = `
      SELECT
        campaign.id, campaign.name,
        ad_group.id, ad_group.name, ad_group.status,
        metrics.impressions, metrics.clicks, metrics.cost_micros,
        metrics.conversions, metrics.ctr, metrics.average_cpc
      FROM ad_group
      WHERE segments.date BETWEEN '${start}' AND '${end}'
        AND ad_group.status != 'REMOVED'
        ${where}
      ORDER BY metrics.cost_micros DESC
      LIMIT 100
    `;
  } else if (level === "KEYWORD") {
    const where = args.campaign_id ? `AND campaign.id = ${args.campaign_id}` : "";
    query = `
      SELECT
        campaign.name, ad_group.name,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        metrics.impressions, metrics.clicks, metrics.cost_micros,
        metrics.conversions, metrics.ctr, metrics.average_cpc
      FROM keyword_view
      WHERE segments.date BETWEEN '${start}' AND '${end}'
        ${where}
      ORDER BY metrics.cost_micros DESC
      LIMIT 100
    `;
  }

  const results = await customer.query(query);
  if (!results.length) return { content: [{ type: "text", text: "No data found for the specified date range." }] };

  const rows = results.map((r: any) => {
    const cost = Number(r.metrics.cost_micros || 0);
    const convValue = Number(r.metrics.conversions_value || r.metrics.all_conversions_value || 0);
    const roas = cost > 0 ? (convValue / (cost / 1_000_000)).toFixed(2) : "N/A";

    return {
      ...(level === "CAMPAIGN" && { campaign_id: r.campaign?.id, campaign: r.campaign?.name }),
      ...(level === "AD_GROUP" && { campaign: r.campaign?.name, ad_group_id: r.ad_group?.id, ad_group: r.ad_group?.name }),
      ...(level === "KEYWORD" && {
        campaign: r.campaign?.name,
        ad_group: r.ad_group?.name,
        keyword: r.ad_group_criterion?.keyword?.text,
        match_type: r.ad_group_criterion?.keyword?.match_type,
      }),
      impressions: r.metrics.impressions?.toLocaleString() || "0",
      clicks: r.metrics.clicks?.toLocaleString() || "0",
      cost: microsToBudget(r.metrics.cost_micros),
      ctr: r.metrics.ctr ? `${(r.metrics.ctr * 100).toFixed(2)}%` : "0%",
      avg_cpc: microsToBudget(r.metrics.average_cpc),
      conversions: r.metrics.conversions?.toFixed(1) || "0",
      roas,
    };
  });

  return {
    content: [{
      type: "text",
      text: `## Performance Report (${level} level | ${start} → ${end})\n\n${JSON.stringify(rows, null, 2)}`,
    }],
  };
}

async function handleGetRecommendations(_args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();
  // Minimal, resilient SELECT: grab recommendation type + parent sub-objects.
  // Deep-nested fields (impact.base_metrics.*, *_recommendation.<deep>) are read
  // in JS from the returned objects — the library's schema validator rejects
  // those deep paths in the SELECT clause, which caused the prior failure.
  const recs = await customer.query(`
    SELECT
      recommendation.type,
      recommendation.campaign,
      recommendation.campaign_budget_recommendation,
      recommendation.keyword_recommendation,
      recommendation.target_cpa_opt_in_recommendation,
      recommendation.text_ad_recommendation
    FROM recommendation
    LIMIT 50
  `);

  if (!recs.length) {
    return { content: [{ type: "text", text: "No recommendations available right now. The account may be well-optimized, or Google needs more data." }] };
  }

  const rows = recs.map((r: any) => {
    const rec = r.recommendation || {};
    const out: any = { type: rec.type };

    const budget = rec.campaign_budget_recommendation;
    if (budget) {
      out.suggested_daily_budget = microsToBudget(budget.recommended_budget_amount_micros);
      if (budget.current_budget_amount_micros != null) {
        out.current_daily_budget = microsToBudget(budget.current_budget_amount_micros);
      }
    }

    const kw = rec.keyword_recommendation;
    if (kw) {
      out.suggested_keyword = kw.keyword?.text;
      out.match_type = kw.keyword?.match_type;
    }

    const tcpa = rec.target_cpa_opt_in_recommendation;
    if (tcpa) {
      out.suggested_target_cpa = microsToBudget(tcpa.recommended_target_cpa_micros);
    }

    return out;
  });

  return {
    content: [{
      type: "text",
      text: `## Google Ads Recommendations (${rows.length})\n\n${JSON.stringify(rows, null, 2)}\n\n> Read-only suggestions from Google. Use the confirmation-gated tools to act on them.`,
    }],
  };
}

async function handleGetAccountSummary(args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();
  const dates = defaultDateRange();
  const start = (args.start_date || dates.start).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const end = (args.end_date || dates.end).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");

  const results = await customer.query(`
    SELECT
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr,
      metrics.average_cpc
    FROM customer
    WHERE segments.date BETWEEN '${start}' AND '${end}'
  `);

  let totals = { impressions: 0, clicks: 0, cost: 0, conversions: 0, conversion_value: 0 };
  for (const r of results) {
    totals.impressions += Number(r.metrics.impressions || 0);
    totals.clicks += Number(r.metrics.clicks || 0);
    totals.cost += Number(r.metrics.cost_micros || 0);
    totals.conversions += Number(r.metrics.conversions || 0);
    totals.conversion_value += Number(r.metrics.conversions_value || 0);
  }

  const ctr = totals.impressions > 0 ? ((totals.clicks / totals.impressions) * 100).toFixed(2) : "0";
  const avgCpc = totals.clicks > 0 ? microsToBudget(totals.cost / totals.clicks) : "$0.00";
  const roas = totals.cost > 0 ? (totals.conversion_value / (totals.cost / 1_000_000)).toFixed(2) : "N/A";

  const summary = {
    date_range: `${start} → ${end}`,
    total_spend: microsToBudget(totals.cost),
    impressions: totals.impressions.toLocaleString(),
    clicks: totals.clicks.toLocaleString(),
    ctr: `${ctr}%`,
    avg_cpc: avgCpc,
    conversions: totals.conversions.toFixed(1),
    conversion_value: `$${totals.conversion_value.toFixed(2)}`,
    roas,
  };

  return {
    content: [{ type: "text", text: `## Account Summary\n\n${JSON.stringify(summary, null, 2)}` }],
  };
}

// Reject anything that isn't a single read-only SELECT. GAQL has no DML, but the
// client's mutate paths are separate methods — this guards against a caller
// smuggling a second statement or a non-SELECT resource through.
const GAQL_FORBIDDEN = /\b(INSERT|UPDATE|DELETE|REMOVE|CREATE|DROP|ALTER|MUTATE)\b/i;

async function handleRunGaql(args: any, ctx: Ctx) {
  const raw = String(args.query || "").trim().replace(/;+\s*$/, "");

  if (!/^SELECT\s/i.test(raw)) {
    throw new Error("Only SELECT queries are permitted. Query must begin with SELECT.");
  }
  if (raw.includes(";")) {
    throw new Error("Multiple statements are not permitted.");
  }
  if (GAQL_FORBIDDEN.test(raw)) {
    throw new Error("Query contains a forbidden mutating keyword. run_gaql is read-only.");
  }

  const limit = Math.min(Number(args.limit) || 200, 2000);
  const customer = ctx.getCustomer();
  const rows = await customer.query(raw);
  const sliced = rows.slice(0, limit);

  return {
    content: [{
      type: "text",
      text:
        `## GAQL Result — account ${ctx.raw()}\n\n` +
        `**Query:** \`${raw}\`\n\n` +
        `**Rows:** ${sliced.length}${rows.length > sliced.length ? ` (truncated from ${rows.length})` : ""}\n\n` +
        "```json\n" + JSON.stringify(sliced, null, 2) + "\n```",
    }],
  };
}

async function handleAddNegativeKeywords(args: any, ctx: Ctx) {
  const keywords: string[] = (args.keywords || [])
    .map((k: any) => String(k).trim())
    .filter(Boolean);
  if (!keywords.length) throw new Error("No keywords supplied.");

  const level = (args.level || "CAMPAIGN").toUpperCase();
  const matchType = (args.match_type || "PHRASE").toUpperCase();
  const cid = ctx.cid();

  if (level === "CAMPAIGN" && !args.campaign_id) {
    throw new Error("campaign_id is required when level is CAMPAIGN.");
  }
  if (level === "AD_GROUP" && !args.ad_group_id) {
    throw new Error("ad_group_id is required when level is AD_GROUP.");
  }

  const target =
    level === "CAMPAIGN"
      ? `campaign ${args.campaign_id}`
      : `ad group ${args.ad_group_id}`;

  if (!args.confirmed) {
    return {
      content: [{
        type: "text",
        text:
          `## ⚠️ Dry Run — Add Negative Keywords\n\n` +
          `**Account:** ${ctx.raw()}\n` +
          `**Target:** ${target} (${level} level)\n` +
          `**Match type:** ${matchType}\n` +
          `**Count:** ${keywords.length}\n\n` +
          keywords.map((k) => `- \`${k}\``).join("\n") +
          `\n\nThis is a preview only. To execute, confirm with \`confirmed: true\`.\n\n> No changes have been made.`,
      }],
    };
  }

  // ── Caps: un-bypassable by any argument ──
  if (keywords.length > CAPS.maxNegativeKeywordsPerCall) {
    logAction({
      tool: "add_negative_keywords", customer_id: ctx.raw(), result: "blocked",
      target, count: keywords.length, reason: "cap",
    });
    return refusal([
      `Requested: **${keywords.length} keywords** in one call.`,
      `Cap: **${CAPS.maxNegativeKeywordsPerCall}** (\`CAPS.maxNegativeKeywordsPerCall\`).`,
      `Split into smaller batches.`,
    ]);
  }

  const rateBlock = await checkRateLimit("add_negative_keywords", ctx.raw(), ctx.actor());
  if (rateBlock) return rateBlock;

  const customer = ctx.getCustomer();
  const mt = (enums.KeywordMatchType as any)[matchType];

  try {
    if (level === "CAMPAIGN") {
      await customer.campaignCriteria.create(
        keywords.map((k) => ({
          campaign: `customers/${cid}/campaigns/${args.campaign_id}`,
          negative: true,
          keyword: { text: k, match_type: mt },
        }))
      );
    } else {
      await customer.adGroupCriteria.create(
        keywords.map((k) => ({
          ad_group: `customers/${cid}/adGroups/${args.ad_group_id}`,
          negative: true,
          keyword: { text: k, match_type: mt },
        }))
      );
    }
  } catch (e: any) {
    logAction({
      tool: "add_negative_keywords", customer_id: ctx.raw(), result: "error",
      target, level, match_type: matchType, count: keywords.length,
      error: String(e?.message ?? e),
    });
    return text(`❌ Failed to add negative keywords: ${e?.message ?? e}\n\n> No changes were applied.`);
  }

  await recordWrite(ctx.actor());
  logAction({
    tool: "add_negative_keywords", customer_id: ctx.raw(), result: "ok",
    target, level, match_type: matchType, count: keywords.length, keywords,
  });

  return {
    content: [{
      type: "text",
      text:
        `✅ Added **${keywords.length} ${matchType} negative keyword(s)** to ${target}.\n\n` +
        keywords.map((k) => `- \`${k}\``).join("\n"),
    }],
  };
}

/** Shared implementation for pause/enable — identical apart from the target status. */
async function setCampaignStatus(args: any, target: "PAUSED" | "ENABLED", ctx: Ctx) {
  const customer = ctx.getCustomer();
  const toolName = target === "PAUSED" ? "pause_campaign" : "enable_campaign";
  const resourceName =
    `customers/${ctx.cid()}/campaigns/${args.campaign_id}`;

  const rows: any[] = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.status
    FROM campaign
    WHERE campaign.id = ${args.campaign_id}
    LIMIT 1
  `);
  if (!rows.length) {
    return text(`❌ Campaign ${args.campaign_id} not found in account ${ctx.raw()}.`);
  }

  const campaignName = rows[0].campaign?.name ?? "(unnamed)";
  const currentStatus = String(
    enums.CampaignStatus[rows[0].campaign?.status] ?? rows[0].campaign?.status ?? "UNKNOWN"
  );

  if (currentStatus === target) {
    return text(
      `ℹ️ **No change needed.** ${campaignName} (${args.campaign_id}) is already **${target}**.\n\n` +
      `> No mutate was issued.`
    );
  }

  if (!args.confirmed) {
    let preflight = "";
    try {
      await customer.campaigns.update(
        [{ resource_name: resourceName, status: enums.CampaignStatus[target] }],
        { validate_only: true }
      );
      preflight = "**Pre-flight:** ✅ API accepts this change\n";
    } catch (e: any) {
      preflight = `**Pre-flight:** ❌ API would reject this — ${e?.message ?? e}\n`;
    }
    return text(
      `## ⚠️ Dry Run — ${target === "PAUSED" ? "Pause" : "Enable"} Campaign\n\n` +
      `**Campaign:** ${campaignName} (${args.campaign_id})\n` +
      `**Account:** ${ctx.raw()}\n` +
      `**Status:** ${currentStatus} → **${target}**\n` +
      preflight +
      `\nTo execute: same call with \`confirmed: true\`.\n\n> No changes have been made.`
    );
  }

  const rateBlock = await checkRateLimit(toolName, ctx.raw(), ctx.actor());
  if (rateBlock) return rateBlock;

  try {
    await customer.campaigns.update([{
      resource_name: resourceName,
      status: enums.CampaignStatus[target],
    }]);
  } catch (e: any) {
    logAction({
      tool: toolName, customer_id: ctx.raw(), result: "error",
      campaign_id: String(args.campaign_id), before: currentStatus, after: target,
      error: String(e?.message ?? e),
    });
    return text(`❌ Status change failed: ${e?.message ?? e}\n\n> No change was applied.`);
  }

  await recordWrite(ctx.actor());
  logAction({
    tool: toolName, customer_id: ctx.raw(), result: "ok",
    campaign_id: String(args.campaign_id), campaign_name: campaignName,
    before: currentStatus, after: target,
  });

  return text(
    `✅ ${campaignName} (${args.campaign_id}): **${currentStatus} → ${target}**.`
  );
}

async function handlePauseCampaign(args: any, ctx: Ctx) {
  return setCampaignStatus(args, "PAUSED", ctx);
}

async function handleEnableCampaign(args: any, ctx: Ctx) {
  // Preflight runs regardless of `confirmed`: enabling is the only path to live spend,
  // and these conditions are the codified version of the launch checklist. A dry run
  // that would fail preflight should say so instead of previewing an enable that will
  // be refused.
  const fails = await enablePreflight(ctx.getCustomer(), ctx.cid(), args.campaign_id);
  if (fails.length) {
    logAction({
      tool: "enable_campaign", customer_id: ctx.raw(), result: "blocked",
      campaign_id: args.campaign_id, reason: "preflight", fails,
    });
    return refusal([
      `**Enable preflight failed** for campaign ${args.campaign_id}:`,
      ...fails.map((f) => `- ${f}`),
      ``,
      `Fix the conditions above (check_enable_preflight re-tests without enabling).`,
    ]);
  }
  return setCampaignStatus(args, "ENABLED", ctx);
}

async function handleUpdateCampaignBudget(args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();
  const newUsd = Number(args.new_daily_budget_usd);
  if (!Number.isFinite(newUsd) || newUsd <= 0) {
    return text("❌ `new_daily_budget_usd` must be a positive number.");
  }
  const newBudgetMicros = toMicros(newUsd);

  // Current state is fetched BEFORE the confirmed branch so the dry run can show a real
  // diff. The previous implementation echoed back the requested value only, which made a
  // 10x typo look like a clean number.
  const rows = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.campaign_budget,
           campaign_budget.amount_micros, campaign_budget.explicitly_shared
    FROM campaign
    WHERE campaign.id = ${args.campaign_id}
    LIMIT 1
  `);
  if (!rows.length) {
    return text(`❌ Campaign ${args.campaign_id} not found in account ${ctx.raw()}.`);
  }

  const row: any = rows[0];
  const campaignName = row.campaign?.name ?? "(unnamed)";
  const budgetResourceName = row.campaign.campaign_budget;
  const currentMicros = Number(row.campaign_budget?.amount_micros ?? 0);
  const explicitlyShared = Boolean(row.campaign_budget?.explicitly_shared);

  // Blast radius: campaignBudgets.update() writes the budget resource, not the campaign.
  const attached: any[] = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.status
    FROM campaign
    WHERE campaign.campaign_budget = '${budgetResourceName}'
      AND campaign.status != 'REMOVED'
  `);

  const deltaMicros = newBudgetMicros - currentMicros;
  const pct = currentMicros > 0 ? (deltaMicros / currentMicros) * 100 : null;
  const sign = deltaMicros >= 0 ? "+" : "−";
  const deltaLine =
    currentMicros > 0
      ? `**Budget:** ${usd(currentMicros)}/day → **${usd(newBudgetMicros)}/day**  ` +
        `(${sign}${usd(Math.abs(deltaMicros))}${pct !== null ? `, ${sign}${Math.abs(pct).toFixed(1)}%` : ""})\n` +
        `**Monthly:** ~$${(currentMicros / 1_000_000 * 30.4).toFixed(0)} → ~$${(newBudgetMicros / 1_000_000 * 30.4).toFixed(0)}\n`
      : `**Budget:** (current unknown) → **${usd(newBudgetMicros)}/day**\n`;

  const sharedLine =
    attached.length > 1 || explicitlyShared
      ? `\n> ⚠️ **Shared budget — this change affects ${attached.length} campaigns:**\n` +
        attached.map((c) => `> - ${c.campaign.name} (${c.campaign.id})`).join("\n") + "\n"
      : `**Shared:** no — used by this campaign only\n`;

  if (!args.confirmed) {
    let preflight = "";
    try {
      await customer.campaignBudgets.update(
        [{ resource_name: budgetResourceName, amount_micros: newBudgetMicros }],
        { validate_only: true }
      );
      preflight = "**Pre-flight:** ✅ API accepts this change\n";
    } catch (e: any) {
      preflight = `**Pre-flight:** ❌ API would reject this — ${e?.message ?? e}\n`;
    }

    // The preview must agree with what execute will actually do. Without this, a change
    // that a cap will refuse still previews as clean and the refusal arrives as a surprise.
    const wouldBlock = checkBudgetCaps(currentMicros || null, newUsd);
    const capLine = wouldBlock
      ? `\n> 🚫 **This would be BLOCKED by a local safety cap.** Confirming will not apply it.\n` +
        `> ${wouldBlock.content[0].text.split("\n").filter((l) => l.trim() && !l.startsWith("❌") && !l.startsWith(">")).join("\n> ")}\n`
      : `**Caps:** ✅ within local limits\n`;

    return text(
      `## ⚠️ Dry Run — Update Campaign Budget\n\n` +
      `**Campaign:** ${campaignName} (${args.campaign_id})\n` +
      `**Account:** ${ctx.raw()}\n` +
      deltaLine + sharedLine + preflight + capLine +
      (wouldBlock ? "" : `\nTo execute: same call with \`confirmed: true\`.\n`) +
      `\n> No changes have been made.`
    );
  }

  // ── Caps: checked after the confirm branch, un-bypassable by any argument ──
  const rateBlock = await checkRateLimit("update_campaign_budget", ctx.raw(), ctx.actor());
  if (rateBlock) return rateBlock;

  const capBlock = checkBudgetCaps(currentMicros || null, newUsd);
  if (capBlock) {
    logAction({
      tool: "update_campaign_budget", customer_id: ctx.raw(), result: "blocked",
      campaign_id: String(args.campaign_id), before_micros: currentMicros,
      requested_micros: newBudgetMicros, reason: "cap",
    });
    return capBlock;
  }

  try {
    await customer.campaignBudgets.update([{
      resource_name: budgetResourceName,
      amount_micros: newBudgetMicros,
    }]);
  } catch (e: any) {
    logAction({
      tool: "update_campaign_budget", customer_id: ctx.raw(), result: "error",
      campaign_id: String(args.campaign_id), before_micros: currentMicros,
      after_micros: newBudgetMicros, error: String(e?.message ?? e),
    });
    return text(`❌ Budget update failed: ${e?.message ?? e}\n\n> No change was applied.`);
  }

  await recordWrite(ctx.actor());
  logAction({
    tool: "update_campaign_budget", customer_id: ctx.raw(), result: "ok",
    campaign_id: String(args.campaign_id), campaign_name: campaignName,
    before_micros: currentMicros, after_micros: newBudgetMicros,
    delta_usd: Number((deltaMicros / 1_000_000).toFixed(2)),
    shared_with_campaigns: attached.length,
  });

  return text(
    `✅ Budget updated: ${campaignName} (${args.campaign_id})\n\n` +
    deltaLine +
    (attached.length > 1 ? `\n⚠️ Applied to a shared budget — **${attached.length} campaigns affected**.\n` : "")
  );
}

async function handleExplainChanges(args: any, ctx: Ctx) {
  const limit = Number(args?.limit) > 0 ? Math.floor(Number(args.limit)) : 20;
  const lines = await readActionLog(limit);
  if (!lines.length) {
    return text(`No writes recorded yet.\n\nLog: \`${actionLogLocation()}\``);
  }

  const rows = lines.map((l) => {
    try {
      const e = JSON.parse(l);
      const icon = e.result === "ok" ? "✅" : e.result === "blocked" ? "🚫" : "❌";
      const detail =
        e.tool === "update_campaign_budget"
          ? `${usd(Number(e.before_micros ?? 0))} → ${usd(Number(e.after_micros ?? e.requested_micros ?? 0))}`
          : e.before && e.after
          ? `${e.before} → ${e.after}`
          : e.count
          ? `${e.count} keywords`
          : "";
      return `${icon} \`${e.ts}\` **${e.tool}** ${e.campaign_name ?? e.target ?? ""} ${detail}` +
             (e.reason ? ` _(${e.reason})_` : "") + (e.error ? ` — ${e.error}` : "");
    } catch {
      return `? ${l.slice(0, 120)}`;
    }
  });

  return text(
    `## Action log — last ${rows.length}\n\n${rows.join("\n")}\n\n_Log: \`${actionLogLocation()}\`_`
  );
}

// ── Audit helper ────────────────────────────────────────────────────────────
function gaqlDate(yyyymmdd: string): string {
  return yyyymmdd.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
}

async function handleRunAudit(args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();

  const lookbackDays: number = args.lookback_days || 90;
  const wastedSpendMin: number = args.wasted_spend_min ?? 80;
  const zeroConvClicks: number = args.zero_conv_clicks ?? 100;
  const qsThreshold: number = args.qs_threshold ?? 6;
  const broadMatchPctFlag: number = args.broad_match_pct_flag ?? 30;

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = gaqlDate(formatDate(start));
  const endStr = gaqlDate(formatDate(end));

  const findings: any[] = [];
  let estimatedWaste = 0;

  // Check 1: Wasted spend on search terms
  try {
    const terms = await customer.query(`
      SELECT search_term_view.search_term, campaign.name,
             metrics.cost_micros, metrics.clicks, metrics.conversions
      FROM search_term_view
      WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
        AND metrics.cost_micros > ${wastedSpendMin * 1_000_000}
        AND metrics.conversions = 0
      ORDER BY metrics.cost_micros DESC
      LIMIT 25
    `);
    const wastedTerms = terms.map((t: any) => {
      estimatedWaste += Number(t.metrics.cost_micros || 0);
      return {
        search_term: t.search_term_view?.search_term,
        campaign: t.campaign?.name,
        cost: microsToBudget(t.metrics.cost_micros),
        clicks: Number(t.metrics.clicks || 0),
      };
    });
    if (wastedTerms.length) {
      findings.push({
        priority: "🔴 HIGH",
        check: "Wasted Spend — Search Terms",
        issue: `${wastedTerms.length} search terms spent over $${wastedSpendMin} each with zero conversions`,
        recommendation: "Add these as negative keywords. Typically the highest-ROI fix in any audit.",
        details: wastedTerms,
      });
    }
  } catch (e: any) {
    findings.push({ priority: "⚠️", check: "Wasted Spend — Search Terms", error: e?.message || String(e) });
  }

  // Check 2: Zero-conversion keywords
  try {
    const kws = await customer.query(`
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             campaign.name, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM keyword_view
      WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
        AND metrics.clicks >= ${zeroConvClicks}
        AND metrics.conversions = 0
        AND ad_group_criterion.status = 'ENABLED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 25
    `);
    const deadKws = kws.map((k: any) => {
      estimatedWaste += Number(k.metrics.cost_micros || 0);
      return {
        keyword: k.ad_group_criterion?.keyword?.text,
        match_type: k.ad_group_criterion?.keyword?.match_type,
        campaign: k.campaign?.name,
        clicks: Number(k.metrics.clicks || 0),
        cost: microsToBudget(k.metrics.cost_micros),
      };
    });
    if (deadKws.length) {
      findings.push({
        priority: "🔴 HIGH",
        check: "Zero-Conversion Keywords",
        issue: `${deadKws.length} keywords with ${zeroConvClicks}+ clicks and zero conversions`,
        recommendation: "Pause these or drastically reduce bids — budget with no return.",
        details: deadKws,
      });
    }
  } catch (e: any) {
    findings.push({ priority: "⚠️", check: "Zero-Conversion Keywords", error: e?.message || String(e) });
  }

  // Check 3: Low Quality Score
  try {
    const qs = await customer.query(`
      SELECT ad_group_criterion.keyword.text,
             ad_group_criterion.quality_info.quality_score,
             campaign.name, metrics.cost_micros
      FROM keyword_view
      WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
        AND ad_group_criterion.quality_info.quality_score < ${qsThreshold}
        AND ad_group_criterion.quality_info.quality_score > 0
        AND ad_group_criterion.status = 'ENABLED'
        AND metrics.cost_micros > 0
      ORDER BY metrics.cost_micros DESC
      LIMIT 25
    `);
    const lowQs = qs.map((k: any) => ({
      keyword: k.ad_group_criterion?.keyword?.text,
      quality_score: k.ad_group_criterion?.quality_info?.quality_score,
      campaign: k.campaign?.name,
      cost: microsToBudget(k.metrics.cost_micros),
    }));
    if (lowQs.length) {
      findings.push({
        priority: "🟡 MEDIUM",
        check: "Low Quality Score",
        issue: `${lowQs.length} active keywords with Quality Score below ${qsThreshold}`,
        recommendation: "Low QS inflates CPC 25-50%. Improve ad relevance, expected CTR, and landing page experience.",
        details: lowQs,
      });
    }
  } catch (e: any) {
    findings.push({ priority: "⚠️", check: "Low Quality Score", error: e?.message || String(e) });
  }

  // Check 4: Match type distribution
  try {
    const mt = await customer.query(`
      SELECT ad_group_criterion.keyword.match_type, metrics.cost_micros
      FROM keyword_view
      WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
        AND ad_group_criterion.status = 'ENABLED'
        AND metrics.cost_micros > 0
    `);
    const spendByType: Record<string, number> = {};
    let totalSpend = 0;
    for (const r of mt) {
      const type = r.ad_group_criterion?.keyword?.match_type || "UNKNOWN";
      const cost = Number(r.metrics.cost_micros || 0);
      spendByType[type] = (spendByType[type] || 0) + cost;
      totalSpend += cost;
    }
    if (totalSpend > 0) {
      const broadPct = ((spendByType["BROAD"] || 0) / totalSpend) * 100;
      const dist = Object.entries(spendByType).map(([type, cost]) => ({
        match_type: type, spend: microsToBudget(cost), pct: `${((cost / totalSpend) * 100).toFixed(1)}%`,
      }));
      findings.push({
        priority: broadPct > broadMatchPctFlag ? "🟡 MEDIUM" : "🟢 LOW",
        check: "Match Type Distribution",
        issue: broadPct > broadMatchPctFlag
          ? `Broad match is ${broadPct.toFixed(1)}% of spend (flag: ${broadMatchPctFlag}%)`
          : "Match type mix looks reasonable.",
        recommendation: broadPct > broadMatchPctFlag
          ? "Heavy broad match often wastes budget. Pair with Smart Bidding + strong negatives, or shift toward exact/phrase."
          : "No action needed.",
        details: dist,
      });
    }
  } catch (e: any) {
    findings.push({ priority: "⚠️", check: "Match Type Distribution", error: e?.message || String(e) });
  }

  // Check 5: Budget-constrained campaigns
  try {
    const camps = await customer.query(`
      SELECT campaign.name, campaign_budget.amount_micros,
             metrics.search_budget_lost_impression_share, metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
        AND campaign.status = 'ENABLED'
        AND metrics.search_budget_lost_impression_share > 0.10
      ORDER BY metrics.search_budget_lost_impression_share DESC
      LIMIT 25
    `);
    const constrained = camps.map((c: any) => ({
      campaign: c.campaign?.name,
      daily_budget: microsToBudget(c.campaign_budget?.amount_micros),
      lost_is_to_budget: `${(Number(c.metrics.search_budget_lost_impression_share || 0) * 100).toFixed(1)}%`,
      conversions: Number(c.metrics.conversions || 0).toFixed(1),
    }));
    if (constrained.length) {
      findings.push({
        priority: "🟡 MEDIUM",
        check: "Budget-Constrained Campaigns",
        issue: `${constrained.length} campaigns losing 10%+ impression share to budget caps`,
        recommendation: "Profitable campaigns here leave conversions on the table. Raise budgets where CPA/ROAS justifies.",
        details: constrained,
      });
    }
  } catch (e: any) {
    findings.push({ priority: "⚠️", check: "Budget-Constrained Campaigns", error: e?.message || String(e) });
  }

  // Check 6: Conversion tracking sanity
  try {
    const conv = await customer.query(`
      SELECT metrics.conversions, metrics.cost_micros
      FROM customer
      WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
    `);
    let totalConv = 0, totalCost = 0;
    for (const r of conv) {
      totalConv += Number(r.metrics.conversions || 0);
      totalCost += Number(r.metrics.cost_micros || 0);
    }
    if (totalCost > 0 && totalConv === 0) {
      findings.push({
        priority: "🔴 HIGH",
        check: "Conversion Tracking",
        issue: "Account spent money but recorded ZERO conversions this period.",
        recommendation: "Strongly suggests broken/missing conversion tracking — verify before trusting other metrics. (Manual check.)",
      });
    }
  } catch (e: any) {
    findings.push({ priority: "⚠️", check: "Conversion Tracking", error: e?.message || String(e) });
  }

  const order: Record<string, number> = { "🔴 HIGH": 0, "🟡 MEDIUM": 1, "🟢 LOW": 2, "⚠️": 3 };
  findings.sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9));

  const header = {
    account: ctx.cid(),
    period: `${startStr} → ${endStr} (${lookbackDays} days)`,
    thresholds_used: { wasted_spend_min: `$${wastedSpendMin}`, zero_conv_clicks: zeroConvClicks, qs_threshold: qsThreshold, broad_match_pct_flag: `${broadMatchPctFlag}%` },
    estimated_identifiable_waste: microsToBudget(estimatedWaste),
    total_findings: findings.length,
  };

  return {
    content: [{
      type: "text",
      text: `# 🔍 Google Ads Account Audit\n\n## Summary\n${JSON.stringify(header, null, 2)}\n\n## Findings (priority order)\n${JSON.stringify(findings, null, 2)}\n\n---\n*Data-driven checks only. Landing pages, tracking accuracy, and creative require manual review.*`,
    }],
  };
}

// ── Server setup ──────────────────────────────────────────────────────────────
async function handleListAccounts(_args: any, ctx: Ctx) {
  const client = getClient();
  const manager = client.Customer({
    customer_id: LOGIN_CUSTOMER_ID.replace(/-/g, ""),
    login_customer_id: LOGIN_CUSTOMER_ID.replace(/-/g, ""),
    refresh_token: ctx.refreshToken(),
  });
  const rows = await manager.query("SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.status = 'ENABLED'");
  const accounts = rows
    .map((r: any) => r.customer_client)
    .filter((c: any) => !c.manager)
    .map((c: any) => ({ cid: String(c.id), name: c.descriptive_name, currency: c.currency_code, active: String(c.id) === ctx.cid() }))
    .sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
  return { content: [{ type: "text", text: "## Accessible Accounts (" + accounts.length + ")\n\n" + JSON.stringify(accounts, null, 2) }] };
}

async function handleSetActiveAccount(args: any, ctx: Ctx) {
  const target = String(args.customer_id || "").replace(/-/g, "");
  if (!target) {
    return { content: [{ type: "text", text: "Please provide a customer_id (CID), e.g. 6305730974." }] };
  }
  const client = getClient();
  const c = client.Customer({
    customer_id: target,
    login_customer_id: LOGIN_CUSTOMER_ID.replace(/-/g, ""),
    refresh_token: ctx.refreshToken(),
  });
  const res = await c.query("SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1");
  const name = (res[0] && res[0].customer && res[0].customer.descriptive_name) || "(unknown)";
  ctx.setActive(target);
  return { content: [{ type: "text", text: "Active account set to " + target + " (" + name + "). All report tools in THIS session will use this account until changed; other sessions are unaffected." }] };
}

async function handleGenerateKeywordIdeas(args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();
  const seeds: string[] = (args.keywords || [])
    .map((k: string) => String(k).trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!seeds.length) {
    return { content: [{ type: "text", text: "Provide at least one seed keyword." }], isError: true };
  }

  const limit = Math.min(Number(args.limit) || 50, 200);
  const request: any = {
    customer_id: ctx.cid(),
    language: `languageConstants/${args.language_id || 1000}`,
    geo_target_constants: (args.location_ids || []).map((id: number | string) => `geoTargetConstants/${id}`),
    keyword_plan_network: enums.KeywordPlanNetwork.GOOGLE_SEARCH,
    keyword_seed: { keywords: seeds },
    include_adult_keywords: false,
    page_size: limit,
  };

  const response: any = await (customer as any).keywordPlanIdeas.generateKeywordIdeas(request);
  const results: any[] = response?.results ?? (Array.isArray(response) ? response : []);
  if (!results.length) {
    return { content: [{ type: "text", text: "No keyword ideas returned for those seeds/locations." }] };
  }

  const rows = results.slice(0, limit).map((r: any) => {
    const m = r.keyword_idea_metrics || {};
    const competition =
      typeof m.competition === "number" ? enums.KeywordPlanCompetitionLevel[m.competition] : m.competition;
    return {
      keyword: r.text,
      avg_monthly_searches: Number(m.avg_monthly_searches ?? 0),
      competition: competition || "UNSPECIFIED",
      competition_index: m.competition_index ?? null,
      top_of_page_bid_low: microsToBudget(m.low_top_of_page_bid_micros),
      top_of_page_bid_high: microsToBudget(m.high_top_of_page_bid_micros),
    };
  });
  rows.sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches);

  const scope = (args.location_ids || []).length
    ? `locations [${(args.location_ids || []).join(", ")}]`
    : "worldwide";
  return {
    content: [
      {
        type: "text",
        text: `## Keyword ideas (${rows.length}, ${scope})\n\nSeeds: ${seeds.join(", ")}\n\n${JSON.stringify(rows, null, 2)}`,
      },
    ],
  };
}


/**
 * The session key for an incoming request.
 *
 * Stdio is one process per client, so every request belongs to the same session
 * and a constant is correct — not a placeholder. When phase 5 adds Streamable
 * HTTP, the transport's session id is read here, and this is the ONLY function
 * that has to change: every handler already reads its account through the Ctx.
 */
export function sessionKeyFor(extra: { sessionId?: string }): string {
  // Streamable HTTP assigns a session id per client and the SDK hands it to the
  // handler. Stdio has none, and one fixed key is correct there: one process is
  // one client, so every request genuinely does belong to the same session.
  return extra.sessionId ?? STDIO_SESSION_KEY;
}

/**
 * The acting identity for an incoming request.
 *
 * Stdio has one operator at the keyboard and no authentication to read, so
 * LOCAL_ACTOR is the honest answer. Phase 5's HTTP transport carries an
 * authenticated identity, and this returns it — the log, the write cap and the
 * credential lookup all key off this one function.
 */
export function actorFor(extra: { authInfo?: { clientId?: string; extra?: Record<string, unknown> } }): string {
  // Prefer the Google subject when the auth layer supplies one — it is stable
  // across token rotations, which a client id is not. Falling back to LOCAL_ACTOR
  // is safe because assertDeploymentIsSound() refuses to start a shared
  // deployment whose credential store is not per-actor, so an unauthenticated
  // request cannot reach a deployment and quietly log as "local".
  const sub = extra.authInfo?.extra?.sub;
  if (typeof sub === "string" && sub) return sub;
  if (extra.authInfo?.clientId) return extra.authInfo.clientId;
  return LOCAL_ACTOR;
}

/**
 * One Server per connection. The SDK binds a Server to a single transport and
 * refuses a second connect(), so the module-level instance the HTTP entry used
 * to share served exactly one session: the second operator to connect got a
 * 500. Handlers are stateless over the session registry, so a fresh Server per
 * session costs two closures.
 */
export function createMcpServer(): Server {
  const server = new Server(
    { name: "google-ads-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    // Resolve the caller's session, then hand every handler the same Ctx. Under
    // stdio this is one fixed key; phase 5 (Streamable HTTP) supplies the real
    // per-client key here and nothing downstream changes.
    const session = await getSession(sessionKeyFor(extra), actorFor(extra));
    const ctx = makeCtx(session);

    // Everything below runs inside the actor's context, so logAction() stamps the
    // right identity without any of its ~30 call sites passing one. The finally
    // awaits queued log writes: a durable sink must be written before the caller
    // is told the write happened.
    try {
      return await runAsActor(session.actor, async () => {
      try {
      switch (name) {
        case "list_accounts":           return await handleListAccounts(args, ctx);
        case "set_active_account":      return await handleSetActiveAccount(args, ctx);
        case "run_audit":               return await handleRunAudit(args, ctx);
        case "run_gaql":                return await handleRunGaql(args, ctx);
        case "add_negative_keywords":   return await handleAddNegativeKeywords(args, ctx);
        case "get_campaigns":           return await handleGetCampaigns(args, ctx);
        case "get_ad_groups":           return await handleGetAdGroups(args, ctx);
        case "get_ads":                 return await handleGetAds(args, ctx);
        case "get_keywords":            return await handleGetKeywords(args, ctx);
        case "get_performance_report":  return await handleGetPerformanceReport(args, ctx);
        case "get_recommendations":     return await handleGetRecommendations(args, ctx);
        case "get_account_summary":     return await handleGetAccountSummary(args, ctx);
        case "pause_campaign":          return await handlePauseCampaign(args, ctx);
        case "enable_campaign":         return await handleEnableCampaign(args, ctx);
        case "update_campaign_budget":  return await handleUpdateCampaignBudget(args, ctx);
        case "generate_keyword_ideas":  return await handleGenerateKeywordIdeas(args, ctx);
        case "explain_changes":         return await handleExplainChanges(args, ctx);
        case "create_campaign":         return await handleCreateCampaign(args, ctx);
        case "create_ad_group":         return await handleCreateAdGroup(args, ctx);
        case "add_keywords":            return await handleAddKeywords(args, ctx);
        case "create_rsa":              return await handleCreateRsa(args, ctx);
        case "create_assets":           return await handleCreateAssets(args, ctx);
        case "create_shared_negative_list": return await handleCreateSharedNegativeList(args, ctx);
        case "create_conversion_action": return await handleCreateConversionAction(args, ctx);
        case "update_conversion_action": return await handleUpdateConversionAction(args, ctx);
        case "update_ad_status":        return await handleUpdateAdStatus(args, ctx);
        case "get_ad_policy_details":   return await handleGetAdPolicyDetails(args, ctx);
        case "check_enable_preflight":  return await handleCheckEnablePreflight(args, ctx);
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
      }
      } catch (error: any) {
      let msg = error?.message; if (!msg || msg === "[object Object]") { const ga = error?.errors || error?.failure?.errors; if (Array.isArray(ga) && ga.length) { msg = ga.map((e: any) => e?.message || JSON.stringify(e?.error_code || e)).join("; "); } else { try { msg = JSON.stringify(error, Object.getOwnPropertyNames(error)); } catch (_) { msg = String(error); } } }
      return {
        content: [{
          type: "text",
          text: `❌ Error calling ${name}:\n\n${msg}\n\n${
            msg.includes("DEVELOPER_TOKEN") ? "Check that your developer token is approved and matches the account." : ""
          }${
            msg.includes("OAuth") || msg.includes("refresh_token") ? "Your refresh token may be expired. Re-run the auth script to get a new one." : ""
          }`,
        }],
        isError: true,
      };
      }
      });
    } finally {
      await flushActionLog();
    }
  });

  return server;
}


async function main() {
  // Stdio has no sign-in, so the .env token is the only identity it can have.
  requireEnv("GOOGLE_ADS_REFRESH_TOKEN");
  // Gate before any transport connects. Local stdio runs pass trivially; a
  // shared deployment missing any shared-state implementation throws here
  // rather than coming up with controls that silently do not hold.
  assertDeploymentIsSound();

  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
  console.error("Google Ads MCP server running on stdio");
}

// The HTTP entry (src/http.ts) imports this module for `server` and must not
// also start a stdio transport, so stdio runs only when this file is the entry.
const isEntry = process.argv[1] && /index\.(js|ts)$/.test(process.argv[1]);
if (isEntry) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
