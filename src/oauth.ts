import { createHmac, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Sealer } from "./seal.js";

/**
 * "Sign in with Google" for the connector. claude.ai (or Claude Code) registers itself, sends the
 * person to /authorize, this service hands them to Google, Google hands them back to
 * /oauth/google/callback, and only a verified account on ALLOWED_DOMAINS (and, when set, on
 * ALLOWED_EMAILS) gets a token. Nobody copies a bearer. The protocol endpoints themselves are the
 * MCP SDK's mcpAuthRouter; this file is the provider behind them.
 *
 * Ported from an earlier MCP server of mine, with one extension: the
 * same sign-in also asks for the Google Ads scope, offline. Google's answer then carries a refresh
 * token minted for the person signing in, and it is stored under their Google subject. Every Ads
 * call that person makes runs as them, so the account's change history and this server's action log
 * name the same human. Nobody pastes a refresh token anywhere, and no shared token exists to leak.
 */

export type OAuthSettings = {
  publicUrl: string; // https://…run.app, no trailing slash
  googleClientId: string;
  googleClientSecret: string;
  signingKey: string;
  allowedDomains: string[]; // lowercase; example.com and example.org during the move to example.org
  allowedEmails: string[]; // lowercase; empty means any verified account on the domain
  allowedRedirectUris: string[]; // exact matches; loopback is always allowed for the CLI
};

const TTL = {
  pending: 10 * 60, // the person is on Google's sign-in page
  code: 2 * 60,
  access: 60 * 60,
  refresh: 30 * 24 * 60 * 60,
  client: 10 * 365 * 24 * 60 * 60, // a registration does not need to expire; the redirect allowlist is the control
};

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";
export const ADWORDS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const GOOGLE_SCOPES = `openid email ${ADWORDS_SCOPE}`;

/** Where a signed-in person's Ads refresh token goes. FirestoreCredentialStore in production. */
export type CredentialSink = { save(sub: string, refreshToken: string, email: string): Promise<void> };

/** claude.ai's connector callback, on both of its domains. */
export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

/**
 * Only known clients may register. Without this, anyone could register a client whose redirect
 * points at their own server, send a workspace owner a sign-in link, and receive the resulting code. The
 * domain check would still pass, because the victim really is on the domain.
 * Loopback (any port) is allowed so Claude Code's local callback works.
 */
export function redirectUriAllowed(uri: string, allowed: string[]): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")) return true;
  return allowed.includes(uri);
}

/**
 * A refused sign-in. `code` is a fixed string and is all that reaches the logs; `message` can name
 * the person and goes only to them, in the redirect back to Claude. Logging the message would put
 * sign-in data in Cloud Logging, which is what CodeQL flagged on the first version (2026-09-24).
 */
export class SignInRefused extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export type GoogleClaims = { iss?: unknown; aud?: unknown; exp?: unknown; nonce?: unknown; email?: unknown; email_verified?: unknown; hd?: unknown; sub?: unknown };

/**
 * The checks on Google's ID token. The signature is not verified, deliberately: the token arrives in
 * the direct, TLS-authenticated response from Google's token endpoint to this server, and OpenID
 * Connect Core 1.0 §3.1.3.7 (item 6) allows TLS server validation in place of the signature check
 * in exactly that case. Every claim below is still checked.
 */
export function checkGoogleClaims(c: GoogleClaims, s: Pick<OAuthSettings, "googleClientId" | "allowedDomains" | "allowedEmails">, nonce: string): { email: string; sub: string } {
  if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") throw new SignInRefused("wrong_issuer", "id_token issuer is not Google");
  if (c.aud !== s.googleClientId) throw new SignInRefused("wrong_audience", "id_token was issued to another client");
  if (typeof c.exp !== "number" || c.exp < Math.floor(Date.now() / 1000)) throw new SignInRefused("expired", "id_token has expired");
  if (c.nonce !== nonce) throw new SignInRefused("nonce_mismatch", "id_token nonce does not match this sign-in");
  if (c.email_verified !== true) throw new SignInRefused("unverified_email", "Google has not verified this email address");
  if (typeof c.email !== "string" || typeof c.sub !== "string") throw new SignInRefused("no_email", "id_token carries no email");
  const email = c.email.toLowerCase();
  // hd is set only for Google Workspace accounts, which is what makes it the right test: a personal
  // Gmail account can never carry it, whatever address it has. hd and the address are checked
  // separately, not against each other: a user on a secondary domain of a Workspace (example.org added to
  // the example.com Workspace, say) can carry the primary domain as hd.
  if (typeof c.hd !== "string" || !s.allowedDomains.includes(c.hd.toLowerCase()) || !domainAllowed(email, s)) {
    throw new SignInRefused("wrong_domain", `only ${s.allowedDomains.join(" or ")} Google Workspace accounts can sign in`);
  }
  if (!emailAllowed(email, s)) throw new SignInRefused("not_allowlisted", `${email} is not on this service's allowlist`);
  return { email, sub: c.sub };
}

function domainAllowed(email: string, s: Pick<OAuthSettings, "allowedDomains">): boolean {
  const at = email.lastIndexOf("@");
  return at > 0 && s.allowedDomains.includes(email.slice(at + 1).toLowerCase());
}

export function emailAllowed(email: string, s: Pick<OAuthSettings, "allowedDomains" | "allowedEmails">): boolean {
  const e = email.toLowerCase();
  if (!domainAllowed(e, s)) return false;
  return s.allowedEmails.length === 0 || s.allowedEmails.includes(e);
}

export function decodeJwtPayload(jwt: string): GoogleClaims {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("malformed id_token");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as GoogleClaims;
}

/** Exchanges Google's code for tokens. Injected so the tests never call Google. */
export type GoogleTokens = { id_token?: string; refresh_token?: string; scope?: string };
export type GoogleExchange = (code: string, redirectUri: string) => Promise<GoogleTokens>;

export function googleExchange(s: OAuthSettings): GoogleExchange {
  return async (code, redirectUri) => {
    const r = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, redirect_uri: redirectUri, grant_type: "authorization_code",
        client_id: s.googleClientId, client_secret: s.googleClientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Google token exchange failed: HTTP ${r.status}`);
    return (await r.json()) as GoogleTokens;
  };
}

type Pending = { cid: string; ru: string; cc: string; st?: string; sc: string[]; rs?: string; nonce: string };
type Grant = { cid: string; email: string; sub: string; sc: string[]; rs?: string };

export class GoogleSignInProvider implements OAuthServerProvider {
  private readonly sealer: Sealer;
  /** Best-effort single use for codes on this instance; PKCE and the 2-minute TTL cover the rest. */
  private readonly usedCodes = new Map<string, number>();

  constructor(
    private readonly s: OAuthSettings,
    private readonly credentials: CredentialSink,
    private readonly exchange: GoogleExchange = googleExchange(s),
  ) {
    this.sealer = new Sealer(s.signingKey);
  }

  get resourceUrl(): URL { return new URL(`${this.s.publicUrl}/mcp`); }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => {
        const c = this.sealer.open<{ m: Omit<OAuthClientInformationFull, "client_id" | "client_secret"> }>("client", clientId);
        if (!c) return undefined;
        const info: OAuthClientInformationFull = { ...c.m, client_id: clientId };
        if (c.m.token_endpoint_auth_method !== "none") info.client_secret = this.clientSecret(clientId);
        return info;
      },
      registerClient: (client) => {
        const uris = (client.redirect_uris ?? []).map(String);
        if (uris.length === 0 || !uris.every((u) => redirectUriAllowed(u, this.s.allowedRedirectUris))) {
          throw new InvalidClientMetadataError("redirect_uri is not one this service accepts");
        }
        // Only what the flow needs is sealed into the id, which keeps it short enough for a URL.
        const m = {
          redirect_uris: uris,
          token_endpoint_auth_method: client.token_endpoint_auth_method ?? "client_secret_post",
          grant_types: client.grant_types,
          response_types: client.response_types,
          client_name: typeof client.client_name === "string" ? client.client_name.slice(0, 80) : undefined,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        const clientId = this.sealer.seal("client", { m, n: randomBytes(8).toString("hex") }, TTL.client);
        const out: OAuthClientInformationFull = { ...m, client_id: clientId };
        if (m.token_endpoint_auth_method !== "none") {
          out.client_secret = this.clientSecret(clientId);
          out.client_secret_expires_at = 0;
        }
        return out;
      },
    };
  }

  /** Derived, never stored: the same id always yields the same secret, on every instance. */
  private clientSecret(clientId: string): string {
    return createHmac("sha256", this.s.signingKey).update(`client-secret:${clientId}`).digest("base64url");
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const nonce = randomBytes(16).toString("base64url");
    const pending: Pending = {
      cid: client.client_id, ru: params.redirectUri, cc: params.codeChallenge, st: params.state,
      sc: params.scopes ?? [], rs: params.resource?.href, nonce,
    };
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.s.googleClientId,
      redirect_uri: `${this.s.publicUrl}${GOOGLE_CALLBACK_PATH}`,
      response_type: "code",
      scope: GOOGLE_SCOPES,
      // offline + consent: Google issues a refresh token only on a consent screen, and a returning
      // person would otherwise skip it and arrive with none. Asking every time is the price of never
      // keeping a stale token.
      access_type: "offline",
      // A hint for the account picker only; checkGoogleClaims is the enforcement. One domain can be
      // named; with several, "*" still narrows the picker to Workspace accounts.
      hd: this.s.allowedDomains.length === 1 ? this.s.allowedDomains[0] : "*",
      prompt: "consent select_account",
      nonce,
      state: this.sealer.seal("pending", pending, TTL.pending),
    }).toString();
    res.redirect(302, url.href);
  }

  /** GET /oauth/google/callback: Google sends the person back here. */
  async googleCallback(req: Request, res: Response): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    const p = this.sealer.open<Pending>("pending", String(req.query.state ?? ""));
    if (!p) {
      res.status(400).type("text/plain").send("This sign-in link has expired or is not valid. Start again from Claude.");
      return;
    }
    const back = new URL(p.ru);
    if (p.st !== undefined) back.searchParams.set("state", p.st);
    const fail = (code: string, description: string) => {
      console.error(JSON.stringify({ event: "oauth_denied", reason: code }));
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", description);
      res.redirect(302, back.href);
    };
    if (typeof req.query.error === "string" || typeof req.query.code !== "string") {
      fail("cancelled", "Google sign-in was cancelled or failed");
      return;
    }
    let who: { email: string; sub: string };
    try {
      const tokens = await this.exchange(req.query.code, `${this.s.publicUrl}${GOOGLE_CALLBACK_PATH}`);
      if (!tokens.id_token) throw new Error("Google returned no id_token");
      who = checkGoogleClaims(decodeJwtPayload(tokens.id_token), this.s, p.nonce);
      // Google's consent screen lets the person untick a scope. Signing in without Ads access would
      // leave them connected and failing on every call, so it is refused here instead, with a reason.
      // Exact token match on the space-separated list (a Set, not a substring test).
      const granted = new Set((tokens.scope ?? "").split(" ").filter(Boolean));
      if (!granted.has(ADWORDS_SCOPE)) throw new SignInRefused("no_ads_scope", "Google Ads access was not granted. Sign in again and leave the Google Ads box ticked.");
      if (!tokens.refresh_token) throw new SignInRefused("no_refresh_token", "Google returned no offline grant. Sign in again.");
      await this.credentials.save(who.sub, tokens.refresh_token, who.email);
    } catch (e) {
      if (e instanceof SignInRefused) fail(e.code, e.message);
      else fail("google_exchange_failed", "Google sign-in could not be completed");
      return;
    }
    const grant: Grant & { ru: string; cc: string } = { cid: p.cid, email: who.email, sub: who.sub, sc: p.sc, rs: p.rs, ru: p.ru, cc: p.cc };
    back.searchParams.set("code", this.sealer.seal("code", grant, TTL.code));
    console.log(JSON.stringify({ event: "oauth_signed_in" }));
    res.redirect(302, back.href);
  }

  private openCode(client: OAuthClientInformationFull, code: string) {
    const g = this.sealer.open<Grant & { ru: string; cc: string }>("code", code);
    if (!g || g.cid !== client.client_id) throw new InvalidGrantError("authorization code is invalid or expired");
    return g;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.openCode(client, code).cc;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const g = this.openCode(client, code);
    if (redirectUri !== undefined && redirectUri !== g.ru) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    const now = Math.floor(Date.now() / 1000);
    for (const [k, exp] of this.usedCodes) if (exp < now) this.usedCodes.delete(k);
    if (this.usedCodes.has(code)) throw new InvalidGrantError("authorization code has already been used");
    this.usedCodes.set(code, g.exp);
    return this.issue({ cid: g.cid, email: g.email, sub: g.sub, sc: g.sc, rs: g.rs });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const g = this.sealer.open<Grant>("refresh", refreshToken);
    if (!g || g.cid !== client.client_id) throw new InvalidGrantError("refresh token is invalid or expired");
    // Re-checked on every refresh, so taking someone off ALLOWED_EMAILS ends their session.
    if (!emailAllowed(g.email, this.s)) throw new InvalidGrantError("this account no longer has access");
    return this.issue({ cid: g.cid, email: g.email, sub: g.sub, sc: g.sc, rs: g.rs });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const g = this.sealer.open<Grant>("access", token);
    if (!g) throw new InvalidTokenError("access token is invalid or expired");
    if (!emailAllowed(g.email, this.s)) throw new InvalidTokenError("this account no longer has access");
    if (g.rs && g.rs !== this.resourceUrl.href) throw new InvalidTokenError("access token was issued for another resource");
    return {
      token, clientId: g.cid, scopes: g.sc, expiresAt: g.exp,
      resource: g.rs ? new URL(g.rs) : undefined,
      // sub is what actorFor() reads: the rate limit, the action log and the credential lookup all
      // key off it. email is for humans reading the log.
      extra: { email: g.email, sub: g.sub },
    };
  }

  private issue(g: Grant): OAuthTokens {
    return {
      access_token: this.sealer.seal("access", g, TTL.access),
      token_type: "bearer",
      expires_in: TTL.access,
      refresh_token: this.sealer.seal("refresh", g, TTL.refresh),
      scope: g.sc.join(" ") || undefined,
    };
  }
}

