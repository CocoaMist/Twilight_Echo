"""Re-render a source-verified frozen corpus through native JSON ownership and DSP.

Reuses unchanged raw public-model windows. Never assigns suitability or listening.
"""
import argparse
import json
import os
import subprocess
import time
from collections import Counter
from pathlib import Path
import numpy as np
import soundfile as sf
import torch
import torchaudio
from render_pairs import Features, binary, save, sha
from merge_windows import merge


def main():
    parser = argparse.ArgumentParser()
    for name in ('corpus', 'baseline', 'probe', 'windows-probe', 'output', 'scratch'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--comparison', type=Path, help='Previously rendered evaluation directory; raw analysis still comes from --baseline')
    parser.add_argument('--rule-version', default='twilight-rules-3')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    args.scratch.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(2)
    raw_report = json.loads((args.baseline / 'pairs.validation.json').read_text(encoding='utf-8'))
    comparison = args.comparison or args.baseline
    before = json.loads((comparison / 'pairs.validation.json').read_text(encoding='utf-8'))
    corpus = json.loads(args.corpus.read_text(encoding='utf-8'))
    assert sha(args.corpus) == before['manifestSha256'] == raw_report['manifestSha256']
    assert len(corpus['pairs']) == len(before['pairs']) == 36
    report = {'schemaVersion': 5, 'ruleVersion': args.rule_version, 'manifestSha256': sha(args.corpus),
              'baselineReportSha256': sha(comparison / 'pairs.validation.json'),
              'rawAnalysisReportSha256': sha(args.baseline / 'pairs.validation.json'),
              'rawAnalysisReused': True, 'rawAnalysisDllSha256': raw_report['analysisDllSha256'],
              'rendererSha256': sha(args.probe), 'windowsProbeSha256': sha(args.windows_probe),
              'pcmRoute': 'libsndfile/torchaudio context PCM; production JSON ownership and C/SSE2/AVX2 selection/mapping/rendering',
              'suitabilityAnnotated': False, 'humanListeningPassed': False, 'releaseReady': False, 'pairs': []}
    verified = {}
    def comparison_wave(pair, mode):
        output = pair['outputs'][mode+'-after']
        path = comparison / (output['file'] if isinstance(output, dict) else output)
        if isinstance(output, dict): assert sha(path) == output['sha256']
        wave, rate = sf.read(path, dtype='float32', always_2d=True)
        assert rate == 48000
        return wave / pair['modes'][mode]['sharedComparisonGain']
    def identity(path):
        path = str(path)
        if path not in verified:
            verified[path] = sha(path)
        return verified[path]

    def decode(path, origin, end):
        with sf.SoundFile(path) as file:
            rate = file.samplerate
            first = max(0, int(origin * rate / 48000) - 128)
            file.seek(first)
            pcm = file.read(min(file.frames - first, int(end * rate / 48000) - first + 256), dtype='float32', always_2d=True)
        if pcm.shape[1] == 1:
            pcm = np.repeat(pcm, 2, axis=1)
        assert pcm.shape[1] == 2
        if rate != 48000:
            pcm = torchaudio.functional.resample(torch.from_numpy(pcm.T.copy()), rate, 48000).numpy().T.copy()
        offset = origin - round(first / rate * 48000)
        assert offset >= 0 and len(pcm) >= offset + end - origin
        return pcm[offset:offset + end - origin].copy()

    for item in corpus['pairs']:
        now = time.monotonic()
        previous = next(p for p in before['pairs'] if p['id'] == item['id'])
        paths = [Path(item[k]) for k in ('current', 'next')]
        identities = [identity(p) for p in paths]
        assert identities == previous['sourceSha256']
        windows = [json.loads((args.baseline / f'{item["id"]}-{side}-windows.json').read_text(encoding='utf-8')) for side in ('current', 'next')]
        for deck in (0, 1):
            assert all(f['sourceIdentity'] == identities[deck] for f in windows[deck])
        entry = {'id': item['id'], 'currentTitle': paths[0].stem, 'nextTitle': paths[1].stem,
                 'sourceSha256': identities, 'modes': {}, 'outputs': {}, 'rawWindowSha256': []}
        for side in ('current', 'next'):
            raw = args.baseline / f'{item["id"]}-{side}-windows.json'
            entry['rawWindowSha256'].append(sha(raw))
        for mode in ('natural', 'dj'):
            files = []
            for d in (0, 1):
                actual = windows[d] if mode == 'dj' else windows[d][:1]
                request = args.scratch / 'windows.json'
                request.write_text(json.dumps({'features': actual[0], 'windows': actual}), encoding='utf-8')
                file = args.scratch / f'{mode}-{d}.features'
                subprocess.run([str(args.windows_probe), '--export-automix-windows', str(request), str(file)], check=True, capture_output=True)
                native = Features.from_buffer_copy(file.read_bytes())
                mirror = Features.from_buffer_copy(binary(merge(actual)))
                for field in ('start', 'end', 'duration', 'complete', 'nb', 'nd', 'nv', 'nf', 'ns'):
                    assert getattr(native, field) == getattr(mirror, field), (item['id'], mode, field)
                for field, count in (('beats','nb'), ('downbeats','nd'), ('voice','nv'), ('music','nv'), ('voice_start','nv'), ('voice_end','nv'), ('frame_db','nf'), ('frame_peak','nf'), ('onset','ns'), ('low_db','ns')):
                    count = getattr(native, count)
                    assert np.max(np.abs(np.asarray(getattr(native, field))[:count] - np.asarray(getattr(mirror, field))[:count]), initial=0) < 1e-5, (item['id'], mode, field)
                files.append(file)
            plan_file, mix_file = args.scratch/'plan.json', args.scratch/'mixed.f32'
            pcm_files = [args.scratch/f'{d}.f32' for d in (0, 1)]
            argv = [args.probe, *files, pcm_files[0], 0, pcm_files[1], 0, 48000, 2, mode, 'c', mix_file, plan_file, *identities]
            subprocess.run(list(map(str, argv)), env={**os.environ, 'TA_AM_PROBE_SELECT_ONLY': '1'}, capture_output=True, check=True)
            chosen = json.loads(plan_file.read_text())
            if chosen['intelligent']:
                origins = [max(0, chosen[side+'Start'] - 96000) for side in ('current', 'next')]
                ends = [min(round(windows[d][0]['coverage']['endSeconds' if d == 0 else 'durationSeconds'] * 48000), chosen[side+'End'] + 96000) for d, side in enumerate(('current', 'next'))]
                pcm = [decode(p, s, e) for p, s, e in zip(paths, origins, ends)]
                for file, wave in zip(pcm_files, pcm): wave.tofile(file)
                argv[4], argv[6] = origins
                reference = plan = None
                maximum = 0
                timings = []
                for cpu in ('c', 'sse2', 'avx2'):
                    argv[10] = cpu
                    t = time.monotonic()
                    cp = subprocess.run(list(map(str, argv)), capture_output=True, text=True)
                    if cp.returncode == 3: continue
                    assert cp.returncode == 0, (item['id'], mode, cp.stderr)
                    timings.append(round((time.monotonic() - t) * 1000))
                    observed = json.loads(plan_file.read_text())
                    assert observed['intelligent'] and (plan is None or observed == plan), (item['id'], mode, cpu, observed, plan)
                    plan = observed
                    wave = np.fromfile(mix_file, dtype='<f4').reshape(-1,2)
                    if reference is not None: maximum = max(maximum, float(np.max(np.abs(wave-reference))))
                    reference = wave.copy()
                assert maximum <= .0002 and np.isfinite(reference).all()
                entry_error = float(np.max(np.abs(reference[0] - pcm[0][chosen['currentStart'] - origins[0]])))
                exit_error = float(np.max(np.abs(reference[-1] - pcm[1][chosen['nextEnd'] - origins[1] - 1])))
                peak = float(np.max(np.abs(reference[480:-480])))
                assert max(entry_error, exit_error) <= 1e-6 and peak <= .9801
                entry['modes'][mode] = {**plan, 'prepareMs': timings, 'maxCpuSampleError': maximum,
                                       'entrySampleError': entry_error, 'exitSampleError': exit_error, 'bodyPeak': peak}
                if plan.get('strategy') == 'tail-overlap':
                    # An independent witness from decoded stereo PCM at full
                    # output rate, using the renderer's exact gain correction.
                    frames = plan['outputFrames']; size = frames // 960
                    lanes = [pcm[d][chosen[side+'Start']-origins[d]:chosen[side+'Start']-origins[d]+frames]
                             for d, side in enumerate(('current', 'next'))]
                    p = np.arange(frames, dtype=np.float64) / (frames - 1)
                    gains = [np.cos(p*np.pi/2), np.sin(p*np.pi/2)*(plan['nextGain']+(1-plan['nextGain'])*p)]
                    raw_mix = lanes[0]*gains[0][:,None] + lanes[1]*gains[1][:,None]
                    energy = np.sum(raw_mix*raw_mix, axis=1)
                    headroom = np.divide(np.sum(reference*raw_mix, axis=1), energy,
                                         out=np.ones(frames), where=energy>1e-12)
                    assert headroom.min() >= -.0002 and headroom.max() <= 1.0002
                    residual = float(np.max(np.abs(reference-raw_mix*headroom[:,None])))
                    assert residual < .0002, (item['id'], 'prepared shared headroom witness', residual)
                    headroom = np.clip(headroom, 0, 1)
                    powers = [np.mean((lanes[d][:size*960].astype(np.float64)*(gains[d]*headroom)[:size*960,None]).reshape(size,960,2)**2,axis=(1,2)) for d in (0,1)]
                    endpoint = max(float(np.mean(lanes[0][:48000].astype(np.float64)**2)),float(np.mean(lanes[1][-48000:].astype(np.float64)**2)))
                    audible = max(10**(-55/10), endpoint*10**(-24/10))
                    joint = float(np.sum((powers[0]>=audible)&(powers[1]>=audible))*.02)
                    assert joint >= frames/48000*.5, (item['id'], 'real PCM jointly audible', joint)
                    entry['modes'][mode]['pcmJointAudibleSeconds'] = round(joint, 3)
                    entry['modes'][mode]['pcmJointThresholdDb'] = round(10*np.log10(audible), 3)
                    entry['modes'][mode]['pcmEvidenceStage'] = 'decoded stereo, exact gain curve and verified prepared shared headroom'
                    entry['modes'][mode]['pcmHeadroomWitnessError'] = residual
                after = np.concatenate([pcm[0][:chosen['currentStart']-origins[0]], reference, pcm[1][chosen['nextEnd']-origins[1]:]])
            else:
                entry['modes'][mode] = chosen
                after = comparison_wave(previous, mode)
            old = comparison_wave(previous, mode)
            gain = min(1, .98 / max(float(np.max(np.abs(old))), float(np.max(np.abs(after))), 1e-9))
            for label, wave in (('before', old), ('after', after)):
                name = f'{item["id"]}-{mode}-{label}.wav'
                sf.write(args.output/name, wave*gain, 48000, subtype='PCM_24')
                entry['outputs'][mode+'-'+label] = {'file':name, 'sha256':sha(args.output/name)}
            entry['modes'][mode]['sharedComparisonGain'] = gain
        entry['elapsedMs'] = round((time.monotonic()-now)*1000)
        report['pairs'].append(entry)
        report['summary'] = {m:{'beforeSuccess':sum(p['modes'][m]['intelligent'] for p in before['pairs']),
                              'afterSuccess':sum(p['modes'][m]['intelligent'] for p in report['pairs']),
                              'beforeLongMixes':sum(p['modes'][m].get('outputFrames',0)>=16*48000 for p in before['pairs']),
                              'afterLongMixes':sum(p['modes'][m].get('outputFrames',0)>=16*48000 for p in report['pairs']),
                              'strategies':dict(Counter(p['modes'][m].get('strategy') for p in report['pairs'] if p['modes'][m]['intelligent'])),
                              'failureReasons':dict(Counter(p['modes'][m].get('reason') for p in report['pairs'] if not p['modes'][m]['intelligent']))} for m in ('natural','dj')}
        save(args.output/'pairs.validation.json',report)
        print(json.dumps({'pair':item['id'], 'summary':report['summary']}),flush=True)
    report['passed'] = True
    save(args.output/'pairs.validation.json',report)


if __name__ == '__main__': main()
