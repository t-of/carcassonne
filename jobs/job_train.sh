#!/bin/bash
# 学習の本番。usage: sbatch jobs/job_train.sh <名前> <分> [train.mjs の追加引数...]
#   例: sbatch jobs/job_train.sh run1 600
# 作業フォルダ runs/<名前>/。同じコマンドで再投入すると続きから進む。
#SBATCH -J carc-train
#SBATCH -p DEF
#SBATCH -N 1
#SBATCH -n 64
#SBATCH -o logs/%x-%j.out
#SBATCH -e logs/%x-%j.out
name=${1:?名前}; min=${2:?分}; shift 2
cd "$SLURM_SUBMIT_DIR"; mkdir -p logs runs
# 世代の途中で時間切れにならないよう、学習側の持ち時間は枠より 15 分短くする
node ai/train.mjs --dir runs/$name --minutes $((min - 15)) --workers ${SLURM_NTASKS:-64} "$@"
