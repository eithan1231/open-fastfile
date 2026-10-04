# syntax=docker/dockerfile:1

# @3d/api — the HTTP authority, and the one process that serves the client.
#
#   docker build -f packages/api/Dockerfile -t 3d-designer-api .
#
# Built from the repo root: this is a pnpm workspace, and the lockfile and the
# four manifests it resolves against all live above this file.
#
# The image carries no worlds and no database. Both are mounted over — which is
# what lets a map be re-exported, or a fresh one added, without rebuilding the
# api (packages/api/src/config.ts says the same thing from the other side).

ARG NODE_VERSION=24-bookworm-slim

# ---------------------------------------------------------------------------
# Everything that compiles. Pinned to BUILDPLATFORM because the output is
# JavaScript and is the same bytes whatever produced it: on an arm64 runner
# building an amd64 image, this is the difference between a native tsc and vite
# and a pair of emulated ones.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# Manifests first, so the install layer is cached until a dependency changes.
# All four, because --frozen-lockfile checks the lockfile against every project
# in the workspace and not just the ones being built.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/api/package.json packages/api/
COPY packages/game-server/package.json packages/game-server/
# --ignore-scripts: nothing here is run, only compiled, and better-sqlite3's
# node-gyp pass would need a C++ toolchain to produce a binary this stage throws
# away. The runtime one below installs it for real.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/api packages/api
COPY packages/client packages/client
# Topological order is pnpm's: @3d/shared first, because the other two import it.
RUN pnpm --filter @3d/shared --filter @3d/api build \
    && pnpm --filter @3d/client build

# ---------------------------------------------------------------------------
# Runtime dependencies, on the target platform, because better-sqlite3 is native.
#
# Two flags carry the whole stage:
#
#   --filter-prod, not --filter, because @3d/api is a *dev* dependency of
#   @3d/game-server and the plain filter follows that edge — which is how a game
#   server ends up carrying SQLite. Here it prunes the client and the game
#   server's own tree, leaving what this process actually loads.
#
#   --ignore-scripts, because better-sqlite3 13 is N-API and ships a prebuilt
#   binary for every platform it supports inside its own tarball: lib/binding.js
#   finds prebuilds/linux-x64.node on its own. Without the flag pnpm runs a
#   node-gyp pass that discovers the same prebuild and stops, having cost the
#   image python3, make and g++ to reach that conclusion — under emulation, at
#   emulated speed.
FROM node:${NODE_VERSION} AS deps

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/api/package.json packages/api/
COPY packages/game-server/package.json packages/game-server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter-prod @3d/api...

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}

ENV NODE_ENV=production

# The worlds volume, the database, and the bundle this process serves at /.
# Absolute, all three: Config resolves a relative one against the repo root,
# and an absolute one is simply itself.
ENV WORLDS_ROOT=/worlds
ENV DB_PATH=/data/server.sqlite
ENV CLIENT_DIST=/app/packages/client/dist
ENV API_PORT=9208

WORKDIR /app

# The workspace layout is kept rather than flattened, and dist/ mirrors src/, so
# `import.meta.dirname` lands where the source says it does: the repo root three
# levels above config.js, the migrations folder two above db/database.js.
COPY --from=deps /app /app
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api/dist packages/api/dist
# Migrations are applied on open, from files read relative to this package
# (src/db/database.ts), rather than as a deploy step of their own.
COPY packages/api/drizzle packages/api/drizzle
COPY --from=build /app/packages/client/dist packages/client/dist

EXPOSE 9208

# /api/health answers once the routes are mounted and worlds/ has been read, so
# this is the same question an operator asks. node rather than curl, because the
# image has node and does not have curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||9208)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

WORKDIR /app/packages/api

# --conditions=dist is what points @3d/shared's exports at its compiled output
# instead of its TypeScript sources; see docs/server/README.md. node directly
# rather than `pnpm start`, so that SIGTERM reaches the process that handles it
# and the shutdown in src/index.ts actually runs.
CMD ["node", "--conditions=dist", "dist/index.js"]
