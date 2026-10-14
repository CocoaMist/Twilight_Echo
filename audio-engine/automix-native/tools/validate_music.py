"""Real music numerical oracle. Local PCM and evidence stay outside the repo.

Checks the locked public PyTorch model + frontend + minimal postprocessor,
the converted graph, and every forced native path. This is not a listening gate.
"""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
import numpy as np
import onnxruntime as ort
import soundfile as sf
import torch
import torchaudio

p = argparse.ArgumentParser()
p.add_argument('assets', type=Path)
p.add_argument('probes', type=Path)
p.add_argument('reference', type=Path)
p.add_argument('checkpoint', type=Path)
p.add_argument('output', type=Path)
p.add_argument('--song', type=Path, action='append', required=True)
p.add_argument('--start', type=float, default=30)
p.add_argument('--paths', nargs='+', default=['c', 'sse2', 'avx2'])
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(a.reference))
from beat_this.inference import load_model
from beat_this.preprocessing import LogMelSpect
from beat_this.model.postprocessor import Postprocessor
lock = json.loads((Path(__file__).parents[1] / 'dependencies.lock.json').read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
model_lock = lock['models']['beat-this-small0']
assert sha(a.checkpoint) == model_lock['weightsSha256']
assert sha(a.assets / 'beat-this.tamg') == model_lock['graphSha256']
commit = subprocess.check_output(['git', '-C', str(a.reference), 'rev-parse', 'HEAD'], text=True).strip()
assert commit == model_lock['commit']
torch.set_num_threads(4)
model, frontend, post = load_model(str(a.checkpoint)), LogMelSpect(), Postprocessor('minimal')
session = ort.InferenceSession(str(a.assets / 'beat-this-fixed.onnx'), providers=['CPUExecutionProvider'])
report = {'schemaVersion': 1, 'kind': 'real-music-numerical-parity', 'publicCommit': commit,
          'graphSha256': model_lock['graphSha256'], 'listeningPassed': False, 'results': []}

def save():
    (a.output / 'music.validation.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')

def run(name, *args):
    r = subprocess.run([str(a.probes / (name + '.exe')), *map(str, args)], capture_output=True, text=True)
    if r.returncode != 3:
        r.check_returncode()
    return r

for index, song in enumerate(a.song):
    with sf.SoundFile(song) as f:
        start = min(a.start, max(0, len(f) / f.samplerate - 30))
        f.seek(round(start * f.samplerate))
        pcm = f.read(round(30 * f.samplerate), dtype='float32', always_2d=True)
        rate = f.samplerate
    assert len(pcm) >= 2 * rate
    mono = pcm.mean(axis=1)
    if np.mean(mono**2) < np.max(np.mean(pcm**2, axis=0)) * 0.02:
        mono = pcm[:, np.argmax(np.mean(pcm**2, axis=0))]
    wave = torchaudio.functional.resample(torch.from_numpy(mono.copy()), rate, 22050)
    wave = torch.nn.functional.pad(wave[:661500], (0, max(0, 661500-len(wave))))
    fixture = a.output / f'music-{index:02d}'
    wave.numpy().tofile(str(fixture) + '-pcm.f32')
    with torch.inference_mode():
        mel = frontend(wave)[:1500]
        logits = model(mel.unsqueeze(0))
        expected = np.concatenate([logits['beat'].numpy().flatten(), logits['downbeat'].numpy().flatten()])
        beats, downbeats = post(logits['beat'].squeeze(0), logits['downbeat'].squeeze(0))
    expected.tofile(str(fixture) + '-torch-logits.f32')
    upstream_mel = mel.numpy()
    converted = np.concatenate([v.flatten() for v in session.run(None, {session.get_inputs()[0].name: upstream_mel[None]})])
    converted_error = float(np.max(np.abs(converted-expected)))
    assert converted_error <= 0.002
    for cpu in a.paths:
        native_mel = str(fixture) + f'-{cpu}-mel.f32'
        result = run('automix_frontend_probe', 'beat-this', str(fixture)+'-pcm.f32', native_mel, 1500, cpu)
        if result.returncode == 3:
            report['results'].append({'fixture': index, 'cpu': cpu, 'status': 'unavailable'})
            continue
        actual_mel = np.fromfile(native_mel, dtype=np.float32).reshape(1500, 128)
        mel_error = float(np.max(np.abs(upstream_mel-actual_mel)))
        native_logit_path = str(fixture) + f'-{cpu}-logits.f32'
        runtime = run('automix_graph_probe', a.assets/'beat-this.tamg', native_mel, native_logit_path, cpu).stdout.strip()
        actual = np.fromfile(native_logit_path, dtype=np.float32)
        logit_error = float(np.max(np.abs(expected-actual)))
        event_path = str(fixture) + f'-{cpu}-events.json'
        run('automix_events_probe', native_logit_path, event_path)
        events = json.loads(Path(event_path).read_text())
        event_errors = []
        for name, reference_events in [('beats', beats), ('downbeats', downbeats)]:
            native_events = np.array(events[name])
            event_errors.append(float(np.max(np.abs(native_events-reference_events)))
                                if len(native_events) == len(reference_events) and len(native_events)
                                else 0 if len(native_events) == len(reference_events) else float('inf'))
        passed = bool(mel_error <= 0.0002 and logit_error <= 0.002 and max(event_errors) <= 0.02000001)
        entry = {'fixture': index, 'source': str(song), 'sourceSha256': sha(song), 'startSeconds': start,
                 'cpu': cpu, 'beatCount': len(beats), 'downbeatCount': len(downbeats),
                 'frontendMaxAbsError': mel_error, 'convertedMaxAbsError': converted_error,
                 'logitMaxAbsError': logit_error, 'eventMaxSecondsError': max(event_errors),
                 'passed': passed, 'runtime': runtime}
        print(json.dumps(entry, ensure_ascii=True), flush=True)
        report['results'].append(entry)
        save()
        assert passed, 'real music model/frontend/event parity failed'
assert any(r.get('beatCount', 0) > 8 for r in report['results']), 'music oracle needs actual detected events'
report['passed'] = True
save()
