"""Run with the enhancement pack's Python (numpy only; no torch/model load)."""
import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
import numpy as np

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'resources/automix-stems'))
from arrangement import source_at, output_at, validate_selection, profile, arrange, mix_blocks


def selection(mode='dj', rates=(1, 1), duration=6):
    sr, frames = 8000, int(duration * 8000)
    result = {'mode': mode, 'sampleRate': sr, 'channels': 2, 'outputFrames': frames, 'nextGain': 1, 'inputs': []}
    for prefix, rate in zip(('current', 'next'), rates):
        start = sr * 2
        end = round(source_at(start, rate, frames, frames))
        result.update({prefix + 'StartSeconds': start / sr, prefix + 'EndSeconds': end / sr, prefix + 'Rate': rate})
        result['inputs'].append({'origin': 0, 'frames': end + sr * 2})
    return result


def stems(plan, deck, vocal=.1, bass=.1):
    count = plan['inputs'][deck]['frames']
    t = np.arange(count) / plan['sampleRate']
    wave = np.zeros((4, 2, count), dtype=np.float32)
    wave[0] = .05 * np.sin(2 * np.pi * 200 * t)
    wave[1] = bass * np.sin(2 * np.pi * 80 * t)
    wave[2] = .05 * np.sin(2 * np.pi * 130 * t)
    wave[3] = vocal * np.sin(2 * np.pi * 600 * t)
    return wave


class ArrangementTests(unittest.TestCase):
    def test_native_clock_integral_and_inverse(self):
        for rate in (.88, .96, 1, 1.04, 1.12):
            rate32 = float(np.float32(rate))
            clock = np.linspace(0, 192000, 2001)
            mapped = source_at(123456, rate, 192000, clock)
            np.testing.assert_allclose(mapped[clock <= 153600], 123456 + clock[clock <= 153600] * rate32, atol=1e-8)
            self.assertAlmostEqual(mapped[-1], 123456 + 192000 * (.9 * rate32 + .1))
            np.testing.assert_allclose(output_at(123456, rate, 192000, mapped), clock, atol=1e-7)

    def test_linear_progress_would_misalign_rate_return(self):
        plan = selection(rates=(1.12, .88))
        n = plan['outputFrames']
        at = .85 * n
        self.assertGreater(abs(source_at(0, 1.12, n, at) / source_at(0, 1.12, n, n) - .85), .005)

    def test_solo_vocal_is_bit_exact_and_bass_absence_is_known(self):
        plan = selection()
        waves = [stems(plan, 0, bass=0), stems(plan, 1, vocal=0, bass=0)]
        clock, gains, evidence = arrange(plan, [profile(x, 8000) for x in waves])
        np.testing.assert_array_equal(gains, 1)
        for lane in ('bass', 'vocals'):
            self.assertEqual(evidence['measurements'][lane]['conflictSeconds'], 0)
        with tempfile.TemporaryDirectory() as temporary:
            for deck, wave in enumerate(waves):
                original = wave.sum(axis=0)
                output = Path(temporary) / str(deck)
                mix_blocks(wave, original, output, plan, plan['inputs'][deck], deck, 8000, clock, gains)
                np.testing.assert_array_equal(np.fromfile(output, '<f4').reshape(-1, 2).T, original)

    def test_local_overlap_reduces_only_conflict_and_preserves_endpoints(self):
        plan = selection()
        waves = [stems(plan, deck) for deck in (0, 1)]
        # Incoming vocals enter at output 2 s; known absence before then.
        waves[1][3, :, :4 * 8000] = 0
        clock, gains, evidence = arrange(plan, [profile(x, 8000) for x in waves])
        np.testing.assert_array_equal(gains[:, 1, clock < 1.98 * 8000], 1)
        self.assertLess(gains[:, 1].min(), .5)
        for lane in ('bass', 'vocals'):
            stats = evidence['measurements'][lane]
            self.assertLess(stats['overlapRmsSecondsAfter'], stats['overlapRmsSecondsBefore'])
            self.assertEqual(stats['soloMaximumReduction'], 0)
        np.testing.assert_array_equal(gains[..., 0], 1)
        np.testing.assert_array_equal(gains[..., -1], 1)

    def test_natural_is_gentler_than_dj(self):
        plan = selection()
        profiles = [profile(stems(plan, d), 8000) for d in (0, 1)]
        _, dj, _ = arrange(plan, profiles)
        plan['mode'] = 'natural'
        _, natural, _ = arrange(plan, profiles)
        self.assertTrue(np.all(natural >= dj - 1e-12))

    def test_quiet_partner_does_not_duck_dominant_solo(self):
        plan = selection()
        _, gains, _ = arrange(plan, [profile(stems(plan, 0), 8000), profile(stems(plan, 1, vocal=1e-5, bass=1e-5), 8000)])
        np.testing.assert_array_equal(gains, 1)

    def test_stereo_antiphase_activity_does_not_cancel(self):
        plan = selection()
        wave = stems(plan, 0)
        regular = profile(wave, 8000)['rms']
        wave[:, 1] *= -1
        np.testing.assert_array_equal(profile(wave, 8000)['rms'], regular)

    def test_missing_coverage_is_not_silence(self):
        plan = selection()
        profiles = [profile(stems(plan, d), 8000) for d in (0, 1)]
        profiles[1]['frames'] -= 1
        with self.assertRaisesRegex(RuntimeError, 'incomplete_stem_coverage'):
            arrange(plan, profiles)
        plan['inputs'][0]['origin'] = 20000
        with self.assertRaisesRegex(RuntimeError, 'incomplete_stem_coverage'):
            validate_selection(plan)

    def test_malformed_timing_modes_and_gains_rejected(self):
        for field, value in (('mode', 'off'), ('currentRate', float('nan')), ('nextRate', 1.5),
                ('nextGain', 0), ('nextGain', True), ('currentEndSeconds', 99), ('outputFrames', True)):
            plan = selection()
            plan[field] = value
            with self.assertRaises(RuntimeError, msg=field):
                validate_selection(plan)

    def test_nonfinite_profile_rejected(self):
        plan = selection()
        profiles = [profile(stems(plan, d), 8000) for d in (0, 1)]
        profiles[0]['rms'][3, 100] = np.nan
        with self.assertRaisesRegex(RuntimeError, 'invalid_stem_activity'):
            arrange(plan, profiles)

    def test_variable_rates_and_partial_blocks_preserve_context(self):
        plan = selection(rates=(1.12, .88))
        waves = [stems(plan, d) for d in (0, 1)]
        clock, gains, _ = arrange(plan, [profile(x, 8000) for x in waves])
        with tempfile.TemporaryDirectory() as temporary:
            for deck, wave in enumerate(waves):
                original = wave.sum(axis=0)
                output = Path(temporary) / str(deck)
                mix_blocks(wave, original, output, plan, plan['inputs'][deck], deck, 8000, clock, gains, 997)
                mixed = np.fromfile(output, '<f4').reshape(-1, 2).T
                self.assertTrue(np.isfinite(mixed).all())
                prefix = 'next' if deck else 'current'
                first, last = [round(plan[prefix + key + 'Seconds'] * 8000) for key in ('Start', 'End')]
                np.testing.assert_array_equal(mixed[:, :first + 1], original[:, :first + 1])
                np.testing.assert_array_equal(mixed[:, last - 1:], original[:, last - 1:])
                self.assertGreater(np.max(abs(mixed - original)), .01)

    def test_cache_trim_protects_already_separated_deck(self):
        import worker
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            protected, old = cache / 'current.npy', cache / 'old.npy'
            for path in (protected, old):
                path.write_bytes(b'0' * 100)
                path.with_suffix('.json').write_text('{}')
            worker.trim_cache(cache, 250, reserve=120, protected=[protected])
            self.assertTrue(protected.exists())
            self.assertFalse(old.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
