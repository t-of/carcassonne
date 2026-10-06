#!/bin/bash
# 対局のデータ集め。usage: sbatch jobs/job_analyze.sh <名前> <1 プロセスあたりの局数> [analyze.mjs の追加引数...]
#   例: sbatch jobs/job_analyze.sh ss 32 --bots search,search     （64 プロセス × 32 局 = 2048 局）
# 出力 runs/analyze-<名前>/part-*.jsonl と summary.txt
#SBATCH -J carc-analyze
#SBATCH -p DEF
#SBATCH -N 1
#SBATCH -n 64
#SBATCH -o logs/%x-%j.out
#SBATCH -e logs/%x-%j.out
name=${1:?名前}; per=${2:?1プロセスあたりの局数}; shift 2
cd "$SLURM_SUBMIT_DIR"; mkdir -p logs runs
export PATH=$HOME/node-v22.11.0-linux-x64/bin:$HOME/opt/node/bin:$PATH
dir=runs/analyze-$name; mkdir -p $dir
procs=${SLURM_NTASKS:-64}
for ((i = 0; i < procs; i++)); do
  node ai/analyze.mjs --games $per --start $((i * per)) --out $dir/part-$i.jsonl --quiet 1 "$@" 2> $dir/part-$i.log &
done
wait
node ai/analyze.mjs --aggregate $dir/part-*.jsonl | tee $dir/summary.txt
