/**
 * Tests for the Firestore stores (plan step 0a).
 *
 * They run against a fake that satisfies the narrow FirestoreLike contract, so
 * the real logic — transaction bodies, window trimming, query shape, the
 * missing-credential refusal — is exercised with no network call and no GCP
 * project, which is the rule the rest of this suite follows.
 *
 * What a fake cannot prove is that Firestore's own transaction semantics behave
 * as assumed under real contention. That is phase 9's job, against the deployed
 * service.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import {
  FirestoreRateLimitStore, FirestoreActionLogStore, FirestoreCredentialStore, COLLECTIONS,
} from "../dist/firestore-stores.js";

// ── A minimal Firestore stand-in ─────────────────────────────────────────────
function makeFake() {
  const data = new Map();           // "collection/doc" -> object
  const added = new Map();          // collection -> array of docs
  let transactions = 0;

  const docRef = (col, id) => ({
    __key: `${col}/${id}`,
    async get() {
      const v = data.get(`${col}/${id}`);
      return { exists: v !== undefined, data: () => v };
    },
    async set(v) { data.set(`${col}/${id}`, v); },
  });

  const query = (col, dir, lim) => ({
    limit(n) { return query(col, dir, n); },
    async get() {
      let docs = [...(added.get(col) ?? [])];
      docs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      if (dir === "desc") docs.reverse();
      if (lim !== undefined) docs = docs.slice(0, lim);
      return { docs: docs.map((d) => ({ data: () => d })) };
    },
  });

  return {
    data, added, transactionCount: () => transactions,
    collection(col) {
      return {
        doc(id) { return docRef(col, id); },
        async add(v) {
          if (!added.has(col)) added.set(col, []);
          added.get(col).push(v);
        },
        orderBy(_field, dir) { return query(col, dir, undefined); },
      };
    },
    async runTransaction(fn) {
      transactions++;
      return fn({
        async get(ref) { return ref.get(); },
        set(ref, v) { data.set(ref.__key, v); },
      });
    },
  };
}

// ── Rate limiting ────────────────────────────────────────────────────────────
{
  const fake = makeFake();
  const store = new FirestoreRateLimitStore(fake);
  assert.equal(store.kind, "shared", "must satisfy the deployment gate");

  assert.equal(await store.exceeded("writes:alice", 3), false, "empty key is not over");

  for (let i = 0; i < 3; i++) await store.record("writes:alice");
  assert.equal(await store.exceeded("writes:alice", 3), true, "cap reached");
  assert.equal(await store.exceeded("writes:bob", 3), false, "another actor is unaffected");

  // Writes go through a transaction — that is what stops two instances from
  // losing each other's entries, which is the whole bug being fixed.
  assert.equal(fake.transactionCount(), 3, "each record must be transactional");

  // Entries older than the window are ignored AND trimmed on write, so a
  // long-lived key cannot grow forever.
  const old = Date.now() - 2 * 60 * 60 * 1000;
  fake.data.set(`${COLLECTIONS.rateLimits}/writes:stale`, { stamps: [old, old, old] });
  assert.equal(await store.exceeded("writes:stale", 3), false, "expired stamps do not count");
  await store.record("writes:stale");
  assert.equal(fake.data.get(`${COLLECTIONS.rateLimits}/writes:stale`).stamps.length, 1,
    "expired stamps must be trimmed on write, not accumulated");

  // Junk in the document must not crash a write path.
  fake.data.set(`${COLLECTIONS.rateLimits}/writes:junk`, { stamps: ["nonsense", null] });
  assert.equal(await store.exceeded("writes:junk", 1), false, "unparseable stamps are ignored");
}

// ── Action log ───────────────────────────────────────────────────────────────
{
  const fake = makeFake();
  const store = new FirestoreActionLogStore(fake);
  assert.equal(store.kind, "durable", "must satisfy the deployment gate");
  assert.match(store.location, /^firestore:/);

  for (const [i, actor] of ["alice", "bob", "alice"].entries()) {
    await store.append({
      ts: `2026-09-22T00:0${i}:00.000Z`, actor,
      tool: "update_campaign_budget", customer_id: "2222222222", result: "ok",
    });
  }

  const tail = (await store.tail(2)).map((r) => JSON.parse(r));
  assert.equal(tail.length, 2);
  // Oldest-first, matching the local file sink — explain_changes renders in
  // that order and must not read differently depending on where it runs.
  assert.equal(tail[0].ts, "2026-09-22T00:01:00.000Z");
  assert.equal(tail[1].ts, "2026-09-22T00:02:00.000Z");
  assert.equal(tail[1].actor, "alice", "the actor must survive the round trip");

  assert.deepEqual(await store.tail(5), (await store.tail(5)), "tail is stable");
  assert.equal((await new FirestoreActionLogStore(makeFake()).tail(5)).length, 0,
    "an empty log is empty, not an error");
}

// ── Credentials ──────────────────────────────────────────────────────────────
{
  const fake = makeFake();
  const store = new FirestoreCredentialStore(fake);
  assert.equal(store.kind, "per-actor", "must satisfy the deployment gate");

  fake.data.set(`${COLLECTIONS.credentials}/sub-alice`, { refreshToken: "token-alice" });
  fake.data.set(`${COLLECTIONS.credentials}/sub-bob`, { refreshToken: "token-bob" });

  assert.equal(await store.refreshTokenFor("sub-alice"), "token-alice");
  assert.equal(await store.refreshTokenFor("sub-bob"), "token-bob",
    "each actor gets their own identity");

  // A missing credential must FAIL, never fall back to someone else's token.
  // An operator acting as another identity is the bug this store exists to end.
  await assert.rejects(
    () => store.refreshTokenFor("sub-unknown"),
    /No Google Ads credential stored for actor 'sub-unknown'/,
    "a missing credential must refuse, not fall back");

  fake.data.set(`${COLLECTIONS.credentials}/sub-empty`, { refreshToken: "" });
  await assert.rejects(() => store.refreshTokenFor("sub-empty"), /No Google Ads credential/,
    "an empty token is a missing token");
}

console.log("firestore-stores: PASS");
process.exit(0);
