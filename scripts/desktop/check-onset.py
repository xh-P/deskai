"""Acoustic onset check of synthetic fake-media only; never opens a device."""
import json
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import correlate

root = Path(__file__).resolve().parents[2]
source, source_rate = sf.read(root / '.cache/desktop-smoke/input.wav')
captured, captured_rate = sf.read(root / 'outputs/desktop-validation/m1/synthetic-first-segment.wav')
assert source_rate == captured_rate == 16000
correlation = correlate(source, captured, mode='full', method='fft')
lag = int(correlation.argmax() - (len(captured) - 1))
aligned = source[max(lag, 0):max(lag, 0) + len(captured)]
count = min(len(aligned), len(captured))
coefficient = float(np.corrcoef(aligned[:count], captured[:count])[0, 1])
source_onset = int(np.flatnonzero(np.abs(source) > .01)[0])
padding = (source_onset - lag) / source_rate
result = dict(simulated=True, correlation=round(coefficient, 6), alignmentSeconds=lag / source_rate,
              sourceFirstVoiceSeconds=source_onset / source_rate,
              preservedLeadingSeconds=round(padding, 6), captureSeconds=len(captured) / captured_rate,
              passed=coefficient >= .65 and padding >= .03 and len(captured) / captured_rate > padding + .2,
              note='Waveform alignment checks synthetic onset retention; ASR spelling and automatic language identification are separate checks.')
print(json.dumps(result))
