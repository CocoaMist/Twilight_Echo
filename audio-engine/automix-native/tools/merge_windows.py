"""Mirror native window ownership; a window edge never overrides real context."""
import copy
import math


def merge(windows):
    windows = sorted(windows, key=lambda f: f['coverage']['startSeconds'])
    if not 1 <= len(windows) <= 6:
        raise ValueError('window count')
    out = copy.deepcopy(windows[0])
    start = out['coverage']['startSeconds']
    end = out['coverage']['endSeconds']
    for f in windows:
        if any(f[k] != out[k] for k in ('sourceIdentity', 'modelVersion')) or f['coverage']['durationSeconds'] != out['coverage']['durationSeconds']:
            raise ValueError('window identity mismatch')
        if f['coverage']['startSeconds'] > end + 1e-6:
            raise ValueError('coverage gap')
        end = max(end, f['coverage']['endSeconds'])
    if end - start > 120.001:
        raise ValueError('unbounded coverage')
    out['coverage']['endSeconds'] = end
    out['coverage']['complete'] = start == 0 and abs(end - out['coverage']['durationSeconds']) < 1e-4

    def owner(t):
        candidates = [f for f in windows if f['coverage']['startSeconds'] <= t <= f['coverage']['endSeconds']]
        return max(candidates, key=lambda f: min(t - f['coverage']['startSeconds'], f['coverage']['endSeconds'] - t)) if candidates else None

    for field in ('beats', 'downbeats'):
        times = sorted(t for f in windows for t in f[field] if owner(t) is f)
        out[field] = []
        for t in times:
            if not out[field] or t - out[field][-1] > .08:
                out[field].append(t)
    fields = ['frameDb', 'framePeak']
    if all('frameOnset' in f and 'frameLowDb' in f for f in windows):
        fields += ['frameOnset', 'frameLowDb']
    for field in fields:
        out[field] = []
    for i in range(math.ceil((end - start) * 50 - 1e-6)):
        t = start + i / 50
        f = owner(t)
        if f is None:
            raise ValueError('missing real frame')
        j = min(len(f['frameDb']) - 1, max(0, math.floor((t - f['coverage']['startSeconds']) * 50)))
        for field in fields:
            out[field].append(f[field][j])
    out['rmsDb'] = 10 * math.log10(max(1e-16, sum(10 ** (x / 10) for x in out['frameDb']) / len(out['frameDb'])))
    out['tempoConfidence'] = min(f['tempoConfidence'] for f in windows)
    if any(f['key'] != out['key'] for f in windows):
        out['key'], out['keyConfidence'] = -1, 0
    bounds = {t for f in windows for p in f['voice'] for t in (p['startSeconds'], p['endSeconds'])}
    bounds.update(t for f in windows for t in (f['coverage']['startSeconds'], f['coverage']['endSeconds']))
    bounds.update((f['coverage']['startSeconds'] + g['coverage']['endSeconds']) / 2 for f in windows for g in windows)
    bounds = sorted(t for t in bounds if start <= t <= end)
    out['voice'] = []
    for s, e in zip(bounds, bounds[1:]):
        mid = (s + e) / 2
        f = owner(mid)
        active = [p for p in f['voice'] if p['startSeconds'] <= mid < p['endSeconds']] if f else []
        if not active or e - s < 1e-8:
            continue
        v, m = max(p['probability'] for p in active), max(p['music'] for p in active)
        if out['voice'] and abs(out['voice'][-1]['endSeconds'] - s) < 1e-7 and out['voice'][-1]['probability'] == v and out['voice'][-1]['music'] == m:
            out['voice'][-1]['endSeconds'] = e
        else:
            out['voice'].append({'startSeconds': s, 'endSeconds': e, 'probability': v, 'music': m})
    return out
