"""Bounded IO, exact envelope and cache accounting tests; no model inference."""
import json
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import worker
import numpy as np


class WorkerMemoryTests(unittest.TestCase):
    def test_block_recomposition_matches_original_arithmetic_sample_exact(self):
        random = np.random.default_rng(20261011)
        for channels, sr in ((1, 44100), (2, 48000), (2, 96000), (2, 192000)):
            frames = worker.BLOCK * 3 + 123
            original = random.normal(0, .1, (channels, frames)).astype(np.float32)
            stems = random.normal(0, .1, (4, channels, frames)).astype(np.float32)
            for deck in (0, 1):
                origin = 987654321
                start, end = worker.BLOCK - .2345, worker.BLOCK * 2 + .6789
                prefix = 'next' if deck else 'current'
                selection = {prefix + 'StartSeconds': (origin + start) / sr,
                             prefix + 'EndSeconds': (origin + end) / sr}
                start = selection[prefix + 'StartSeconds'] * sr - origin
                end = selection[prefix + 'EndSeconds'] * sr - origin
                indices = np.arange(frames, dtype=np.float64)
                phase = np.clip((indices - start) / max(1, end - start), 0, 1)
                smooth = lambda x: (np.clip(x, 0, 1) ** 2) * (3 - 2 * np.clip(x, 0, 1))
                bass = smooth((phase - .42) / .16)
                vocals = smooth((phase - .35) / .3)
                edge = smooth(np.minimum(indices - start, end - indices) / (sr * .1))
                bass_gain = 1 - edge * (bass if deck == 0 else 1 - bass)
                voice_gain = 1 - edge * .85 * (vocals if deck == 0 else 1 - vocals)
                expected = stems[0] + stems[2] + stems[1] * bass_gain + stems[3] * voice_gain
                expected = original + (expected - original) * edge
                with tempfile.TemporaryDirectory() as directory:
                    output = Path(directory) / 'mixed.f32'
                    worker.mix_blocks(stems, original, output, selection, {'origin': origin, 'frames': frames}, deck, sr, np)
                    actual = np.fromfile(output, dtype='<f4').reshape(frames, channels).T
                    self.assertTrue(np.array_equal(expected.astype(np.float32), actual))

    def test_lru_includes_metadata_and_reserves_before_write(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            for key in ('a', 'b', 'c'):
                (cache / (key + '.npy')).write_bytes(bytes(100))
                (cache / (key + '.json')).write_bytes(bytes(40))
            os.utime(cache / 'a.npy', (10, 10)); os.utime(cache / 'b.npy', (20, 20)); os.utime(cache / 'c.npy', (30, 30))
            (cache / 'orphan.json').write_text('{}')
            (cache / 'interrupted.tmp').write_bytes(bytes(300))
            total = worker.trim_cache(cache, 400, 150)
            self.assertEqual(total, 140)
            self.assertEqual(sorted(x.name for x in cache.iterdir()), ['c.json', 'c.npy'])
            self.assertLessEqual(total + 150, 400)
            worker.trim_cache(cache, 0)
            self.assertEqual(list(cache.iterdir()), [])

    def test_reservation_cannot_evict_a_pending_validated_hit(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            for key in ('a', 'b'):
                (cache / (key + '.npy')).write_bytes(bytes(100))
                (cache / (key + '.json')).write_bytes(bytes(40))
            os.utime(cache / 'a.npy', (10, 10)); os.utime(cache / 'b.npy', (20, 20))
            self.assertEqual(worker.trim_cache(cache, 300, 150, [cache / 'a.npy']), 140)
            self.assertTrue((cache / 'a.npy').exists())
            self.assertFalse((cache / 'b.npy').exists())

    def test_cache_compatibility_digest_shape_dtype_and_nonfinite(self):
        with tempfile.TemporaryDirectory() as directory:
            entry = Path(directory) / 'a.npy'; metadata = entry.with_suffix('.json')
            shape = (4, 2, worker.BLOCK + 12)
            stems = np.zeros(shape, dtype=np.float32)
            def store():
                np.save(entry, stems, allow_pickle=False)
                metadata.write_text(json.dumps({'sha256': worker.sha(entry), 'modelSha256': 'pinned'}))
            store()
            self.assertTrue(worker.cached_valid(entry, metadata, shape, 'pinned', np))
            self.assertFalse(worker.cached_valid(entry, metadata, shape, 'wrong-model', np))
            with entry.open('r+b') as stream: stream.seek(-1, 2); stream.write(b'!')
            self.assertFalse(worker.cached_valid(entry, metadata, shape, 'pinned', np))
            stems[3, 1, -1] = np.nan; store()
            self.assertFalse(worker.cached_valid(entry, metadata, shape, 'pinned', np))
            metadata.write_text('{broken')
            self.assertFalse(worker.cached_valid(entry, metadata, shape, 'pinned', np))

    def test_disk_full_recomposition_propagates_without_partial_success(self):
        with tempfile.TemporaryDirectory() as directory:
            original = np.zeros((2, 100), dtype=np.float32)
            stems = np.zeros((4, 2, 100), dtype=np.float32)
            with patch.object(Path, 'open', side_effect=OSError(28, 'disk full')):
                with self.assertRaises(OSError):
                    worker.mix_blocks(stems, original, Path(directory) / 'mixed.f32',
                        {'currentStartSeconds': 0, 'currentEndSeconds': 1}, {'origin': 0, 'frames': 100}, 0, 48000, np)


if __name__ == '__main__':
    unittest.main()
