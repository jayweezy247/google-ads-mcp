import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Sealed tokens: everything the OAuth flow hands out (client ids, sign-in state, authorization
 * codes, access and refresh tokens) is a JSON payload encrypted and authenticated with AES-256-GCM
 * under a key derived from OAUTH_SIGNING_KEY. The service keeps no token store, so any Cloud Run
 * instance can read what any other instance issued, and scaling to zero loses nothing.
 *
 * The kind ("code", "access", ...) is bound in as associated data, so a token of one kind never
 * opens as another: an authorization code cannot be presented as an access token.
 *
 * What stateless costs: a sealed token cannot be revoked individually before it expires. The
 * controls are short access-token lifetimes, the ALLOWED_EMAILS check on every use, and rotating
 * OAUTH_SIGNING_KEY, which invalidates everything at once. See README "Sign in with Google".
 */

export type SealKind = "client" | "pending" | "code" | "access" | "refresh";

const VERSION = "v1";

export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("OAUTH_SIGNING_KEY must be at least 32 characters");
    this.key = Buffer.from(hkdfSync("sha256", secret, "google-ads-mcp", "oauth-seal-v1", 32));
  }

  seal(kind: SealKind, payload: Record<string, unknown>, ttlSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`${VERSION}:${kind}`));
    const body = Buffer.concat([cipher.update(JSON.stringify({ ...payload, exp }), "utf8"), cipher.final()]);
    return `${VERSION}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
  }

  /** The payload, or null for anything forged, tampered, of another kind, or expired. */
  open<T extends Record<string, unknown>>(kind: SealKind, token: string): (T & { exp: number }) | null {
    if (typeof token !== "string" || !token.startsWith(`${VERSION}.`) || token.length > 8192) return null;
    const raw = Buffer.from(token.slice(VERSION.length + 1), "base64url");
    if (raw.length < 12 + 16 + 1) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`${VERSION}:${kind}`));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
      const payload = JSON.parse(text) as T & { exp: number };
      if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }
}
