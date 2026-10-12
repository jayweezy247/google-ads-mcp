/**
 * Sign in with Google, end to end, against the real Express app with Google
 * and Firestore faked. What it proves:
 *
 *  - An unauthenticated /mcp call gets the 401 that makes claude.ai start sign-in.
 *  - Sign-in asks Google for the Ads scope, offline, with a consent screen.
 *  - The refresh token Google returns is stored under the person's Google sub,
 *    and nothing is stored when the Ads scope or the offline grant is missing.
 *  - The access token carries that sub, which is what actorFor() reads.
 *  - Two people hold live sessions at once (the SDK binds one Server to one
 *    transport; a shared Server gave the second operator a 500).
 *  - A session id presented by a different signed-in person is refused.
 *  - A shared deployment without sign-in settings names every missing value.
 *
 * No network: Google's token exchange and the credential store are injected.
 * Run: npm test
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

process.env.GOOGLE_ADS_CLIENT_ID ||= "test";
process.env.GOOGLE_ADS_CLIENT_SECRET ||= "test";
process.env.GOOGLE_ADS_CUSTOMER_ID ||= "1111111111";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ||= "1234567890";
delete process.env.GOOGLE_ADS_REFRESH_TOKEN; // the HTTP path must not need one

const { GoogleSignInProvider, ADWORDS_SCOPE, DEFAULT_REDIRECT_URIS } = await import("../dist/oauth.js");
const { createApp, oauthSettingsFromEnv } = await import("../dist/http.js");
const { configureCredentials } = await import("../dist/write-safety.js");

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const settings = {
  publicUrl: "https://example.run.app", googleClientId: "gid.apps.googleusercontent.com", googleClientSecret: "gsecret",
  signingKey: "k".repeat(40), allowedDomains: ["example.com", "example.org"], allowedEmails: [],
  allowedRedirectUris: DEFAULT_REDIRECT_URIS,
};
const now = () => Math.floor(Date.now() / 1000);
const idToken = (c) => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b(c)}.sig`;
};
const claims = (nonce, who) => ({
  iss: "https://accounts.google.com", aud: settings.googleClientId, exp: now() + 300, nonce,
  email: `${who}@example.com`, email_verified: true, hd: "example.com", sub: `sub-${who}`,
});

// Fakes: a credential store that also serves reads, so a signed-in session resolves.
const saved = new Map();
const store = {
  kind: "per-actor",
  async save(sub, refreshToken, email) { saved.set(sub, { refreshToken, email }); },
  async refreshTokenFor(actor) {
    const c = saved.get(actor);
    if (!c) throw new Error(`No Google Ads credential stored for actor '${actor}'`);
    return c.refreshToken;
  },
};
configureCredentials(store);

let who = "alice";
let googleReply = (nonce) => ({ id_token: idToken(claims(nonce, who)), refresh_token: `rt-${who}`, scope: `openid email ${ADWORDS_SCOPE}` });
let lastNonce = "";
const provider = new GoogleSignInProvider(settings, store, async (code, redirectUri) => {
  assert.equal(code, "google-code");
  assert.equal(redirectUri, "https://example.run.app/oauth/google/callback");
  return googleReply(lastNonce);
});

const { app, closeAll } = createApp({ provider });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const get = (path) => fetch(base + path, { redirect: "manual" });
const form = (path, body) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body),
});
const mcp = (auth, sessionId, body) => fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  },
  body: JSON.stringify(body ?? {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  }),
});

try {
  // ── Unauthenticated ────────────────────────────────────────────────────────
  assert.equal((await get("/health")).status, 200, "/health needs no sign-in");
  const anon = await mcp();
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate") ?? "",
    /resource_metadata="https:\/\/example\.run\.app\/\.well-known\/oauth-protected-resource\/mcp"/,
    "the 401 must point claude.ai at the sign-in");

  const client = await (await fetch(`${base}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE], client_name: "Claude", token_endpoint_auth_method: "client_secret_post" }),
  })).json();
  assert.ok(client.client_id);

  /** One full sign-in as `who`; returns claude.ai's callback URL. */
  async function signIn() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authz = await get(`/authorize?${new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: CLAUDE, code_challenge: challenge,
      code_challenge_method: "S256", state: "st", resource: "https://example.run.app/mcp",
    })}`);
    assert.equal(authz.status, 302);
    const google = new URL(authz.headers.get("location") ?? "");
    lastNonce = google.searchParams.get("nonce") ?? "";
    const cb = await get(`/oauth/google/callback?${new URLSearchParams({ code: "google-code", state: google.searchParams.get("state") ?? "" })}`);
    assert.equal(cb.status, 302);
    return { google, back: new URL(cb.headers.get("location") ?? ""), verifier };
  }

  async function tokenFor(back, verifier) {
    const r = await form("/token", {
      grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", code_verifier: verifier,
      redirect_uri: CLAUDE, client_id: client.client_id, client_secret: client.client_secret,
    });
    assert.equal(r.status, 200);
    return (await r.json()).access_token;
  }

  // ── Alice signs in ────────────────────────────────────────────────────────
  const j = await signIn();
  assert.equal(j.google.searchParams.get("scope"), `openid email ${ADWORDS_SCOPE}`, "sign-in must ask for Google Ads");
  assert.equal(j.google.searchParams.get("access_type"), "offline", "without offline Google returns no refresh token");
  assert.match(j.google.searchParams.get("prompt") ?? "", /consent/, "a returning user must still get a refresh token");
  assert.ok(j.back.searchParams.get("code"), "a good sign-in returns a code to claude.ai");
  assert.deepEqual(saved.get("sub-alice"), { refreshToken: "rt-alice", email: "alice@example.com" },
    "the Ads refresh token is stored under the Google sub");
  const aliceToken = await tokenFor(j.back, j.verifier);

  const auth = await provider.verifyAccessToken(aliceToken);
  assert.equal(auth.extra.sub, "sub-alice", "actorFor() reads extra.sub; it must be there");

  const init = await mcp(aliceToken);
  assert.equal(init.status, 200, "a signed-in person can open a session");
  const aliceSession = init.headers.get("mcp-session-id");
  assert.ok(aliceSession);

  // ── Bob signs in, then tries Alice's session id ───────────────────────────
  who = "bob";
  const s = await signIn();
  const skyToken = await tokenFor(s.back, s.verifier);
  assert.equal(saved.get("sub-bob").refreshToken, "rt-bob");
  assert.equal(saved.get("sub-alice").refreshToken, "rt-alice", "one person's sign-in never overwrites another's token");
  const skyInit = await mcp(skyToken);
  assert.equal(skyInit.status, 200, "a second operator must get a session while the first is live");
  const skySession = skyInit.headers.get("mcp-session-id");
  assert.notEqual(skySession, aliceSession);
  const list = { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} };
  for (const [tok, sid] of [[aliceToken, aliceSession], [skyToken, skySession]]) {
    await mcp(tok, sid, { jsonrpc: "2.0", method: "notifications/initialized" });
    const r = await mcp(tok, sid, list);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /set_active_account/, "both sessions serve tools");
  }
  const hijack = await mcp(skyToken, aliceSession, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(hijack.status, 403, "a session id is not a credential");

  // ── Refusals store nothing ────────────────────────────────────────────────
  who = "noscope";
  googleReply = (nonce) => ({ id_token: idToken(claims(nonce, who)), refresh_token: "rt-x", scope: "openid email" });
  const noScope = await signIn();
  assert.equal(noScope.back.searchParams.get("error"), "access_denied");
  assert.match(noScope.back.searchParams.get("error_description") ?? "", /Google Ads access was not granted/);
  assert.equal(saved.has("sub-noscope"), false, "unticking the Ads box must not store a token");

  who = "nooffline";
  googleReply = (nonce) => ({ id_token: idToken(claims(nonce, who)), scope: `openid email ${ADWORDS_SCOPE}` });
  const noRt = await signIn();
  assert.equal(noRt.back.searchParams.get("error"), "access_denied");
  assert.equal(saved.has("sub-nooffline"), false);

  // ── Shared deployment without sign-in settings ─────────────────────────────
  assert.throws(() => oauthSettingsFromEnv({}),
    (e) => ["PUBLIC_URL", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "OAUTH_SIGNING_KEY"].every((n) => e.message.includes(n)),
    "every missing value is named, not just the first");
  const ok = oauthSettingsFromEnv({
    PUBLIC_URL: "https://x.run.app/", GOOGLE_ADS_CLIENT_ID: "a", GOOGLE_ADS_CLIENT_SECRET: "b", OAUTH_SIGNING_KEY: "k".repeat(32),
  });
  assert.equal(ok.publicUrl, "https://x.run.app", "trailing slash trimmed");
  assert.deepEqual(ok.allowedDomains, ["example.com", "example.org"]);

  console.log("oauth-signin: all assertions passed");
} finally {
  closeAll();
  server.close();
}
