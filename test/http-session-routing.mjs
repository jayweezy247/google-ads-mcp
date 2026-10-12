/**
 * Acceptance test for phase 5: the two seams that decide which session and which
 * identity a request belongs to.
 *
 * Scope, stated honestly: this covers the routing logic, not a live two-client
 * run against Google Ads. The scope doc's concurrency test — two real sessions
 * calling set_active_account on different CIDs — needs credentials and a
 * deployment, and stays phase 9. What is provable here is that the inputs the
 * HTTP transport supplies map to distinct sessions and actors, which is the
 * thing phase 1 could not exercise at all under stdio.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";

process.env.GOOGLE_ADS_CLIENT_ID ||= "test";
process.env.GOOGLE_ADS_CLIENT_SECRET ||= "test";
process.env.GOOGLE_ADS_REFRESH_TOKEN ||= "test";
process.env.GOOGLE_ADS_CUSTOMER_ID ||= "1111111111";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ||= "1234567890";

const { sessionKeyFor, actorFor, getSession, makeCtx, endSession, STDIO_SESSION_KEY } =
  await import("../dist/index.js");
const { LOCAL_ACTOR } = await import("../dist/write-safety.js");

// ── Session key ──────────────────────────────────────────────────────────────
assert.equal(sessionKeyFor({}), STDIO_SESSION_KEY,
  "no transport session id means stdio, where one key is correct");
assert.equal(sessionKeyFor({ sessionId: "abc" }), "abc");
assert.notEqual(sessionKeyFor({ sessionId: "abc" }), sessionKeyFor({ sessionId: "def" }));

// ── Actor ────────────────────────────────────────────────────────────────────
assert.equal(actorFor({}), LOCAL_ACTOR, "no auth info means the local operator");
assert.equal(actorFor({ authInfo: { clientId: "client-1" } }), "client-1");
// The Google subject wins over client id: it is stable across token rotation.
assert.equal(
  actorFor({ authInfo: { clientId: "client-1", extra: { sub: "google-sub-9" } } }),
  "google-sub-9",
  "a stable subject must win over the client id");
assert.equal(actorFor({ authInfo: { clientId: "c", extra: { sub: "" } } }), "c",
  "an empty subject must not become the actor");

// ── End to end through the seams ─────────────────────────────────────────────
// Two HTTP clients, as the transport would present them.
const aliceExtra = { sessionId: "sess-a", authInfo: { extra: { sub: "sub-alice" } } };
const skyExtra    = { sessionId: "sess-b", authInfo: { extra: { sub: "sub-bob" } } };

const alice = makeCtx(await getSession(sessionKeyFor(aliceExtra), actorFor(aliceExtra)));
const bob    = makeCtx(await getSession(sessionKeyFor(skyExtra), actorFor(skyExtra)));

assert.equal(alice.actor(), "sub-alice");
assert.equal(bob.actor(), "sub-bob");

alice.setActive("2222222222");
bob.setActive("3333333333");
assert.equal(alice.cid(), "2222222222");
assert.equal(bob.cid(), "3333333333", "two HTTP sessions must not share an active account");

// A repeat request on the same session id resumes the same session.
const aliceAgain = makeCtx(await getSession(sessionKeyFor(aliceExtra), actorFor(aliceExtra)));
assert.equal(aliceAgain.cid(), "2222222222", "the same session id must resume the same session");

// ── Session cleanup ──────────────────────────────────────────────────────────
// A closed transport releases its session; otherwise the map leaks on a
// long-lived service, and a reused id would inherit stale state.
endSession("sess-a");
const aliceFresh = makeCtx(await getSession("sess-a", "sub-alice"));
assert.equal(aliceFresh.cid(), "1111111111",
  "a new session under a reused id must start at the default, not inherit");
assert.equal(bob.cid(), "3333333333", "ending one session must not disturb another");

console.log("http-session-routing: PASS");
process.exit(0);
