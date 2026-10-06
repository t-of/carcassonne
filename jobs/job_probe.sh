#!/bin/bash
# 1 世代の時間と局数を測るだけ。usage: sbatch jobs/job_probe.sh [train.mjs の追加引数...]
#SBATCH -J carc-probe
#SBATCH -p DEF
#SBATCH -N 1
#SBATCH -n 64
#SBATCH -t 00:05:00
#SBATCH -o logs/%x-%j.out
#SBATCH -e logs/%x-%j.out
cd "$SLURM_SUBMIT_DIR"; mkdir -p logs
# 使い捨ての作業フォルダで 1 世代だけ（minutes 0.01 → 1 世代回って止まる）。model.json は書き換えない
rm -rf runs/probe
node ai/train.mjs --dir runs/probe --out runs/probe/model.json --minutes 0.01 --workers ${SLURM_NTASKS:-64} "$@"
