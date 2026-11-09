#!/usr/bin/env bash

# Stop if there's any error.
set -e

if [ -z "$VER" ]; then
    echo "Environment variable VER not defined!" >&2
    exit 1
fi

BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null) || branch=$(git rev-parse --short HEAD 2>/dev/null)
if [ "$BRANCH" != "release/v$VER" ];then
    echo "Refusing to release in a non-standard branch!" >&2
    echo "Your git branch should be \`release/v$VER\`." >&2
    exit 1
fi

echo
echo "Bumping versions to $VER everywhere..."
npm version $VER --no-git-tag-version

echo
echo "Generating custom images for the installers..."
./scripts/gen_nsis_images.py

echo
echo "When you are ready to sent the PR, run:"
echo
echo "git commit -m 'chore: release $VER'"
echo
echo "followed by:"
echo
echo "git push"
