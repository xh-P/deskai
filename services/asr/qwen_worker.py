"""Line-delimited private child protocol. Model output is kept off stdout."""
import base64
import contextlib
import io
import json
import os
import sys


def send(value):
    print(json.dumps(value, ensure_ascii=False), file=sys.__stdout__, flush=True)


def main():
    with contextlib.redirect_stdout(sys.stderr):
        import soundfile as sf
        import torch
        from qwen_asr import Qwen3ASRModel
        device = os.environ.get('DESKAI_QWEN_DEVICE', 'cuda:0')
        model = Qwen3ASRModel.from_pretrained(
            os.environ.get('DESKAI_QWEN_MODEL', 'Qwen/Qwen3-ASR-0.6B'),
            dtype=torch.float32 if device == 'cpu' else torch.float16,
            device_map=device, max_inference_batch_size=1, max_new_tokens=256)
    send({'ready': True})
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            audio, rate = sf.read(io.BytesIO(base64.b64decode(request['wav'])), dtype='float32')
            with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                result = model.transcribe(audio=(audio, rate), language=None)
            send({'id': request['id'], 'text': result[0].text})
        except Exception:
            send({'id': request.get('id') if request else None, 'error': 'QWEN_ASR_INFERENCE_FAILED'})


if __name__ == '__main__':
    main()
