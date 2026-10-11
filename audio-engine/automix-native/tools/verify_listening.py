"""Verify provenance, prior suitability annotation and actual human verdicts.

This script never supplies missing annotations/ratings and never enables release.
"""
import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path

METRICS = ['节拍连续性', '人声完整性', '变速伪影控制', '响度平稳', '整体偏好']
CATEGORIES = {'steady', 'different_tempo', 'vocal', 'slow', 'live', 'weak_beat'}

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()

def verify(corpus_path, evidence_dir, ratings_path):
    corpus = json.loads(corpus_path.read_text(encoding='utf-8'))
    evidence = json.loads((evidence_dir / 'pairs.validation.json').read_text(encoding='utf-8'))
    ratings = json.loads(ratings_path.read_text(encoding='utf-8'))
    digest = sha(corpus_path)
    errors, categories, coverage = [], set(), {}
    if evidence['manifestSha256'] != digest or ratings.get('manifestSha256') != digest:
        errors.append('corpus_provenance_mismatch')
    if len(corpus['pairs']) < 36 or len(evidence['pairs']) < 36: errors.append('fewer_than_36_real_pairs')
    if not isinstance(ratings.get('reviewer'), str) or not ratings['reviewer'].strip(): errors.append('human_reviewer_missing')
    records = {p['id']: p for p in evidence['pairs']}
    suitable = {mode: 0 for mode in ['natural', 'dj']}
    intelligent = {mode: 0 for mode in ['natural', 'dj']}
    for pair in corpus['pairs']:
        pid = pair['id']; render = records.get(pid); vote = ratings.get('pairs', {}).get(pid)
        if not render or not vote: errors.append(f'{pid}:missing_render_or_human_record'); continue
        if vote.get('category') not in CATEGORIES: errors.append(f'{pid}:unknown_category')
        else: categories.add(vote['category'])
        try:
            prior = vote.get('annotatedBeforeReveal') is True and datetime.fromisoformat(vote['annotationAt'].replace('Z', '+00:00')) <= datetime.fromisoformat(vote['revealedAt'].replace('Z', '+00:00'))
        except (KeyError, TypeError, ValueError): prior = False
        if not prior: errors.append(f'{pid}:not_preannotated')
        for deck, source in enumerate([pair['current'], pair['next']]):
            if sha(Path(source)) != render['sourceSha256'][deck]: errors.append(f'{pid}:source_changed')
        for mode, output in render['outputs'].items():
            file = output['file']
            if Path(file).name != file or sha(evidence_dir / file) != output['sha256']:
                errors.append(f'{pid}:{mode}:render_changed')
            if vote.get('outputs', {}).get(mode) != output: errors.append(f'{pid}:{mode}:rating_provenance_mismatch')
        for mode in ['natural', 'dj']:
            label = vote.get('suitable', {}).get(mode)
            if label not in {'yes', 'no', 'uncertain'}: errors.append(f'{pid}:{mode}:suitability_missing')
            if label == 'yes':
                suitable[mode] += 1
                intelligent[mode] += int(render['modes'][mode]['intelligent'])
        for mode in ['crossfade', 'natural', 'dj']:
            scores = vote.get('ratings', {}).get(mode, {})
            if any(type(scores.get(metric)) is not int or not 1 <= scores[metric] <= 5 for metric in METRICS):
                errors.append(f'{pid}:{mode}:human_scores_missing')
    for mode in ['natural', 'dj']:
        ratio = intelligent[mode] / suitable[mode] if suitable[mode] else None
        coverage[mode] = {'preannotatedSuitable': suitable[mode], 'intelligent': intelligent[mode], 'ratio': ratio}
        if ratio is None or ratio < 0.8: errors.append(f'{mode}:suitable_coverage_below_80_percent_or_unknown')
    if categories != CATEGORIES: errors.append('required_song_categories_missing')
    if ratings.get('humanApproved') is not True: errors.append('explicit_human_listening_verdict_missing')
    return {'schemaVersion': 1, 'passed': not errors, 'corpusSha256': digest,
            'ratingsSha256': sha(ratings_path), 'coverage': coverage, 'errors': errors,
            'releaseReady': False}

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('corpus', type=Path); p.add_argument('evidence', type=Path); p.add_argument('ratings', type=Path)
    a = p.parse_args(); report = verify(a.corpus, a.evidence, a.ratings)
    print(json.dumps(report, ensure_ascii=False, indent=2)); raise SystemExit(0 if report['passed'] else 1)
