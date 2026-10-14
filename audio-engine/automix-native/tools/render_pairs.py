"""Prepare local, reproducible listening comparisons; never marks human gates passed.

Create a corpus before analysis: --create-manifest <directory>. Then run against
the production analysis DLL and the development C/NASM renderer. All music,
features, renders and ratings stay in the caller's external evidence directory.
"""
import argparse
import ctypes as c
import hashlib
import json
import os
import random
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import soundfile as sf
import torch
import torchaudio

class Features(c.Structure):
    _fields_ = [(n, c.c_double) for n in ['start', 'end', 'duration']] + [
        (n, c.c_uint32) for n in ['complete', 'nb', 'nd', 'nv']] + [
        (n, c.c_float) for n in ['bpm', 'tempo', 'rms', 'peak', 'key_confidence']] + [
        ('key', c.c_int32), ('beats', c.c_double * 6000), ('downbeats', c.c_double * 6000),
        ('voice', c.c_float * 1024), ('music', c.c_float * 1024),
        ('voice_start', c.c_double * 1024), ('voice_end', c.c_double * 1024),
        ('frame_db', c.c_float * 6000), ('frame_peak', c.c_float * 6000), ('nf', c.c_uint32), ('onset', c.c_float * 6000), ('low_db', c.c_float * 6000), ('ns', c.c_uint32)]
assert c.sizeof(Features) == 216648

def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()

def save(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)

def binary(f):
    x = Features()
    for field, key in [('start', 'startSeconds'), ('end', 'endSeconds'), ('duration', 'durationSeconds'), ('complete', 'complete')]:
        setattr(x, field, f['coverage'][key])
    for field, key in [('bpm', 'bpm'), ('tempo', 'tempoConfidence'), ('rms', 'rmsDb'), ('peak', 'peak'),
                       ('key', 'key'), ('key_confidence', 'keyConfidence')]: setattr(x, field, f[key])
    for field, key, count in [('beats', 'beats', 'nb'), ('downbeats', 'downbeats', 'nd'),
                            ('frame_db', 'frameDb', 'nf'), ('frame_peak', 'framePeak', 'nf')]:
        setattr(x, count, len(f[key]))
        for i, value in enumerate(f[key]): getattr(x, field)[i] = value
    x.nv = len(f['voice'])
    for i, patch in enumerate(f['voice']):
        x.voice[i], x.music[i] = patch['probability'], patch['music']
        x.voice_start[i], x.voice_end[i] = patch['startSeconds'], patch['endSeconds']
    if 'frameOnset' in f and 'frameLowDb' in f:
        x.ns = len(f['frameOnset'])
        for i, v in enumerate(f['frameOnset']): x.onset[i] = v
        for i, v in enumerate(f['frameLowDb']): x.low_db[i] = v
    return bytes(x)

def listening_page(output, report):
    data = json.dumps({'manifestSha256': report['manifestSha256'], 'pairs': report['pairs']}, ensure_ascii=False).replace('<', '\\u003c')
    template = (Path(__file__).parent / 'listening.html').read_text(encoding='utf-8')
    (output / 'listening.html').write_text(re.sub(r'/\*CORPUS_DATA\*/\s*null', lambda _: data, template, count=1), encoding='utf-8')

def main():
    p = argparse.ArgumentParser()
    p.add_argument('manifest', type=Path)
    p.add_argument('output', type=Path)
    p.add_argument('--create-manifest', type=Path)
    p.add_argument('--pairs', type=int, default=36)
    p.add_argument('--seed', type=int, default=20261011)
    p.add_argument('--dll', type=Path)
    p.add_argument('--assets', type=Path)
    p.add_argument('--probe', type=Path)
    p.add_argument('--reuse-analysis-from', type=Path,
                   help='Reuse verified raw public-model features from this same fixed corpus; no inference rerun')
    p.add_argument('--limit', type=int)
    p.add_argument('--page-only', action='store_true')
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    if a.page_only:
        listening_page(a.output, json.loads((a.output / 'pairs.validation.json').read_text(encoding='utf-8')))
        return
    if a.create_manifest:
        if a.manifest.exists(): raise RuntimeError('Existing corpus is never silently replaced')
        songs = sorted(path.resolve() for path in a.create_manifest.rglob('*') if path.suffix.lower() in {'.flac', '.mp3', '.wav', '.ogg', '.m4a'})
        random.Random(a.seed).shuffle(songs)
        if len(songs) < a.pairs + 1: raise RuntimeError('Not enough distinct real songs')
        save(a.manifest, {'schemaVersion': 1, 'createdAt': datetime.now(timezone.utc).isoformat(), 'seed': a.seed,
             'selection': 'filename corpus shuffled before inference; no quality filtering',
             'pairs': [{'id': f'pair-{i+1:02d}', 'current': str(songs[i]), 'next': str(songs[i+1]),
                        'suitability': None, 'category': None} for i in range(a.pairs)]})
        print(f'Created {a.pairs} unannotated pairs: {a.manifest}', flush=True)
        return
    if (not a.dll and not a.reuse_analysis_from) or not a.assets or not a.probe:
        p.error('--assets, --probe and either --dll or --reuse-analysis-from are required')
    corpus = json.loads(a.manifest.read_text(encoding='utf-8'))
    torch.set_num_threads(2)
    directory, engine = None, None
    handle = c.c_void_p()
    graphs = {name: sha(a.assets / name) for name in ['beat-this.tamg', 'yamnet.tamg']}
    if a.reuse_analysis_from:
        previous_file = a.reuse_analysis_from / 'pairs.validation.json'
        previous = json.loads(previous_file.read_text(encoding='utf-8'))
        if previous['manifestSha256'] != sha(a.manifest) or previous['graphs'] != graphs:
            raise RuntimeError('Analysis reuse requires the identical corpus and public graphs')
        dll_hash = previous['analysisDllSha256']
    else:
        directory = os.add_dll_directory(str(a.dll.resolve().parent))
        engine = c.CDLL(str(a.dll.resolve()))
        engine.TAE_CreateEngine.argtypes = [c.POINTER(c.c_void_p)]
        engine.TAE_DestroyEngine.argtypes = [c.c_void_p]
        engine.TAE_AnalyzeAutoMix.argtypes = [c.c_void_p, c.c_char_p, c.c_char_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]
        if engine.TAE_CreateEngine(c.byref(handle)): raise RuntimeError('Native engine creation failed')
        dll_hash = sha(a.dll)
    probe_hash = sha(a.probe)
    report = {'schemaVersion': 1, 'kind': 'real-pair-render-evidence', 'manifestSha256': sha(a.manifest),
              'analysisDllSha256': dll_hash, 'rendererSha256': probe_hash,
              'graphs': graphs,
              'pcmRoute': 'libsndfile decode and public torchaudio resampling at 48000Hz stereo; native C/NASM prepare/mix',
              'humanListeningPassed': False, 'suitabilityAnnotated': False, 'devicePlaybackValidated': False, 'pairs': []}
    if a.reuse_analysis_from:
        report['analysisReuse'] = {'directory': str(a.reuse_analysis_from.resolve()),
            'reportSha256': sha(previous_file), 'newInferenceExecuted': False}
    cache = {}
    rate, channels = 48000, 2
    def analyse(path, boundary):
        key = (str(path), boundary)
        if key in cache: return cache[key]
        identity = sha(path)
        filename = (a.reuse_analysis_from or a.output) / f'{identity}-{boundary}.analysis.json'
        options = json.dumps({'assetDirectory': str(a.assets.resolve()), 'sourceIdentity': identity, 'boundary': boundary}).encode()
        if filename.exists():
            stored = json.loads(filename.read_text(encoding='utf-8'))
            f = stored['features'] if stored.get('dllSha256') == dll_hash and stored.get('graphs') == report['graphs'] else None
        else: f = None
        if f is None:
            if a.reuse_analysis_from: raise RuntimeError(f'Missing or mismatched analysis: {filename}')
            required = c.c_size_t()
            engine.TAE_AnalyzeAutoMix(handle, str(path).encode('utf-8'), options, None, 0, c.byref(required))
            if not 0 < required.value <= 512 * 1024: raise RuntimeError('Invalid analysis ABI length')
            buffer = c.create_string_buffer(required.value)
            if engine.TAE_AnalyzeAutoMix(handle, str(path).encode('utf-8'), options, buffer, len(buffer), c.byref(required)):
                raise RuntimeError('Native analysis ABI failed')
            f = json.loads(buffer.value)
            if not f['ok']: raise RuntimeError(f)
            save(filename, {'dllSha256': dll_hash, 'graphs': report['graphs'], 'features': f})
        if not f.get('ok') or f.get('sourceIdentity') != identity:
            raise RuntimeError('Analysis source identity mismatch')
        coverage = f['coverage']
        with sf.SoundFile(path) as source:
            sr = source.samplerate
            source.seek(round(coverage['startSeconds'] * sr))
            wave = source.read(round((coverage['endSeconds'] - coverage['startSeconds']) * sr), dtype='float32', always_2d=True)
        if wave.shape[1] == 1: wave = np.repeat(wave, 2, axis=1)
        if wave.shape[1] != 2: raise RuntimeError('Corpus multichannel requires production layout decode; do not silently downmix')
        if sr != rate: wave = torchaudio.functional.resample(torch.from_numpy(wave.T.copy()), sr, rate).numpy().T.copy()
        cache[key] = (f, wave, identity)
        # Keep only one pair's decoded PCM resident.
        return cache[key]
    try:
        for item in corpus['pairs'][:a.limit]:
            pair_id = item['id']
            if not pair_id.startswith('pair-') or not pair_id[5:].isdigit(): raise RuntimeError('Invalid corpus pair ID')
            fa, x, ah = analyse(Path(item['current']), 'tail')
            fb, y, bh = analyse(Path(item['next']), 'head')
            origin = round(fa['coverage']['startSeconds'] * rate)
            current_bin, next_bin = a.output / f'{pair_id}-current.features', a.output / f'{pair_id}-next.features'
            current_pcm, next_pcm = a.output / f'{pair_id}-current.f32', a.output / f'{pair_id}-next.f32'
            current_bin.write_bytes(binary(fa)); next_bin.write_bytes(binary(fb))
            if a.reuse_analysis_from:
                for file in [current_bin, next_bin]:
                    if file.read_bytes() != (a.reuse_analysis_from / file.name).read_bytes():
                        raise RuntimeError('Reused features differ from the original corpus inputs')
            x.tofile(current_pcm); y.tofile(next_pcm)
            length = min(22 * rate, len(x), len(y))
            tail, head = x[-length:], y[:length]
            original = np.concatenate([tail, head])
            overlap = min(6 * rate, length)
            theta = np.linspace(0, np.pi / 2, overlap, dtype=np.float32)[:, None]
            plain = np.concatenate([tail[:-overlap], tail[-overlap:] * np.cos(theta) + head[:overlap] * np.sin(theta), head[overlap:]])
            entry = {'id': pair_id, 'currentTitle': Path(item['current']).stem, 'nextTitle': Path(item['next']).stem,
                     'sourceSha256': [ah, bh], 'featureSha256': [sha(current_bin), sha(next_bin)],
                     'outputs': {}, 'modes': {}, 'renderMetrics': {}, 'suitability': None}
            outputs = {'original': original, 'crossfade': plain}
            for mode in ['natural', 'dj']:
                expected, reference = None, None
                maximum_cpu_error = 0
                for cpu in ['c', 'sse2', 'avx2']:
                    pcm_out, plan_out = a.output / f'{pair_id}-{mode}-{cpu}.f32', a.output / f'{pair_id}-{mode}-{cpu}.plan.json'
                    args = [a.probe, current_bin, next_bin, current_pcm, origin, next_pcm, 0, rate, channels, mode, cpu, pcm_out, plan_out, ah, bh]
                    completed = subprocess.run(list(map(str, args)), capture_output=True, text=True)
                    if completed.returncode == 3: continue
                    if completed.returncode: raise RuntimeError(completed.stderr or f'pair probe exit {completed.returncode}')
                    plan = json.loads(plan_out.read_text(encoding='utf-8'))
                    if expected is not None and plan != expected: raise RuntimeError('C/NASM selection or source-frame boundary differs')
                    expected = plan
                    if plan['intelligent']:
                        mixed = np.fromfile(pcm_out, dtype=np.float32).reshape(-1, channels)
                        if len(mixed) != plan['outputFrames'] or not np.isfinite(mixed).all():
                            raise RuntimeError('Invalid rendered frame count or nonfinite PCM')
                        if reference is not None:
                            maximum_cpu_error = max(maximum_cpu_error, float(np.max(np.abs(mixed - reference))))
                            if maximum_cpu_error > 0.0002: raise RuntimeError('C/NASM prepared audio differs')
                        reference = mixed
                        pcm_out.unlink()
                if expected is None: raise RuntimeError('No renderer execution path available')
                entry['modes'][mode] = expected
                if expected['intelligent']:
                    start = expected['currentStart'] - origin
                    end = expected['nextEnd']
                    edge = rate // 100
                    body_peak = float(np.max(np.abs(reference[edge:-edge])))
                    if body_peak > .9801: raise RuntimeError('Prepared overlap exceeded its headroom ceiling')
                    entry_error = float(np.max(np.abs(reference[0] - x[start])))
                    exit_error = float(np.max(np.abs(reference[-1] - y[end - 1])))
                    if max(entry_error, exit_error) > 1e-6:
                        raise RuntimeError('Prepared overlap did not rejoin real source PCM')
                    entry['renderMetrics'][mode] = {
                        'unscaledOverlapPeak': float(np.max(np.abs(reference))),
                        'bodyPeakExcludingBoundary10ms': body_peak,
                        'maxCpuSampleError': maximum_cpu_error,
                        'entrySampleError': entry_error,
                        'exitSampleError': exit_error,
                        'headroomScope': 'Prepared PCM before existing deck DSP; exact joins preserved, boundary source peaks remain possible'
                    }
                    outputs[mode] = np.concatenate([x[max(0, start - 6 * rate):start], reference, y[end:min(len(y), end + 8 * rate)]])
                else: outputs[mode] = plain.copy()
            # Apply a single gain to all four comparisons, avoiding clipping
            # while preserving the loudness differences under evaluation.
            peak = max(float(np.max(np.abs(wave))) for wave in outputs.values())
            entry['sharedAuditionGain'] = min(1, 0.98 / max(peak, 1e-9))
            for name, wave in outputs.items():
                filename = f'{pair_id}-{name}.wav'
                sf.write(a.output / filename, wave * entry['sharedAuditionGain'], rate, subtype='PCM_24')
                entry['outputs'][name] = {'file': filename, 'sha256': sha(a.output / filename), 'frames': len(wave)}
            current_pcm.unlink(); next_pcm.unlink()
            cache.clear()
            report['pairs'].append(entry)
            save(a.output / 'pairs.validation.json', report)
            listening_page(a.output, report)
            print(json.dumps({'pair': pair_id, 'natural': entry['modes']['natural'], 'dj': entry['modes']['dj']}, ensure_ascii=False), flush=True)
    finally:
        if engine: engine.TAE_DestroyEngine(handle)
        if directory: directory.close()
        save(a.output / 'pairs.validation.json', report)

if __name__ == '__main__': main()
