import importlib.util
from pathlib import Path
import json
import os
import struct
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/tts"))
# worker routes third-party stdout to stderr; restore it for the test runner.
saved_stdout = sys.stdout
import worker
sys.stdout = saved_stdout
from voices import DEFAULT_VOICE, contained_file, load_registry, public_registry, select_reference


class ProtocolTests(unittest.TestCase):
    def message(self):
        return dict(voiceId=DEFAULT_VOICE, text="你好。", language="all_zh", sessionId="s",
                    turnId="t", segmentId="seg", generationId=1, voiceRevision=0)

    def test_all_resource_paths_exist_and_default_reference(self):
        registry = load_registry()
        self.assertEqual(len(registry), 10)
        self.assertIn("平静", registry[DEFAULT_VOICE]["references"][0]["name"])

    def test_rejects_arbitrary_voice_and_bad_identity(self):
        for changes in [dict(voiceId="../../model.pth"), dict(generationId=True),
                        dict(generationId=-1), dict(language="guess"), dict(text=""), dict(text="a" * 601)]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                worker.validate_synthesis({**self.message(), **changes})

    def test_all_voices_and_speed_routes_are_allowed(self):
        for voice_id in load_registry():
            worker.validate_synthesis({**self.message(), "voiceId": voice_id, "speed": 1.5})
        for value in (True, 0.49, 2.01, float("nan"), "1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                worker.validate_synthesis({**self.message(), "speed": value})

    def test_public_registry_has_opaque_reference_ids_and_no_paths(self):
        registry = load_registry()
        for voice in public_registry(registry):
            self.assertEqual(voice["defaultReferenceId"], "ref-01")
            self.assertEqual(len({r["id"] for r in voice["references"]}), len(voice["references"]))
            self.assertNotIn("gpt", voice)
            self.assertEqual(set(voice["references"][0]), {"id", "name"})
            self.assertEqual(select_reference(registry[voice["id"]])["id"], "ref-01")
            with self.assertRaises(ValueError):
                select_reference(registry[voice["id"]], "../../audio.wav")

    def test_voice_pair_rollback_is_warmed_before_reuse(self):
        service = worker.Service(ROOT / ".cache/test-tts-unused")
        registry = service.registry
        old = registry[DEFAULT_VOICE]
        new = next(v for v in registry.values() if v is not old)
        service.voice, service.reference = old, select_reference(old)
        calls = []

        def load_pair(voice, reference):
            calls.append(voice["id"])
            service.voice, service.reference = voice, reference

        def warmup():
            if service.voice is new:
                raise RuntimeError("SIMULATED_LOAD_FAILURE")

        service.load_pair, service.warmup = load_pair, warmup
        try:
            with self.assertRaises(RuntimeError):
                service.switch(new, select_reference(new))
            self.assertEqual(calls, [new["id"], old["id"]])
            self.assertIs(service.voice, old)
            self.assertEqual(service.revision, 0)
            self.assertIsNone(service.load_error)
            service.warmup = lambda: None
            service.switch(new, select_reference(new))
            self.assertEqual(service.revision, 1)
        finally:
            service.executor.shutdown()

    def test_binary_frame_preserves_identity_and_pcm(self):
        identity = worker.validate_synthesis(self.message())
        raw = worker.pack_pcm(identity, b"\x01\x00\xff\x7f")
        length = struct.unpack("<I", raw[:4])[0]
        self.assertEqual(json.loads(raw[4:4 + length]), identity)
        self.assertEqual(raw[4 + length:], b"\x01\x00\xff\x7f")

    def test_path_escape_rejected(self):
        with self.assertRaises(ValueError):
            contained_file(ROOT / "assets", "../package.json")


class FakeSocket:
    def __init__(self, token, messages=()):
        self.token, self.messages, self.sent, self.closed = token, messages, [], None

    async def recv(self):
        return json.dumps(dict(token=self.token))

    async def send(self, value):
        self.sent.append(json.loads(value))

    async def close(self, code, reason):
        self.closed = code

    async def __aiter__(self):
        for message in self.messages:
            yield json.dumps(message)


class OwnershipTests(unittest.IsolatedAsyncioTestCase):
    async def test_unauthenticated_client_cannot_stop_or_own_worker(self):
        service = worker.Service(ROOT / ".cache/test-tts-unused")
        ws = FakeSocket("incorrect")
        try:
            with patch.dict(os.environ, DESKAI_TTS_TOKEN="secret-token"):
                await service.handler(ws, "/")
            self.assertEqual(ws.closed, 1008)
            self.assertIsNone(service.owner)
            self.assertFalse(service.stop.is_set())
        finally:
            service.executor.shutdown()

    async def test_authenticated_disconnect_stops_worker_and_registry_has_no_paths(self):
        service = worker.Service(ROOT / ".cache/test-tts-unused")
        ws = FakeSocket("secret-token", [dict(op="registry", requestId="catalog")])
        try:
            with patch.dict(os.environ, DESKAI_TTS_TOKEN="secret-token"):
                await service.handler(ws, "/")
            self.assertTrue(service.stop.is_set())
            catalog = next(frame for frame in ws.sent if frame["event"] == "registry")
            self.assertEqual(len(catalog["voices"]), 10)
            self.assertNotIn("path", json.dumps(catalog))
        finally:
            service.executor.shutdown()


if __name__ == "__main__":
    unittest.main()
