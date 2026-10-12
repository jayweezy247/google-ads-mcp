import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Local safety controls for the four mutating tools.
 *
 * The `confirmed: true` flag on each write tool is a visibility control — it puts a
 * preview in the transcript, but the caller can set it on the first call and skip the
 * preview entirely. The caps below are the only controls a caller cannot argue past:
 * they are checked after the confirmed branch and refuse regardless of arguments.
 *
 * Tune these to the accounts you actually run. A global cap set too high protects
 * nothing; set too low it blocks real work.
 */
export const CAPS = {
  /** Reject a budget increase larger than this percentage in a single call. */
  maxBudgetIncreasePct: 50,
  /** Reject any absolute daily budget above this, regardless of the delta. */
  maxDailyBudgetUsd: 500,
  /** Reject writes beyond this many per rolling hour, per actor. */
  maxWritesPerHour: 10,
  /** Reject a single add_negative_keywords call larger than this. */
  maxNegativeKeywordsPerCall: 50,
};

/** USD minimum billing unit for Google Ads is 10,000 micros. */
const MICROS_PER_UNIT = 10_000;

export function toMicros(usd: number): number {
  // Round to the currency's minimum unit. Math.round(usd * 1e6) can produce a value
  // that is not a multiple of 10,000, which the API rejects or silently adjusts.
  return Math.round(usd * 100) * MICROS_PER_UNIT;
}

export function fromMicros(micros: number): number {
  return micros / 1_000_000;
}

export function usd(micros: number): string {
  return `$${fromMicros(micros).toFixed(2)}`;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
/**
 * The write cap is the one control a caller cannot argue past, so it has to hold
 * wherever the server runs.
 *
 * It used to be a plain in-memory array, which was correct for a single-user
 * stdio server and fails three ways on Cloud Run: autoscaling to N instances
 * gives N x the cap, `min-instances=0` resets the window whenever traffic
 * pauses, and "restart the server" is not advice an operator of a shared
 * service can act on. None of that surfaces as an error — the cap simply stops
 * being a cap on the four tools that move client money.
 *
 * So the window lives behind a store. Local runs keep the in-memory one and
 * behave exactly as before; a deployed run must be given a shared store, and
 * `assertRateLimitingIsSound()` refuses to let it start without one.
 */
const WINDOW_MS = 60 * 60 * 1000;

export type RateLimitStore = {
  /** Identifies the implementation in refusals and startup checks. */
  readonly kind: "in-memory" | "shared";
  /** True when `key` has already used its allowance in the trailing window. */
  exceeded(key: string, maxPerHour: number): Promise<boolean>;
  /** Record one write against `key`. */
  record(key: string): Promise<void>;
};

/** Process-local window. Correct for stdio; never correct for a shared service. */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly kind = "in-memory" as const;
  private windows = new Map<string, number[]>();

  async exceeded(key: string, maxPerHour: number): Promise<boolean> {
    return this.trim(key).length >= maxPerHour;
  }

  async record(key: string): Promise<void> {
    this.trim(key).push(Date.now());
  }

  private trim(key: string): number[] {
    const cutoff = Date.now() - WINDOW_MS;
    const stamps = this.windows.get(key) ?? [];
    while (stamps.length && stamps[0] < cutoff) stamps.shift();
    this.windows.set(key, stamps);
    return stamps;
  }
}

export type DeploymentMode = "local" | "shared";

let store: RateLimitStore = new InMemoryRateLimitStore();
let mode: DeploymentMode = "local";

export function configureRateLimiting(opts: { mode: DeploymentMode; store?: RateLimitStore }): void {
  mode = opts.mode;
  if (opts.store) store = opts.store;
}

/** Test seam — resets to the local default. */
export function resetRateLimitingForTest(): void {
  store = new InMemoryRateLimitStore();
  logStore = new LocalFileActionLogStore();
  credentials = null;
  mode = "local";
  pending = [];
}

// ── Per-actor credentials ─────────────────────────────────────────────────────
/**
 * One refresh token in .env means the server *is* one Google identity: every
 * operator acts as whoever minted it, so the log cannot attribute a change even
 * once it is durable. A deployment resolves a token per authenticated actor.
 */
export type CredentialStore = {
  readonly kind: "single-env" | "per-actor";
  refreshTokenFor(actor: string): Promise<string>;
};

/** The single shared token from .env. Correct locally; never correct shared. */
export class SingleEnvCredentialStore implements CredentialStore {
  readonly kind = "single-env" as const;
  constructor(private readonly refreshToken: string) {}
  async refreshTokenFor(_actor: string): Promise<string> {
    return this.refreshToken;
  }
}

let credentials: CredentialStore | null = null;

export function configureCredentials(store: CredentialStore): void {
  credentials = store;
}

export async function refreshTokenFor(actor: string): Promise<string> {
  if (!credentials) throw new Error("Credentials not configured — call configureCredentials().");
  return credentials.refreshTokenFor(actor);
}

/**
 * Startup gate for every piece of state that stops being safe when one process
 * stops serving one operator. Each of these fails silently rather than loudly:
 * caps that no longer cap, an audit log destroyed on scale-down, and writes
 * attributed to a single shared identity. So the service refuses to come up
 * instead. Call it before connecting any transport.
 */
export function assertDeploymentIsSound(): void {
  if (mode !== "shared") return;
  const faults: string[] = [];

  if (store.kind !== "shared") {
    faults.push(
      `rate-limit store is '${store.kind}': a process-local window does not survive ` +
      "autoscaling or scale-to-zero, so the write caps would not be enforced"
    );
  }
  if (logStore.kind !== "durable") {
    faults.push(
      `action log store is '${logStore.kind}': a container filesystem is ephemeral, ` +
      "so the audit trail would be destroyed on scale-down"
    );
  }
  if (!credentials || credentials.kind !== "per-actor") {
    faults.push(
      `credential store is '${credentials?.kind ?? "unset"}': every operator would act ` +
      "as one shared Google identity, making writes unattributable"
    );
  }

  if (faults.length) {
    throw new Error(
      "Refusing to start in shared mode:\n" +
      faults.map((f) => `  - ${f}`).join("\n") +
      "\nConfigure shared implementations before connecting a transport."
    );
  }
}

/** @deprecated Use assertDeploymentIsSound(). Kept so callers do not silently skip the gate. */
export const assertRateLimitingIsSound = assertDeploymentIsSound;

/**
 * The window is keyed per actor, which is the faithful translation of the old
 * "per server process" cap: one process was one operator. Deliberately NOT keyed
 * per (actor, account) — that would multiply the allowance by the number of
 * clients (11 today), which is a loosening of a safety control and Alice's call
 * to make, not a side effect of this refactor.
 */
export function rateLimitKey(actor: string): string {
  return `writes:${actor}`;
}

/** Actor placeholder until per-user OAuth lands (plan phase 4). */
export const LOCAL_ACTOR = "local";

// ── Refusals ──────────────────────────────────────────────────────────────────
/** Refusals are returned as normal content, not thrown, so the model reports them cleanly. */
export function refusal(lines: string[]) {
  return {
    content: [{
      type: "text",
      text: `❌ **Blocked by local safety cap.**\n\n${lines.join("\n")}\n\n> No changes have been made. Adjust CAPS in \`src/write-safety.ts\` if this is intended.`,
    }],
  };
}

export function text(body: string) {
  return { content: [{ type: "text", text: body }] };
}

// ── Action log ────────────────────────────────────────────────────────────────
/**
 * The log answers "who changed this account, and when". On a laptop the file in
 * $HOME was a fine answer. On Cloud Run the container filesystem is ephemeral,
 * so the same code silently produces a per-instance file destroyed on
 * scale-down — and the entries had no actor field, so even if one survived it
 * could not say which owner acted.
 *
 * Both halves are fixed here: the sink is pluggable (local file for stdio, a
 * durable store for a deployment, gated at startup like the rate limiter), and
 * the actor is stamped from ambient context rather than passed by hand at each
 * of the ~30 call sites — one forgotten argument would otherwise be an
 * unattributable write.
 */
const LOG_DIR = path.join(os.homedir(), ".local", "state", "google-ads-mcp");
const LOG_PATH = path.join(LOG_DIR, "actions.jsonl");

export type ActionLogEntry = {
  tool: string;
  customer_id: string;
  result: "ok" | "error" | "blocked";
  [k: string]: unknown;
};

/** A log line as written: the caller's entry, stamped with time and actor. */
export type StampedEntry = ActionLogEntry & { ts: string; actor: string };

export type ActionLogStore = {
  readonly kind: "local-file" | "durable";
  append(entry: StampedEntry): Promise<void>;
  tail(limit: number): Promise<string[]>;
  readonly location: string;
};

export class LocalFileActionLogStore implements ActionLogStore {
  readonly kind = "local-file" as const;
  readonly location = LOG_PATH;

  async append(entry: StampedEntry): Promise<void> {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", { mode: 0o600 });
  }

  async tail(limit: number): Promise<string[]> {
    try {
      return fs.readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean).slice(-limit);
    } catch {
      return [];
    }
  }
}

let logStore: ActionLogStore = new LocalFileActionLogStore();

export function configureActionLog(store: ActionLogStore): void {
  logStore = store;
}

// ── Actor context ─────────────────────────────────────────────────────────────
/**
 * The acting identity for the current request, carried implicitly so that every
 * logAction() call is attributed without the call site having to remember.
 */
const actorContext = new AsyncLocalStorage<string>();

export function runAsActor<T>(actor: string, fn: () => T): T {
  return actorContext.run(actor, fn);
}

export function currentActor(): string {
  return actorContext.getStore() ?? LOCAL_ACTOR;
}

// ── Writing ───────────────────────────────────────────────────────────────────
// Entries are queued rather than awaited at the call site, so a logging failure
// can still never break a write that already succeeded; dispatch flushes before
// responding, so a durable sink is written before the caller is told anything.
let pending: Promise<void>[] = [];

/** Append-only. Logs executed writes, refusals, and failures — never previews. */
export function logAction(entry: ActionLogEntry): void {
  const stamped: StampedEntry = {
    ts: new Date().toISOString(),
    actor: currentActor(),
    ...entry,
  };
  pending.push(
    logStore.append(stamped).catch((e: any) => {
      console.error(`[google-ads-mcp] action log write failed: ${e?.message}`);
    })
  );
}

/** Awaits queued log writes. Called by dispatch before it returns a result. */
export async function flushActionLog(): Promise<void> {
  const inflight = pending;
  pending = [];
  await Promise.all(inflight);
}

export async function readActionLog(limit: number): Promise<string[]> {
  return logStore.tail(limit);
}

export function actionLogLocation(): string {
  return logStore.location;
}

/** Back-compat for the local path; prefer actionLogLocation(). */
export const ACTION_LOG_PATH = LOG_PATH;

// ── Shared cap checks ─────────────────────────────────────────────────────────
/** Returns a refusal object if any cap is violated, otherwise null. */
export function checkBudgetCaps(currentMicros: number | null, newUsd: number) {
  if (newUsd > CAPS.maxDailyBudgetUsd) {
    return refusal([
      `Requested: **$${newUsd.toFixed(2)}/day**`,
      `Cap: **$${CAPS.maxDailyBudgetUsd.toFixed(2)}/day** (\`CAPS.maxDailyBudgetUsd\`)`,
    ]);
  }
  if (currentMicros && currentMicros > 0) {
    const pct = ((toMicros(newUsd) - currentMicros) / currentMicros) * 100;
    if (pct > CAPS.maxBudgetIncreasePct) {
      return refusal([
        `Current: **${usd(currentMicros)}/day** → Requested: **$${newUsd.toFixed(2)}/day**`,
        `That is a **+${pct.toFixed(1)}%** increase.`,
        `Cap: **+${CAPS.maxBudgetIncreasePct}%** per call (\`CAPS.maxBudgetIncreasePct\`).`,
      ]);
    }
  }
  return null;
}

export async function recordWrite(actor: string = LOCAL_ACTOR): Promise<void> {
  await store.record(rateLimitKey(actor));
}

export async function checkRateLimit(tool: string, customerId: string, actor: string = LOCAL_ACTOR) {
  if (await store.exceeded(rateLimitKey(actor), CAPS.maxWritesPerHour)) {
    logAction({ tool, customer_id: customerId, result: "blocked", reason: "rate_limit", actor });
    return refusal([
      `Already executed **${CAPS.maxWritesPerHour} writes** in the last hour.`,
      `Cap: \`CAPS.maxWritesPerHour\`, over a rolling 60-minute window.`,
      `The window rolls as the oldest write ages out — no restart is possible or needed.`,
    ]);
  }
  return null;
}
