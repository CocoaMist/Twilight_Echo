"""Compare real native-exported PCM: base / fixed 2.2 / paired arrangement.

Tickets come from the production host's source-bound export and verified worker.
This evaluates material/DSP, never assigns musical suitability or listening.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import numpy as np
import soundfile as sf


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    for name in ('tickets', 'cache', 'legacy-worker', 'native-build', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    tickets = json.loads(args.tickets.read_text(encoding='utf-8'))
    assert tickets['passed']
    assert sha(args.legacy_worker) == 'bbc20fb23540b8519c2c93b18e9513ddafa134b22594a8fe479b950c024d186b'
    spec = importlib.util.spec_from_file_location('legacy_stem_worker', args.legacy_worker)
    legacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(legacy)
    probe = args.native_build / 'automix-native/automix_pair_probe.exe'
    window_probe = args.native_build / 'twilight_audio_performance_gate.exe'
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'passed': False, 'humanListeningPassed': False, 'suitabilityAnnotated': False,
        'corpusSha256': tickets['corpusSha256'], 'ticketReportSha256': sha(args.tickets),
        'workerSha256': sha(tickets['worker']), 'legacyWorkerSha256': sha(args.legacy_worker),
        'rendererSha256': sha(probe), 'windowsProbeSha256': sha(window_probe),
        'pcmRoute': 'production native exported source PCM; same C/SSE2/AVX2 native plan and DSP; production material edge blending', 'pairs': []}
    for item in tickets['tickets']:
        directory, selection = Path(item['directory']), item['selection']
        sr, channels = selection['sampleRate'], selection['channels']
        request = json.loads((directory / 'native-request.json').read_text(encoding='utf-8'))
        originals, wet_paths, features, lane_stats = [], {'base': [], 'fixed': [], 'adaptive': []}, [], []
        for deck, prefix in enumerate(('current', 'next')):
            descriptor = selection['inputs'][deck]
            original_path = directory / (prefix + '.f32')
            assert sha(original_path) == descriptor['sha256']
            original = np.fromfile(original_path, '<f4').reshape(-1, channels)
            originals.append(original)
            key = hashlib.sha256(json.dumps([2, descriptor['sourceIdentity'], descriptor['sha256'],
                descriptor['origin'], descriptor['frames'], sr, channels,
                legacy.CHECKPOINT_SHA256 if hasattr(legacy, 'CHECKPOINT_SHA256') else '8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4', 7.8, .25, 0]).encode()).hexdigest()
            cache = args.cache / (key + '.npy')
            metadata = json.loads(cache.with_suffix('.json').read_text(encoding='utf-8'))
            assert sha(cache) == metadata['sha256']
            stems = np.load(cache, mmap_mode='r', allow_pickle=False)
            try:
                assert stems.shape == (4, channels, descriptor['frames'])
                fixed = directory / (prefix + '-fixed.f32')
                legacy.mix_blocks(stems, original.T, fixed, selection, descriptor, deck, sr, np)
            finally:
                stems._mmap.close()
            edge = np.clip((np.minimum(np.arange(len(original)), len(original) - 1 - np.arange(len(original))) / sr - 2) / .05, 0, 1)
            wet_paths['base'].append(original_path)
            for variant in ('fixed', 'adaptive'):
                material_path = directory / (prefix + '-' + variant + '.f32')
                if variant == 'adaptive':
                    assert sha(material_path) == item['stemMaterials'][prefix]['sha256']
                material = np.fromfile(material_path, '<f4').reshape(original.shape)
                # Float32 native operations, including rounding of wet itself.
                material = original + (material - original) * edge.astype(np.float32)[:, None]
                assert np.isfinite(material).all()
                wet = directory / (prefix + '-' + variant + '-native-wet.f32')
                material.astype('<f4').tofile(wet)
                wet_paths[variant].append(wet)
                lane_stats.append({'deck': prefix, 'variant': variant,
                    'changedSampleFraction': float(np.mean(material != original)),
                    'materialDifferenceRms': float(np.sqrt(np.mean((material.astype(np.float64) - original) ** 2)))})
            windows = request[prefix + 'Windows']
            window_request = directory / (prefix + '-windows.json')
            window_request.write_text(json.dumps({'features': windows[0], 'windows': windows}), encoding='utf-8')
            feature = directory / (prefix + '.features')
            subprocess.run([str(window_probe), '--export-automix-windows', str(window_request), str(feature)], check=True, capture_output=True)
            features.append(feature)
        rendered, plans = {}, {}
        for variant in ('base', 'fixed', 'adaptive'):
            reference = None
            env = dict(os.environ)
            env.pop('TA_AM_PROBE_SELECT_ONLY', None)
            env.pop('TA_AM_PROBE_STEM_ENHANCED', None)
            if variant != 'base':
                env['TA_AM_PROBE_STEM_ENHANCED'] = '1'
            for cpu in ('c', 'sse2', 'avx2'):
                mix, detail = directory / (variant + '-' + cpu + '.f32'), directory / (variant + '-' + cpu + '.json')
                paths = wet_paths[variant]
                argv = [probe, *features, paths[0], selection['inputs'][0]['origin'], paths[1], selection['inputs'][1]['origin'],
                    sr, channels, item['mode'], cpu, mix, detail, *item['sourceSha256']]
                cp = subprocess.run(list(map(str, argv)), env=env, capture_output=True, text=True)
                if cp.returncode == 3:
                    continue
                assert cp.returncode == 0, cp.stderr
                plan = json.loads(detail.read_text(encoding='utf-8'))
                assert plan['intelligent'] and plan['stemEnhanced'] == (variant != 'base'), plan
                for field in ('currentStart', 'currentEnd', 'nextStart', 'nextEnd'):
                    assert plan[field] == round(selection[field + 'Seconds'] * sr)
                assert plan['outputFrames'] == selection['outputFrames']
                wave = np.fromfile(mix, '<f4').reshape(-1, channels)
                assert np.isfinite(wave).all()
                if reference is not None:
                    assert np.max(abs(reference - wave)) <= .0002
                reference = wave.copy()
                plans[variant + '-' + cpu] = plan
            assert reference is not None
            a = round(selection['currentStartSeconds'] * sr) - selection['inputs'][0]['origin']
            b = round(selection['nextEndSeconds'] * sr) - selection['inputs'][1]['origin']
            np.testing.assert_array_equal(reference[0], originals[0][a])
            np.testing.assert_array_equal(reference[-1], originals[1][b - 1])
            assert np.max(abs(reference[sr // 100:-sr // 100])) <= .9801
            rendered[variant] = np.concatenate((originals[0][:a], reference, originals[1][b:]))
        gain = min(1, .98 / max(float(np.max(abs(wave))) for wave in rendered.values()))
        outputs = {}
        for variant, wave in rendered.items():
            name = item['id'] + '-' + item['mode'] + '-' + variant + '.wav'
            file = args.output / name
            sf.write(file, wave * gain, sr, subtype='PCM_24')
            outputs[variant] = {'file': name, 'sha256': sha(file), 'frames': len(wave)}
        report['pairs'].append({'id': item['id'], 'mode': item['mode'], 'stemEnhanced': True, 'fallback': False,
            'selection': selection, 'resources': item['resources'], 'materialDifferences': lane_stats,
            'sourceSha256': item['sourceSha256'], 'inputPcmSha256': [x['sha256'] for x in selection['inputs']],
            'sharedAuditionGain': gain, 'plans': plans, 'outputs': outputs})
        (args.output / 'validation.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
        print('Rendered ' + item['id'] + ' ' + item['mode'], flush=True)
    report['passed'] = True
    (args.output / 'validation.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    main()
