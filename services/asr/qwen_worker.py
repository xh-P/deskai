"""Line-delimited private child protocol. Model output is kept off stdout."""
import base64
import contextlib
import io
import json
import os
import sys

from qwen_engine import QwenEngine


def send(value):
    print(json.dumps(value, ensure_ascii=True), file=sys.__stdout__, flush=True)


def main():
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import soundfile as sf
            config = json.loads(os.environ['DESKAI_QWEN_RUNTIME'])
            model = QwenEngine(config['model'], config['device'], **config['inference'])
    except Exception:
        send({'startupError': 'QWEN_ASR_INITIALIZATION_FAILED'})
        raise
    send({'ready': True, 'runtime': model.startup})
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            audio, rate = sf.read(io.BytesIO(base64.b64decode(request['wav'])), dtype='float32')
            with contextlib.redirect_stdout(sys.stderr):
                text, metrics = model.transcribe(audio, rate)
            send({'id': request['id'], 'text': text, 'metrics': metrics})
        except Exception:
            send({'id': request.get('id') if request else None, 'error': 'QWEN_ASR_INFERENCE_FAILED'})


if __name__ == '__main__':
    main()
