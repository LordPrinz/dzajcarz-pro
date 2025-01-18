FROM oven/bun:latest

WORKDIR /app

COPY bun.lockb package.json ./

COPY ./src ./src
COPY ./config ./config
COPY ./scripts ./scripts
COPY .env .env
COPY .husky .husky

RUN chmod -R +x .husky
RUN chmod -R +x scripts

RUN bun install

RUN bun run prepare

CMD ["bun", "run", "start:prod"]