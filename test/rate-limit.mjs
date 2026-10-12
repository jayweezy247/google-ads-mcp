/**
 * Acceptance test for phase 3: the write cap survives a shared, autoscaled
 * deployment — or the server refuses to start.
 *
 * The failure this guards against is silent. An in-memory window on Cloud Run
 * gives N instances x the cap and resets on scale-to-zero, with no error and
 * nothing in the transcript to say the caps stopped applying.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import {
  CAPS, InMemoryRateLimitStore, configureRateLimiting, resetRateLimitingForTest,
  assertRateLimitingIsSound, checkRateLimit, recordWrite, rateLimitKey,
  configureActionLog, configureCredentials,
} from "../dist/write-safety.js";

const MAX = CAPS.maxWritesPerHour;

// ── 1. The cap holds for one actor ───────────────────────────────────────────
resetRateLimitingForTest();
for (let i = 0; i < MAX; i++) {
  assert.equal(await checkRateLimit("pause_campaign", "2222222222", "alice"), null,
    `write ${i + 1} of ${MAX} should be allowed`);
  await recordWrite("alice");
}
const blocked = await checkRateLimit("pause_campaign", "2222222222", "alice");
assert.ok(blocked, `write ${MAX + 1} must be refused`);
assert.match(blocked.content[0].text, /Blocked by local safety cap/);
// The old refusal told the caller to restart the server. That is not actionable
// against a shared service, and the text must not regress to it.
assert.doesNotMatch(blocked.content[0].text, /[Rr]estart the server/,
  "refusal must not advise restarting a shared service");

// ── 2. Actors do not consume each other's allowance ──────────────────────────
assert.equal(await checkRateLimit("pause_campaign", "2222222222", "bob"), null,
  "one actor exhausting the cap must not block another");
assert.notEqual(rateLimitKey("alice"), rateLimitKey("bob"));

// ── 3. The failure mode, demonstrated ────────────────────────────────────────
// Two "instances", each with its own process-local window, as Cloud Run would
// have. Between them they let through 2x the cap — this is the bug.
const instanceA = new InMemoryRateLimitStore();
const instanceB = new InMemoryRateLimitStore();
let throughPerProcess = 0;
for (const inst of [instanceA, instanceB]) {
  for (let i = 0; i < MAX + 5; i++) {
    if (await inst.exceeded(rateLimitKey("alice"), MAX)) break;
    await inst.record(rateLimitKey("alice"));
    throughPerProcess++;
  }
}
assert.equal(throughPerProcess, MAX * 2,
  "two process-local windows should let through twice the cap — the bug this phase fixes");

// A shared store behind both instances holds the real cap.
const shared = new (class {
  kind = "shared";
  stamps = new Map();
  async exceeded(key, max) { return (this.stamps.get(key) ?? []).length >= max; }
  async record(key) { this.stamps.set(key, [...(this.stamps.get(key) ?? []), Date.now()]); }
})();
let throughShared = 0;
for (let inst = 0; inst < 2; inst++) {
  for (let i = 0; i < MAX + 5; i++) {
    if (await shared.exceeded(rateLimitKey("alice"), MAX)) break;
    await shared.record(rateLimitKey("alice"));
    throughShared++;
  }
}
assert.equal(throughShared, MAX, "a shared store must hold the cap across instances");

// ── 4. The startup gate ──────────────────────────────────────────────────────
resetRateLimitingForTest();
assertRateLimitingIsSound();                       // local + in-memory: fine

configureRateLimiting({ mode: "shared" });         // shared + in-memory: must refuse
assert.throws(() => assertRateLimitingIsSound(), /Refusing to start/,
  "a shared deployment with a process-local window must not come up");

// Since phases 2 and 4 the gate covers the log and credentials too, so a sound
// rate-limit store alone is no longer enough to start — see audit-and-identity.
configureRateLimiting({ mode: "shared", store: shared });
assert.throws(() => assertRateLimitingIsSound(), /action log store|credential store/,
  "a shared rate-limit store alone must not satisfy the full deployment gate");

resetRateLimitingForTest();
console.log("rate-limit: PASS");
process.exit(0);
