"""Real music YAMNet/frontend/voice oracle. All audio/evidence stays external.

Uses the locked public TensorFlow source and checkpoint, without a production
TensorFlow dependency. Patch coverage follows real PCM, never padded silence.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

os.environ['TF_USE_LEGACY_KERAS'] = '1'
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
import tensorflow as tf

p = argparse.ArgumentParser()
p.add_argument('assets', type=Path)
p.add_argument('probes', type=Path)
p.add_argument('reference', type=Path)
p.add_argument('weights', type=Path)
p.add_argument('output', type=Path)
p.add_argument('--song', type=Path, action='append', required=True)
p.add_argument('--start', type=float, default=30)
p.add_argument('--seconds', type=float, default=5)
p.add_argument('--paths', nargs='+', default=['c', 'sse2', 'avx2'])
a = p.parse_args()
assert 0.975 <= a.seconds <= 30
a.output.mkdir(parents=True, exist_ok=True)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
lock = json.loads((Path(__file__).parents[1] / 'dependencies.lock.json').read_text())['models']['yamnet']
assert sha(a.weights) == lock['weightsSha256']
assert sha(a.assets / 'yamnet.tamg') == lock['graphSha256']
for name, digest in lock['sourceFiles'].items():
    assert sha(a.reference / name) == digest
sys.path.insert(0, str(a.reference))
import features
import params
import yamnet

tf.config.threading.set_intra_op_parallelism_threads(4)
tf.config.threading.set_inter_op_parallelism_threads(1)
param = params.Params()
full = yamnet.yamnet_frames_model(param)
full.load_weights(str(a.weights))
weights = full.get_weights()
patches = tf.keras.layers.Input(shape=(96, 64), batch_size=1, dtype=tf.float32)
scores, _ = yamnet.yamnet(patches, param)
model = tf.keras.Model(patches, scores)
model.set_weights(weights)
report = {'schemaVersion': 1, 'kind': 'real-music-voice-parity',
          'publicCommit': lock['commit'], 'graphSha256': lock['graphSha256'],
          'listeningPassed': False, 'results': []}

def save():
    (a.output / 'voice.validation.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')

for index, song in enumerate(a.song):
    with sf.SoundFile(song) as f:
        start = min(a.start, max(0, len(f) / f.samplerate - a.seconds))
        f.seek(round(start * f.samplerate))
        pcm = f.read(round(a.seconds * f.samplerate), dtype='float32', always_2d=True)
        rate = f.samplerate
    mono = pcm.mean(axis=1)
    if np.mean(mono**2) < np.max(np.mean(pcm**2, axis=0)) * 0.02:
        mono = pcm[:, np.argmax(np.mean(pcm**2, axis=0))]
    factor = gcd(rate, 16000)
    wave = resample_poly(mono, 16000 // factor, rate // factor).astype(np.float32)
    assert len(wave) >= 15600
    offsets = list(range(0, len(wave) - 15600 + 1, 7680))
    if offsets[-1] != len(wave) - 15600:
        offsets.append(len(wave) - 15600)
    source_digest = sha(song)
    for patch, offset in enumerate(offsets):
        prefix = a.output / f'music-{index:02d}-patch-{patch:02d}'
        x = wave[offset:offset + 15600]
        x.tofile(str(prefix) + '-pcm.f32')
        upstream_mel, upstream_patches = features.waveform_to_log_mel_spectrogram_patches(tf.constant(x), param)
        expected = model(upstream_patches, training=False).numpy().flatten()
        for cpu in a.paths:
            native_mel = Path(str(prefix) + f'-{cpu}-mel.f32')
            r = subprocess.run([str(a.probes / 'automix_frontend_probe.exe'), 'yamnet',
                                str(prefix) + '-pcm.f32', str(native_mel), '96', cpu], capture_output=True, text=True)
            if r.returncode == 3:
                report['results'].append({'fixture': index, 'cpu': cpu, 'status': 'unavailable'})
                continue
            r.check_returncode()
            actual_mel = np.fromfile(native_mel, dtype=np.float32).reshape(96, 64)
            mel_error = float(np.max(np.abs(actual_mel - upstream_mel.numpy())))
            native_scores = Path(str(prefix) + f'-{cpu}-scores.f32')
            result = subprocess.run([str(a.probes / 'automix_graph_probe.exe'), str(a.assets / 'yamnet.tamg'),
                                     str(native_mel), str(native_scores), cpu], check=True, capture_output=True, text=True)
            actual = np.fromfile(native_scores, dtype=np.float32)
            probability_error = float(np.max(np.abs(expected - actual)))
            passed = bool(mel_error <= 0.0002 and probability_error <= 0.001)
            entry = {'fixture': index, 'source': str(song), 'sourceSha256': source_digest, 'patch': patch,
                     'startSeconds': start + offset / 16000, 'endSeconds': start + (offset + 15600) / 16000,
                     'cpu': cpu, 'frontendMaxAbsError': mel_error, 'probabilityMaxAbsError': probability_error,
                     'referenceVoice': float(expected[:35].max()), 'nativeVoice': float(actual[:35].max()),
                     'referenceVoiceClass': int(expected[:35].argmax()),
                     'referenceMusic': float(expected[132]), 'nativeMusic': float(actual[132]),
                     'passed': passed, 'runtime': result.stdout.strip()}
            report['results'].append(entry)
            save()
            print(json.dumps(entry, ensure_ascii=True), flush=True)
            assert passed, 'real music frontend/voice parity failed'
assert any(r.get('referenceVoice', 0) > 0.5 for r in report['results']), 'oracle needs a real vocal passage'
assert any(r.get('referenceVoice', 1) < 0.1 for r in report['results']), 'oracle needs a real non-vocal passage'
report['passed'] = True
save()
