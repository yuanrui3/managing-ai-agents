"""Verify Windows text prefill policies with small CPU-only native models."""

import os
import site
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
workspace = Path(__file__).resolve().parent.parent
site.addsitedir(str(workspace / "runs/local-runtime/venv/Lib/site-packages"))
sys.path.insert(0, str(workspace))

import torch
from transformers import AutoConfig, AutoModelForImageTextToText, AutoProcessor
from local.worker import GlmDesktopBackend, TextPrefillDesktopBackend, TransformersBackend


class NativeTextPrefillTests(unittest.TestCase):
    checkpoint = "zai-org/GLM-4.6V-Flash"
    revision = "411bb4d77144a3f03accbf4b780f5acb8b7cde4e"
    backend_class = GlmDesktopBackend

    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        cache_name = "models--" + cls.checkpoint.replace("/", "--")
        snapshot = workspace / "runs/local-runtime/huggingface/hub" / cache_name / "snapshots" / cls.revision
        config = AutoConfig.from_pretrained(snapshot, local_files_only=True, trust_remote_code=False)
        text = config.text_config
        text.hidden_size = 32
        text.intermediate_size = 64
        text.num_hidden_layers = 2
        text.num_attention_heads = 2
        text.num_key_value_heads = 1
        text.max_position_embeddings = 4096
        visual = config.vision_config
        visual.hidden_size = 32
        visual.intermediate_size = 64
        if cls.backend_class is GlmDesktopBackend:
            text.rope_parameters = {"rope_type": "default", "rope_theta": 10000,
                                    "partial_rotary_factor": 0.5, "mrope_section": [1, 1, 2]}
            visual.depth = 1
            visual.num_heads = 2
            visual.out_hidden_size = 32
            visual.image_size = 16
        else:
            text.head_dim = 16
            visual.num_hidden_layers = 1
            visual.num_attention_heads = 2
            visual.head_dim = 16
            visual.image_size = 28
        config._attn_implementation = "sdpa"
        torch.manual_seed(123)
        model = AutoModelForImageTextToText.from_config(config, trust_remote_code=False).float().eval()

        cls.backend = cls.backend_class.__new__(cls.backend_class)
        cls.backend.model = model
        cls.backend.processor = AutoProcessor.from_pretrained(snapshot, local_files_only=True, trust_remote_code=False)
        cls.backend.vision = True
        cls.backend.template_options = {"enable_thinking": False} if cls.backend_class is GlmDesktopBackend else {}
        cls.backend.device = torch.device("cpu")
        cls.backend.dtype = torch.float32
        cls.backend.context_limit = 4096
        cls.backend.set_seed = torch.manual_seed
        # The shared runner synchronizes its configured device after generation.
        cls.backend.torch = SimpleNamespace(inference_mode=torch.inference_mode,
                                           cuda=SimpleNamespace(synchronize=lambda _: None))

    def test_native_chunks_match_unmodified_generation_and_restore_config(self):
        backend = self.backend
        original = backend.model.generation_config
        original.prefill_chunk_size = None
        original.use_cache = True
        prompt = "Count the bright stars and describe the result. " * 150
        plain = TransformersBackend.generate(backend, prompt, 4, 123)
        forwards = []

        def record(module, args, kwargs):
            mask = kwargs.get("attention_mask")
            forwards.append((kwargs["input_ids"].shape[-1], kwargs["position_ids"].shape[-1],
                             None if mask is None else mask.shape[-1]))

        handle = backend.model.register_forward_pre_hook(record, with_kwargs=True)
        try:
            chunked = backend.generate(prompt, 4, 123)
        finally:
            handle.remove()
        self.assertEqual(chunked, plain)
        self.assertGreater(chunked.input_tokens, 1024)
        remaining = chunked.input_tokens - 1024
        # Both real text processors omit an all-visible attention mask.
        self.assertEqual(forwards[:2], [(1024, 1024, None), (remaining, remaining, None)])
        self.assertIsNone(original.prefill_chunk_size)
        self.assertTrue(original.use_cache)
        self.assertFalse(torch.cuda.is_initialized())

    def test_image_requests_keep_existing_generation_config(self):
        config = self.backend.model.generation_config
        config.prefill_chunk_size = None
        config.use_cache = None

        def image_path(*args):
            self.assertIsNone(config.prefill_chunk_size)
            self.assertIsNone(config.use_cache)
            return "original image path"

        with patch.object(TransformersBackend, "generate", side_effect=image_path) as generate:
            self.assertEqual(self.backend.generate("image task", 4, 123, b"image"), "original image path")
            generate.assert_called_once_with("image task", 4, 123, b"image")

    def test_native_failure_restores_settings(self):
        config = self.backend.model.generation_config
        config.prefill_chunk_size = None
        config.use_cache = None
        with patch.object(TransformersBackend, "generate", side_effect=RuntimeError("fixture failure")):
            with self.assertRaisesRegex(RuntimeError, "fixture failure"):
                self.backend.generate("task", 4, 123)
        self.assertIsNone(config.prefill_chunk_size)
        self.assertIsNone(config.use_cache)


class MistralTextPrefillTests(NativeTextPrefillTests):
    checkpoint = "mistralai/Ministral-3-8B-Instruct-2512-BF16"
    revision = "f6fae9795746f63c9be8344932f01275f3c63734"
    backend_class = TextPrefillDesktopBackend

    def test_explicit_masks_and_positions_are_chunked(self):
        model = self.backend.model
        tokens = torch.full((1, 1200), 42, dtype=torch.long)
        inputs = {"input_ids": tokens, "attention_mask": torch.ones_like(tokens),
                  "position_ids": torch.arange(1200).unsqueeze(0)}
        options = {"do_sample": False, "use_cache": True, "max_new_tokens": 3,
                   "temperature": None, "top_p": None, "top_k": None}
        with torch.inference_mode():
            plain = model.generate(**inputs, **options, prefill_chunk_size=None)
            chunked = model.generate(**inputs, **options, prefill_chunk_size=1024)
        self.assertTrue(torch.equal(plain, chunked))
        self.assertFalse(torch.cuda.is_initialized())


if __name__ == "__main__":
    unittest.main()
