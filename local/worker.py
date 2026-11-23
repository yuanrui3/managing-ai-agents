"""Run a pinned checkpoint from a Windows workspace queue."""

import argparse
import os
import site
import sys
from pathlib import Path


workspace = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(workspace / 'cluster'))
from worker import CHECKPOINT, REVISION, TransformersBackend, serve


class TextPrefillDesktopBackend(TransformersBackend):
    """Bound native text prefill while preserving the existing image path."""

    def generate(self, prompt, output_limit, seed, image=None, **options):
        if image is not None:
            return super().generate(prompt, output_limit, seed, image, **options)

        config = self.model.generation_config
        previous_chunk_size, previous_use_cache = config.prefill_chunk_size, config.use_cache
        config.prefill_chunk_size = 1024
        config.use_cache = True
        try:
            return super().generate(prompt, output_limit, seed, **options)
        finally:
            config.prefill_chunk_size = previous_chunk_size
            config.use_cache = previous_use_cache


class GlmDesktopBackend(TextPrefillDesktopBackend):
    """Run visual encoding on CPU to keep the 4 GiB CUDA margin available."""

    def place_model(self):
        core = self.model.model
        visual = core.visual
        del core.visual
        super().place_model()
        # Append the visual module after the CUDA decoder so generate() sees a CUDA model.
        core.visual = visual.eval()
        visual.register_forward_pre_hook(self.move_vision_inputs, with_kwargs=True)

    @staticmethod
    def move_vision_inputs(module, args, kwargs):
        def to_cpu(value):
            return value.cpu() if hasattr(value, "device") else value

        return tuple(map(to_cpu, args)), {key: to_cpu(value) for key, value in kwargs.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=('worker', 'judge'), required=True)
    parser.add_argument('--loader', choices=('causal', 'vision'), required=True)
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--queue', type=Path, required=True)
    parser.add_argument('--memory-mib', type=int, required=True)
    args = parser.parse_args()
    snapshot = args.snapshot.resolve(strict=True)
    queue = args.queue.resolve(strict=True)
    if not CHECKPOINT.fullmatch(args.checkpoint) or not REVISION.fullmatch(args.revision):
        parser.error('Expected a public repository and exact pinned revision.')
    cache_name = 'models--' + args.checkpoint.replace('/', '--')
    if snapshot.parts[-3:] != (cache_name, 'snapshots', args.revision) or not snapshot.is_relative_to(workspace / 'runs'):
        parser.error('Use the pinned snapshot directory under workspace runs/.')
    if not queue.is_relative_to(workspace / 'runs') or args.memory_mib <= 0:
        parser.error('Expected a workspace queue and positive memory limit.')
    if args.role == 'judge' and args.loader != 'vision':
        parser.error('Judging requires a vision checkpoint.')

    # Start the base executable directly so the watchdog owns the actual CUDA PID.
    dependencies = workspace / 'runs' / 'local-runtime' / 'venv' / 'Lib' / 'site-packages'
    if not dependencies.is_dir():
        parser.error('The workspace inference packages are missing.')
    site.addsitedir(str(dependencies))

    def load():
        import torch

        total = torch.cuda.get_device_properties(0).total_memory
        torch.cuda.set_per_process_memory_fraction(min(1.0, args.memory_mib * 2**20 / total), 0)
        offload_vision = (args.checkpoint == 'zai-org/GLM-4.6V-Flash' and
                          args.revision == '411bb4d77144a3f03accbf4b780f5acb8b7cde4e')
        chunk_mistral_text = (args.checkpoint == 'mistralai/Ministral-3-8B-Instruct-2512-BF16' and
                              args.revision == 'f6fae9795746f63c9be8344932f01275f3c63734')
        backend_class = TransformersBackend
        if offload_vision:
            backend_class = GlmDesktopBackend
        elif chunk_mistral_text:
            backend_class = TextPrefillDesktopBackend
        backend = backend_class(args.loader, args.checkpoint, snapshot)
        if offload_vision or chunk_mistral_text:
            backend.details.update(text_prefill_chunk_size=1024, text_prefill_use_cache=True,
                                   image_prefill_chunk_size=None)
        if args.loader == 'vision':
            backend.details['vision_device'] = 'cpu' if offload_vision else str(backend.device)
        return backend

    provenance = {'site': 'desktop-windows', 'role': args.role, 'loader': args.loader, 'checkpoint': args.checkpoint,
                  'revision': args.revision, 'worker_pid': os.getpid(), 'memory_limit_mib': args.memory_mib}
    serve(queue, provenance, load, should_stop=lambda: (queue / 'pause-worker').exists(),
          idle_seconds=15, resume=True, stop_on_oom=True)


if __name__ == '__main__':
    for flag in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_IMPLICIT_TOKEN', 'HF_HUB_DISABLE_TELEMETRY'):
        os.environ[flag] = '1'
    main()
