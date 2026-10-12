/**
 * Acceptance test for phase 1 of the Cloud Run migration: the active account is
 * per-session, never shared.
 *
 * Why this exists: before this change `ACTIVE_CUSTOMER_ID` was a module global,
 * read at 25 sites. On stdio that is harmless — one process serves one client.
 * On a shared HTTP service it means one operator's `set_active_account` silently
 * retargets another operator's next write to a different client's account. That
 * is the failure this test exists to prevent from coming back.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";

// Dummy credentials: the module validates presence at import. No network call is
// made — this test never constructs a Google Ads client.
process.env.GOOGLE_ADS_CLIENT_ID ||= "test";
process.env.GOOGLE_ADS_CLIENT_SECRET ||= "test";
process.env.GOOGLE_ADS_REFRESH_TOKEN ||= "test";
process.env.GOOGLE_ADS_CUSTOMER_ID ||= "1111111111";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ||= "1234567890";

const { makeCtx, getSession, STDIO_SESSION_KEY } = await import("../dist/index.js");

// getSession is async since phase 4: it resolves the actor's credentials once.
const alice = makeCtx(await getSession("session-alice", "alice"));
const bob = makeCtx(await getSession("session-bob", "bob"));

// A new session starts at the configured default, not at whatever another
// session was last looking at.
assert.equal(alice.cid(), "1111111111", "new session should start at the default account");
assert.equal(bob.cid(), "1111111111", "new session should start at the default account");

alice.setActive("2222222222");
assert.equal(alice.cid(), "2222222222", "set_active_account should move the calling session");
assert.equal(bob.cid(), "1111111111", "one session's switch must NOT move another's");

bob.setActive("3333333333");
assert.equal(alice.cid(), "2222222222", "a later switch elsewhere must not disturb the first session");
assert.equal(bob.cid(), "3333333333");

// The same key must resolve to the same session — stdio depends on this, since
// every request there shares one key.
assert.equal(makeCtx(await getSession("session-alice", "alice")).cid(), "2222222222",
  "the same session key must resolve to the same session");
assert.equal(typeof STDIO_SESSION_KEY, "string");

// The session carries its actor, which is what stamps the log and keys the cap.
assert.equal(alice.actor(), "alice");
assert.equal(bob.actor(), "bob");

console.log("session-isolation: PASS");
process.exit(0);
