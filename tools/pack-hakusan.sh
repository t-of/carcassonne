#!/bin/bash
# HAKUSAN に持っていくものだけを hakusan-carcassonne.tar.gz にまとめる
cd "$(dirname "$0")/.." && tar czf hakusan-carcassonne.tar.gz engine.js package.json ai jobs README_hakusan.md --exclude=ai/test.mjs --exclude=.DS_Store && ls -lh hakusan-carcassonne.tar.gz
