import assert from 'node:assert/strict'
import test from 'node:test'
import {
  musicRatingAtLeast,
  normalizeMusicExternalRating,
  resolveMusicRating,
  validMusicExternalRating,
  validMusicExternalRatingApproval,
  validMusicRatingBaseSelection,
  type MusicExternalRating,
  type MusicExternalRatingApproval,
  type MusicRatingBaseSelection
} from './musicRatingSources.ts'

const usage = { display: true, cache: true, crossSource: true, export: false }
const context = { now: 1000 }
function fact(overrides: Partial<MusicExternalRating> = {}): MusicExternalRating {
  return {
    provider: 'fixture-editor',
    nativeTarget: { kind: 'release', id: 'release-1' },
    mechanism: 'editorial',
    rawValue: 79.2,
    scale: { id: 'score-100', minimum: 0, maximum: 100 },
    conversion: 'divide_0_100_by_20',
    voteCount: null,
    ratedAt: null,
    attribution: {
      provider: 'fixture-editor',
      externalId: 'release-1',
      url: 'https://example.com/releases/1',
      license: 'Fixture permission',
      licenseUrl: '',
      attribution: 'Fixture editor',
      revision: 'r1',
      retrievedAt: 900
    },
    usage: { ...usage },
    ...overrides
  }
}
function approval(
  overrides: Partial<MusicExternalRatingApproval> = {}
): MusicExternalRatingApproval {
  return {
    provider: 'fixture-editor',
    targetKind: 'release',
    mechanism: 'editorial',
    scale: { id: 'score-100', minimum: 0, maximum: 100 },
    conversion: 'divide_0_100_by_20',
    usage: { ...usage },
    ...overrides
  }
}
const selection: MusicRatingBaseSelection = {
  provider: 'fixture-editor',
  targetKind: 'release',
  mechanism: 'editorial'
}
function resolve(overrides: Partial<Parameters<typeof resolveMusicRating>[0]> = {}) {
  return resolveMusicRating({
    mode: 'effective',
    personalSteps: null,
    target: { kind: 'release', id: 'release-1' },
    baseSelection: selection,
    ratings: [fact()],
    approvals: [approval()],
    context,
    ...overrides
  })
}

test('external rating DTO preserves native level, raw precision, unknown counts and provenance', () => {
  const value = fact()
  assert.equal(validMusicExternalRating(value), true)
  assert.equal(validMusicExternalRating(fact({ voteCount: 0, ratedAt: 850 })), true)
  assert.equal(validMusicExternalRating(fact({ conversion: 'unavailable' })), true)
  assert.equal(value.rawValue, 79.2)
  assert.equal(value.voteCount, null)
  assert.equal(value.ratedAt, null)
})

test('external rating DTO rejects extra metrics and malformed numeric or attribution data', () => {
  const value = fact()
  for (const raw of [
    { ...value, popularity: 90 },
    { ...value, matchScore: 0.99 },
    { ...value, editorPick: true },
    { ...value, mechanism: 'editor_pick' },
    { ...value, mechanism: 'popularity' },
    { ...value, rawValue: NaN },
    { ...value, rawValue: Infinity },
    { ...value, rawValue: 101 },
    { ...value, rawValue: -1 },
    { ...value, voteCount: -1 },
    { ...value, voteCount: 3.5 },
    { ...value, voteCount: undefined },
    { ...value, ratedAt: undefined },
    { ...value, ratedAt: 0 },
    { ...value, nativeTarget: { ...value.nativeTarget, relation: 'album' } },
    { ...value, nativeTarget: { kind: 'artist', id: 'release-1' } },
    { ...value, scale: { ...value.scale, maximum: NaN } },
    { ...value, scale: { ...value.scale, maximum: 0 } },
    { ...value, scale: { ...value.scale, unit: 'percent' } },
    { ...value, attribution: { ...value.attribution, provider: 'other' } },
    { ...value, attribution: { ...value.attribution, externalId: 'other' } },
    { ...value, attribution: { ...value.attribution, url: 'file:///D:/private' } },
    { ...value, attribution: { ...value.attribution, url: 'https://x:y@example.com/' } },
    { ...value, attribution: { ...value.attribution, url: 'https://example.com/?token=x' } },
    { ...value, usage: { ...usage, commercialApproval: true } },
    { ...value, sourceProvider: 'platform' },
    { ...value, providerContext: 'account-1' }
  ])
    assert.equal(validMusicExternalRating(raw), false, JSON.stringify(raw))
})

test('conversion requires an explicit matching deployment approval, never just range bounds', () => {
  assert.equal(normalizeMusicExternalRating(fact(), null, context), null)
  assert.equal(
    normalizeMusicExternalRating(fact({ conversion: 'unavailable' }), approval(), context),
    null
  )
  assert.equal(normalizeMusicExternalRating(fact(), approval({ provider: 'other' }), context), null)
  assert.equal(
    normalizeMusicExternalRating(fact(), approval({ mechanism: 'community' }), context),
    null
  )
  assert.equal(
    normalizeMusicExternalRating(fact(), approval({ targetKind: 'recording' }), context),
    null
  )
  assert.equal(
    normalizeMusicExternalRating(
      fact(),
      approval({
        scale: { id: 'another-100-scale', minimum: 0, maximum: 100 }
      }),
      context
    ),
    null
  )
  assert.equal(resolve({ approvals: undefined }).value, null)
  assert.equal(resolve({ approvals: [] }).value, null)
  assert.equal(
    validMusicExternalRatingApproval({ ...approval(), conversion: 'unavailable' }),
    false
  )
  assert.equal(validMusicExternalRatingApproval({ ...approval(), approvedByProvider: true }), false)
  assert.equal(
    validMusicExternalRatingApproval({ ...approval(), conversion: 'identity_1_5' }),
    false
  )
})

test('approved transformations preserve decimal precision rather than personal half-star steps', () => {
  const normalized = normalizeMusicExternalRating(fact(), approval(), context)
  assert.ok(normalized)
  assert.equal(normalized.stars, 3.96)
  assert.equal(normalized.stars.toFixed(1), '4.0')
  assert.equal(musicRatingAtLeast(normalized.stars, 4), false)
  assert.equal(musicRatingAtLeast(normalized.stars, 3.96), true)
  assert.equal(musicRatingAtLeast(null, 0), false)
  assert.equal(musicRatingAtLeast(NaN, 0), false)
  assert.throws(() => musicRatingAtLeast(4, Infinity), TypeError)
  assert.throws(() => musicRatingAtLeast(4, 5.1), TypeError)
  const scale = { id: 'five-stars', minimum: 1, maximum: 5 }
  assert.equal(
    normalizeMusicExternalRating(
      fact({
        rawValue: 3.96,
        scale,
        conversion: 'identity_1_5'
      }),
      approval({ scale, conversion: 'identity_1_5' }),
      context
    )?.stars,
    3.96
  )
  // A 0..5 scale is not silently treated as the approved 1..5 identity scale.
  assert.equal(
    validMusicExternalRating(
      fact({ rawValue: 3.96, scale: { ...scale, minimum: 0 }, conversion: 'identity_1_5' })
    ),
    false
  )
})

test('zero in an approved 0..100 scale remains a rated zero, not missing data', () => {
  const result = resolve({ ratings: [fact({ rawValue: 0 })] })
  assert.equal(result.value, 0)
  assert.equal(result.origin, 'base')
  assert.equal(result.personalUnrated, true)
  assert.equal(musicRatingAtLeast(result.value, 0), true)
})

test('deployment approval and provider restrictions intersect without broadening permissions', () => {
  assert.equal(
    normalizeMusicExternalRating(
      fact({ usage: { ...usage, display: false } }),
      approval(),
      context
    ),
    null
  )
  assert.equal(
    normalizeMusicExternalRating(fact(), approval({ usage: { ...usage, cache: false } }), context),
    null
  )
  const limited = normalizeMusicExternalRating(
    fact({ usage: { ...usage, expiresAt: 1200 } }),
    approval({ usage: { ...usage, expiresAt: 1100, crossSource: false } }),
    { ...context, sourceProvider: 'fixture-editor' }
  )
  assert.ok(limited)
  assert.deepEqual(limited.usage, { ...usage, expiresAt: 1100, crossSource: false })
  assert.equal(
    normalizeMusicExternalRating(
      fact(),
      approval({ usage: { ...usage, crossSource: false } }),
      context
    ),
    null
  )
  for (const expiresAt of [999, 1000]) {
    assert.equal(
      normalizeMusicExternalRating(fact({ usage: { ...usage, expiresAt } }), approval(), context),
      null
    )
    assert.equal(
      normalizeMusicExternalRating(fact(), approval({ usage: { ...usage, expiresAt } }), context),
      null
    )
  }
})

test('restricted platform rating requires the actual account and allowed source context', () => {
  const value = fact({
    sourceProvider: 'platform-a',
    providerContext: 'account-1',
    usage: { ...usage, crossSource: false }
  })
  assert.equal(validMusicExternalRating(value), true)
  assert.equal(normalizeMusicExternalRating(value, approval(), context), null)
  assert.equal(
    normalizeMusicExternalRating(value, approval(), {
      ...context,
      sourceProvider: 'platform-a',
      platformContexts: { 'platform-a': 'account-2' }
    }),
    null
  )
  assert.equal(
    normalizeMusicExternalRating(value, approval(), {
      ...context,
      sourceProvider: 'platform-b',
      platformContexts: { 'platform-a': 'account-1' }
    }),
    null
  )
  assert.equal(
    normalizeMusicExternalRating(value, approval(), {
      ...context,
      sourceProvider: 'platform-a',
      platformContexts: { 'platform-a': 'account-1' }
    })?.stars,
    3.96
  )
  assert.equal(
    normalizeMusicExternalRating({ ...value, usage }, approval(), {
      ...context,
      sourceProvider: 'platform-b',
      platformContexts: { 'platform-a': 'account-1' }
    })?.stars,
    3.96
  )
})

test('personal, base and effective modes keep personal clear/unrated independent of fallback', () => {
  assert.equal(resolve({ mode: 'personal', personalSteps: 7 }).value, 3.5)
  assert.equal(resolve({ mode: 'base', personalSteps: 7 }).value, 3.96)
  const effective = resolve({ mode: 'effective', personalSteps: 7 })
  assert.equal(effective.value, 3.5)
  assert.equal(effective.origin, 'personal')
  assert.equal(effective.personalUnrated, false)
  const cleared = resolve({ personalSteps: null })
  assert.equal(cleared.value, 3.96)
  assert.equal(cleared.origin, 'base')
  assert.equal(cleared.personalUnrated, true)
  assert.equal(resolve({ mode: 'personal', personalSteps: null }).value, null)
})

test('without a selected external source effective is exactly personal, even if facts exist', () => {
  const unrated = resolve({ baseSelection: null })
  assert.equal(unrated.value, null)
  assert.equal(unrated.base, null)
  assert.equal(unrated.personalUnrated, true)
  assert.equal(resolve({ baseSelection: null, personalSteps: 8 }).value, 4)
  assert.equal(resolve({ mode: 'base', baseSelection: null, personalSteps: 8 }).value, null)
})

test('base fixes supplier, native target ID, target kind and mechanism without averaging', () => {
  const original = fact()
  const otherProvider = fact({
    provider: 'other',
    rawValue: 100,
    attribution: { ...original.attribution, provider: 'other' }
  })
  const community = fact({ mechanism: 'community', rawValue: 100, voteCount: 25 })
  const otherRelease = fact({
    nativeTarget: { kind: 'release', id: 'release-2' },
    rawValue: 100,
    attribution: { ...original.attribution, externalId: 'release-2' }
  })
  const result = resolve({
    ratings: [otherProvider, community, otherRelease, original],
    approvals: [approval(), approval({ provider: 'other' }), approval({ mechanism: 'community' })]
  })
  assert.equal(result.value, 3.96)
  assert.equal(result.base?.rating, original)
  assert.equal(resolve({ ratings: [community] }).value, null)
  assert.equal(resolve({ ratings: [otherRelease] }).value, null)
  assert.equal(
    validMusicRatingBaseSelection({ provider: 'fixture-editor', targetKind: 'release' }),
    false
  )
  assert.equal(validMusicRatingBaseSelection({ ...selection, popularity: true }), false)
})

test('project scores require an explicit project query and never populate release or recording', () => {
  const project = fact({
    nativeTarget: { kind: 'album_project', id: 'project-1' },
    attribution: { ...fact().attribution, externalId: 'project-1' }
  })
  const projectApproval = approval({ targetKind: 'album_project' })
  assert.equal(resolve({ ratings: [project], approvals: [projectApproval] }).value, null)
  assert.equal(
    resolve({
      target: { kind: 'recording', id: 'project-1' },
      ratings: [project],
      approvals: [projectApproval],
      baseSelection: { ...selection, targetKind: 'recording' }
    }).value,
    null
  )
  assert.equal(
    resolve({
      target: { kind: 'album_project', id: 'project-1' },
      ratings: [project],
      approvals: [projectApproval],
      baseSelection: { ...selection, targetKind: 'album_project' }
    }).value,
    3.96
  )
  assert.throws(
    () => resolve({ target: { kind: 'album_project', id: 'project-1' }, personalSteps: 8 }),
    TypeError
  )
})

test('one latest eligible provider snapshot wins; selection does not mutate or average facts', () => {
  const older = fact({ rawValue: 40 })
  const newer = fact({ rawValue: 80, attribution: { ...older.attribution, retrievedAt: 950 } })
  const expired = fact({
    rawValue: 100,
    attribution: { ...older.attribution, retrievedAt: 990 },
    usage: { ...usage, expiresAt: 1000 }
  })
  const values = [newer, older, expired]
  const before = structuredClone(values)
  assert.equal(resolve({ ratings: values }).value, 4)
  assert.equal(resolve({ ratings: [older, expired, newer] }).value, 4)
  assert.deepEqual(values, before)
})

test('invalid personal steps and selection are rejected instead of coercing input', () => {
  for (const steps of [0, 0.5, 3.96, 11, NaN, Infinity])
    assert.throws(() => resolve({ personalSteps: steps }), TypeError)
  assert.equal(resolve({ personalSteps: 1 }).value, 0.5)
  assert.equal(resolve({ personalSteps: 10 }).value, 5)
  assert.equal(normalizeMusicExternalRating(fact(), approval(), { now: NaN }), null)
  assert.equal(normalizeMusicExternalRating(fact(), approval(), { now: -1 }), null)
})
