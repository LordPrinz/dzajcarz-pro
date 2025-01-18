#!/bin/sh

protected_branch='main'
current_branch=$(git rev-parse --abbrev-ref HEAD)

if [ "$current_branch" = "$protected_branch" ]; then
  echo "Direct pushes to the $protected_branch branch are not allowed. Please create a pull request."
  exit 1
fi

exit 0