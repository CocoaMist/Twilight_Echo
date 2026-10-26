import assert from 'node:assert/strict'
import test from 'node:test'
import { getTrackSearchBlob } from './trackSearchText.ts'
import {
  damerauLevenshteinDistance,
  getMaxSymSpellTolerance,
  matchesPreparedSearch,
  matchesTrackSearch,
  prepareSearchFields,
  prepareSearchFieldsFromBlob,
  prepareSearchQuery,
  scorePreparedSearchRelevance,
  scoreTrackSearchRelevance,
  SymSpellIndex,
  tokenizeWords
} from './searchRelevance.ts'

test('tokenizeWords and prepareSearchQuery split whitespace tokens vs single tokens accurately', () => {
  assert.deepEqual(tokenizeWords('Moon River (Remastered 2024)'), [
    'moon',
    'river',
    'remastered',
    '2024'
  ])

  const single = prepareSearchQuery('文件-414')
  assert.equal(single.fullNormalized, '文件414')
  assert.deepEqual(single.tokens, ['文件414'])
  assert.equal(single.isMultiToken, false)

  const cjkSingle = prepareSearchQuery('阿中')
  assert.equal(cjkSingle.fullNormalized, '阿中')
  assert.deepEqual(cjkSingle.tokens, ['阿中'])
  assert.equal(cjkSingle.isMultiToken, false)

  const multi = prepareSearchQuery('  周杰伦   晴天 ')
  assert.equal(multi.fullNormalized, '周杰伦晴天')
  assert.deepEqual(multi.tokens, ['周杰伦', '晴天'])
  assert.equal(multi.isMultiToken, true)
})

test('prepareSearchFieldsFromBlob reuses precomputed blob values without drift', () => {
  const raw = {
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    fileName: '03 - 晴天.flac'
  }
  const blob = getTrackSearchBlob(raw)
  const fromBlob = prepareSearchFieldsFromBlob(blob, '\u0000', raw)
  const direct = prepareSearchFields(raw)

  assert.deepEqual(fromBlob, direct)
})

test('single-token queries never match across field boundaries', () => {
  const cjkTrack = prepareSearchFields({
    title: '阿',
    artist: '中',
    album: '华'
  })
  assert.equal(matchesPreparedSearch(cjkTrack, prepareSearchQuery('阿中')), false)
  assert.equal(scorePreparedSearchRelevance(cjkTrack, prepareSearchQuery('阿中')).total, 0)

  const latinTrack = prepareSearchFields({
    title: 'foo',
    artist: 'bar',
    album: 'baz'
  })
  assert.equal(matchesPreparedSearch(latinTrack, prepareSearchQuery('obar')), false)
  assert.equal(scorePreparedSearchRelevance(latinTrack, prepareSearchQuery('obar')).total, 0)
})

test('relevance hierarchy: Exact > Prefix > Word-boundary > Substring > Album > Pinyin Initials > Filename', () => {
  const query = prepareSearchQuery('moon')

  const exactTitle = scoreTrackSearchRelevance(
    { title: 'Moon', artist: 'Someone', album: 'Other', fileName: '01.flac' },
    query
  )
  const prefixTitle = scoreTrackSearchRelevance(
    { title: 'Moonlight', artist: 'Someone', album: 'Other', fileName: '02.flac' },
    query
  )
  const wordBoundaryExactTitle = scoreTrackSearchRelevance(
    { title: 'Blue Moon', artist: 'Someone', album: 'Other', fileName: '03.flac' },
    query
  )
  const wordBoundaryPrefixTitle = scoreTrackSearchRelevance(
    { title: 'Blue Moonlight', artist: 'Someone', album: 'Other', fileName: '04.flac' },
    query
  )
  const substringTitle = scoreTrackSearchRelevance(
    { title: 'Supermoon', artist: 'Someone', album: 'Other', fileName: '05.flac' },
    query
  )
  const substringAlbum = scoreTrackSearchRelevance(
    { title: 'Untitled', artist: 'Someone', album: 'Supermoon', fileName: '06.flac' },
    query
  )
  const substringArtistInitials = scoreTrackSearchRelevance(
    {
      title: 'Untitled',
      artist: 'Someone',
      album: 'Other',
      albumInitials: 'xxmoonxx',
      fileName: '07.flac'
    },
    query
  )
  const filenameOnly = scoreTrackSearchRelevance(
    { title: 'Untitled', artist: 'Someone', album: 'Other', fileName: 'supermoon_track.flac' },
    query
  )

  assert.ok(
    exactTitle.total > prefixTitle.total,
    `Expected exact (${exactTitle.total}) > prefix (${prefixTitle.total})`
  )
  assert.ok(
    prefixTitle.total > wordBoundaryExactTitle.total,
    `Expected prefix (${prefixTitle.total}) > word-boundary exact (${wordBoundaryExactTitle.total})`
  )
  assert.ok(
    wordBoundaryExactTitle.total > wordBoundaryPrefixTitle.total,
    `Expected word-boundary exact (${wordBoundaryExactTitle.total}) > word-boundary prefix (${wordBoundaryPrefixTitle.total})`
  )
  assert.ok(
    wordBoundaryPrefixTitle.total > substringTitle.total,
    `Expected word-boundary prefix (${wordBoundaryPrefixTitle.total}) > substring title (${substringTitle.total})`
  )
  assert.ok(
    substringTitle.total > substringAlbum.total,
    `Expected substring title (${substringTitle.total}) > substring album (${substringAlbum.total})`
  )
  assert.ok(
    substringAlbum.total > substringArtistInitials.total,
    `Expected substring album (${substringAlbum.total}) > album initials (${substringArtistInitials.total})`
  )
  assert.ok(
    substringArtistInitials.total > filenameOnly.total,
    `Expected album initials (${substringArtistInitials.total}) > filename (${filenameOnly.total})`
  )
  assert.ok(filenameOnly.total > 0)
})

test('multi-token cross-field queries and contiguous phrase bonus rank best matches first', () => {
  const jayQuery = prepareSearchQuery('周杰伦 晴天')
  const exactArtistTitle = scoreTrackSearchRelevance(
    { title: '晴天', artist: '周杰伦', album: '叶惠美' },
    jayQuery
  )
  const partialLooseMatch = scoreTrackSearchRelevance(
    { title: '晴天娃娃', artist: '其他歌手', album: '周杰伦致敬合辑' },
    jayQuery
  )

  assert.ok(exactArtistTitle.exact >= 450)
  assert.ok(exactArtistTitle.phrase >= 240)
  assert.ok(exactArtistTitle.total > partialLooseMatch.total)

  const audreyQuery = prepareSearchQuery('audrey moon river')
  const contiguousPhraseTrack = scoreTrackSearchRelevance(
    { title: 'Moon River', artist: 'Audrey Hepburn', album: 'Breakfast at Tiffany’s' },
    audreyQuery
  )
  const scatteredTokensTrack = scoreTrackSearchRelevance(
    { title: 'River of Dreams', artist: 'Audrey', album: 'Dark Moon' },
    audreyQuery
  )

  assert.ok(contiguousPhraseTrack.phrase > scatteredTokensTrack.phrase)
  assert.ok(contiguousPhraseTrack.total > scatteredTokensTrack.total)
})

test('per-field BM25 is completely invariant to unmatched field lengths', () => {
  const query = prepareSearchQuery('moon')

  const scoreShortUnmatched = scoreTrackSearchRelevance(
    {
      title: 'Moon River',
      artist: 'A',
      album: 'B',
      fileName: '1.mp3'
    },
    query
  )

  const scoreLongUnmatched = scoreTrackSearchRelevance(
    {
      title: 'Moon River',
      artist: 'An Extremely Long Unmatched Artist Name With Many Extra Words',
      album: 'An Extremely Long Unmatched Deluxe Anniversary Edition Album Title',
      fileName: '0001_extremely_long_unmatched_file_name_for_testing_invariance.flac'
    },
    query
  )

  assert.equal(scoreShortUnmatched.ftsBm25, scoreLongUnmatched.ftsBm25)
  assert.equal(scoreShortUnmatched.total, scoreLongUnmatched.total)
})

test('personal signals apply favorite boost, banned demotion, logarithmic playCount, and lastPlayed boost', () => {
  const track = { title: 'Moon River', artist: 'Audrey Hepburn', album: 'OST' }
  const query = prepareSearchQuery('moon river')

  const base = scoreTrackSearchRelevance(track, query)
  const favored = scoreTrackSearchRelevance(track, query, {
    signals: { favorite: true }
  })
  const banned = scoreTrackSearchRelevance(track, query, {
    signals: { banned: true, favorite: true }
  })
  const played = scoreTrackSearchRelevance(track, query, {
    signals: { playCount: 20, lastPlayed: 1_700_000_000_000 }
  })

  assert.equal(favored.favorite, 80)
  assert.equal(favored.total, Number((base.total + 80).toFixed(4)))

  assert.equal(banned.favorite, -200)
  assert.equal(banned.total, Number((base.total - 200).toFixed(4)))

  assert.ok(played.playCount > 15)
  assert.ok(played.total > base.total)
})

test('damerauLevenshteinDistance and getMaxSymSpellTolerance handle transpositions and token rules', () => {
  assert.equal(getMaxSymSpellTolerance('ab'), 0)
  assert.equal(getMaxSymSpellTolerance('414'), 0)
  assert.equal(getMaxSymSpellTolerance('周杰伦'), 0)
  assert.equal(getMaxSymSpellTolerance('audry'), 1)
  assert.equal(getMaxSymSpellTolerance('beethovn'), 2)

  assert.equal(damerauLevenshteinDistance('beethovne', 'beethoven', 2), 1)
  assert.equal(damerauLevenshteinDistance('mooon', 'moon', 2), 1)
  assert.equal(damerauLevenshteinDistance('radiahed', 'radiohead', 2), 2)
  assert.ok(damerauLevenshteinDistance('impossible', 'moonlight', 2) > 2)
})

test('SymSpellIndex corrects single-char, transposition, distance-2, bigram, and pinyin initials without false rewrites', () => {
  const index = new SymSpellIndex()
  index.addTrack({
    title: 'Moonlight Sonata',
    artist: 'Ludwig van Beethoven',
    album: 'Classical Masterpieces'
  })
  index.addTrack({
    title: 'Moon River',
    artist: 'Audrey Hepburn',
    album: 'Breakfast at Tiffany’s'
  })
  index.addTrack({
    title: 'Paranoid Android',
    artist: 'Radiohead',
    album: 'OK Computer'
  })
  index.addTrack({
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美'
  })
  // Add "Jay Chou" with strong bigram and another artist with "chao" to test bigram disambiguation
  index.addTrack({ title: 'Nocturne', artist: 'Jay Chou', album: 'November Chopin' })
  index.addTrack({ title: 'Fantasy', artist: 'Jay Chou', album: 'Fantasy' })
  index.addTrack({ title: 'Song One', artist: 'Chao Chen', album: 'Album' })

  // 1. Single-char deletion / substitution
  assert.equal(index.suggestQuery('beethovn')?.correctedQuery, 'beethoven')
  assert.equal(index.suggestQuery('audry')?.correctedQuery, 'audrey')

  // 2. Adjacent transposition (distance 1)
  const transposed = index.suggestQuery('beethovne')
  assert.equal(transposed?.correctedQuery, 'beethoven')
  assert.equal(transposed?.totalDistance, 1)
  assert.equal(transposed?.penaltyFactor, 0.8)

  // 3. Distance-2 typo
  const dist2 = index.suggestQuery('radiahed')
  assert.equal(dist2?.correctedQuery, 'radiohead')
  assert.equal(dist2?.totalDistance, 2)

  // 4. Multi-word bigram disambiguation ("jay chuo" -> "jay chou")
  const bigramSuggestion = index.suggestQuery('jay chuo')
  assert.equal(bigramSuggestion?.correctedQuery, 'jay chou')

  // 5. Pinyin initials correction ("zjl" is 3 chars, "zhoujielun" if indexed or 4+ char initials)
  index.addTerm('zhoujielun', 5)
  assert.equal(index.suggestQuery('zhjielun')?.correctedQuery, 'zhoujielun')

  // 6. In-vocabulary exact query returns null from suggestQuery (no rewrite needed)
  assert.equal(index.suggestQuery('beethoven'), null)

  // 7. CJK, numbers, and out-of-vocabulary words do not get corrupted
  assert.equal(index.suggestQuery('周杰伦'), null)
  assert.equal(index.suggestQuery('414'), null)
  assert.equal(index.suggestQuery('impossible'), null)
  assert.equal(index.suggestQuery('nonexistent'), null)
  assert.equal(matchesTrackSearch({ title: '晴天', artist: '周杰伦', album: '叶惠美' }, '周杰伦 晴天'), true)
})

test('SymSpellIndex 10,000-track build and lookup performance stays within budget', () => {
  const index = new SymSpellIndex()
  const artists = [
    'Ludwig van Beethoven',
    'Audrey Hepburn',
    'Radiohead',
    'Jay Chou',
    'Taylor Swift',
    'Pink Floyd',
    'Daft Punk',
    'Fleetwood Mac',
    'Arctic Monkeys',
    'The Velvet Underground'
  ]
  const adjectives = [
    'Moonlight',
    'Electric',
    'Midnight',
    'Golden',
    'Crystal',
    'Silent',
    'Eternal',
    'Velvet',
    'Cosmic',
    'Harmonic'
  ]
  const nouns = [
    'Sonata',
    'Symphony',
    'River',
    'Horizon',
    'Odyssey',
    'Rhapsody',
    'Serenade',
    'Nocturne',
    'Lullaby',
    'Echoes'
  ]

  const buildStart = performance.now()
  for (let i = 0; i < 10_000; i++) {
    const artist = artists[i % artists.length]
    const adj = adjectives[i % adjectives.length]
    const noun = nouns[(i * 7) % nouns.length]
    index.addTrack({
      title: `${adj} ${noun} ${i % 50}`,
      artist,
      album: `${adj} Collection Vol ${(i % 20) + 1}`
    })
  }
  const buildElapsedMs = performance.now() - buildStart

  const lookupStart = performance.now()
  const suggestion = index.suggestQuery('beethovne sonat')
  const lookupElapsedMs = performance.now() - lookupStart

  assert.equal(suggestion?.correctedQuery, 'beethoven sonata')
  assert.ok(
    buildElapsedMs < 250,
    `Expected 10k track SymSpell build to be fast, took ${buildElapsedMs.toFixed(2)}ms`
  )
  assert.ok(
    lookupElapsedMs < 5,
    `Expected SymSpell lookup to be < 5ms, took ${lookupElapsedMs.toFixed(2)}ms`
  )
})
