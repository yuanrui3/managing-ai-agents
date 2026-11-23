"""Download a pinned, public checkpoint into the workspace Hugging Face cache."""

import argparse
import os
from pathlib import Path

# Hugging Face's native transport can resume the large public weight shards.
os.environ.pop('HF_HUB_DISABLE_XET', None)
from huggingface_hub import snapshot_download


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('checkpoint')
parser.add_argument('revision')
parser.add_argument('cache', type=Path)
args = parser.parse_args()

print(snapshot_download(
    repo_id=args.checkpoint,
    revision=args.revision,
    cache_dir=args.cache,
    token=False,
    max_workers=4,
    allow_patterns=['*.safetensors', '*.json', '*.model', '*.tiktoken', '*.jinja', 'merges.txt', 'vocab.txt'],
    ignore_patterns=['consolidated.safetensors'] if args.checkpoint.startswith('mistralai/') else None,
))
