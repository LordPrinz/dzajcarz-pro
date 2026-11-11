# The bot and the web panel, each as one self-contained binary (`bun build --compile`). The bot migrates the
# database, deploys the slash commands and runs; the panel (which never migrates) serves the React page, the
# API and the WebSocket. Built from the repository root because both bundle the workspace packages.
# One build stage and two runtime stages: `docker build --target web .` or `--target bot .`. The bot stage is
# last, so a plain `docker build .` still gives the bot.
# Base images are pinned by digest; Dependabot refreshes the digests.

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY . .
# --ignore-scripts: the root `prepare` script installs git hooks, which a build has no use for.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --ignore-scripts
# The binary takes its settings from the container's environment only: it must not pick up a .env or
# bunfig.toml from whatever directory it happens to start in.
RUN bun build apps/bot/src/index.ts --compile --minify --sourcemap \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile /out/bot
# The React page is embedded through its HTML import.
RUN bun build apps/web/src/index.ts --compile --minify --sourcemap \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile /out/web

# The compiled binaries need glibc and libstdc++, which the distroless "cc" image provides, and nothing else:
# no shell, no package manager. `nonroot` is uid 65532.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS web
# The commit the image was built from; `bun run prod:up` passes it.
ARG REVISION=unknown
LABEL org.opencontainers.image.title="dzajcarz-web" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
COPY --from=build /out/web /app/web
# The container publishes no port: only the compose network reaches the panel (docs/DEPLOYMENT.md).
ENV NODE_ENV=production \
    WEB_PORT=3000 \
    WEB_HOSTNAME=0.0.0.0
USER nonroot
EXPOSE 3000
# start-period gives the panel time to reach Postgres and Redis before /health can report ready.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD ["/app/web", "healthcheck"]
ENTRYPOINT ["/app/web"]

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS bot
# The commit the image was built from; `bun run prod:up` passes it.
ARG REVISION=unknown
LABEL org.opencontainers.image.title="dzajcarz-bot" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
COPY --from=build /out/bot /app/bot
ENV HEALTH_PORT=8080 \
    HEALTH_HOSTNAME=0.0.0.0
USER nonroot
EXPOSE 8080
# start-period covers the migrations and the Discord login before /health can report ready.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["/app/bot", "healthcheck"]
# SIGTERM (Docker's default stop signal) makes the bot close Discord, Lavalink, Redis and Postgres;
# compose waits stop_grace_period for it.
ENTRYPOINT ["/app/bot"]
