"""C11 vs forced handwritten paths across the complete real-PCM analysis."""
import argparse
import ctypes as c
import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio

class Features(c.Structure):
    _fields_ = [(name, c.c_double) for name in ['start', 'end', 'duration']] + [
        (name, c.c_uint32) for name in ['complete', 'nb', 'nd', 'nv']] + [
        (name, c.c_float) for name in ['bpm', 'tempo', 'rms', 'peak', 'key_confidence']] + [
        ('key', c.c_int32), ('beats', c.c_double * 6000), ('downbeats', c.c_double * 6000),
        ('voice', c.c_float * 1024), ('music', c.c_float * 1024),
        ('voice_start', c.c_double * 1024), ('voice_end', c.c_double * 1024),
        ('frame_db', c.c_float * 6000), ('frame_peak', c.c_float * 6000), ('nf', c.c_uint32), ('onset', c.c_float * 6000), ('low_db', c.c_float * 6000), ('ns', c.c_uint32)]
assert c.sizeof(Features) == 216648
p = argparse.ArgumentParser()
p.add_argument('assets', type=Path)
p.add_argument('probes', type=Path)
p.add_argument('output', type=Path)
p.add_argument('--song', type=Path, action='append', required=True)
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
torch.set_num_threads(4)
report = {'schemaVersion': 1, 'kind': 'native-complete-analysis-differential', 'results': []}

for index, song in enumerate(a.song):
    digest = hashlib.sha256(song.read_bytes()).hexdigest()
    for seconds in [30, 7.137]:
        with sf.SoundFile(song) as f:
            assert len(f) / f.samplerate > 35
            f.seek(5 * f.samplerate)
            pcm = f.read(round(seconds * f.samplerate), dtype='float32', always_2d=True)
            sr = f.samplerate
        mono = pcm.mean(axis=1)
        if np.mean(mono**2) < np.max(np.mean(pcm**2, axis=0)) * 0.02:
            mono = pcm[:, np.argmax(np.mean(pcm**2, axis=0))]
        wave = torch.from_numpy(mono.copy())
        prefix = a.output / f'{index}-{seconds}'
        files = []
        for rate in [22050, 16000]:
            file = Path(str(prefix) + f'-{rate}.f32')
            torchaudio.functional.resample(wave, sr, rate).numpy()[:int(seconds * rate)].tofile(file)
            files.append(file)
        reference = None
        for cpu in ['c', 'sse2', 'avx2']:
            file = Path(str(prefix) + f'-{cpu}.features')
            result = subprocess.run([str(a.probes / 'automix_analysis_probe.exe'),
                str(a.assets / 'beat-this.tamg'), str(a.assets / 'yamnet.tamg'),
                *map(str, files), '0', str(seconds), str(file), cpu], capture_output=True, text=True)
            if result.returncode == 3: continue
            if result.returncode: print(result.stderr, flush=True)
            result.check_returncode()
            features = Features.from_buffer_copy(file.read_bytes())
            assert features.complete == 1 and abs(features.end - seconds) <= 1 / 16000 + 1e-9
            if reference is None: reference = features
            errors = {}
            for name, count in [('beats', features.nb), ('downbeats', features.nd), ('voice', features.nv),
                                ('music', features.nv), ('frame_db', features.nf), ('frame_peak', features.nf)]:
                x, y = np.array(getattr(reference, name))[:count], np.array(getattr(features, name))[:count]
                errors[name] = float(np.max(np.abs(x - y))) if count else 0
            scalar_error = max(abs(getattr(reference, name) - getattr(features, name))
                               for name in ['bpm', 'tempo', 'rms', 'peak', 'key_confidence'])
            passed = bool(features.nb == reference.nb and features.nd == reference.nd and
                features.nv == reference.nv and features.nf == reference.nf and features.key == reference.key and
                errors['beats'] == 0 and errors['downbeats'] == 0 and max(errors.values()) <= 0.001 and scalar_error <= 0.001)
            entry = {'fixture': index, 'sourceSha256': digest, 'seconds': seconds, 'cpu': cpu,
                     'key': features.key, 'keyConfidence': features.key_confidence,
                     'arrayMaxAbsErrors': errors, 'scalarMaxAbsError': scalar_error, 'passed': passed}
            print(json.dumps(entry), flush=True)
            report['results'].append(entry)
            (a.output / 'native-analysis.validation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
            assert passed, 'complete native analysis paths differ'
report['passed'] = True
(a.output / 'native-analysis.validation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
