/**
 * Acceptance test for phases 2 and 4: every write is attributable, and the
 * server will not start in a configuration where it would not be.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import {
  logAction, flushActionLog, runAsActor, currentActor, configureActionLog,
  configureCredentials, configureRateLimiting, resetRateLimitingForTest,
  assertDeploymentIsSound, SingleEnvCredentialStore, refreshTokenFor,
  LOCAL_ACTOR, checkRateLimit, recordWrite, CAPS,
} from "../dist/write-safety.js";

// A durable sink stand-in, so the gate and the stamping can be tested without GCP.
class MemoryLogStore {
  kind = "durable"; location = "memory://test"; rows = [];
  async append(entry) { this.rows.push(entry); }
  async tail(limit) { return this.rows.slice(-limit).map((r) => JSON.stringify(r)); }
}
class PerActorCredentialStore {
  kind = "per-actor";
  constructor(map) { this.map = map; }
  async refreshTokenFor(actor) {
    const t = this.map.get(actor);
    if (!t) throw new Error(`no credential for actor ${actor}`);
    return t;
  }
}

// ── 1. Entries are stamped with the ambient actor, not a passed argument ─────
resetRateLimitingForTest();
const log = new MemoryLogStore();
configureActionLog(log);

await runAsActor("alice", async () => {
  logAction({ tool: "update_campaign_budget", customer_id: "2222222222", result: "ok" });
});
await runAsActor("bob", async () => {
  logAction({ tool: "pause_campaign", customer_id: "3333333333", result: "ok" });
});
await flushActionLog();

assert.equal(log.rows.length, 2);
assert.equal(log.rows[0].actor, "alice", "entry must carry the acting identity");
assert.equal(log.rows[1].actor, "bob", "a second actor's entry must not inherit the first");
assert.ok(log.rows.every((r) => r.ts), "every entry is timestamped");

// The stamp survives awaits inside the request — the realistic case, since a
// write logs after an API round trip.
await runAsActor("alice", async () => {
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(currentActor(), "alice", "actor context must survive an await");
  logAction({ tool: "enable_campaign", customer_id: "1", result: "ok" });
});
await flushActionLog();
assert.equal(log.rows.at(-1).actor, "alice");

// Outside any request the actor is the local placeholder, never undefined —
// an unattributed line is the thing this phase exists to prevent.
logAction({ tool: "x", customer_id: "1", result: "ok" });
await flushActionLog();
assert.equal(log.rows.at(-1).actor, LOCAL_ACTOR);

// ── 2. A logging failure never breaks a write that already succeeded ─────────
configureActionLog(new (class { kind = "durable"; location = "x";
  async append() { throw new Error("sink down"); } async tail() { return []; } })());
logAction({ tool: "pause_campaign", customer_id: "1", result: "ok" });
await flushActionLog();   // must not throw
configureActionLog(log);

// ── 3. The write cap is per actor, keyed off the same identity ───────────────
resetRateLimitingForTest();
configureActionLog(log);
for (let i = 0; i < CAPS.maxWritesPerHour; i++) await recordWrite("alice");
assert.ok(await checkRateLimit("pause_campaign", "1", "alice"), "alice is capped");
assert.equal(await checkRateLimit("pause_campaign", "1", "bob"), null, "bob is not");

// ── 4. Per-actor credentials ─────────────────────────────────────────────────
configureCredentials(new SingleEnvCredentialStore("shared-token"));
assert.equal(await refreshTokenFor("alice"), "shared-token");
assert.equal(await refreshTokenFor("bob"), "shared-token", "single-env gives everyone one identity");

configureCredentials(new PerActorCredentialStore(new Map([
  ["alice", "token-alice"], ["bob", "token-bob"],
])));
assert.equal(await refreshTokenFor("alice"), "token-alice");
assert.equal(await refreshTokenFor("bob"), "token-bob", "each actor gets their own identity");

// ── 5. The startup gate names every unsafe piece ─────────────────────────────
resetRateLimitingForTest();
assertDeploymentIsSound();                      // local: nothing to check

configureRateLimiting({ mode: "shared" });
let err;
try { assertDeploymentIsSound(); } catch (e) { err = e; }
assert.ok(err, "shared mode with local implementations must refuse to start");
for (const fragment of ["rate-limit store", "action log store", "credential store"]) {
  assert.match(err.message, new RegExp(fragment),
    `the refusal must name the ${fragment} fault, not just the first one found`);
}

// Fixing all three lets it start.
configureRateLimiting({ mode: "shared", store: new (class { kind = "shared";
  async exceeded() { return false; } async record() {} })() });
configureActionLog(log);
configureCredentials(new PerActorCredentialStore(new Map([["alice", "t"]])));
assertDeploymentIsSound();

resetRateLimitingForTest();
console.log("audit-and-identity: PASS");
process.exit(0);
