#!/usr/bin/env bash

echo -e "┏━━━ 🔧 SETTING-UP GIT HOOKS ━━━━━━━━━━━━━━━━\n"

bun install
bunx husky

DOTENV_FILE_DIR="$(pwd)"
if [ ! -f "$DOTENV_FILE_DIR/.env" ]; then
  echo ".env not found"
  cp "$DOTENV_FILE_DIR/.env.example" "$DOTENV_FILE_DIR/.env"
fi