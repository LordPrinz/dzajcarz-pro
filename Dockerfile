# The bot as one self-contained binary (`bun build --compile`): it migrates the database, deploys the slash
# commands and runs. Built from the repository root because the bot bundles every workspace package.
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

# The compiled binary needs glibc and libstdc++, which the distroless "cc" image provides, and nothing else:
# no shell, no package manager. `nonroot` is uid 65532.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
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
