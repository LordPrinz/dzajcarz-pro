#!/usr/bin/env bash

echo -e "┏━━━ 📦 BUILD: $(pwd) ━━━━━━━━━━━━\n"
bun build src/index.ts --outdir=dist --minify