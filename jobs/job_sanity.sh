#!/bin/bash
# 網の入れ方の確認。usage: sbatch jobs/job_sanity.sh [net.json（省略可。例 runs/run2/cand.json）] [局数]
#SBATCH -J carc-sanity
#SBATCH -p DEF
#SBATCH -n 64
#SBATCH -o logs/%x-%j.out
#SBATCH -e logs/%x-%j.out
cd "$SLURM_SUBMIT_DIR"; mkdir -p logs
export PATH=$HOME/node-v22.11.0-linux-x64/bin:$HOME/opt/node/bin:$PATH
node ai/sanity.mjs --net "${1:-}" --games ${2:-400} --workers ${SLURM_NTASKS:-64}
