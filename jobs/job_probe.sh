#!/bin/bash
# 1 世代の時間と局数を測るだけ（本番の 1/4 ほどの局数。手元 2 ワーカーで 14 局 252 秒だったので 20 分の枠）。usage: sbatch jobs/job_probe.sh [train.mjs の追加引数...]
#SBATCH -J carc-probe
#SBATCH -p DEF
#SBATCH -N 1
#SBATCH -n 64
#SBATCH -t 00:20:00
#SBATCH -o logs/%x-%j.out
#SBATCH -e logs/%x-%j.out
cd "$SLURM_SUBMIT_DIR"; mkdir -p logs
# 使い捨ての作業フォルダで 1 世代だけ（minutes 0.01 → 1 世代回って止まる）。model.json は書き換えない
rm -rf runs/probe
export PATH=$HOME/node-v22.11.0-linux-x64/bin:$HOME/opt/node/bin:$PATH
node ai/train.mjs --dir runs/probe --out runs/probe/model.json --minutes 0.01 --workers ${SLURM_NTASKS:-64} --games 128 --arena-games 64 --ref-games 64 "$@"
