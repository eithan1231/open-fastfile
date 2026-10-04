# syntax=docker/dockerfile:1

# @3d/game-server — the games the api gives it. Many of these.
#
#   docker build -f packages/game-server/Dockerfile -t 3d-designer-game-server .
#
# Built from the repo root, like the api's: the lockfile is up there.
#
# This one holds nothing that outlives a game and reads nothing off disk, so it
# carries no volume: an instance is an image, an API_URL and a SERVICE_TOKEN.
# It is not tied to a map either — it fetches whatever world an order names.

ARG NODE_VERSION=24-bookworm-slim

# ---------------------------------------------------------------------------
# Everything that compiles, on the runner's own platform: the output is
# JavaScript and is the same bytes whatever produced it, so an amd64 image built
# on an arm64 runner pays no emulation for this stage.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/api/package.json packages/api/
COPY packages/game-server/package.json packages/game-server/
# --ignore-scripts: this stage compiles and runs nothing, and node-datachannel's
# install script would fetch a binary for the wrong platform to throw away.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/game-server packages/game-server
RUN pnpm --filter @3d/shared --filter @3d/game-server build

# ---------------------------------------------------------------------------
# Runtime dependencies, on the target platform: node-datachannel is geckos'
# WebRTC transport and is native.
#
# Its install script is `prebuild-install -r napi`, which fetches the binary for
# the platform it is installing for — so this stage has to be the target's, and
# an emulated install is a download rather than a build. Scripts are therefore
# *not* ignored here, unlike the api's deps stage: this one binary is not in the
# npm tarball and has to be fetched from the project's GitHub releases.
#
# cmake is deliberately absent. The documented fallback is a libdatachannel
# source build, which under QEMU is tens of minutes of C++ pretending to be
# progress — and which fails on its own terms anyway (`prebuild WARN This
# package does not support N-API version undefined`). A build that stops on a
# missing or unreachable prebuild says something true; one that starts compiling
# does not.
#
# --filter-prod rather than --filter: @3d/api is a *dev* dependency here (the
# integration tests stand both ends up), and the plain filter follows that edge,
# which is how this image ends up carrying SQLite and the api's routes.
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
    pnpm install --frozen-lockfile --prod --filter-prod @3d/game-server...

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}

ENV NODE_ENV=production

WORKDIR /app

COPY --from=deps /app /app
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/game-server/dist packages/game-server/dist

# Signalling and /healthz on 9300; the data channel on one UDP port, which is
# the one to forward. It has to be one port and not a range — geckos multiplexes
# every connection onto a single socket and picks from the range at random, so a
# range and a forwarded port agree by luck. Two instances on a host need
# different ones, and sharing fails as a silent ICE timeout.
EXPOSE 9300/tcp
EXPOSE 20000/udp

# The start period is generous because booting is: this process waits for the
# api with backoff, then loads the catalogue's bodies and rigs before it listens
# at all (docs/server/README.md, "Booting a game server").
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.GAME_PORT||9300)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

WORKDIR /app/packages/game-server

# --conditions=dist is what points @3d/shared's exports at its compiled output
# instead of its TypeScript sources; see docs/server/README.md.
CMD ["node", "--conditions=dist", "dist/index.js"]
