# Google Ads MCP — Cloud Run image (plan phase 6).
#
# Two stages so the runtime image carries no compiler, no dev dependencies and
# no TypeScript source. Nothing secret is baked in: every credential arrives at
# runtime from Secret Manager, which is why there is no .env here and why
# .dockerignore excludes it rather than relying on nobody having created one.

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve the tree.
# `npm ci` requires the lockfile to match package.json — a drift fails the
# build here rather than producing an image nobody can reproduce.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Tests run in CI, not here: a failing test should fail a pull request, not
# produce a mysteriously broken image later.

# Re-resolve with production dependencies only, for copying into the runtime.
RUN npm ci --omit=dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# HTTP is multi-client, so the server defaults to shared mode on its own. Set
# explicitly anyway: a reader of this file should not have to know the default
# to know what the container enforces. With this set, the server refuses to
# start unless the rate-limit store, the audit log and the credential store are
# all deployment-grade.
ENV DEPLOYMENT_MODE=shared

# Cloud Run injects PORT and the server reads it; 8080 is the documented default
# and only applies if something runs this image outside Cloud Run.
ENV PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The node image ships an unprivileged `node` user. Nothing here writes to disk
# in shared mode — the audit log goes to Firestore — so the filesystem stays
# read-only as far as this process is concerned.
USER node

EXPOSE 8080
CMD ["node", "dist/http.js"]
