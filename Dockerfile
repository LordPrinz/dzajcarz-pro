FROM oven/bun:latest

WORKDIR /app

COPY bun.lockb package.json ./

RUN bun install

COPY ./src ./src
COPY ./config ./config
COPY ./scripts ./scripts
COPY .env .env
COPY .husky .husky