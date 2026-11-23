"""One-checkpoint Slurm file-queue worker. No provider credentials or network clients."""

import argparse
import base64
import filecmp
import io
import json
import math
import os
import re
import signal
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

PROTOCOL_VERSION = 1
ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
CHECKPOINT = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
REVISION = re.compile(r"[a-f0-9]{40}\Z")
MAX_PROMPT_BYTES = 96 * 1024
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_REQUEST_BYTES = 3 * 1024 * 1024
MAX_IMAGE_DIMENSION = 2048
MAX_OUTPUT_TOKENS = 4096
MAX_CONTEXT_TOKENS = 8192
IDLE_SECONDS = 600
POLL_SECONDS = 0.5


class RequestError(Exception):
    """A request cannot be serviced; the message is safe for the reply."""


class ExecutionLimit(RequestError):
    """The cell's remaining backend execution allowance was consumed."""


@dataclass(frozen=True)
class Request:
    id: str
    prompt: str
    max_output_tokens: int
    seed: int
    draft_tokens: int
    image: bytes | None
    max_execution_seconds: float | None = None


@dataclass(frozen=True)
class Generation:
    text: str
    input_tokens: int
    output_tokens: int


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def write_json(path, data):
    """Publish a complete result via same-directory atomic replacement."""
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8", delete=False) as file:
            temp = Path(file.name)
            json.dump(data, file, ensure_ascii=False, allow_nan=False)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        temp.replace(path)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def read_request(path, role):
    with path.open("rb") as file:
        data = file.read(MAX_REQUEST_BYTES + 1)
    if len(data) > MAX_REQUEST_BYTES:
        raise RequestError("request_too_large")
    try:
        body = json.loads(data)
    except (ValueError, UnicodeError, RecursionError):
        raise RequestError("invalid_json") from None
    if not isinstance(body, dict) or body.get("id") != path.stem:
        raise RequestError("invalid_request_id")
    if body.keys() - {"id", "prompt", "max_output_tokens", "seed", "draft_tokens", "image_base64", "max_execution_seconds"}:
        raise RequestError("unknown_request_field")
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise RequestError("invalid_prompt")
    try:
        if len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
            raise RequestError("prompt_too_large")
    except UnicodeError:
        raise RequestError("invalid_prompt_encoding") from None
    output_limit = body.get("max_output_tokens")
    if type(output_limit) is not int or not 1 <= output_limit <= MAX_OUTPUT_TOKENS:
        raise RequestError("invalid_output_limit")
    seed = body.get("seed")
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise RequestError("invalid_seed")
    draft_tokens = body.get("draft_tokens", 0)
    if type(draft_tokens) is not int or draft_tokens not in (0, 128, 512) or (role != "worker" and draft_tokens):
        raise RequestError("invalid_draft_limit")
    image = None
    if "image_base64" in body:
        if role != "judge" or not isinstance(body["image_base64"], str):
            raise RequestError("invalid_image")
        try:
            image = base64.b64decode(body["image_base64"], validate=True)
        except ValueError:
            raise RequestError("invalid_image") from None
        if not image or len(image) > MAX_IMAGE_BYTES:
            raise RequestError("invalid_image_size")
    allowance = body.get("max_execution_seconds")
    if "max_execution_seconds" in body and (type(allowance) not in (int, float) or
                                           not 0 < allowance <= 14400 or not math.isfinite(allowance)):
        raise RequestError("invalid_execution_limit")
    return Request(path.stem, prompt, output_limit, seed, draft_tokens, image, allowance)


class TransformersBackend:
    def __init__(self, loader, checkpoint, snapshot):
        import torch
        import transformers

        if torch.cuda.device_count() != 1:
            raise RuntimeError("Exactly one visible CUDA device is required.")
        self.torch = torch
        self.set_seed = transformers.set_seed
        self.vision = loader == "vision"
        self.device = torch.device("cuda:0")
        self.dtype = torch.bfloat16 if torch.cuda.is_bf16_supported(including_emulation=False) else torch.float16
        explicit_non_thinking = checkpoint.startswith(("Qwen/Qwen3-", "zai-org/GLM-4.6V-"))
        self.template_options = {"enable_thinking": False} if explicit_non_thinking else {}
        local = {"local_files_only": True, "trust_remote_code": False}
        if self.vision:
            self.processor = transformers.AutoProcessor.from_pretrained(snapshot, **local)
            model_class = getattr(transformers, "AutoModelForMultimodalLM", None)
            if model_class is None:
                model_class = transformers.AutoModelForImageTextToText
        else:
            self.processor = transformers.AutoTokenizer.from_pretrained(snapshot, **local)
            model_class = transformers.AutoModelForCausalLM
        self.model = model_class.from_pretrained(snapshot, dtype=self.dtype, use_safetensors=True, **local)
        self.place_model()
        text_config = getattr(self.model.config, "text_config", self.model.config)
        self.context_limit = min(MAX_CONTEXT_TOKENS, getattr(text_config, "max_position_embeddings", MAX_CONTEXT_TOKENS))
        torch.cuda.synchronize(self.device)
        gpu = torch.cuda.get_device_properties(self.device)
        self.details = {
            "dtype": str(self.dtype).removeprefix("torch."),
            "gpu": gpu.name,
            "gpu_memory_bytes": gpu.total_memory,
            "model_cuda_allocated_bytes": torch.cuda.memory_allocated(self.device),
            "python_version": sys.version.split()[0],
            "torch_version": str(torch.__version__),
            "transformers_version": transformers.__version__,
            "context_limit": self.context_limit,
            "decoding": "greedy",
            "native_thinking_control": "enable_thinking=false" if explicit_non_thinking else None,
        }

    def place_model(self):
        self.model.to(self.device).eval()

    def prepare_image(self, image):
        from PIL import Image

        try:
            with Image.open(io.BytesIO(image), formats=["JPEG", "PNG"]) as decoded:
                if max(decoded.size) > MAX_IMAGE_DIMENSION or getattr(decoded, "n_frames", 1) != 1:
                    raise RequestError("invalid_image_dimensions")
                return decoded.convert("RGB")
        except (OSError, Image.DecompressionBombError):
            raise RequestError("invalid_image") from None

    def generate(self, prompt, output_limit, seed, image=None, *, execution_deadline=None):
        if self.vision:
            content = [{"type": "text", "text": prompt}]
            decoded_image = self.prepare_image(image) if image is not None else None
            if decoded_image is not None:
                content.insert(0, {"type": "image"})
            formatted = self.processor.apply_chat_template(
                [{"role": "user", "content": content}], tokenize=False, add_generation_prompt=True,
                **self.template_options,
            )
            images = [decoded_image] if decoded_image is not None else None
            batch = self.processor(text=formatted, images=images, return_tensors="pt")
        else:
            batch = self.processor.apply_chat_template(
                [{"role": "user", "content": prompt}], tokenize=True, return_dict=True,
                return_tensors="pt", add_generation_prompt=True, **self.template_options,
            )

        input_tokens = batch["input_ids"].shape[1]
        if input_tokens + output_limit > self.context_limit:
            raise RequestError("token_limit_exceeded")
        batch = {key: value.to(device=self.device, dtype=self.dtype) if value.is_floating_point() else value.to(self.device)
                 for key, value in batch.items()}
        self.set_seed(seed)
        time_limit = {}
        if execution_deadline is not None:
            remaining = execution_deadline - time.monotonic()
            if remaining <= 0:
                raise ExecutionLimit("execution_cap")
            # Transformers includes prefill and checks this limit between decoding steps.
            time_limit["max_time"] = remaining
        with self.torch.inference_mode():
            output = self.model.generate(
                **batch, do_sample=False, num_beams=1, max_new_tokens=output_limit, return_dict_in_generate=False,
                temperature=None, top_p=None, top_k=None, **time_limit,
            )
        tokens = output[0, input_tokens:].tolist()
        self.torch.cuda.synchronize(self.device)
        text = self.processor.decode(tokens, skip_special_tokens=True)
        return Generation(text, int(input_tokens), len(tokens))


def run_request(backend, request):
    start = time.monotonic()
    deadline = start + request.max_execution_seconds if request.max_execution_seconds is not None else None

    def generate(prompt, output_limit, image=None):
        options = {"execution_deadline": deadline} if deadline is not None else {}
        result = backend.generate(prompt, output_limit, request.seed, **options) if image is None else backend.generate(
            prompt, output_limit, request.seed, image, **options)
        if deadline is not None and time.monotonic() > deadline:
            raise ExecutionLimit("execution_cap")
        return result

    draft = Generation("", 0, 0)
    prompt = request.prompt
    if request.draft_tokens:
        plan = ("Prepare short task-relevant planning notes for a later attempt. Output planning notes only, "
                "even if the task asks for a different response format.\n\nTask:\n" + prompt)
        draft = generate(plan, request.draft_tokens)
        prompt = ("Use the optional planning notes if helpful. Follow the original task's output requirements.\n\n"
                  f"Planning notes:\n{draft.text}\n\nOriginal task:\n{prompt}")
    final = generate(prompt, request.max_output_tokens, request.image)
    return {
        "status": "ok",
        "text": final.text,
        "input_tokens": draft.input_tokens + final.input_tokens,
        "output_tokens": draft.output_tokens + final.output_tokens,
        "draft_tokens": draft.output_tokens,
        "reasoning_tokens": None,
        "active_seconds": time.monotonic() - start,
    }


def serve(queue, provenance, load_backend, *, should_stop, idle_seconds=IDLE_SECONDS,
          clock=time.monotonic, sleep=time.sleep, resume=False, stop_on_oom=False):
    inbox, inflight, outbox = [queue / name for name in ("inbox", "inflight", "outbox")]
    for directory in (inbox, inflight, outbox):
        directory.mkdir(exist_ok=True)
    if resume:
        for path in inflight.glob("*.json"):
            if (outbox / path.name).exists():
                path.unlink()
                continue
            queued = inbox / path.name
            if queued.exists():
                if not filecmp.cmp(path, queued, shallow=False):
                    raise RuntimeError("Conflicting queued and interrupted requests.")
                path.unlink()
            else:
                path.rename(queued)
            # Try fresh requests before retrying work that did not fit the previous GPU window.
            os.utime(queued, None)
    elif ((queue / "ready.json").exists() or (queue / "finished.json").exists() or
          any(inflight.iterdir()) or any(outbox.iterdir())):
        raise RuntimeError("Use a fresh queue for each allocation.")

    state = {**provenance, "protocol_version": PROTOCOL_VERSION, "started_at": utc_now()}
    finish_reason = "startup_error"
    try:
        backend = load_backend()
        state.update({**backend.details, "ready_at": utc_now()})
        write_json(queue / "ready.json", state)
        finish_reason = "worker_error"
        idle_deadline = clock() + idle_seconds
        while not should_stop():
            # Observe the seal before listing requests. The submitter writes it last.
            sealed = (queue / "sealed.json").is_file()
            requests = [path for path in inbox.glob("*.json")
                        if ID.fullmatch(path.stem) and path.is_file() and not path.is_symlink()]
            if not requests:
                if sealed:
                    finish_reason = "drained"
                    break
                if clock() >= idle_deadline:
                    finish_reason = "idle"
                    break
                sleep(POLL_SECONDS)
                continue
            for path in sorted(requests, key=lambda candidate: (candidate.stat().st_mtime_ns, candidate.name)):
                if should_stop():
                    break
                claim = path.replace(inflight / path.name)
                response_path = outbox / path.name
                if response_path.exists():
                    claim.unlink()
                    continue
                started = utc_now()
                started_clock = clock()
                try:
                    request = read_request(claim, provenance["role"])
                    result = run_request(backend, request)
                except ExecutionLimit as error:
                    result = {"status": "error", "error": str(error), "error_type": "execution_cap"}
                except RequestError as error:
                    result = {"status": "error", "error": str(error)}
                except Exception as error:
                    result = {"status": "error", "error": "inference_failed", "error_type": type(error).__name__}
                    if result["error_type"] == "OutOfMemoryError":
                        result["error_detail"] = str(error)
                        traceback.print_exc()
                if result["status"] == "error":
                    result["active_seconds"] = clock() - started_clock
                write_json(response_path, {**result, **state, "id": path.stem, "request_started_at": started,
                                           "request_finished_at": utc_now()})
                claim.unlink()
                if stop_on_oom and result.get("error_type") == "OutOfMemoryError":
                    raise RuntimeError("CUDA memory limit reached. The failed request was saved for recovery.")
                idle_deadline = clock() + idle_seconds
        if should_stop():
            finish_reason = "signal"
    finally:
        write_json(queue / "finished.json", {**state, "finished_at": utc_now(), "reason": finish_reason})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", choices=("worker", "judge"), required=True)
    parser.add_argument("--loader", choices=("causal", "vision"), required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--queue", type=Path, required=True)
    args = parser.parse_args()
    job_id = os.environ.get("SLURM_JOB_ID")
    if not job_id or os.environ.get("HF_HUB_OFFLINE") != "1":
        parser.error("Start via the offline Gilbreth Slurm job.")
    if args.role == "judge" and args.loader != "vision":
        parser.error("The judging stage requires a vision checkpoint.")
    if not CHECKPOINT.fullmatch(args.checkpoint) or not REVISION.fullmatch(args.revision):
        parser.error("Specify a repository ID and exact 40-character commit revision.")
    snapshot = args.snapshot.resolve(strict=True)
    model_cache = "models--" + args.checkpoint.replace("/", "--")
    if snapshot.parts[-3:] != (model_cache, "snapshots", args.revision):
        parser.error("Snapshot path must match the specified checkpoint and revision.")

    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    provenance = {"role": args.role, "loader": args.loader, "checkpoint": args.checkpoint,
                  "revision": args.revision, "job_id": job_id}
    serve(args.queue.resolve(strict=True), provenance, lambda: TransformersBackend(args.loader, args.checkpoint, snapshot),
          should_stop=lambda: stopping)


if __name__ == "__main__":
    main()
