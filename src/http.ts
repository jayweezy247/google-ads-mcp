/**
 * Streamable HTTP entry point (plan phase 5), behind "Sign in with Google".
 *
 * Why this is a second entry rather than a flag inside index.ts: stdio stays the
 * local fallback and the way to test without deploying, and keeping the two
 * apart means a laptop run cannot accidentally boot a listener.
 *
 * Express, which the first version avoided: the MCP SDK's OAuth router and
 * bearer middleware are Express handlers, and re-implementing /authorize,
 * /token, /register and both .well-known documents to save a dependency the
 * SDK already pulls in would be the worse trade. The auth is ported from
 * an earlier MCP server of mine, which runs it in production.
 *
 * Run: node dist/http.js  (DEPLOYMENT_MODE=local for a laptop, no sign-in)
 */
import express from "express";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createMcpServer, endSession } from "./index.js";
import {
  assertDeploymentIsSound, configureRateLimiting, configureActionLog,
  configureCredentials, DeploymentMode,
} from "./write-safety";
import {
  FirestoreRateLimitStore, FirestoreActionLogStore, FirestoreCredentialStore,
  defaultFirestore,
} from "./firestore-stores.js";
import {
  GoogleSignInProvider, GOOGLE_CALLBACK_PATH, DEFAULT_REDIRECT_URIS,
  type OAuthSettings, type CredentialSink,
} from "./oauth.js";

const PORT = Number(process.env.PORT || 8080);
const MCP_PATH = "/mcp";

/**
 * HTTP is multi-client by construction, so this entry defaults to `shared` —
 * the mode under which assertDeploymentIsSound() actually enforces anything.
 *
 * This default is the point. Phase 3 built the gate, but nothing set the mode,
 * so a deployed container would have started in `local`, passed the gate
 * trivially, and run with a process-local rate window and an ephemeral audit
 * log — exactly the state the gate exists to prevent, and silently.
 *
 * DEPLOYMENT_MODE=local is the escape hatch for running this entry on a laptop
 * against local implementations. It warns, because on a real deployment it
 * would be a disabled safety control.
 */
function deploymentMode(): DeploymentMode {
  if (process.env.DEPLOYMENT_MODE === "local") {
    console.error(
      "[google-ads-mcp] WARNING: DEPLOYMENT_MODE=local on the HTTP entry. " +
      "Write caps are process-local and the audit log is a local file. " +
      "Never set this on a deployed instance."
    );
    return "local";
  }
  return "shared";
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * Sign-in settings from the environment. The Google client is the Ads OAuth
 * client itself (GOOGLE_ADS_CLIENT_ID/SECRET), not a second one: a refresh
 * token only works with the client that minted it, so signing in through any
 * other client would yield a token the Ads API refuses.
 *
 * Throws naming every missing value. A shared deployment without sign-in would
 * have no way to tell operators apart, so it must not start.
 */
export function oauthSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthSettings {
  const s: OAuthSettings = {
    publicUrl: (env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
    googleClientId: env.GOOGLE_ADS_CLIENT_ID ?? "",
    googleClientSecret: env.GOOGLE_ADS_CLIENT_SECRET ?? "",
    signingKey: env.OAUTH_SIGNING_KEY ?? "",
    allowedDomains: list(env.ALLOWED_DOMAINS ?? "example.com,example.org").map((d) => d.toLowerCase()),
    allowedEmails: list(env.ALLOWED_EMAILS).map((e) => e.toLowerCase()),
    allowedRedirectUris: env.ALLOWED_REDIRECT_URIS ? list(env.ALLOWED_REDIRECT_URIS) : DEFAULT_REDIRECT_URIS,
  };
  const faults: string[] = [];
  if (!/^https:\/\//.test(s.publicUrl)) faults.push("PUBLIC_URL must be the service's https:// URL");
  if (!s.googleClientId) faults.push("GOOGLE_ADS_CLIENT_ID is unset");
  if (!s.googleClientSecret) faults.push("GOOGLE_ADS_CLIENT_SECRET is unset");
  if (s.signingKey.length < 32) faults.push("OAUTH_SIGNING_KEY must be at least 32 characters");
  if (s.allowedDomains.length === 0) faults.push("ALLOWED_DOMAINS is empty");
  if (faults.length) throw new Error(`Sign-in is not configured: ${faults.join("; ")}.`);
  return s;
}

type Live = { transport: StreamableHTTPServerTransport; sub?: string };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function subOf(req: Request): string | undefined {
  const sub = (req as Request & { auth?: { extra?: Record<string, unknown> } }).auth?.extra?.sub;
  return typeof sub === "string" && sub ? sub : undefined;
}

export type AppOptions = {
  /** Present in shared mode. Absent only for DEPLOYMENT_MODE=local on a laptop. */
  provider?: GoogleSignInProvider;
};

export function createApp(o: AppOptions = {}) {
  /** One transport per client session, so the SDK can route responses correctly. */
  const transports = new Map<string, Live>();
  const app = express();
  app.disable("x-powered-by");
  // Cloud Run puts one proxy in front; the SDK's rate limiters on /token and
  // /register key on the client address and refuse an untrusted X-Forwarded-For.
  app.set("trust proxy", 1);

  // Cloud Run's health check must not require a session or a credential.
  app.get("/health", (_req, res) => { res.json({ ok: true, sessions: transports.size }); });

  let guard: RequestHandler = (_req, _res, next) => next();
  if (o.provider) {
    const provider = o.provider;
    // /authorize, /token, /register and both .well-known documents, from the MCP SDK.
    app.use(mcpAuthRouter({
      provider,
      issuerUrl: new URL(provider.resourceUrl.origin),
      resourceServerUrl: provider.resourceUrl,
      resourceName: "Google Ads MCP",
    }));
    app.get(GOOGLE_CALLBACK_PATH, (req, res) => {
      provider.googleCallback(req, res).catch(() => {
        // A fixed event, no message: the error came out of a sign-in and could carry its data.
        console.error(JSON.stringify({ event: "oauth_error" }));
        if (!res.headersSent) res.status(500).type("text/plain").send("Sign-in failed. Start again from Claude.");
      });
    });
    // A request without a valid token gets the SDK's 401, whose WWW-Authenticate
    // header points at the resource metadata; that pointer is what makes
    // claude.ai start the sign-in instead of asking for a header.
    guard = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(provider.resourceUrl),
    });
  }

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header("mcp-session-id");
    const existing = sessionId ? transports.get(sessionId) : undefined;
    const sub = subOf(req);

    if (existing) {
      // A session id is not a credential. It rides in a header and shows up in
      // logs, so a second signed-in person presenting it must not inherit the
      // first person's session, active account and refresh token.
      if (existing.sub !== sub) {
        res.status(403).json({ error: "This session belongs to another signed-in user" });
        return;
      }
      await existing.transport.handleRequest(req, res, await readBody(req));
      return;
    }

    if (req.method !== "POST") {
      // A GET or DELETE naming a session we do not have is not recoverable by
      // creating one — say so rather than silently starting a new session.
      res.status(404).json({ error: "Unknown or expired session" });
      return;
    }

    // A POST with no session id is an initialize request: stand up a transport.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => { transports.set(id, { transport, sub }); },
    });

    // Sessions are per-client state on a long-lived process, so they must be
    // released when the client goes away or the map is a slow leak.
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        transports.delete(id);
        endSession(id);
      }
    };

    await createMcpServer().connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
  };

  app.all("/mcp", guard, (req: Request, res: Response, _next: NextFunction) => {
    handleMcp(req, res).catch((err) => {
      console.error("[google-ads-mcp] request failed:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  });

  app.use((_req, res) => { res.status(404).json({ error: "Not found" }); });

  const closeAll = () => { for (const l of transports.values()) void l.transport.close(); };
  return { app, closeAll };
}

async function main(): Promise<void> {
  // Every shared-state control must be sound before this process accepts a
  // single request. In shared mode this throws unless the rate-limit store, the
  // action log and the credential store are all deployment-grade.
  const mode = deploymentMode();
  let provider: GoogleSignInProvider | undefined;
  if (mode === "shared") {
    // One client for all three stores. Constructed only in shared mode, so a
    // local run needs no GCP credentials and no project.
    const db = defaultFirestore();
    const credentials = new FirestoreCredentialStore(db);
    configureRateLimiting({ mode, store: new FirestoreRateLimitStore(db) });
    configureActionLog(new FirestoreActionLogStore(db));
    configureCredentials(credentials);
    // Sign-in is what gives each request an actor. Without it every request
    // would resolve to "local", which has no stored credential, so the service
    // would be up and useless; refusing to start says why.
    provider = new GoogleSignInProvider(oauthSettingsFromEnv(), credentials satisfies CredentialSink);
  } else {
    configureRateLimiting({ mode });
  }

  // Still asserted, not assumed. The wiring above is what should satisfy it;
  // the gate is what proves it did, and what catches the next person who adds
  // a fourth piece of shared state and forgets to wire it.
  assertDeploymentIsSound();

  const { app, closeAll } = createApp({ provider });
  const http = app.listen(PORT, () => {
    console.error(`Google Ads MCP server listening on :${PORT}${MCP_PATH} (sign-in ${provider ? "on" : "off"})`);
  });

  // Cloud Run sends SIGTERM before reclaiming an instance. Close transports so
  // queued audit-log writes flush rather than dying with the container.
  const shutdown = () => {
    http.close();
    closeAll();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Tests import createApp; only a direct run starts a listener.
const isEntry = process.argv[1] && /http\.(js|ts)$/.test(process.argv[1]);
if (isEntry) {
  main().catch((err) => {
    console.error("Fatal error:", err?.message ?? err);
    process.exit(1);
  });
}
