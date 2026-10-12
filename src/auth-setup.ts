#!/usr/bin/env node
/**
 * OAuth setup / token re-mint.
 * Run from the package root:  npm run auth
 *
 * Uses the loopback redirect flow. The old out-of-band flow
 * (urn:ietf:wg:oauth:2.0:oob) was deprecated by Google in 2022 and is now
 * rejected outright — do not reintroduce it.
 *
 * PREREQUISITE — one-time, in Google Cloud Console:
 *   APIs & Services -> Credentials -> your OAuth 2.0 Client ID
 *   -> Authorised redirect URIs -> add:  http://localhost:8085/oauth2callback
 *   The client must be of type "Web application" for redirect URIs to be listed.
 *
 * On success the new refresh token is written straight into .env (chmod 600).
 * It is never printed to the terminal — terminal scrollback and shell history
 * are exactly where credentials should not end up.
 */

import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import * as dotenv from "dotenv";
import { resolveEnvPath } from "./env-path";

// Same resolution as the server, so a re-auth writes the refreshed token back to
// the file the server actually reads.
const ENV_PATH = resolveEnvPath();
dotenv.config({ path: ENV_PATH });

const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`❌ Missing GOOGLE_ADS_CLIENT_ID or GOOGLE_ADS_CLIENT_SECRET in ${ENV_PATH}`);
  process.exit(1);
}

const PORT = 8085;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = "https://www.googleapis.com/auth/adwords";
const STATE = crypto.randomBytes(16).toString("hex");

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent` +
  `&state=${STATE}`;

function writeRefreshToken(token: string) {
  let body = fs.readFileSync(ENV_PATH, "utf8");
  const line = `GOOGLE_ADS_REFRESH_TOKEN=${token}`;
  body = /^GOOGLE_ADS_REFRESH_TOKEN=.*$/m.test(body)
    ? body.replace(/^GOOGLE_ADS_REFRESH_TOKEN=.*$/m, line)
    : body.replace(/\n*$/, "\n") + line + "\n";
  fs.writeFileSync(ENV_PATH, body, { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
}

function exchange(code: string): Promise<any> {
  const postData = new URLSearchParams({
    code,
    client_id: CLIENT_ID!,
    client_secret: CLIENT_SECRET!,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch { reject(new Error(body)); }
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/oauth2callback") { res.writeHead(404).end(); return; }

  const err = url.searchParams.get("error");
  if (err) {
    res.writeHead(200, { "Content-Type": "text/html" })
       .end(`<h2>Authorisation failed</h2><p>${err}</p>`);
    console.error(`\n❌ Authorisation failed: ${err}`);
    server.close(); process.exit(1);
  }

  if (url.searchParams.get("state") !== STATE) {
    res.writeHead(400, { "Content-Type": "text/html" })
       .end("<h2>State mismatch — request rejected.</h2>");
    console.error("\n❌ State mismatch. Possible CSRF. Aborting.");
    server.close(); process.exit(1);
  }

  const code = url.searchParams.get("code");
  if (!code) { res.writeHead(400).end("Missing code"); return; }

  const json = await exchange(code);

  if (json.refresh_token) {
    writeRefreshToken(json.refresh_token);
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<h2>✅ Done.</h2><p>New refresh token written to .env. You can close this tab.</p>"
    );
    console.log("\n✅ New refresh token written to .env (chmod 600). Not printed here by design.");
    console.log("\nNext:");
    console.log("  1. Restart Claude Desktop so the MCP server picks up the new token.");
    console.log("  2. Verify with a list_accounts call.");
    console.log("\n⚠️  Do NOT revoke app access on https://myaccount.google.com/connections now.");
    console.log("    Revoking removes the grant for this OAuth client entirely, which would");
    console.log("    invalidate the token just issued. Revoke FIRST, mint SECOND — never the");
    console.log("    other way round. prompt=consent already forces a fresh refresh token on");
    console.log("    every run, so re-minting alone does not require a revoke.");
  } else {
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<h2>❌ No refresh token returned.</h2><p>Check the terminal.</p>"
    );
    console.error("\n❌ No refresh token in response:");
    console.error(JSON.stringify(json, null, 2));
    console.error(
      "\nIf error is redirect_uri_mismatch: add exactly\n" +
      `  ${REDIRECT_URI}\n` +
      "to the OAuth client's Authorised redirect URIs in Google Cloud Console.\n" +
      "If no refresh_token but no error: Google only returns one on first consent —\n" +
      "revoke at https://myaccount.google.com/permissions and run this again."
    );
  }
  server.close();
});

server.listen(PORT, () => {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  Google Ads MCP — OAuth setup / token re-mint");
  console.log("══════════════════════════════════════════════════════════\n");
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log("\nOpening your browser. If it does not open, visit:\n");
  console.log(authUrl + "\n");
  try { execSync(`open ${JSON.stringify(authUrl)}`); } catch { /* user opens manually */ }
});
