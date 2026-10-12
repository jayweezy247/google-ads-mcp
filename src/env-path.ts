import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Resolve the credentials file, in priority order:
 *
 *   1. $GOOGLE_ADS_MCP_ENV        — explicit override (used by tests / op run)
 *   2. ~/.config/google-ads-mcp/.env  — canonical location
 *   3. <package root>/.env        — legacy in-project location, kept as a fallback
 *                                   so an incomplete migration cannot break the server
 *
 * Returns the first path that exists. If none do, returns the canonical path so
 * error messages point at where the file is supposed to live.
 *
 * Note this is resolved from __dirname, not cwd: Claude Desktop launches the
 * server with cwd="/".
 */
export const CANONICAL_ENV_PATH = path.join(
  os.homedir(),
  ".config",
  "google-ads-mcp",
  ".env"
);

export const LEGACY_ENV_PATH = path.join(__dirname, "..", ".env");

export function resolveEnvPath(): string {
  const override = process.env.GOOGLE_ADS_MCP_ENV;
  const candidates = [
    ...(override ? [override] : []),
    CANONICAL_ENV_PATH,
    LEGACY_ENV_PATH,
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return CANONICAL_ENV_PATH;
}

/** Warn on stderr (never stdout — stdout is the MCP transport) if the legacy file is still present. */
export function warnIfLegacyEnvPresent(resolved: string): void {
  if (resolved !== LEGACY_ENV_PATH && fs.existsSync(LEGACY_ENV_PATH)) {
    console.error(
      `[google-ads-mcp] Note: credentials loaded from ${resolved}, but a stale ` +
        `copy still exists at ${LEGACY_ENV_PATH}. Delete it once you have verified this works.`
    );
  }
}
