import importlib.util
from pathlib import Path
import json
import struct
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/tts"))
# worker routes third-party stdout to stderr; restore it for the test runner.
saved_stdout = sys.stdout
import worker
sys.stdout = saved_stdout
from voices import DEFAULT_VOICE, contained_file, load_registry


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

    def test_binary_frame_preserves_identity_and_pcm(self):
        identity = worker.validate_synthesis(self.message())
        raw = worker.pack_pcm(identity, b"\x01\x00\xff\x7f")
        length = struct.unpack("<I", raw[:4])[0]
        self.assertEqual(json.loads(raw[4:4 + length]), identity)
        self.assertEqual(raw[4 + length:], b"\x01\x00\xff\x7f")

    def test_path_escape_rejected(self):
        with self.assertRaises(ValueError):
            contained_file(ROOT / "assets", "../package.json")


if __name__ == "__main__":
    unittest.main()
