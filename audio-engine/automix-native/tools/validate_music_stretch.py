"""Real music objective stretch comparison. Human listening remains a gate."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio

p = argparse.ArgumentParser()
p.add_argument('probes', type=Path)
p.add_argument('output', type=Path)
p.add_argument('--song', type=Path, action='append', required=True)
p.add_argument('--start', type=float, default=30)
p.add_argument('--paths', nargs='+', default=['c', 'sse2', 'avx2'])
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
torch.set_num_threads(4)
sr, frames, pre = 48000, 48000 * 8, 48000
report = {'schemaVersion': 1, 'kind': 'real-music-stretch-objective-comparison',
          'listeningPassed': False, 'waveformEquivalenceRequired': False, 'results': []}

def save():
    (a.output / 'music-stretch.validation.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')

def metrics(x):
    # One-second spectra retain pitch resolution while averaging phase differences.
    spectrum = np.abs(np.fft.rfft(x[:sr * 6, 0].reshape(6, sr) * np.hanning(sr), axis=1)).mean(axis=0)
    norm = float(np.sqrt(np.mean(x.astype(np.float64)**2)))
    correlation = float(np.corrcoef(x[:, 0], x[:, 1])[0, 1])
    return spectrum, norm, correlation

for index, song in enumerate(a.song):
    with sf.SoundFile(song) as f:
        start = min(a.start, max(0, len(f) / f.samplerate - 11))
        f.seek(round(start * f.samplerate))
        pcm = f.read(round(11 * f.samplerate), dtype='float32', always_2d=True)
        rate = f.samplerate
    assert len(pcm) >= 11 * rate, 'fixture needs eleven seconds of real PCM'
    pcm = pcm[:, :2] if pcm.shape[1] > 1 else np.repeat(pcm, 2, axis=1)
    if rate != sr:
        pcm = torchaudio.functional.resample(torch.from_numpy(pcm.T.copy()), rate, sr).numpy().T.copy()
    fixture = a.output / f'music-{index:02d}-input.f32'
    pcm.tofile(fixture)
    digest = hashlib.sha256(song.read_bytes()).hexdigest()
    for ratio in [0.92, 0.96, 1.04, 1.08]:
        ref = a.output / f'music-{index:02d}-{ratio}-upstream.f32'
        common = [str(fixture), str(ref), str(sr), '2', str(frames), str(ratio), str(pre)]
        subprocess.run([str(a.probes / 'automix_reference_stretch.exe'), *common], check=True)
        reference = np.fromfile(ref, dtype=np.float32).reshape(-1, 2)
        sx, rmsx, cx = metrics(reference[sr:-sr])
        for cpu in a.paths:
            target = a.output / f'music-{index:02d}-{ratio}-{cpu}.f32'
            args = common.copy(); args[1] = str(target)
            result = subprocess.run([str(a.probes / 'automix_stretch_probe.exe'), *args, cpu], capture_output=True, text=True)
            if result.returncode == 3:
                report['results'].append({'fixture': index, 'cpu': cpu, 'status': 'unavailable'})
                continue
            result.check_returncode()
            actual = np.fromfile(target, dtype=np.float32).reshape(-1, 2)
            sy, rmsy, cy = metrics(actual[sr:-sr])
            cosine = float(np.dot(sx, sy) / np.sqrt(np.dot(sx, sx) * np.dot(sy, sy)))
            db = float(20 * np.log10(rmsy / rmsx))
            stereo_difference = abs(cy - cx)
            passed = bool(np.isfinite(actual).all() and abs(db) <= 1.5 and cosine >= 0.95 and stereo_difference <= 0.08)
            entry = {'fixture': index, 'source': str(song), 'sourceSha256': digest, 'startSeconds': start,
                     'rate': ratio, 'cpu': cpu, 'rmsDifferenceDb': db, 'spectralCosine': cosine,
                     'stereoCorrelationDifference': stereo_difference, 'passed': passed}
            print(json.dumps(entry, ensure_ascii=True), flush=True)
            report['results'].append(entry)
            save()
            assert passed, 'real music objective stretch comparison failed'
report['passed'] = True
save()
