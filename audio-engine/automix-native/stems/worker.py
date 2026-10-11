"""Isolated pinned Demucs worker; v2 material/cache tickets stay compatible.

Cache validation precedes torch import. Streaming split inference preserves
Demucs 4.0.1's order, device multiplication and global resampling semantics.
"""
import hashlib
import json
import os
import sys
import time
from pathlib import Path

# Set before any numerical import, including numpy's OpenBLAS initialization.
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'] = '1'
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True
BLOCK = 65536
DEFAULT_CACHE_BYTES = 512 * 1024 ** 2


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def within(path, directory):
    supplied = Path(path)
    resolved = supplied.resolve(strict=True)
    if resolved.parent != directory or supplied.is_symlink():
        raise RuntimeError('invalid_material_path')
    return resolved


def cache_size(cache):
    return sum(p.stat().st_size for p in cache.iterdir() if p.is_file())


def trim_cache(cache, budget, reserve=0, protected=()):
    # This directory is dedicated to v2 stems, never arbitrary user files.
    for entry in cache.iterdir():
        if entry.suffix == '.tmp' or (entry.suffix == '.json' and not entry.with_suffix('.npy').exists()):
            entry.unlink(missing_ok=True)
    entries = sorted(cache.glob('*.npy'), key=lambda p: (p.stat().st_mtime_ns, p.name))
    total = cache_size(cache)
    for entry in entries:
        if total + reserve <= budget:
            break
        if entry in protected:
            continue
        for path in (entry, entry.with_suffix('.json')):
            if path.exists():
                size = path.stat().st_size
                path.unlink()
                total -= size
    return total


def valid_array(array, np, limit=None):
    for offset in range(0, array.shape[-1], BLOCK):
        block = array[..., offset:offset + BLOCK]
        if not np.isfinite(block).all() or (limit is not None and np.max(np.abs(block)) > limit):
            return False
    return True


def cached_valid(entry, metadata, shape, model_sha, np):
    if not entry.exists():
        return False
    array = None
    try:
        record = json.loads(metadata.read_text(encoding='utf-8'))
        if record.get('modelSha256') != model_sha or record.get('sha256') != sha(entry):
            return False
        array = np.load(entry, mmap_mode='r', allow_pickle=False)
        return array.shape == shape and array.dtype == np.float32 and valid_array(array, np)
    except (ValueError, OSError, KeyError, TypeError):
        return False
    finally:
        if isinstance(array, np.memmap):
            array._mmap.close()


def streaming_apply(bag, audio, device, torch):
    from demucs.apply import TensorChunk, apply_model
    # The locked htdemucs repository is a single model with unity bag weights.
    if len(bag.models) != 1 or any(w != 1 for w in bag.weights[0]):
        raise RuntimeError('model_bag_mismatch')
    model = bag.models[0]
    original_device = next(model.parameters()).device
    model.to(device)
    model.eval()
    length = audio.shape[-1]
    segment = int(model.samplerate * 7.8)
    stride = int((1 - .25) * segment)
    output = torch.zeros(audio.shape[0], len(model.sources), model.audio_channels, length, device=audio.device)
    total = torch.zeros(length, device=audio.device)
    weight = torch.cat([torch.arange(1, segment // 2 + 1, device=device),
                        torch.arange(segment - segment // 2, 0, -1, device=device)])
    weight = (weight / weight.max()) ** 1.
    try:
        for offset in range(0, length, stride):
            chunk = TensorChunk(audio, offset, segment)
            chunk_out = apply_model(model, chunk, device=device, shifts=0, split=False,
                                    overlap=.25, segment=7.8, progress=False, num_workers=0)
            count = chunk_out.shape[-1]
            # Demucs multiplies on the compute device BEFORE transferring to CPU.
            output[..., offset:offset + segment] += (weight[:count] * chunk_out).to(audio.device)
            total[offset:offset + segment] += weight[:count].to(audio.device)
            del chunk_out, chunk
        assert total.min() > 0
        output /= total
        # BagOfModels' unity multiplication/division do not alter these values.
        return output
    finally:
        model.to(original_device)


def mix_blocks(stems, original, output, selection, descriptor, deck, sr, np):
    prefix = 'next' if deck else 'current'
    start = selection[prefix + 'StartSeconds'] * sr - descriptor['origin']
    end = selection[prefix + 'EndSeconds'] * sr - descriptor['origin']
    smooth = lambda x: (np.clip(x, 0, 1) ** 2) * (3 - 2 * np.clip(x, 0, 1))
    with output.open('wb') as stream:
        for offset in range(0, descriptor['frames'], BLOCK):
            stop = min(offset + BLOCK, descriptor['frames'])
            indices = np.arange(offset, stop, dtype=np.float64)
            phase = np.clip((indices - start) / max(1, end - start), 0, 1)
            bass = smooth((phase - .42) / .16)
            vocals = smooth((phase - .35) / .3)
            edge = smooth(np.minimum(indices - start, end - indices) / (sr * .1))
            bass_gain = 1 - edge * (bass if deck == 0 else 1 - bass)
            voice_gain = 1 - edge * .85 * (vocals if deck == 0 else 1 - vocals)
            block = stems[..., offset:stop]
            source = original[..., offset:stop]
            # Keep v2.1 arithmetic ordering, including promotion to float64.
            mixed = block[0] + block[2] + block[1] * bass_gain + block[3] * voice_gain
            mixed = source + (mixed - source) * edge
            if not np.isfinite(mixed).all() or np.max(np.abs(mixed)) > 16:
                raise RuntimeError('model_output_invalid')
            mixed.T.astype('<f4').tofile(stream)


def memory_resources():
    if os.name != 'nt':
        return {}
    import ctypes as c
    class Counters(c.Structure):
        _fields_ = [('cb', c.c_ulong), ('faults', c.c_ulong)] + [(n, c.c_size_t) for n in
            ['peakWorkingSet', 'workingSet', 'quotaPeakPaged', 'quotaPaged', 'quotaPeakNonPaged',
             'quotaNonPaged', 'pagefile', 'peakPagefile', 'privateUsage']]
    counters = Counters()
    counters.cb = c.sizeof(counters)
    c.windll.kernel32.GetCurrentProcess.restype = c.c_void_p
    c.windll.psapi.GetProcessMemoryInfo.argtypes = [c.c_void_p, c.c_void_p, c.c_ulong]
    if c.windll.psapi.GetProcessMemoryInfo(c.windll.kernel32.GetCurrentProcess(), c.byref(counters), counters.cb):
        return {'peakHostBytes': counters.peakWorkingSet, 'peakWorkingSetBytes': counters.peakWorkingSet,
                'workingSetBytes': counters.workingSet, 'privateCommitBytes': counters.privateUsage,
                'peakPrivateCommitBytes': counters.peakPagefile}
    return {}


def run(request_path):
    started = time.monotonic()
    stages = {}
    request = json.loads(request_path.read_text(encoding='utf-8'))
    pack = Path(__file__).resolve().parent
    manifest = json.loads((pack / 'manifest.json').read_text(encoding='utf-8'))
    lock = json.loads((pack / 'model.lock.json').read_text(encoding='utf-8'))
    if manifest['checkpointSha256'] != lock['checkpointSha256'] or manifest['modelVersion'] != 'demucs-4.0.1:955717e8':
        raise RuntimeError('model_manifest_mismatch')
    checkpoint = pack / 'models' / '955717e8-8726e21a.th'
    if not checkpoint.exists():
        raise RuntimeError('model_missing')
    if sha(checkpoint) != lock['checkpointSha256']:
        raise RuntimeError('model_digest_mismatch')
    selection = request['selection']
    directory = Path(selection['stemDirectory']).resolve(strict=True)
    if not directory.name.startswith('twilight-automix-material-') or directory != request_path.resolve().parent:
        raise RuntimeError('invalid_material_directory')
    sr, channels = selection['sampleRate'], selection['channels']
    if not isinstance(sr, int) or not 8000 <= sr <= 384000 or channels not in (1, 2) or len(selection['inputs']) != 2:
        raise RuntimeError('unsupported_stem_format')
    budget = request.get('cacheBudgetBytes', DEFAULT_CACHE_BYTES)
    if isinstance(budget, bool) or not isinstance(budget, int) or not 0 <= budget <= 2 * 1024 ** 3:
        raise RuntimeError('invalid_cache_budget')
    stages['requestAndModelValidationSeconds'] = time.monotonic() - started
    array_started = time.monotonic()
    import numpy as np
    stages['arrayRuntimeLoadSeconds'] = time.monotonic() - array_started
    cache = Path(request['cacheDirectory']).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    cache_writable = True
    try:
        trim_cache(cache, budget)
    except OSError:
        cache_writable = False
    inputs = []
    validation_started = time.monotonic()
    for descriptor in selection['inputs']:
        source = within(descriptor['path'], directory)
        if sha(source) != descriptor['sha256']:
            raise RuntimeError('material_digest_mismatch')
        frames = descriptor['frames']
        if not isinstance(frames, int) or not 1 <= frames <= sr * 40 or source.stat().st_size != frames * channels * 4:
            raise RuntimeError('material_range_mismatch')
        original = np.memmap(source, dtype='<f4', mode='r', shape=(frames, channels)).T
        try:
            if not valid_array(original, np, 16):
                raise RuntimeError('material_nonfinite')
        finally:
            original._mmap.close()
        key = hashlib.sha256(json.dumps([2, descriptor['sourceIdentity'], descriptor['sha256'],
            descriptor['origin'], frames, sr, channels, lock['checkpointSha256'], 7.8, .25, 0]).encode()).hexdigest()
        entry, metadata = cache / (key + '.npy'), cache / (key + '.json')
        hit = budget > 0 and cached_valid(entry, metadata, (4, channels, frames), lock['checkpointSha256'], np)
        if hit:
            try:
                os.utime(entry, None)
            except OSError:
                cache_writable = False
        inputs.append((source, entry, metadata, hit))
    stages['sourceAndCacheValidationSeconds'] = time.monotonic() - validation_started
    resources = {'device': 'cache', 'executionPath': 'cache-reuse', 'cacheHits': sum(x[3] for x in inputs),
                 'executionPathLabel': '缓存复用',
                 'checkpointSha256': lock['checkpointSha256'], 'cacheBudgetBytes': budget,
                 'modelLoaded': False, 'torchImported': False, 'cudaInitialized': False,
                 'openBlasThreads': 1, 'torchThreads': 4, 'stages': stages, 'decks': []}
    resources.update(peakGpuBytes=0, peakGpuAllocatedBytes=0, peakGpuReservedBytes=0)
    model = torch = torchaudio = None
    if resources['cacheHits'] != 2:
        model_started = time.monotonic()
        import torch
        import torchaudio
        from demucs.pretrained import get_model
        from importlib.metadata import version
        if version('demucs') != '4.0.1' or torch.__version__ != '2.8.0+cu128' or sys.version_info[:2] != (3, 11):
            raise RuntimeError('model_runtime_mismatch')
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        torch.set_grad_enabled(False)
        model = get_model('htdemucs', repo=pack / 'models')
        model.eval()
        if list(model.sources) != ['drums', 'bass', 'other', 'vocals']:
            raise RuntimeError('model_stem_order_mismatch')
        device = 'cuda' if request.get('device', 'auto') != 'cpu' and torch.cuda.is_available() else 'cpu'
        if device == 'cuda' and 'gpuMemoryFraction' in request:
            fraction = request['gpuMemoryFraction']
            if not isinstance(fraction, (int, float)) or not 0 < fraction <= 1:
                raise RuntimeError('invalid_gpu_budget')
            torch.cuda.set_per_process_memory_fraction(fraction)
        resources.update(device=device, executionPath='partial-cache' if resources['cacheHits'] else 'inference',
                         executionPathLabel='部分缓存复用' if resources['cacheHits'] else '分轨推理',
                         modelLoaded=True, torchImported=True)
        stages['runtimeAndModelLoadSeconds'] = time.monotonic() - model_started
    results = {'version': 2, 'modelVersion': manifest['modelVersion'], 'selectionId': selection['selectionId']}
    completed_outputs = []
    try:
        for deck, (source, entry, metadata, hit) in enumerate(inputs):
            deck_started = time.monotonic()
            descriptor = selection['inputs'][deck]
            frames = descriptor['frames']
            original = np.memmap(source, dtype='<f4', mode='r', shape=(frames, channels)).T
            stems = None
            try:
                if hit:
                    stems = np.load(entry, mmap_mode='r', allow_pickle=False)
                else:
                    audio = torch.from_numpy(original.copy())
                    if channels == 1:
                        audio = audio.repeat(2, 1)
                    audio = torchaudio.functional.resample(audio, sr, model.samplerate)
                    ref = audio.mean(0)
                    mean, std = ref.mean(), ref.std().clamp_min(1e-5)
                    audio = (audio - mean) / std
                    try:
                        separated = streaming_apply(model, audio[None], device, torch)[0].cpu()
                    except torch.cuda.OutOfMemoryError:
                        model.cpu()
                        torch.cuda.empty_cache()
                        device = 'cpu'
                        resources['device'] = 'cpu-oom-fallback'
                        separated = streaming_apply(model, audio[None], device, torch)[0].cpu()
                    separated = separated * std + mean / 4
                    separated = torchaudio.functional.resample(separated, model.samplerate, sr)
                    if separated.shape[-1] < frames:
                        separated = torch.nn.functional.pad(separated, (0, frames - separated.shape[-1]))
                    stems = separated[..., :frames].numpy()
                    if channels == 1:
                        stems = stems.mean(axis=1, keepdims=True)
                    stems[2] += original - stems.sum(axis=0)
                    del audio, ref, mean, std, separated
                    if not valid_array(stems, np):
                        raise RuntimeError('model_nonfinite')
                inference_seconds = time.monotonic() - deck_started
                prefix = 'next' if deck else 'current'
                output = directory / (prefix + '-mixed.f32')
                completed_outputs.append(output)
                mix_started = time.monotonic()
                mix_blocks(stems, original, output, selection, descriptor, deck, sr, np)
                results[prefix] = {**descriptor, 'path': str(output), 'sha256': sha(output)}
                # Reserve space while protecting any still-needed validated hit.
                cache_seconds = 0
                if not hit and cache_writable and budget >= stems.nbytes + 4096:
                    cache_started = time.monotonic()
                    temporary = cache / (entry.stem + '.tmp')
                    metadata_tmp = cache / (entry.stem + '.json.tmp')
                    try:
                        # Protect the remaining hit by refreshing it; reserve only if
                        # it fits along with this write, otherwise skip this write.
                        pending = sum(e.stat().st_size + m.stat().st_size for _, e, m, h in inputs[deck + 1:] if h)
                        if pending + stems.nbytes + 4096 <= budget:
                            remaining = trim_cache(cache, budget, stems.nbytes + 4096,
                                protected=[e for _, e, _, h in inputs[deck + 1:] if h])
                            if remaining + stems.nbytes + 4096 > budget:
                                raise OSError('cache_budget_unavailable')
                            with temporary.open('wb') as stream:
                                np.save(stream, stems, allow_pickle=False)
                            metadata_tmp.write_text(json.dumps({'sha256': sha(temporary),
                                'modelSha256': lock['checkpointSha256']}), encoding='utf-8')
                            temporary.replace(entry)
                            metadata_tmp.replace(metadata)
                    except OSError:
                        entry.unlink(missing_ok=True)
                        metadata.unlink(missing_ok=True)
                    finally:
                        temporary.unlink(missing_ok=True)
                        metadata_tmp.unlink(missing_ok=True)
                    cache_seconds = time.monotonic() - cache_started
                resources['decks'].append({'deck': prefix, 'cacheHit': hit,
                    'inferenceOrReadSeconds': inference_seconds, 'cacheWriteSeconds': cache_seconds,
                    'mixAndDigestSeconds': time.monotonic() - mix_started - cache_seconds})
            finally:
                original._mmap.close()
                if isinstance(stems, np.memmap):
                    stems._mmap.close()
                del stems, original
        resources.update(memory_resources())
        resources.update(elapsedSeconds=time.monotonic() - started, cpuSeconds=time.process_time(),
                         cacheBytes=cache_size(cache), materialBytes=sum(p.stat().st_size for p in directory.iterdir() if p.is_file()),
                         torchImported='torch' in sys.modules)
        if torch is not None:
            resources['cudaInitialized'] = torch.cuda.is_initialized()
            if resources['cudaInitialized']:
                resources.update(peakGpuBytes=torch.cuda.max_memory_allocated(),
                                 peakGpuAllocatedBytes=torch.cuda.max_memory_allocated(),
                                 peakGpuReservedBytes=torch.cuda.max_memory_reserved())
        return {'ok': True, 'stemMaterials': results, 'resources': resources}
    except Exception:
        for output in completed_outputs:
            output.unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    request = Path(sys.argv[1])
    started = time.monotonic()
    try:
        result = run(request)
    except Exception as error:
        reason = str(error)
        if len(reason) > 100 or not all(c.islower() or c == '_' for c in reason):
            reason = 'stem_worker_failed'
        result = {'ok': False, 'reason': reason, 'resources': {**memory_resources(),
            'elapsedSeconds': time.monotonic() - started, 'executionPath': 'failed',
            'torchImported': 'torch' in sys.modules}}
    (request.parent / 'result.json').write_text(json.dumps(result), encoding='utf-8')
    sys.exit(0 if result['ok'] else 1)
