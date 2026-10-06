#!/bin/bash
# HAKUSAN に持っていくものだけを hakusan-carcassonne.tar.gz にまとめる
cd "$(dirname "$0")/.." && COPYFILE_DISABLE=1 tar --no-xattrs -czf hakusan-carcassonne.tar.gz --exclude=ai/test.mjs --exclude=.DS_Store engine.js package.json ai jobs README_hakusan.md && ls -lh hakusan-carcassonne.tar.gz
