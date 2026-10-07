#!/bin/bash
# 探索 CPU の変種対決。usage: sbatch jobs/job_arena.sh <名前> <1 プロセスあたりの局数（偶数）> --a '<json>' --b '<json>' [--players 2]
#   例: sbatch jobs/job_arena.sh x4 8 --a '{"iters":48}' --b '{"iters":12}'
# 64 プロセスが種を分けて打ち、runs/arena-<名前>/p<番号>.jsonl と summary.txt を出す。
#SBATCH -J carc-arena
#SBATCH -p DEF
#SBATCH -n 64
#SBATCH -o logs/%x-%j.out
#SBATCH -e logs/%x-%j.out
name=${1:?名前}; games=${2:?局数}; shift 2
cd "$SLURM_SUBMIT_DIR"; mkdir -p logs
export PATH=$HOME/node-v22.11.0-linux-x64/bin:$HOME/opt/node/bin:$PATH
dir=runs/arena-$name; mkdir -p $dir
N=${SLURM_NTASKS:-64}
# "$@"（JSON の引用符を含む）を srun がそのまま各プロセスへ渡す。--seed と --out はプロセスごとに変える
srun --ntasks=$N bash -c 'node ai/arena.mjs --games '"$games"' --seed $((SLURM_PROCID + 1)) --out '"$dir"'/p$SLURM_PROCID.jsonl "$@" > /dev/null' _ "$@"
node ai/arena.mjs --summary $dir/p*.jsonl | tee $dir/summary.txt
