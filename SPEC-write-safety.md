# Write-safety spec — google-ads-mcp

Status: proposed, 2026-08-10
Applies to: `src/index.ts`, the four mutating tools
Supersedes: the "two-phase confirm" section of *Internal Google Ads MCP - build plan*

## Where we actually are

The build plan calls for a two-phase layer (`plan_id` → `confirm_action`/`cancel_action`),
`validate_only` dry-runs, a SQLite action log, and a daily spend-delta cap. None of those
names exist in the code. But the code is *not* unguarded: each of the four write tools
(`add_negative_keywords`, `pause_campaign`, `enable_campaign`, `update_campaign_budget`)
already implements a single-tool two-mode gate:

```ts
if (!args.confirmed) {
  return { content: [{ type: "text", text: "## ⚠️ Dry Run — ...\n> No changes have been made." }] };
}
```

`confirmed` is absent from every `required` array, so omitting it yields a preview. That
default is correct and should be preserved.

So the question is not "build the plan's layer." It is "which of the plan's four controls
actually buy something the `confirmed` flag doesn't."

## What the confirm ceremony cannot do (read this before building it)

A `plan_id`/`confirm_action` split cannot prove a human approved anything. The model
receives the plan text and can immediately call `confirm_action` with the id it was just
handed. No server-side check distinguishes "human read the diff" from "model relayed the
id." The build plan's phrase — *"confirm step enforced in the server, not by
tool-annotation hints"* — overstates what is achievable from inside an MCP server.

What the split genuinely buys is narrow but real: it forces the diff to be **rendered into
the transcript** before the write, where a human can see it. That is a visibility property,
not an enforcement property.

The only controls that are actually un-bypassable by the model are the **hard caps** in
§1 — because refusal happens regardless of any argument the caller supplies. Prioritize
accordingly.

## Priority order

| # | Control | Effort | Why it ranks here |
|---|---|---|---|
| 1 | Hard caps | S | Only real enforcement; model cannot argue past it |
| 2 | Real before/after diff | S | Closes the largest correctness hole in today's preview |
| 3 | Shared-budget detection | S | Silent multi-campaign blast radius |
| 4 | `validate_only` pre-flight | S | Catches API rejections the local preview cannot |
| 5 | Append-only action log | S | After-the-fact accountability |
| 6 | `plan_id` two-call split | M | Ceremony; visibility only. Do last, or skip |

---

## 1. Hard caps (un-bypassable)

Module-level constants, checked inside each write handler **after** the `confirmed` branch
and **before** any mutate call. No argument disables these.

```ts
const CAPS = {
  maxBudgetIncreasePct: 50,      // reject >50% increase in one call
  maxDailyBudgetUsd: 500,        // reject any absolute daily budget above this
  maxWritesPerHour: 10,          // per process
  maxNegativeKeywordsPerCall: 50,
};
```

On violation, return a refusal in the normal content shape — not a thrown error — so the
model reports it cleanly:

```
❌ Blocked by local safety cap.
Requested: $800.00/day. Cap: $500.00/day (CAPS.maxDailyBudgetUsd).
Raise the cap in src/index.ts if this is intended.
```

The rate limiter is an in-memory ring of write timestamps. Process restart resets it; that
is an acceptable failure mode for a single-user stdio server.

Tune `maxDailyBudgetUsd` per account, not globally, if client budgets differ by an order of
magnitude — a single global cap either blocks real work or protects nothing.

## 2. Real before/after diff

Today's `update_campaign_budget` preview echoes the *requested* value and never fetches
current state:

```
**New Daily Budget:** $75.00/day        ← target only, no delta
```

The dry run must query current state first and show the change. Reuse the query the execute
path already runs, and hoist it above the `confirmed` branch:

```
## ⚠️ Dry Run — Update Campaign Budget

Campaign:  Pool Service — Brand (id 1234567890)
Account:   Johnson Pools (987-654-3210)
Budget:    $50.00/day  →  $75.00/day   (+$25.00, +50.0%)
Monthly:   ~$1,520     →  ~$2,280      (+$760)
Shared:    no — budget used by this campaign only

To execute: same call with confirmed: true
> No changes have been made.
```

Apply the same treatment to the other three:
- `pause_campaign` / `enable_campaign` — show current status, and refuse as a no-op if
  already in the target state (today it issues a pointless mutate).
- `add_negative_keywords` — show the count already present at that level and flag
  duplicates rather than creating them.

The `+%` line is what makes a fat-fingered `750` instead of `75` visible. That is the whole
point of this item.

## 3. Shared-budget detection

`campaignBudgets.update()` writes the budget *resource*, not the campaign. If that budget is
shared, every campaign attached to it changes. Nothing in the current preview says so.

Before the mutate, count attached campaigns:

```sql
SELECT campaign.id, campaign.name
FROM campaign
WHERE campaign.campaign_budget = '<budgetResourceName>'
```

If the count is > 1, the dry run must list every affected campaign, and the execute path
must refuse unless `acknowledge_shared_budget: true` is also passed. This is the one place a
second explicit flag is warranted — the blast radius is invisible otherwise.

## 4. `validate_only` pre-flight

`google-ads-api` supports `validate_only` on mutate calls. Run it during the dry run so the
preview reflects what the API will actually accept:

```ts
await customer.campaignBudgets.update(
  [{ resource_name: budgetResourceName, amount_micros: newBudgetMicros }],
  { validate_only: true }
);
```

Surface any returned error verbatim in the preview. This catches the failure classes local
string formatting cannot: budget below the currency minimum, campaign in `REMOVED` state,
shared-budget conflicts, micros not a multiple of the currency's minimum unit.

Related bug to fix while here: `Math.round(usd * 1_000_000)` can produce a value that is not
a multiple of 10,000 micros (USD minimum unit). Round to the unit:

```ts
const newBudgetMicros = Math.round(args.new_daily_budget_usd * 100) * 10_000;
```

## 5. Append-only action log

SQLite is overkill for a single-user stdio server. Use JSONL:

```
~/.local/state/google-ads-mcp/actions.jsonl
```

One line per *executed* write (not per preview), opened `'a'`, `fs.appendFileSync` so a
crash cannot lose the record:

```json
{"ts":"2026-08-10T15:04:11.painZ","tool":"update_campaign_budget","customer_id":"9876543210",
 "campaign_id":"1234567890","before":{"amount_micros":50000000},
 "after":{"amount_micros":75000000},"delta_usd":25.00,"caps_ok":true,"result":"ok"}
```

Log failures too, with `"result":"error"` and the API message. Then add a read-only
`explain_changes` tool (tail the last N lines) so "what did you change last week" is
answerable without opening the file. Keep the log outside the project directory — see §7.

## 6. `plan_id` two-call split — optional, do last

Only if §1–5 land and you still want the ceremony.

```ts
type PendingPlan = {
  id: string; tool: string; args: any; diff: string;
  deltaUsd: number; createdAt: number;
};
const PENDING = new Map<string, PendingPlan>();
const PLAN_TTL_MS = 5 * 60_000;
```

- Write tools called without `confirmed` register a plan and return the diff plus
  `plan_id: "pln_a1b2c3"`.
- New tool `confirm_write({ plan_id })` looks it up, re-checks §1 caps against *current*
  state (state may have drifted), executes, logs, deletes the entry.
- New tool `cancel_write({ plan_id })` deletes it.
- Expired or unknown ids return "plan expired, re-run the preview" — never auto-recreate.
- Re-check the diff at confirm time and abort if current state no longer matches what the
  plan was computed against. This is the one substantive advantage over the `confirmed`
  flag: it detects concurrent changes made in the Google Ads UI between preview and execute.

Keep the `confirmed` flag working alongside this. Removing it breaks every saved prompt and
runbook that already uses it, for no safety gain.

## 7. File placement

Nothing that survives a process restart belongs in the project directory:

| What | Where | Why |
|---|---|---|
| Credentials | `~/.config/google-ads-mcp/.env`, `chmod 600` | Per the vault credential rule; survives a `rm -rf` of the project; cannot be swept into a zip or `git add -A` |
| Action log | `~/.local/state/google-ads-mcp/actions.jsonl` | Audit trail must outlive the working tree |
| Caps config | `src/index.ts` constants | Should require a rebuild to change — that is the point |

Resolve the env path explicitly rather than relying on cwd:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
dotenv.config({ path: join(homedir(), ".config", "google-ads-mcp", ".env") });
```

## Done criteria

- A 10× budget typo is refused by a cap, not merely previewed.
- Every budget preview shows current → new with absolute and percentage delta.
- A shared-budget change lists all affected campaigns and needs a second flag.
- `validate_only` runs on every dry run; API rejections appear in the preview.
- `actions.jsonl` has one line per executed write, and `explain_changes` reads it back.
- Credentials load from `~/.config/`; the project directory contains no secrets.
