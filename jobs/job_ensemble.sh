#!/bin/bash
# 「4 本ぶんを合わせる（アプリの複数 Worker）」対「今のつよい（1 本）」。各本の予算は同じ（budget 3000）。
#   sbatch -p DEF -n 64 --nice=10000 jobs/job_ensemble.sh ens4 8     （8 局 × 64 プロセス = 512 局）
#SBATCH -J carc-ens
#SBATCH -p DEF
#SBATCH -n 64
#SBATCH -o logs/%x-%j.out
#SBATCH -e logs/%x-%j.out
S='"candidates":"diverse","rootPolicy":"halving","depth":8,"budget":3000'
exec bash "$SLURM_SUBMIT_DIR/jobs/job_arena.sh" "${1:-ens4}" "${2:-8}" --a "{$S,\"ensemble\":4}" --b "{$S}"
