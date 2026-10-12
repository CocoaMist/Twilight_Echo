"""Frozen real corpus, honest expanded windows, native selection and SIMD renders.

Suitability and listening remain human gates. This script never assigns them.
"""
import argparse
import copy
import ctypes as c
import json
import math
import os
import shutil
import subprocess
import time
from collections import Counter
from pathlib import Path
import numpy as np
import soundfile as sf
import torch
import torchaudio
from render_pairs import binary, sha, save


def merge(windows):
    windows = sorted(windows, key=lambda f: f['coverage']['startSeconds'])
    out = copy.deepcopy(windows[0])
    start = out['coverage']['startSeconds']
    end = out['coverage']['endSeconds']
    for f in windows:
        if f['sourceIdentity'] != out['sourceIdentity'] or f['modelVersion'] != out['modelVersion'] or f['coverage']['durationSeconds'] != out['coverage']['durationSeconds']:
            raise RuntimeError('window identity mismatch')
        if f['coverage']['startSeconds'] > end + 1e-6:
            raise RuntimeError('coverage gap')
        end = max(end, f['coverage']['endSeconds'])
    out['coverage']['endSeconds'] = end
    out['coverage']['complete'] = start == 0 and abs(end - out['coverage']['durationSeconds']) < 1e-4
    for field in ['beats', 'downbeats']:
        out[field] = []
        for t in sorted(t for f in windows for t in f[field]):
            if not out[field] or t - out[field][-1] > .08:
                out[field].append(t)
    fields = ['frameDb', 'framePeak']
    if all('frameOnset' in f and 'frameLowDb' in f for f in windows):
        fields += ['frameOnset', 'frameLowDb']
    for field in fields:
        out[field] = []
    for i in range(math.ceil((end - start) * 50 - 1e-6)):
        t = start + i / 50
        candidates = [f for f in windows if f['coverage']['startSeconds'] <= t < f['coverage']['endSeconds']]
        if not candidates:
            raise RuntimeError('missing real frame')
        f = max(candidates, key=lambda f: min(t - f['coverage']['startSeconds'], f['coverage']['endSeconds'] - t))
        j = min(len(f['frameDb']) - 1, max(0, math.floor((t - f['coverage']['startSeconds']) * 50)))
        for field in fields:
            out[field].append(f[field][j])
    out['rmsDb'] = 10 * math.log10(max(1e-16, sum(10 ** (x / 10) for x in out['frameDb']) / len(out['frameDb'])))
    out['tempoConfidence'] = min(f['tempoConfidence'] for f in windows)
    if any(f['key'] != out['key'] for f in windows):
        out['key'], out['keyConfidence'] = -1, 0
    patches = [p for f in windows for p in f['voice']]
    bounds = sorted({t for p in patches for t in [p['startSeconds'], p['endSeconds']]})
    out['voice'] = []
    for s, e in zip(bounds, bounds[1:]):
        active = [p for p in patches if p['startSeconds'] <= (s + e) / 2 < p['endSeconds']]
        if not active or e - s < 1e-8:
            continue
        v, m = max(p['probability'] for p in active), min(p['music'] for p in active)
        if out['voice'] and abs(out['voice'][-1]['endSeconds'] - s) < 1e-7 and out['voice'][-1]['probability'] == v and out['voice'][-1]['music'] == m:
            out['voice'][-1]['endSeconds'] = e
        else:
            out['voice'].append({'startSeconds': s, 'endSeconds': e, 'probability': v, 'music': m})
    return out


def starts(duration, deck):
    lower, upper = (0, min(60, duration)) if deck else (max(0, duration - 100), duration)
    result = [0 if deck else max(0, duration - 30)]
    position = lower
    while position < upper:
        bounded = max(lower, min(position, upper - 30))
        if not any(abs(bounded - x) < 1e-4 for x in result):
            result.append(bounded)
        if bounded + 30 >= upper:
            break
        position += 25
    return result


def main():
    parser = argparse.ArgumentParser()
    for name in ['corpus', 'baseline', 'dll', 'assets', 'probe', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--reuse-analysis-dll-sha256', default='')
    parser.add_argument('--only-pair', default='')
    args = parser.parse_args()
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(2)
    dll_directory = os.add_dll_directory(str(args.dll.parent.resolve()))
    engine = c.CDLL(str(args.dll.resolve()))
    handle = c.c_void_p()
    engine.TAE_CreateEngine.argtypes = [c.POINTER(c.c_void_p)]
    engine.TAE_DestroyEngine.argtypes = [c.c_void_p]
    engine.TAE_AnalyzeAutoMix.argtypes = [c.c_void_p, c.c_char_p, c.c_char_p, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t)]
    if engine.TAE_CreateEngine(c.byref(handle)):
        raise RuntimeError('engine creation')
    dll_hash = sha(args.dll)
    corpus = json.loads(args.corpus.read_text(encoding='utf-8'))
    before = json.loads((args.baseline / 'pairs.validation.json').read_text(encoding='utf-8'))
    if before['manifestSha256'] != sha(args.corpus):
        raise RuntimeError('baseline corpus changed')
    report = {'schemaVersion': 2, 'ruleVersion': 'twilight-rules-2', 'manifestSha256': sha(args.corpus),
        'analysisDllSha256': dll_hash, 'compatibleAnalysisDllSha256': args.reuse_analysis_dll_sha256, 'rendererSha256': sha(args.probe), 'baselineReportSha256': sha(args.baseline / 'pairs.validation.json'),
        'suitabilityAnnotated': False, 'humanListeningPassed': False, 'releaseReady': False,
        'pcmRoute': 'libsndfile/torchaudio source PCM; native C/SSE2/AVX2 selection, mapping and rendering', 'pairs': []}
    def analyse(path, start=None, boundary='head'):
        identity = sha(path)
        key = boundary if start is None else format(start, '.9f')
        file = output / f'{identity}-{key}.analysis.json'
        if file.exists():
            stored = json.loads(file.read_text(encoding='utf-8'))
            if stored['dllSha256'] in [dll_hash, *args.reuse_analysis_dll_sha256.split(',')]:
                return stored['features'], stored['elapsedMs']
        options = {'sourceIdentity': identity, 'assetDirectory': str(args.assets.resolve())}
        if start is None:
            options['boundary'] = boundary
        else:
            options['rangeStartSeconds'] = start
        encoded = json.dumps(options).encode()
        now = time.monotonic()
        required = c.c_size_t()
        engine.TAE_AnalyzeAutoMix(handle, str(path).encode('utf-8'), encoded, None, 0, c.byref(required))
        if not 0 < required.value <= 512 * 1024:
            raise RuntimeError('analysis response size')
        buffer = c.create_string_buffer(required.value)
        if engine.TAE_AnalyzeAutoMix(handle, str(path).encode('utf-8'), encoded, buffer, len(buffer), c.byref(required)):
            raise RuntimeError('analysis ABI')
        features = json.loads(buffer.value)
        if not features['ok']:
            raise RuntimeError(features)
        elapsed = round((time.monotonic() - now) * 1000)
        save(file, {'dllSha256': dll_hash, 'features': features, 'elapsedMs': elapsed})
        return features, elapsed
    def decode(path, first, end):
        with sf.SoundFile(path) as file:
            sr = file.samplerate
            file.seek(round(first * sr / 48000))
            audio = file.read(math.ceil((end - first) * sr / 48000), dtype='float32', always_2d=True)
        if audio.shape[1] == 1:
            audio = np.repeat(audio, 2, axis=1)
        if audio.shape[1] != 2:
            raise RuntimeError('unsupported corpus channels')
        if sr != 48000:
            audio = torchaudio.functional.resample(torch.from_numpy(audio.T.copy()), sr, 48000).numpy().T.copy()
        if len(audio) < end - first:
            raise RuntimeError('incomplete corpus PCM')
        return audio[:end - first]
    try:
        for item in corpus['pairs']:
            if args.only_pair and item['id'] != args.only_pair:
                continue
            pair_started = time.monotonic()
            pair_id = item['id']
            paths = [Path(item['current']), Path(item['next'])]
            primary, expanded, analysis_ms = [], [], []
            for deck, path in enumerate(paths):
                f, elapsed = analyse(path, boundary='head' if deck else 'tail')
                primary.append(f)
                windows = [f]
                times = [elapsed]
                for start in starts(f['coverage']['durationSeconds'], deck)[1:]:
                    window, ms = analyse(path, start)
                    windows.append(window)
                    times.append(ms)
                expanded.append(merge(windows))
                analysis_ms.extend(times)
                save(output / f'{pair_id}-{"next" if deck else "current"}-windows.json', windows)
            entry = {'id': pair_id, 'currentTitle': paths[0].stem, 'nextTitle': paths[1].stem,
                'suitability': None, 'sourceSha256': [f['sourceIdentity'] for f in primary], 'analysisMs': analysis_ms,
                'modes': {}, 'outputs': {}}
            old = next(p for p in before['pairs'] if p['id'] == pair_id)
            for mode in ['natural', 'dj']:
                features = primary if mode == 'natural' else expanded
                files = [output / f'{pair_id}-{mode}-{deck}.features' for deck in [0, 1]]
                for file, f in zip(files, features):
                    file.write_bytes(binary(f))
                pcm_files = [output / f'{pair_id}-{mode}-{d}.f32' for d in [0, 1]]
                plan_file, mix_file = output / 'selection.json', output / 'mixed.f32'
                argv = [args.probe, files[0], files[1], pcm_files[0], 0, pcm_files[1], 0, 48000, 2, mode, 'c', mix_file, plan_file, *entry['sourceSha256']]
                selected = subprocess.run(list(map(str, argv)), env={**os.environ, 'TA_AM_PROBE_SELECT_ONLY': '1'}, capture_output=True, text=True)
                if selected.returncode:
                    raise RuntimeError(selected.stderr or 'selection probe failed')
                chosen = json.loads(plan_file.read_text(encoding='utf-8'))
                if chosen['intelligent']:
                    origins = [max(0, chosen[name + 'Start'] - 96000) for name in ['current', 'next']]
                    # The outgoing decoder may report a shorter real codec tail.
                    # Incoming DJ selections can extend beyond the primary head window.
                    ends = [min(round(primary[d]['coverage']['endSeconds' if d == 0 else 'durationSeconds'] * 48000), chosen[name + 'End'] + 96000) for d, name in enumerate(['current', 'next'])]
                    pcm = [decode(path, first, end) for path, first, end in zip(paths, origins, ends)]
                    for file, audio in zip(pcm_files, pcm):
                        audio.tofile(file)
                    argv[4], argv[6] = origins
                    reference, plan, maximum, prepare_ms = None, None, 0, []
                    for cpu in ['c', 'sse2', 'avx2']:
                        argv[10] = cpu
                        now = time.monotonic()
                        result = subprocess.run(list(map(str, argv)), capture_output=True, text=True)
                        prepare_ms.append(round((time.monotonic() - now) * 1000))
                        if result.returncode == 3:
                            continue
                        if result.returncode:
                            raise RuntimeError(result.stderr or 'render probe failed')
                        observed = json.loads(plan_file.read_text(encoding='utf-8'))
                        save(output / f'{pair_id}-{mode}-{cpu}.plan.json', observed)
                        if not observed['intelligent'] or (plan is not None and observed != plan):
                            raise RuntimeError(f'native candidate parity failed: {cpu}: {observed}; reference: {plan}')
                        plan = observed
                        audio = np.fromfile(mix_file, dtype='<f4').reshape(-1, 2)
                        if reference is not None:
                            maximum = max(maximum, float(np.max(np.abs(audio - reference))))
                        reference = audio
                    if maximum > .0002 or not np.isfinite(reference).all():
                        raise RuntimeError('render parity/nonfinite')
                    entry_error = float(np.max(np.abs(reference[0] - pcm[0][chosen['currentStart'] - origins[0]])))
                    exit_error = float(np.max(np.abs(reference[-1] - pcm[1][chosen['nextEnd'] - origins[1] - 1])))
                    peak = float(np.max(np.abs(reference[480:-480])))
                    if max(entry_error, exit_error) > 1e-6 or peak > .9801:
                        raise RuntimeError('raw source join or limiter failed')
                    entry['modes'][mode] = {**plan, 'prepareMs': prepare_ms, 'maxCpuSampleError': maximum,
                        'entrySampleError': entry_error, 'exitSampleError': exit_error, 'bodyPeak': peak}
                    start, end = chosen['currentStart'] - origins[0], chosen['nextEnd'] - origins[1]
                    audio = np.concatenate([pcm[0][:start], reference, pcm[1][end:]])
                    name = f'{pair_id}-{mode}-after.wav'
                    sf.write(output / name, audio, 48000, subtype='PCM_24')
                    entry['outputs'][mode + '-after'] = name
                    if mode == 'dj' and not (output / 'stem-fixture.json').exists():
                        save(output / 'stem-fixture.json', {'pair': pair_id, 'plan': chosen, 'paths': [str(p) for p in paths],
                            'origins': origins, 'ends': ends, 'identities': entry['sourceSha256']})
                else:
                    entry['modes'][mode] = chosen
                oldfile = args.baseline / old['outputs'][mode]['file']
                name = f'{pair_id}-{mode}-before.wav'
                shutil.copy2(oldfile, output / name)
                entry['outputs'][mode + '-before'] = name
                if mode + '-after' not in entry['outputs']:
                    name = f'{pair_id}-{mode}-after.wav'
                    shutil.copy2(args.baseline / old['outputs']['original']['file'], output / name)
                    entry['outputs'][mode + '-after'] = name
                before_pcm, _ = sf.read(output / entry['outputs'][mode + '-before'], dtype='float32', always_2d=True)
                before_pcm /= old['sharedAuditionGain']
                after_pcm, _ = sf.read(output / entry['outputs'][mode + '-after'], dtype='float32', always_2d=True)
                if not entry['modes'][mode]['intelligent']:
                    after_pcm /= old['sharedAuditionGain']
                gain = min(1, .98 / max(float(np.max(np.abs(before_pcm))), float(np.max(np.abs(after_pcm))), 1e-9))
                sf.write(output / entry['outputs'][mode + '-before'], before_pcm * gain, 48000, subtype='PCM_24')
                sf.write(output / entry['outputs'][mode + '-after'], after_pcm * gain, 48000, subtype='PCM_24')
                entry['modes'][mode]['sharedComparisonGain'] = gain
                for file in pcm_files:
                    file.unlink(missing_ok=True)
            entry['totalElapsedMs'] = round((time.monotonic() - pair_started) * 1000)
            report['pairs'].append(entry)
            report['summary'] = {mode: {'beforeSuccess': sum(p['modes'][mode]['intelligent'] for p in before['pairs']),
                'afterSuccess': sum(p['modes'][mode]['intelligent'] for p in report['pairs']),
                'longMixes': sum(p['modes'][mode].get('outputFrames', 0) >= 16 * 48000 for p in report['pairs']),
                'failureReasons': dict(Counter(p['modes'][mode].get('reason') for p in report['pairs'] if not p['modes'][mode]['intelligent']))}
                for mode in ['natural', 'dj']}
            save(output / 'pairs.validation.json', report)
            print(json.dumps({'pair': pair_id, 'summary': report['summary']}), flush=True)
    finally:
        engine.TAE_DestroyEngine(handle)
        dll_directory.close()
        save(output / 'pairs.validation.json', report)


if __name__ == '__main__':
    main()
