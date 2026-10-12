"""Player-owned, paired stem arrangement on the native output clock.

RMS/activity values are local measurements, not model probabilities. Missing
coverage rejects enhancement; measured silence preserves the original samples.
The raw Demucs v2 cache is independent of this arrangement policy.
"""
import math
import numpy as np

VERSION = 'twilight-stem-arrangement-1'
HOP_SECONDS = .02


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def source_at(start, rate, frames, frame):
    # Same integral as ta_am_c_source_at: hold 80%, return to 1 over 20%.
    rate = float(np.float32(rate))
    t = np.clip(frame, 0, frames)
    x = np.maximum(0, t - frames * .8)
    return start + t * rate + (1 - rate) * x * x / (frames * .4)


def output_at(start, rate, frames, source):
    rate = float(np.float32(rate))
    y = np.maximum(0, source - start)
    delta = np.maximum(0, y - frames * .8 * rate)
    slope = (1 - rate) / (frames * .2)
    # Rationalized quadratic root is stable at rate=1 and near unity.
    x = 2 * delta / (rate + np.sqrt(np.maximum(0, rate * rate + 2 * slope * delta)))
    return np.clip(np.where(y <= frames * .8 * rate, y / rate, frames * .8 + x), 0, frames)


def validate_selection(selection):
    sr, frames = selection['sampleRate'], selection['outputFrames']
    mode = selection['mode']
    if (mode not in ('natural', 'dj') or isinstance(frames, bool) or
            not isinstance(frames, int) or not 2 <= frames <= sr * (8 if mode == 'natural' else 32)):
        raise RuntimeError('invalid_arrangement_plan')
    gain = selection['nextGain']
    if not isinstance(gain, (int, float)) or isinstance(gain, bool) or not math.isfinite(gain) or not .5 <= gain <= 2:
        raise RuntimeError('invalid_arrangement_plan')
    for deck, prefix in enumerate(('current', 'next')):
        rate = selection[prefix + 'Rate']
        limits = (.96, 1.04) if mode == 'natural' else (.88, 1.12)
        if not isinstance(rate, (int, float)) or isinstance(rate, bool) or not math.isfinite(rate) or not limits[0] - 1e-7 <= rate <= limits[1] + 1e-7:
            raise RuntimeError('invalid_arrangement_plan')
        start, end = [selection[prefix + key + 'Seconds'] for key in ('Start', 'End')]
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 <= v <= 604800 for v in (start, end)):
            raise RuntimeError('invalid_arrangement_plan')
        first, last = round(start * sr), round(end * sr)
        if first >= last or abs(source_at(first, rate, frames, frames) - last) > .501:
            raise RuntimeError('invalid_arrangement_timeline')
        descriptor = selection['inputs'][deck]
        origin, count = descriptor['origin'], descriptor['frames']
        if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (origin, count)) or origin > first or origin + count < last:
            raise RuntimeError('incomplete_stem_coverage')


def profile(stems, sr):
    """50 Hz RMS across channels; at most one small PCM slice is copied."""
    hop = max(1, round(sr * HOP_SECONDS))
    count = stems.shape[-1]
    centres, rms = [], []
    for start in range(0, count, hop):
        end = min(count, start + hop)
        block = stems[..., start:end].astype(np.float64)
        centres.append((start + end - 1) * .5)
        rms.append(np.sqrt(np.mean(block * block, axis=(1, 2))))
    return {'centres': np.asarray(centres), 'rms': np.asarray(rms).T, 'frames': count}


def moving_average(values, half):
    padded = np.pad(values, (half, half), mode='edge')
    return np.convolve(padded, np.ones(half * 2 + 1) / (half * 2 + 1), mode='valid')


def arrange(selection, profiles):
    validate_selection(selection)
    sr, frames = selection['sampleRate'], selection['outputFrames']
    clock = np.unique(np.r_[np.arange(0, frames, max(1, round(sr * HOP_SECONDS))), frames - 1])
    phase = clock / (frames - 1)
    measured = []
    for deck, prefix in enumerate(('current', 'next')):
        descriptor = selection['inputs'][deck]
        if profiles[deck]['frames'] != descriptor['frames']:
            raise RuntimeError('incomplete_stem_coverage')
        positions = source_at(round(selection[prefix + 'StartSeconds'] * sr), selection[prefix + 'Rate'], frames, clock) - descriptor['origin']
        if np.any(positions < 0) or np.any(positions >= descriptor['frames']):
            raise RuntimeError('incomplete_stem_coverage')
        measured.append([np.interp(positions, profiles[deck]['centres'], lane) for lane in profiles[deck]['rms']])
    rms = np.asarray(measured)
    if rms.shape != (2, 4, len(clock)) or not np.isfinite(rms).all() or np.any(rms < 0):
        raise RuntimeError('invalid_stem_activity')
    deck_gain = np.asarray([np.cos(phase * math.pi / 2),
        np.sin(phase * math.pi / 2) * (selection['nextGain'] + (1 - selection['nextGain']) * phase)])
    gains = np.ones((2, 2, len(clock)))  # bass, vocals; drums/other never ducked
    evidence = {}
    edge = smooth(np.minimum(clock, frames - 1 - clock) / (sr * .1))
    total = np.sqrt(np.sum(rms * rms, axis=1))
    for lane, stem, name in ((0, 1, 'bass'), (1, 3, 'vocals')):
        relative = rms[:, stem] / np.maximum(total, 1e-12)
        db = 20 * np.log10(np.maximum(rms[:, stem], 1e-12))
        activity = smooth((relative - .04) / .08) * smooth((db + 60) / 12)
        audible = rms[:, stem] * deck_gain
        quieter, louder = np.min(audible, axis=0), np.max(audible, axis=0)
        balance = quieter / np.maximum(louder, 1e-12)
        raw = np.min(activity, axis=0) * smooth((balance - .1) / .4) * smooth((20 * np.log10(np.maximum(quieter, 1e-12)) + 60) / 14)
        # 0.3 s edges follow the Java reference's local conflict curves. Cap
        # by local activity so a known absent partner cannot trigger ducking.
        conflict = np.minimum(moving_average(raw, 7), raw)
        switch = smooth((phase - (.42 if lane == 0 else .35)) / (.16 if lane == 0 else .3))
        depth = (.95 if lane == 0 else .85) if selection['mode'] == 'dj' else .65
        gains[0, lane] -= edge * depth * switch * conflict
        gains[1, lane] -= edge * depth * (1 - switch) * conflict
        before = np.minimum(audible[0], audible[1])
        after = np.minimum(audible[0] * gains[0, lane], audible[1] * gains[1, lane])
        integrate = lambda x: float(np.sum((x[:-1] + x[1:]) * .5 * np.diff(clock) / sr))
        solo = np.min(activity, axis=0) == 0
        evidence[name] = {'conflictSeconds': integrate(conflict),
            'overlapRmsSecondsBefore': integrate(before), 'overlapRmsSecondsAfter': integrate(after),
            'minimumGain': float(gains[:, lane].min()),
            'soloMaximumReduction': float(np.max(1 - gains[:, lane, solo], initial=0))}
    return clock, gains, {'version': VERSION, 'activityUnit': 'local-stem-rms-amplitude',
        'timeline': 'native-hold-80-return-20', 'mode': selection['mode'],
        'profileHopSeconds': HOP_SECONDS, 'measurements': evidence}


def mix_blocks(stems, original, output, selection, descriptor, deck, sr, clock, gains, block_size=65536):
    prefix = 'next' if deck else 'current'
    frames = selection['outputFrames']
    start = round(selection[prefix + 'StartSeconds'] * sr)
    end = round(selection[prefix + 'EndSeconds'] * sr)
    with output.open('wb') as stream:
        for offset in range(0, descriptor['frames'], block_size):
            stop = min(offset + block_size, descriptor['frames'])
            source_clock = np.arange(offset, stop, dtype=np.float64) + descriptor['origin']
            mapped = output_at(start, selection[prefix + 'Rate'], frames, source_clock)
            inside = (source_clock > start) & (source_clock < end - 1)
            bass = np.where(inside, np.interp(mapped, clock, gains[deck, 0]), 1)
            vocal = np.where(inside, np.interp(mapped, clock, gains[deck, 1]), 1)
            # Subtract only the conflicting lanes from the ORIGINAL mix.
            # At unity this is bit-exact, without Demucs reconstruction drift.
            mixed = original[..., offset:stop] + stems[1, :, offset:stop] * (bass - 1) + stems[3, :, offset:stop] * (vocal - 1)
            if not np.isfinite(mixed).all() or np.max(np.abs(mixed)) > 16:
                raise RuntimeError('model_output_invalid')
            mixed.T.astype('<f4').tofile(stream)
