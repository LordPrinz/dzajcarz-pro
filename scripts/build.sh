#!/usr/bin/env bash

echo -e "┏━━━ 📦 BUILD: $(pwd) ━━━━━━━━━━━━\n"
bun build src/main.ts --outdir=dist --minify