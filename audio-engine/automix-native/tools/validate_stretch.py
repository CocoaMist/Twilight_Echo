"""Development Signalsmith objective oracle; does not replace listening."""
import argparse
import json
import subprocess
from pathlib import Path
import numpy as np
p = argparse.ArgumentParser()
p.add_argument('probes', type=Path)
p.add_argument('output', type=Path)
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
sr, frames, start = 48000, 48000*6, 48000
t = np.arange(sr*9, dtype=np.float64)/sr
tone = (0.18*np.sin(2*np.pi*440*t)).astype(np.float32)
harmonics = sum(0.1/i*np.sin(2*np.pi*220*i*t) for i in range(1, 7)).astype(np.float32)
clicks = np.zeros_like(tone)
for i in range(sr, len(clicks)-sr, sr//2):
    clicks[i:i+480] = np.exp(-np.arange(480)/70).astype(np.float32)*0.5
fixtures = {'tone': np.stack([tone, tone], axis=1),
            'anti-phase': np.stack([tone, -tone], axis=1),
            'harmonics': np.stack([harmonics, harmonics], axis=1),
            'transients': np.stack([clicks, clicks], axis=1)}
report = {'schemaVersion': 1, 'kind': 'signalsmith-objective-comparison',
          'listeningPassed': False, 'waveformEquivalenceRequired': False, 'results': []}
for name, pcm in fixtures.items():
    file = a.output/f'{name}-input.f32'
    pcm.tofile(file)
    for rate in [0.92, 0.96, 1.04, 1.08]:
        ref = a.output/f'{name}-{rate}-upstream.f32'
        common = [str(file), None, str(sr), '2', str(frames), str(rate), str(start)]
        args = common.copy(); args[1] = str(ref)
        subprocess.run([str(a.probes/'automix_reference_stretch.exe'), *args], check=True)
        reference = np.fromfile(ref, dtype=np.float32).reshape(-1, 2)
        for cpu in ['c', 'sse2', 'avx2']:
            target = a.output/f'{name}-{rate}-{cpu}.f32'
            args = common.copy(); args[1] = str(target)
            r = subprocess.run([str(a.probes/'automix_stretch_probe.exe'), *args, cpu])
            if r.returncode == 3: continue
            r.check_returncode()
            actual = np.fromfile(target, dtype=np.float32).reshape(-1, 2)
            # Exclude the start/end windows: algorithms have distinct windows.
            x, y = reference[sr//2:-sr//2, 0], actual[sr//2:-sr//2, 0]
            rms_difference = float(20*np.log10(np.sqrt(np.mean(y*y)/np.mean(x*x))))
            stereo_error = float(np.max(np.abs(actual[:,0] + actual[:,1] if name == 'anti-phase'
                                               else actual[:,0] - actual[:,1])))
            entry = {'fixture': name, 'rate': rate, 'cpu': cpu, 'rmsDifferenceDb': rms_difference,
                     'stereoMaxError': stereo_error}
            if name != 'transients':
                n = sr*4
                freq = lambda z: float(np.argmax(np.abs(np.fft.rfft(z[:n]*np.hanning(n))))*sr/n)
                entry['referencePitchHz'], entry['nativePitchHz'] = freq(x), freq(y)
                pitch_ok = abs(entry['referencePitchHz']-entry['nativePitchHz']) <= 0.5
            else:
                # Compare transient locations (rate mapping), not phase.
                def peaks(z):
                    e = np.convolve(z*z, np.ones(240)/240, mode='same')
                    candidates = np.flatnonzero((e[1:-1] > e[:-2]) & (e[1:-1] >= e[2:]) & (e[1:-1] > e.max()*0.3))+1
                    chosen = []
                    for v in candidates:
                        if not chosen or v-chosen[-1] > sr*0.15: chosen.append(v)
                        elif e[v] > e[chosen[-1]]: chosen[-1] = v
                    return np.array(chosen)
                px, py = peaks(x), peaks(y)
                entry['referenceTransients'], entry['nativeTransients'] = len(px), len(py)
                entry['transientMaxErrorSeconds'] = float(np.max(np.abs(px-py))/sr) if len(px)==len(py) and len(px) else 999
                pitch_ok = entry['transientMaxErrorSeconds'] <= 0.04
            entry['passed'] = bool(np.isfinite(actual).all() and abs(rms_difference) <= 1.5 and stereo_error <= 1e-6 and pitch_ok)
            report['results'].append(entry)
            print(json.dumps(entry), flush=True)
            (a.output/'stretch.validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
            assert entry['passed'], 'objective stretch comparison failed'
report['passed'] = True
(a.output/'stretch.validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
