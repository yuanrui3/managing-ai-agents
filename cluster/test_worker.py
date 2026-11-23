import base64
import json
import os
import shutil
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from worker import Generation, serve, write_json


class FakeClock:
    def __init__(self):
        self.now = 0

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeBackend:
    details = {"dtype": "fixture", "gpu": "fixture"}

    def __init__(self):
        self.calls = []

    def generate(self, prompt, limit, seed, image=None):
        self.calls.append((prompt, limit, seed, image))
        if limit == 128:
            return Generation("notes for the final pass", 13, 8)
        return Generation("finished answer", 25, 7)


class FileQueueTests(unittest.TestCase):
    def setUp(self):
        # Use the workspace because managed Windows temporary folders can deny rename.
        temp_root = Path(__file__).resolve().parent
        self.queue = temp_root / f"agent-worker-test-{uuid4().hex}"
        self.queue.mkdir()
        self.addCleanup(shutil.rmtree, self.queue)
        self.inbox = self.queue / "inbox"
        self.inbox.mkdir()
        self.backend = FakeBackend()
        self.timer = FakeClock()

    def submit(self, id, **overrides):
        body = {"id": id, "prompt": "Produce the part.", "max_output_tokens": 73, "seed": 41, **overrides}
        write_json(self.inbox / f"{id}.json", body)

    def work(self, role="worker", loader=None, resume=False):
        provenance = {"role": role, "checkpoint": "Sample/Model", "revision": "1" * 40, "job_id": "123"}
        serve(self.queue, provenance, loader or (lambda: self.backend), should_stop=lambda: False,
              idle_seconds=1, clock=self.timer.time, sleep=self.timer.sleep, resume=resume)

    def read(self, path):
        return json.loads((self.queue / path).read_text(encoding="utf-8"))

    def test_draft_usage_and_ready_and_idle_markers(self):
        self.submit("pack-one", draft_tokens=128)
        self.submit("malformed", draft_tokens=35)
        (self.inbox / "unfinished.tmp").write_text("{", encoding="utf-8")
        self.work()

        result = self.read("outbox/pack-one.json")
        self.assertEqual((result["status"], result["text"]), ("ok", "finished answer"))
        self.assertEqual((result["input_tokens"], result["output_tokens"], result["draft_tokens"]), (38, 15, 8))
        self.assertIsNone(result["reasoning_tokens"])
        self.assertGreaterEqual(result["active_seconds"], 0)
        self.assertEqual(result["job_id"], "123")
        self.assertIn("started_at", result)
        self.assertIn("request_finished_at", result)
        self.assertEqual(self.backend.calls[0][1:], (128, 41, None))
        self.assertIn("notes for the final pass", self.backend.calls[1][0])
        self.assertEqual(self.backend.calls[1][1:], (73, 41, None))
        self.assertNotIn("notes for the final pass", json.dumps(result))
        self.assertEqual(self.read("outbox/malformed.json")["error"], "invalid_draft_limit")
        self.assertTrue((self.inbox / "unfinished.tmp").exists())
        self.assertEqual(self.read("ready.json")["dtype"], "fixture")
        self.assertEqual(self.read("finished.json")["reason"], "idle")
        self.assertEqual(self.timer.time(), 1)
        self.assertFalse(list((self.queue / "inflight").iterdir()))

    def test_judge_image_and_draft_rules(self):
        image = b"mock image payload"
        self.submit("picture", image_base64=base64.b64encode(image).decode("ascii"))
        self.submit("draft", draft_tokens=128)
        self.submit("url", image_base64="https://example.test/image.png")
        self.work(role="judge")

        self.assertEqual(len(self.backend.calls), 1)
        self.assertEqual(self.backend.calls[0][3], image)
        self.assertEqual(self.read("outbox/picture.json")["draft_tokens"], 0)
        self.assertEqual(self.read("outbox/draft.json")["error"], "invalid_draft_limit")
        self.assertEqual(self.read("outbox/url.json")["error"], "invalid_image")

    def test_execution_allowance_covers_both_draft_and_final(self):
        self.submit("completes", draft_tokens=128, max_execution_seconds=0.75)
        self.submit("expires", draft_tokens=128, max_execution_seconds=0.125)
        os.utime(self.inbox / "completes.json", (10, 10))
        os.utime(self.inbox / "expires.json", (20, 20))
        write_json(self.queue / "sealed.json", {})
        generate = self.backend.generate
        deadlines = []

        def timed_generation(prompt, limit, seed, image=None, *, execution_deadline):
            deadlines.append((limit, execution_deadline, self.timer.time()))
            self.timer.sleep(0.25)
            return generate(prompt, limit, seed, image)

        self.backend.generate = timed_generation
        with patch("worker.time.monotonic", self.timer.time):
            self.work()

        self.assertEqual(deadlines, [(128, 0.75, 0), (73, 0.75, 0.25), (128, 0.625, 0.5)])
        self.assertEqual(self.read("outbox/completes.json")["active_seconds"], 0.5)
        expired = self.read("outbox/expires.json")
        self.assertEqual((expired["status"], expired["error_type"], expired["active_seconds"]),
                         ("error", "execution_cap", 0.25))
        self.assertNotIn("text", expired)

    def test_execution_allowance_rejects_invalid_values(self):
        invalid = [None, True, 0, -1, "1.5", 14401]
        for index, value in enumerate(invalid):
            self.submit(f"invalid-{index}", max_execution_seconds=value)
        write_json(self.queue / "sealed.json", {})
        self.work()

        self.assertFalse(self.backend.calls)
        for index in range(len(invalid)):
            self.assertEqual(self.read(f"outbox/invalid-{index}.json")["error"], "invalid_execution_limit")

    def test_duplicate_does_not_regenerate_and_queue_cannot_be_reused(self):
        self.submit("duplicate")
        original = self.backend.generate

        def generate(*args):
            self.submit("duplicate")
            return original(*args)

        self.backend.generate = generate
        self.work()
        self.assertEqual(len(self.backend.calls), 1)
        self.assertFalse((self.inbox / "duplicate.json").exists())
        with self.assertRaisesRegex(RuntimeError, "fresh queue"):
            self.work()

    def test_loading_error_leaves_terminal_marker(self):
        def load():
            raise RuntimeError("fixture load failure")

        with self.assertRaisesRegex(RuntimeError, "fixture load failure"):
            self.work(loader=load)
        self.assertEqual(self.read("finished.json")["reason"], "startup_error")
        self.assertFalse((self.queue / "ready.json").exists())

    def test_identical_interrupted_claim_is_requeued_behind_fresh_requests(self):
        self.submit("interrupted", prompt="first attempt")
        self.submit("fresh", prompt="fresh request")
        os.utime(self.inbox / "interrupted.json", (10, 10))
        os.utime(self.inbox / "fresh.json", (20, 20))
        inflight = self.queue / "inflight"
        inflight.mkdir()
        shutil.copyfile(self.inbox / "interrupted.json", inflight / "interrupted.json")
        self.work(resume=True)
        self.assertEqual([call[0] for call in self.backend.calls], ["fresh request", "first attempt"])
        self.assertEqual(self.read("outbox/interrupted.json")["status"], "ok")

    def test_sealed_batch_exits_when_drained(self):
        self.submit("last")
        write_json(self.queue / "sealed.json", {})
        self.work()
        self.assertEqual(self.read("outbox/last.json")["status"], "ok")
        self.assertEqual(self.read("finished.json")["reason"], "drained")
        self.assertEqual(self.timer.time(), 0)


if __name__ == "__main__":
    unittest.main()
