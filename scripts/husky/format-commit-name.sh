#!/bin/sh

BRANCH_NAME=$(git symbolic-ref --short HEAD)
PR_NUMBER=$(echo "$BRANCH_NAME" | grep -oE '[0-9]+' | head -n 1)

COMMIT_MSG_FILE=$1
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

if [ -z "$PR_NUMBER" ]; then
  echo "PR number not found in branch name. Are you sure you are in a PR branch?"
  exit 0
fi

if [ -z "$COMMIT_MSG" ]; then
  echo "Commit message is empty. Please provide a commit message."
  exit 1
fi

COMMIT_MSG=$(echo "$COMMIT_MSG" | sed -E 's/\[dzaj-([0-9]+)\]/\[DZAJ-\1\]/Ig')

DZAJ_PATTERN="\\[DZAJ-([0-9]+)\\]"
if echo "$COMMIT_MSG" | grep -iqE "$DZAJ_PATTERN"; then
  COMMIT_DZAJ_NUMBER=$(echo "$COMMIT_MSG" | grep -ioE "$DZAJ_PATTERN" | grep -ioE '[0-9]+')
  if [ "$COMMIT_DZAJ_NUMBER" != "$PR_NUMBER" ]; then
    echo "Warning: The DZAJ number in the commit message [$COMMIT_DZAJ_NUMBER] does not match the DZAJ number from the branch name [$PR_NUMBER]."
    exit 1
  else
    echo "$COMMIT_MSG" > "$COMMIT_MSG_FILE"
    exit 0
  fi
fi

CAPITALIZED_COMMIT_MSG=$(echo "$COMMIT_MSG" | sed 's/^ *//;s/ *$//' | awk '{print toupper(substr($0,1,1)) tolower(substr($0,2))}')

FORMATTED_MSG="[DZAJ-$PR_NUMBER] $CAPITALIZED_COMMIT_MSG"

echo "$FORMATTED_MSG" > "$COMMIT_MSG_FILE"