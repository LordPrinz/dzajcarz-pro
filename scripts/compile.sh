#!/usr/bin/env bash

echo -e "┏━━━ 🔨 COMPILE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
bun build src/index.ts --compile --outfile cli/main