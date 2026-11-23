#!/bin/bash
#SBATCH --job-name=agent-experiment-gilbreth
#SBATCH --dependency=singleton
#SBATCH --no-requeue
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=40G
#SBATCH --gpus-per-node=1
#SBATCH --time=04:00:00
#SBATCH --export=NIL

set -euo pipefail
umask 077

if [[ $# -ne 9 || -z ${SLURM_JOB_ID:-} || -z ${CUDA_VISIBLE_DEVICES:-} ]]; then
    echo "Run via Slurm with one GPU: ROLE LOADER MODEL REVISION SCRATCH QUEUE SNAPSHOT PYTHON WORKER" >&2
    exit 2
fi

role=$1
loader=$2
model=$3
revision=$4
scratch=$(/usr/bin/realpath -e -- "$5")
queue=$(/usr/bin/realpath -e -- "$6")
snapshot=$(/usr/bin/realpath -e -- "$7")
python=$8
worker=$(/usr/bin/realpath -e -- "$9")

if [[ $scratch != /scratch/gilbreth/* || $queue != "$scratch/"* || $snapshot != "$scratch/"* ||
      $worker != "$scratch/"* || $python != "$scratch/"* || ! -x $python ]]; then
    echo "Use a Gilbreth scratch directory for the queue, checkpoint, Python environment, and worker." >&2
    exit 2
fi

cache="$scratch/runtime-cache"
/usr/bin/mkdir -p -- "$cache"/{home,huggingface,torch,cuda,triton,tmp}
cd -- "$queue"

# Pass only scheduler metadata and the settings needed by the local Python process.
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$cache/home" TMPDIR="$cache/tmp" \
    CUDA_VISIBLE_DEVICES="$CUDA_VISIBLE_DEVICES" CUDA_CACHE_PATH="$cache/cuda" \
    SLURM_JOB_ID="$SLURM_JOB_ID" OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-4}" \
    HF_HOME="$cache/huggingface" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_DISABLE_IMPLICIT_TOKEN=1 XDG_CACHE_HOME="$cache" TORCH_HOME="$cache/torch" \
    TRITON_CACHE_DIR="$cache/triton" TOKENIZERS_PARALLELISM=false PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 \
    "$python" -B "$worker" --role "$role" --loader "$loader" --checkpoint "$model" --revision "$revision" \
    --snapshot "$snapshot" --queue "$queue"
