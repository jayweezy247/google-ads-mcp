import { enums } from "google-ads-api";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CAPS, toMicros, usd, refusal, text, logAction, recordWrite, checkRateLimit } from "./write-safety";

/**
 * Build tools — campaign construction and lifecycle management.
 *
 * Same contract as the original four write tools: every mutating tool defaults to a
 * dry-run preview and requires `confirmed: true`; caps and preflights are checked after
 * the confirmed branch and cannot be argued past; every executed write, refusal, and
 * failure is appended to the action log.
 *
 * Design rules specific to building:
 *  - create_campaign ALWAYS creates PAUSED. enable_campaign is the only path to live
 *    traffic, and it runs the preflight in enablePreflight() first.
 *  - create_* tools refuse on accounts not marked active in ~/.config/google-ads-mcp/accounts.json
 *    (guards against building into a legacy duplicate account).
 *  - RSA character limits are validated server-side, including worst-case expansion of
 *    {LOCATION(...)} customizers, so a violating ad cannot be created at all.
 */

export const BUILD_CAPS = {
  /** Absolute ceiling on a new campaign's daily budget. */
  maxNewCampaignDailyBudgetUsd: 100,
  /** Max positive keywords per add_keywords call. */
  maxKeywordsPerCall: 50,
  /** Max RSAs per create_rsa call (one per call keeps diffs reviewable). */
  maxAdsPerCall: 2,
  /** Worst-case chars a {LOCATION(City)} insert can expand to. Longest targeted
   *  location across managed accounts; override per call with longest_location_length. */
  defaultLocationExpansion: 16,
};

// ── Per-account config (active flag, monthly ad budget) ───────────────────────
// ~/.config/google-ads-mcp/accounts.json:
//   { "5918422213": { "active": true, "monthly_ad_budget_usd": 1200 }, ... }
const ACCOUNTS_PATH = path.join(os.homedir(), ".config", "google-ads-mcp", "accounts.json");

type AccountCfg = { active?: boolean; building?: boolean; monthly_ad_budget_usd?: number };

function accountCfg(cid: string): AccountCfg | null {
  try {
    const all = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
    return all[cid.replace(/-/g, "")] ?? null;
  } catch {
    return null;
  }
}

/** Refuse builds into accounts not explicitly allowlisted. Unknown accounts refuse too:
 *  the config is the allowlist, and adding a line to it is the deliberate act.
 *  Two tiers: `active: true` (launched client) and `building: true` (new client being
 *  built out pre-launch — entities can be created, but enablePreflight still requires
 *  active, so a building account can never serve traffic). */
function checkAccountBuildable(tool: string, cid: string) {
  const cfg = accountCfg(cid);
  if (!cfg || (cfg.active !== true && cfg.building !== true)) {
    logAction({ tool, customer_id: cid, result: "blocked", reason: "account_not_allowlisted" });
    return refusal([
      `Account **${cid}** is not marked \`active: true\` or \`building: true\` in \`${ACCOUNTS_PATH}\`.`,
      `Build tools only run against accounts explicitly allowlisted there — this guards`,
      `against building into a legacy duplicate account. Use \`building: true\` for a new`,
      `client under construction; flip to \`active: true\` at launch.`,
    ]);
  }
  return null;
}

// ── RSA validation ────────────────────────────────────────────────────────────
const CUSTOMIZER = /\{[A-Za-z]+\([^)]*\)(?::[^}]*)?\}|\{KeyWord:[^}]*\}/gi;
const LOCATION_TAG = /\{LOCATION\([^)]*\)(?::[^}]*)?\}/gi;

/** Effective length with every {LOCATION(...)} expanded to the worst-case location. */
function effectiveLen(s: string, locLen: number): number {
  return s.replace(LOCATION_TAG, "X".repeat(locLen)).length;
}

export function validateRsa(
  headlines: { text: string; pinned_field?: string }[],
  descriptions: { text: string; pinned_field?: string }[],
  locLen: number
): string[] {
  const errs: string[] = [];
  if (headlines.length < 3 || headlines.length > 15)
    errs.push(`Headlines: ${headlines.length} supplied; RSAs need 3–15.`);
  if (descriptions.length < 2 || descriptions.length > 4)
    errs.push(`Descriptions: ${descriptions.length} supplied; RSAs need 2–4.`);
  for (const h of headlines) {
    const eff = effectiveLen(h.text, locLen);
    if (eff > 30)
      errs.push(`Headline over 30 chars (worst-case ${eff} with ${locLen}-char location): "${h.text}"`);
  }
  for (const d of descriptions) {
    const eff = effectiveLen(d.text, locLen);
    if (eff > 90)
      errs.push(`Description over 90 chars (worst-case ${eff}): "${d.text}"`);
  }
  const plain = headlines.filter((h) => !CUSTOMIZER.test(h.text) && (CUSTOMIZER.lastIndex = 0) === 0);
  if (plain.length < 3)
    errs.push(`Only ${plain.length} headline(s) without customizers; Google requires ≥3.`);
  const pinned = headlines.filter((h) => h.pinned_field).length;
  if (pinned > 2)
    errs.push(`${pinned} pinned headlines; keep to ≤2 or Ad Strength degrades.`);
  return errs;
}

// ── Enable preflight ──────────────────────────────────────────────────────────
/**
 * The rules that make enabling safe. All query-based; any failure blocks the enable.
 * Returns [] when the campaign may go live.
 */
export async function enablePreflight(customer: any, cid: string, campaignId: string): Promise<string[]> {
  const fails: string[] = [];

  const cfg = accountCfg(cid);
  if (!cfg || cfg.active !== true)
    fails.push(
      `Account ${cid} not marked active: true in ${ACCOUNTS_PATH}` +
      (cfg?.building === true ? ` (it is building: true — flip to active at launch).` : `.`)
    );

  // 1. Exactly one primary conversion action counted for bidding.
  const convs = await customer.query(`
    SELECT conversion_action.name, conversion_action.primary_for_goal, conversion_action.status
    FROM conversion_action
    WHERE conversion_action.status = 'ENABLED'
  `);
  const primaries = convs.filter((c: any) => c.conversion_action.primary_for_goal);
  if (primaries.length !== 1)
    fails.push(
      `${primaries.length} primary conversion actions (need exactly 1): ` +
      primaries.map((c: any) => c.conversion_action.name).join(", ")
    );

  // 2. A shared negative list is attached to this campaign.
  const sharedSets = await customer.query(`
    SELECT shared_set.name FROM campaign_shared_set
    WHERE campaign.id = ${campaignId} AND campaign_shared_set.status = 'ENABLED'
  `);
  if (!sharedSets.length)
    fails.push(`No shared negative keyword list attached to campaign ${campaignId}.`);

  // 3. No enabled broad-match positive keywords in the campaign.
  const broad = await customer.query(`
    SELECT ad_group_criterion.keyword.text FROM keyword_view
    WHERE campaign.id = ${campaignId}
      AND ad_group_criterion.keyword.match_type = 'BROAD'
      AND ad_group_criterion.negative = FALSE
      AND ad_group_criterion.status = 'ENABLED'
    LIMIT 10
  `);
  if (broad.length)
    fails.push(
      `${broad.length}+ enabled BROAD match keywords (standard requires zero), e.g. ` +
      broad.slice(0, 3).map((k: any) => `"${k.ad_group_criterion.keyword.text}"`).join(", ")
    );

  // 4. At least one non-disapproved RSA.
  const ads = await customer.query(`
    SELECT ad_group_ad.policy_summary.approval_status FROM ad_group_ad
    WHERE campaign.id = ${campaignId} AND ad_group_ad.status = 'ENABLED'
  `);
  const servable = ads.filter(
    (a: any) => a.ad_group_ad.policy_summary?.approval_status !== enums.PolicyApprovalStatus.DISAPPROVED
  );
  if (!servable.length) fails.push(`Campaign ${campaignId} has no enabled, non-disapproved ads.`);

  // 5. Budget: this campaign + all currently-enabled campaigns ≤ monthly budget / 30.4.
  if (cfg?.monthly_ad_budget_usd) {
    const dailyCap = cfg.monthly_ad_budget_usd / 30.4;
    // GAQL has no OR: fetch all non-removed campaigns and filter client-side to
    // {currently enabled} ∪ {the campaign being enabled}.
    const budgets = await customer.query(`
      SELECT campaign.id, campaign.status, campaign_budget.amount_micros FROM campaign
      WHERE campaign.status != 'REMOVED'
    `);
    let totalMicros = 0;
    for (const b of budgets) {
      const isEnabled = b.campaign.status === enums.CampaignStatus.ENABLED || b.campaign.status === "ENABLED";
      if (isEnabled || String(b.campaign.id) === String(campaignId)) {
        totalMicros += Number(b.campaign_budget?.amount_micros ?? 0);
      }
    }
    if (totalMicros / 1_000_000 > dailyCap)
      fails.push(
        `Enabled daily budgets would total ${usd(totalMicros)}/day; account cap is ` +
        `$${dailyCap.toFixed(2)}/day ($${cfg.monthly_ad_budget_usd}/mo in ${ACCOUNTS_PATH}).`
      );
  }

  return fails;
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const confirmed = {
  confirmed: { type: "boolean", description: "Must be true to execute. Defaults to false (dry run)." },
};

export const BUILD_TOOLS = [
  {
    name: "create_campaign",
    description:
      "⚠️ MUTATING — Create a Search campaign (with its budget) in the active account. Always created PAUSED; use enable_campaign (which runs a safety preflight) to go live. Geo targeting is presence-only by design. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        daily_budget_usd: { type: "number" },
        geo_target_ids: {
          type: "array", items: { type: "string" },
          description: "geoTargetConstant IDs, e.g. [\"1026874\"]. Applied presence-only.",
        },
        bidding: {
          type: "string", enum: ["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"],
          description: "Defaults to MAXIMIZE_CONVERSIONS. tCPA/tROAS deliberately unsupported here — set targets in the UI after 30 conv/30d.",
        },
        ...confirmed,
      },
      required: ["name", "daily_budget_usd", "geo_target_ids"],
    },
  },
  {
    name: "create_ad_group",
    description: "⚠️ MUTATING — Create an ad group in a campaign. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: { type: "string" },
        name: { type: "string" },
        cpc_bid_usd: { type: "number", description: "Optional default max CPC." },
        ...confirmed,
      },
      required: ["campaign_id", "name"],
    },
  },
  {
    name: "add_keywords",
    description:
      "⚠️ MUTATING — Add positive keywords (EXACT or PHRASE only; BROAD is refused per the account standard) to an ad group. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        ad_group_id: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
        match_type: { type: "string", enum: ["EXACT", "PHRASE"] },
        ...confirmed,
      },
      required: ["ad_group_id", "keywords", "match_type"],
    },
  },
  {
    name: "create_rsa",
    description:
      "⚠️ MUTATING — Create a responsive search ad. Validates 30/90 char limits server-side, expanding {LOCATION(...)} tags to the worst-case location length so a violating ad cannot be created. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        ad_group_id: { type: "string" },
        headlines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              pinned_field: { type: "string", enum: ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"] },
            },
            required: ["text"],
          },
        },
        descriptions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              pinned_field: { type: "string", enum: ["DESCRIPTION_1", "DESCRIPTION_2"] },
            },
            required: ["text"],
          },
        },
        final_url: { type: "string" },
        path1: { type: "string" }, path2: { type: "string" },
        longest_location_length: {
          type: "number",
          description: "Worst-case chars a {LOCATION} tag can insert for this account's geo. Default 16.",
        },
        ...confirmed,
      },
      required: ["ad_group_id", "headlines", "descriptions", "final_url"],
    },
  },
  {
    name: "create_assets",
    description:
      "⚠️ MUTATING — Create sitelink, callout, or structured snippet assets and link them at account (customer) level so they serve on all campaigns. Char limits validated server-side (sitelink 25/35/35, callout 25, snippet values 25). Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        asset_type: { type: "string", enum: ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET"] },
        sitelinks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              link_text: { type: "string" }, description1: { type: "string" },
              description2: { type: "string" }, final_url: { type: "string" },
            },
            required: ["link_text", "final_url"],
          },
        },
        callouts: { type: "array", items: { type: "string" } },
        snippet_header: { type: "string", description: "e.g. 'Service catalog', 'Brands', 'Types'." },
        snippet_values: { type: "array", items: { type: "string" } },
        ...confirmed,
      },
      required: ["asset_type"],
    },
  },
  {
    name: "create_shared_negative_list",
    description:
      "⚠️ MUTATING — Create a shared negative-keyword set, populate it, and attach it to campaigns. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
        match_type: { type: "string", enum: ["EXACT", "PHRASE", "BROAD"] },
        attach_to_campaign_ids: { type: "array", items: { type: "string" } },
        ...confirmed,
      },
      required: ["name", "keywords"],
    },
  },
  {
    name: "create_conversion_action",
    description:
      "⚠️ MUTATING — Create a website conversion action (tag-based, for GTM/gtag firing). Returns the Conversion ID (AW-…) and label needed to wire the tag. Only runs against accounts allowlisted active. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        category: {
          type: "string",
          enum: ["SUBMIT_LEAD_FORM", "BOOK_APPOINTMENT", "PHONE_CALL_LEAD", "CONTACT", "SIGNUP", "REQUEST_QUOTE", "PURCHASE", "DEFAULT"],
          description: "Goal category. Leads default: SUBMIT_LEAD_FORM.",
        },
        primary_for_goal: {
          type: "boolean",
          description: "true = counted for bidding (primary). Defaults to false (secondary/observe) — promote deliberately.",
        },
        counting_type: { type: "string", enum: ["ONE_PER_CLICK", "MANY_PER_CLICK"], description: "Defaults to ONE_PER_CLICK." },
        click_through_lookback_window_days: { type: "number", description: "Defaults to 30." },
        default_value_usd: { type: "number", description: "Optional fixed value per conversion. Omit for no value." },
        ...confirmed,
      },
      required: ["name", "category"],
    },
  },
  {
    name: "update_conversion_action",
    description:
      "⚠️ MUTATING — Update a conversion action: primary_for_goal flag, counting type, name, or status (ENABLED/HIDDEN). This is the tool for collapsing to one primary conversion before enabling AI-bid campaigns. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        conversion_action_id: { type: "string" },
        primary_for_goal: { type: "boolean" },
        counting_type: { type: "string", enum: ["ONE_PER_CLICK", "MANY_PER_CLICK"] },
        name: { type: "string" },
        status: { type: "string", enum: ["ENABLED", "HIDDEN"] },
        ...confirmed,
      },
      required: ["conversion_action_id"],
    },
  },
  {
    name: "update_ad_status",
    description: "⚠️ MUTATING — Pause or enable a specific ad. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        ad_group_id: { type: "string" },
        ad_id: { type: "string" },
        status: { type: "string", enum: ["ENABLED", "PAUSED"] },
        ...confirmed,
      },
      required: ["ad_group_id", "ad_id", "status"],
    },
  },
  {
    name: "get_ad_policy_details",
    description:
      "Read-only — surface per-ad policy findings (the reason behind APPROVED_LIMITED / DISAPPROVED) for a campaign or ad group.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: { type: "string" },
        ad_group_id: { type: "string" },
      },
    },
  },
  {
    name: "check_enable_preflight",
    description:
      "Read-only — run the enable_campaign safety preflight for a campaign without enabling anything: single primary conversion action, shared negative list attached, zero broad keywords, servable ads, budget within the account's monthly cap.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: "string" } },
      required: ["campaign_id"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────────────
type Ctx = { getCustomer: () => any; cid: () => string; actor: () => string };

function dryRun(title: string, body: string) {
  return text(`## ⚠️ Dry Run — ${title}\n\n${body}\n\nTo execute, confirm with \`confirmed: true\`.\n\n> No changes have been made.`);
}

export async function handleCreateCampaign(args: any, ctx: Ctx) {
  const cid = ctx.cid();
  const bidding = args.bidding || "MAXIMIZE_CONVERSIONS";
  const preview =
    `**Account:** ${cid}\n**Name:** ${args.name}\n**Budget:** $${args.daily_budget_usd}/day (new, unshared)\n` +
    `**Bidding:** ${bidding}\n**Geo (presence-only):** ${args.geo_target_ids.join(", ")}\n` +
    `**Networks:** Google Search only (no partners, no Display)\n**Created status:** PAUSED (always)`;
  if (!args.confirmed) return dryRun("Create Campaign", preview);

  const block = checkAccountBuildable("create_campaign", cid) || await checkRateLimit("create_campaign", cid, ctx.actor());
  if (block) return block;
  if (args.daily_budget_usd > BUILD_CAPS.maxNewCampaignDailyBudgetUsd) {
    logAction({ tool: "create_campaign", customer_id: cid, result: "blocked", reason: "budget_cap" });
    return refusal([
      `Requested budget $${args.daily_budget_usd}/day exceeds cap ` +
      `$${BUILD_CAPS.maxNewCampaignDailyBudgetUsd}/day (\`BUILD_CAPS.maxNewCampaignDailyBudgetUsd\`).`,
    ]);
  }

  const customer = ctx.getCustomer();
  try {
    const budgetRes = await customer.campaignBudgets.create([{
      name: `${args.name} budget`,
      amount_micros: toMicros(args.daily_budget_usd),
      explicitly_shared: false,
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
    }]);
    const budgetRn = budgetRes.results[0].resource_name;
    const campRes = await customer.campaigns.create([{
      name: args.name,
      status: enums.CampaignStatus.PAUSED,
      advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
      campaign_budget: budgetRn,
      geo_target_type_setting: {
        positive_geo_target_type: enums.PositiveGeoTargetType.PRESENCE,
        negative_geo_target_type: enums.NegativeGeoTargetType.PRESENCE,
      },
      network_settings: {
        target_google_search: true,
        target_search_network: false,
        target_content_network: false,
        target_partner_search_network: false,
      },
      ...(bidding === "MAXIMIZE_CONVERSIONS"
        ? { maximize_conversions: {} }
        : { maximize_conversion_value: {} }),
    }]);
    const campRn = campRes.results[0].resource_name;
    const campaignId = campRn.split("/").pop();
    await customer.campaignCriteria.create(
      args.geo_target_ids.map((g: string) => ({
        campaign: campRn,
        location: { geo_target_constant: `geoTargetConstants/${g}` },
      }))
    );
    await recordWrite(ctx.actor());
    logAction({ tool: "create_campaign", customer_id: cid, result: "ok", name: args.name, campaign_id: campaignId });
    return text(
      `✅ Created campaign **${args.name}** (id \`${campaignId}\`) — **PAUSED**, ` +
      `$${args.daily_budget_usd}/day, ${args.geo_target_ids.length} presence-only geo targets.\n\n` +
      `Note: AI Max / advanced search settings are not exposed by this API client — toggle AI Max in the UI before enabling.`
    );
  } catch (e: any) {
    logAction({ tool: "create_campaign", customer_id: cid, result: "error", name: args.name, error: String(e?.message ?? e) });
    return text(`❌ create_campaign failed: ${e?.message ?? e}\n\n> Partial objects may exist (budget without campaign); check with get_campaigns.`);
  }
}

export async function handleCreateAdGroup(args: any, ctx: Ctx) {
  const cid = ctx.cid();
  const preview = `**Campaign:** ${args.campaign_id}\n**Name:** ${args.name}` +
    (args.cpc_bid_usd ? `\n**Default CPC:** $${args.cpc_bid_usd}` : "");
  if (!args.confirmed) return dryRun("Create Ad Group", preview);
  const block = checkAccountBuildable("create_ad_group", cid) || await checkRateLimit("create_ad_group", cid, ctx.actor());
  if (block) return block;
  const customer = ctx.getCustomer();
  try {
    const res = await customer.adGroups.create([{
      campaign: `customers/${cid}/campaigns/${args.campaign_id}`,
      name: args.name,
      status: enums.AdGroupStatus.ENABLED,
      type: enums.AdGroupType.SEARCH_STANDARD,
      ...(args.cpc_bid_usd ? { cpc_bid_micros: toMicros(args.cpc_bid_usd) } : {}),
    }]);
    const id = res.results[0].resource_name.split("/").pop();
    await recordWrite(ctx.actor());
    logAction({ tool: "create_ad_group", customer_id: cid, result: "ok", name: args.name, ad_group_id: id });
    return text(`✅ Created ad group **${args.name}** (id \`${id}\`) in campaign ${args.campaign_id}.`);
  } catch (e: any) {
    logAction({ tool: "create_ad_group", customer_id: cid, result: "error", error: String(e?.message ?? e) });
    return text(`❌ create_ad_group failed: ${e?.message ?? e}`);
  }
}

export async function handleAddKeywords(args: any, ctx: Ctx) {
  const cid = ctx.cid();
  const kws: string[] = (args.keywords || []).map((k: any) => String(k).trim()).filter(Boolean);
  const mt = String(args.match_type).toUpperCase();
  if (mt === "BROAD") {
    return refusal([`BROAD match positive keywords are refused by design (account standard §1).`]);
  }
  const preview = `**Ad group:** ${args.ad_group_id}\n**Match:** ${mt}\n**Count:** ${kws.length}\n\n` +
    kws.map((k) => `- \`${k}\``).join("\n");
  if (!args.confirmed) return dryRun("Add Keywords", preview);
  const block = checkAccountBuildable("add_keywords", cid) || await checkRateLimit("add_keywords", cid, ctx.actor());
  if (block) return block;
  if (kws.length > BUILD_CAPS.maxKeywordsPerCall) {
    return refusal([`Requested ${kws.length} keywords; cap is ${BUILD_CAPS.maxKeywordsPerCall} per call.`]);
  }
  const customer = ctx.getCustomer();
  try {
    await customer.adGroupCriteria.create(
      kws.map((k) => ({
        ad_group: `customers/${cid}/adGroups/${args.ad_group_id}`,
        status: enums.AdGroupCriterionStatus.ENABLED,
        keyword: { text: k, match_type: (enums.KeywordMatchType as any)[mt] },
      }))
    );
    await recordWrite(ctx.actor());
    logAction({ tool: "add_keywords", customer_id: cid, result: "ok", ad_group_id: args.ad_group_id, match_type: mt, count: kws.length, keywords: kws });
    return text(`✅ Added **${kws.length} ${mt}** keyword(s) to ad group ${args.ad_group_id}.`);
  } catch (e: any) {
    logAction({ tool: "add_keywords", customer_id: cid, result: "error", error: String(e?.message ?? e) });
    return text(`❌ add_keywords failed: ${e?.message ?? e}`);
  }
}

export async function handleCreateRsa(args: any, ctx: Ctx) {
  const cid = ctx.cid();
  const locLen = args.longest_location_length ?? BUILD_CAPS.defaultLocationExpansion;
  const errs = validateRsa(args.headlines, args.descriptions, locLen);
  if (errs.length) {
    return text(`❌ **RSA validation failed** (nothing sent to the API):\n\n${errs.map((e) => `- ${e}`).join("\n")}`);
  }
  const preview =
    `**Ad group:** ${args.ad_group_id}\n**Final URL:** ${args.final_url}\n` +
    `**Location expansion budget:** ${locLen} chars\n\n**Headlines (${args.headlines.length}):**\n` +
    args.headlines.map((h: any) => `- (${effectiveLen(h.text, locLen)}) ${h.text}${h.pinned_field ? ` 📌${h.pinned_field}` : ""}`).join("\n") +
    `\n\n**Descriptions (${args.descriptions.length}):**\n` +
    args.descriptions.map((d: any) => `- (${effectiveLen(d.text, locLen)}) ${d.text}`).join("\n");
  if (!args.confirmed) return dryRun("Create RSA", preview);
  const block = checkAccountBuildable("create_rsa", cid) || await checkRateLimit("create_rsa", cid, ctx.actor());
  if (block) return block;
  const customer = ctx.getCustomer();
  try {
    const res = await customer.adGroupAds.create([{
      ad_group: `customers/${cid}/adGroups/${args.ad_group_id}`,
      status: enums.AdGroupAdStatus.ENABLED,
      ad: {
        final_urls: [args.final_url],
        responsive_search_ad: {
          headlines: args.headlines.map((h: any) => ({
            text: h.text,
            ...(h.pinned_field ? { pinned_field: (enums.ServedAssetFieldType as any)[h.pinned_field] } : {}),
          })),
          descriptions: args.descriptions.map((d: any) => ({
            text: d.text,
            ...(d.pinned_field ? { pinned_field: (enums.ServedAssetFieldType as any)[d.pinned_field] } : {}),
          })),
          ...(args.path1 ? { path1: args.path1 } : {}),
          ...(args.path2 ? { path2: args.path2 } : {}),
        },
      },
    }]);
    const id = res.results[0].resource_name.split("~").pop();
    await recordWrite(ctx.actor());
    logAction({ tool: "create_rsa", customer_id: cid, result: "ok", ad_group_id: args.ad_group_id, ad_id: id });
    return text(`✅ Created RSA (ad id \`${id}\`) in ad group ${args.ad_group_id} — ${args.headlines.length} headlines / ${args.descriptions.length} descriptions, all within limits at ${locLen}-char location expansion.`);
  } catch (e: any) {
    logAction({ tool: "create_rsa", customer_id: cid, result: "error", error: String(e?.message ?? e) });
    return text(`❌ create_rsa failed: ${e?.message ?? e}`);
  }
}

export async function handleCreateAssets(args: any, ctx: Ctx) {
  const cid = ctx.cid();
  const t = args.asset_type;
  const errs: string[] = [];
  let items: any[] = [];
  if (t === "SITELINK") {
    items = args.sitelinks || [];
    for (const s of items) {
      if (s.link_text?.length > 25) errs.push(`Sitelink text >25: "${s.link_text}"`);
      if (s.description1 && s.description1.length > 35) errs.push(`Sitelink d1 >35: "${s.description1}"`);
      if (s.description2 && s.description2.length > 35) errs.push(`Sitelink d2 >35: "${s.description2}"`);
    }
  } else if (t === "CALLOUT") {
    items = args.callouts || [];
    for (const c of items) if (c.length > 25) errs.push(`Callout >25: "${c}"`);
  } else if (t === "STRUCTURED_SNIPPET") {
    items = args.snippet_values || [];
    if (!args.snippet_header) errs.push("snippet_header required.");
    if (items.length < 3) errs.push("Structured snippets need ≥3 values.");
    for (const v of items) if (v.length > 25) errs.push(`Snippet value >25: "${v}"`);
  }
  if (!items.length) errs.push(`No ${t} items supplied.`);
  if (errs.length) return text(`❌ **Asset validation failed:**\n\n${errs.map((e) => `- ${e}`).join("\n")}`);

  const preview = `**Type:** ${t}\n**Link level:** account (customer) — serves on all campaigns\n**Count:** ${items.length}\n\n` +
    items.map((i: any) => `- ${t === "SITELINK" ? `${i.link_text} → ${i.final_url}` : i}`).join("\n");
  if (!args.confirmed) return dryRun("Create Assets", preview);
  const block = checkAccountBuildable("create_assets", cid) || await checkRateLimit("create_assets", cid, ctx.actor());
  if (block) return block;
  const customer = ctx.getCustomer();
  try {
    let assetPayloads: any[] = [];
    let fieldType: any;
    if (t === "SITELINK") {
      fieldType = enums.AssetFieldType.SITELINK;
      assetPayloads = items.map((s: any) => ({
        final_urls: [s.final_url],
        sitelink_asset: {
          link_text: s.link_text,
          ...(s.description1 ? { description1: s.description1 } : {}),
          ...(s.description2 ? { description2: s.description2 } : {}),
        },
      }));
    } else if (t === "CALLOUT") {
      fieldType = enums.AssetFieldType.CALLOUT;
      assetPayloads = items.map((c: string) => ({ callout_asset: { callout_text: c } }));
    } else {
      fieldType = enums.AssetFieldType.STRUCTURED_SNIPPET;
      assetPayloads = [{ structured_snippet_asset: { header: args.snippet_header, values: items } }];
    }
    const created = await customer.assets.create(assetPayloads);
    const rns = created.results.map((r: any) => r.resource_name);
    await customer.customerAssets.create(
      rns.map((rn: string) => ({ asset: rn, field_type: fieldType }))
    );
    await recordWrite(ctx.actor());
    logAction({ tool: "create_assets", customer_id: cid, result: "ok", asset_type: t, count: rns.length });
    return text(`✅ Created and account-linked **${rns.length} ${t}** asset(s).`);
  } catch (e: any) {
    logAction({ tool: "create_assets", customer_id: cid, result: "error", asset_type: t, error: String(e?.message ?? e) });
    return text(`❌ create_assets failed: ${e?.message ?? e}\n\n> Assets may exist unlinked; check the Asset Library.`);
  }
}

export async function handleCreateSharedNegativeList(args: any, ctx: Ctx) {
  const cid = ctx.cid();
  const kws: string[] = (args.keywords || []).map((k: any) => String(k).trim()).filter(Boolean);
  const mt = String(args.match_type || "PHRASE").toUpperCase();
  const attach: string[] = args.attach_to_campaign_ids || [];
  const preview = `**List name:** ${args.name}\n**Match:** ${mt}\n**Keywords:** ${kws.length}\n` +
    `**Attach to campaigns:** ${attach.length ? attach.join(", ") : "(none)"}\n\n` +
    kws.map((k) => `- \`${k}\``).join("\n");
  if (!args.confirmed) return dryRun("Create Shared Negative List", preview);
  const block = checkAccountBuildable("create_shared_negative_list", cid) || await checkRateLimit("create_shared_negative_list", cid, ctx.actor());
  if (block) return block;
  if (kws.length > CAPS.maxNegativeKeywordsPerCall) {
    return refusal([`Requested ${kws.length} keywords; cap is ${CAPS.maxNegativeKeywordsPerCall} per call.`]);
  }
  const customer = ctx.getCustomer();
  try {
    const setRes = await customer.sharedSets.create([{
      name: args.name, type: enums.SharedSetType.NEGATIVE_KEYWORDS,
    }]);
    const setRn = setRes.results[0].resource_name;
    await customer.sharedCriteria.create(
      kws.map((k) => ({
        shared_set: setRn,
        keyword: { text: k, match_type: (enums.KeywordMatchType as any)[mt] },
      }))
    );
    if (attach.length) {
      await customer.campaignSharedSets.create(
        attach.map((cId) => ({
          campaign: `customers/${cid}/campaigns/${cId}`,
          shared_set: setRn,
        }))
      );
    }
    await recordWrite(ctx.actor());
    logAction({ tool: "create_shared_negative_list", customer_id: cid, result: "ok", name: args.name, count: kws.length, attached: attach });
    return text(`✅ Created shared negative list **${args.name}** (${kws.length} ${mt} keywords)` +
      (attach.length ? `, attached to ${attach.length} campaign(s).` : `.`));
  } catch (e: any) {
    logAction({ tool: "create_shared_negative_list", customer_id: cid, result: "error", error: String(e?.message ?? e) });
    return text(`❌ create_shared_negative_list failed: ${e?.message ?? e}`);
  }
}

/** Pull AW conversion ID + label out of a conversion action's tag snippets. */
async function fetchTagIds(customer: any, conversionActionId: string) {
  const rows = await customer.query(`
    SELECT conversion_action.id, conversion_action.tag_snippets
    FROM conversion_action WHERE conversion_action.id = ${conversionActionId}
  `);
  const snippets = rows[0]?.conversion_action?.tag_snippets || [];
  for (const s of snippets) {
    const m = String(s.event_snippet || "").match(/AW-(\d+)\/([\w-]+)/);
    if (m) return { conversion_id: `AW-${m[1]}`, label: m[2] };
  }
  return null;
}

export async function handleCreateConversionAction(args: any, ctx: Ctx) {
  const cid = ctx.cid();
  const counting = args.counting_type || "ONE_PER_CLICK";
  const lookback = args.click_through_lookback_window_days ?? 30;
  const primary = args.primary_for_goal === true;
  const preview =
    `**Account:** ${cid}\n**Name:** ${args.name}\n**Type:** WEBPAGE (tag-based)\n` +
    `**Category:** ${args.category}\n**Goal:** ${primary ? "PRIMARY (counted for bidding)" : "secondary (observe)"}\n` +
    `**Count:** ${counting}\n**Click-through window:** ${lookback} days\n` +
    `**Value:** ${args.default_value_usd != null ? usd(args.default_value_usd) + " per conversion" : "none"}`;
  if (!args.confirmed) return dryRun("Create Conversion Action", preview);

  const block = checkAccountBuildable("create_conversion_action", cid) || await checkRateLimit("create_conversion_action", cid, ctx.actor());
  if (block) return block;

  const customer = ctx.getCustomer();
  try {
    const dupes = await customer.query(`
      SELECT conversion_action.id, conversion_action.name FROM conversion_action
      WHERE conversion_action.name = '${String(args.name).replace(/'/g, "\\'")}'
        AND conversion_action.status != 'REMOVED'
    `);
    if (dupes.length) {
      logAction({ tool: "create_conversion_action", customer_id: cid, result: "blocked", reason: "duplicate_name" });
      return refusal([
        `A conversion action named **${args.name}** already exists (id ${dupes[0].conversion_action.id}).`,
        `Use update_conversion_action on it, or pick a different name.`,
      ]);
    }

    const res = await customer.conversionActions.create([{
      name: args.name,
      type: enums.ConversionActionType.WEBPAGE,
      category: (enums.ConversionActionCategory as any)[args.category],
      status: enums.ConversionActionStatus.ENABLED,
      primary_for_goal: primary,
      counting_type: (enums.ConversionActionCountingType as any)[counting],
      click_through_lookback_window_days: lookback,
      value_settings: args.default_value_usd != null
        ? { default_value: args.default_value_usd, always_use_default_value: true }
        : { default_value: 0, always_use_default_value: false },
    }]);
    const rn = res.results[0].resource_name;
    const id = rn.split("/").pop();
    const tag = await fetchTagIds(customer, id);
    await recordWrite(ctx.actor());
    logAction({ tool: "create_conversion_action", customer_id: cid, result: "ok", id, name: args.name, category: args.category, primary });
    return text(
      `✅ Created conversion action **${args.name}** (id ${id}, ${primary ? "PRIMARY" : "secondary"}, ${counting}).\n\n` +
      (tag
        ? `**Conversion ID:** \`${tag.conversion_id}\`\n**Label:** \`${tag.label}\`\n**send_to:** \`${tag.conversion_id}/${tag.label}\``
        : `Tag snippet not yet available — query \`conversion_action.tag_snippets\` for id ${id} in a moment to get the AW ID/label.`)
    );
  } catch (e: any) {
    logAction({ tool: "create_conversion_action", customer_id: cid, result: "error", error: String(e?.message ?? e) });
    return text(`❌ create_conversion_action failed: ${e?.message ?? e}`);
  }
}

export async function handleUpdateConversionAction(args: any, ctx: Ctx) {
  const cid = ctx.cid();
  const customer = ctx.getCustomer();
  const rows = await customer.query(`
    SELECT conversion_action.id, conversion_action.name, conversion_action.primary_for_goal,
           conversion_action.counting_type, conversion_action.status
    FROM conversion_action WHERE conversion_action.id = ${args.conversion_action_id}
  `);
  if (!rows.length) return text(`❌ Conversion action ${args.conversion_action_id} not found.`);
  const cur = rows[0].conversion_action;
  const changes: string[] = [];
  if (args.primary_for_goal !== undefined && args.primary_for_goal !== cur.primary_for_goal)
    changes.push(`primary_for_goal: ${cur.primary_for_goal} → **${args.primary_for_goal}**`);
  if (args.counting_type && args.counting_type !== String(cur.counting_type))
    changes.push(`counting_type: ${cur.counting_type} → **${args.counting_type}**`);
  if (args.name && args.name !== cur.name)
    changes.push(`name: "${cur.name}" → **"${args.name}"**`);
  if (args.status && args.status !== String(cur.status))
    changes.push(`status: ${cur.status} → **${args.status}**`);
  if (!changes.length) return text(`No changes: "${cur.name}" already matches the requested settings.`);
  const preview = `**Action:** ${cur.name} (id ${args.conversion_action_id})\n` + changes.map((c) => `- ${c}`).join("\n");
  if (!args.confirmed) return dryRun("Update Conversion Action", preview);
  const block = await checkRateLimit("update_conversion_action", cid, ctx.actor());
  if (block) return block;
  try {
    await customer.conversionActions.update([{
      resource_name: `customers/${cid}/conversionActions/${args.conversion_action_id}`,
      ...(args.primary_for_goal !== undefined ? { primary_for_goal: args.primary_for_goal } : {}),
      ...(args.counting_type ? { counting_type: (enums.ConversionActionCountingType as any)[args.counting_type] } : {}),
      ...(args.name ? { name: args.name } : {}),
      ...(args.status ? { status: (enums.ConversionActionStatus as any)[args.status] } : {}),
    }]);
    await recordWrite(ctx.actor());
    logAction({ tool: "update_conversion_action", customer_id: cid, result: "ok", id: args.conversion_action_id, changes });
    return text(`✅ Updated conversion action **${cur.name}**:\n` + changes.map((c) => `- ${c}`).join("\n"));
  } catch (e: any) {
    logAction({ tool: "update_conversion_action", customer_id: cid, result: "error", error: String(e?.message ?? e) });
    return text(`❌ update_conversion_action failed: ${e?.message ?? e}`);
  }
}

export async function handleUpdateAdStatus(args: any, ctx: Ctx) {
  const cid = ctx.cid();
  const preview = `**Ad:** ${args.ad_id} (ad group ${args.ad_group_id})\n**New status:** ${args.status}`;
  if (!args.confirmed) return dryRun("Update Ad Status", preview);
  const block = await checkRateLimit("update_ad_status", cid, ctx.actor());
  if (block) return block;
  const customer = ctx.getCustomer();
  try {
    await customer.adGroupAds.update([{
      resource_name: `customers/${cid}/adGroupAds/${args.ad_group_id}~${args.ad_id}`,
      status: (enums.AdGroupAdStatus as any)[args.status],
    }]);
    await recordWrite(ctx.actor());
    logAction({ tool: "update_ad_status", customer_id: cid, result: "ok", ad_id: args.ad_id, status: args.status });
    return text(`✅ Ad ${args.ad_id} set to **${args.status}**.`);
  } catch (e: any) {
    logAction({ tool: "update_ad_status", customer_id: cid, result: "error", error: String(e?.message ?? e) });
    return text(`❌ update_ad_status failed: ${e?.message ?? e}`);
  }
}

export async function handleGetAdPolicyDetails(args: any, ctx: Ctx) {
  const customer = ctx.getCustomer();
  const where = args.ad_group_id
    ? `ad_group.id = ${args.ad_group_id}`
    : args.campaign_id
      ? `campaign.id = ${args.campaign_id}`
      : `ad_group_ad.status != 'REMOVED'`;
  const rows = await customer.query(`
    SELECT ad_group_ad.ad.id, campaign.name, ad_group.name,
           ad_group_ad.policy_summary.approval_status,
           ad_group_ad.policy_summary.review_status,
           ad_group_ad.policy_summary.policy_topic_entries
    FROM ad_group_ad WHERE ${where} AND ad_group_ad.status = 'ENABLED' LIMIT 200
  `);
  const flagged = rows.filter(
    (r: any) => r.ad_group_ad.policy_summary?.approval_status !== enums.PolicyApprovalStatus.APPROVED
  );
  if (!flagged.length) return text(`All ${rows.length} enabled ads fully APPROVED — no policy findings.`);
  const out = flagged.map((r: any) => ({
    ad_id: r.ad_group_ad.ad.id,
    campaign: r.campaign.name,
    ad_group: r.ad_group.name,
    approval: r.ad_group_ad.policy_summary.approval_status,
    review: r.ad_group_ad.policy_summary.review_status,
    topics: (r.ad_group_ad.policy_summary.policy_topic_entries || []).map((t: any) => ({
      topic: t.topic, type: t.type,
    })),
  }));
  return text(`## Policy findings — ${flagged.length} of ${rows.length} enabled ads not fully approved\n\n` +
    JSON.stringify(out, null, 2));
}

export async function handleCheckEnablePreflight(args: any, ctx: Ctx) {
  const fails = await enablePreflight(ctx.getCustomer(), ctx.cid(), args.campaign_id);
  if (!fails.length)
    return text(`✅ **Preflight PASS** — campaign ${args.campaign_id} meets all enable conditions.`);
  return text(`❌ **Preflight FAIL** — campaign ${args.campaign_id} cannot be enabled:\n\n` +
    fails.map((f) => `- ${f}`).join("\n"));
}
