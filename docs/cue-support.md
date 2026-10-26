# Single-file CUE support

Twilight Echo treats a supported audio file plus one unambiguous sibling CUE sheet as several
logical local tracks. The audio file remains the only decoder source; the CUE file supplies stable
track identity, title/performer/album metadata, source ranges, and pregap metadata.

## Intake and decoding

- CUE files are limited to 2 MiB and may be UTF-8 with or without BOM, GBK, or GB18030. Decoding
  is fatal: malformed byte sequences are rejected instead of being replaced with `U+FFFD`.
- GB18030 four-byte sequences are detected before GBK so the stored `cueEncoding` is accurate on
  ICU builds that accept GB18030 extensions through a GBK decoder.
- Only one referenced audio file and `AUDIO` tracks are accepted. Every track requires `INDEX 01`.
  Absolute paths, directory traversal, unsupported extensions, missing files, overlapping ranges,
  and ambiguous multiple CUE sheets leave the ordinary audio-file track intact.
- **Scan behavior:** oversize / bad encoding / multi-CUE / path escape keeps the whole-file track
  (no toast). Main process logs `[library] CUE skipped (…): <reason>`. Settings → 音乐库 also
  summarizes these limits next to full rescan.
- `INDEX 00` source audio is not discarded. The preceding logical range ends at the next
  `INDEX 01`, keeping album playback continuous, while the following track still starts at its
  `INDEX 01`. `sourcePregapSeconds` records that source-backed interval for presentation only.
- An explicit `PREGAP` is different: it has no source bytes and becomes a synthetic-silence prefix
  on the following logical track. Its duration is stored as `virtualPregapSeconds`.
  `pregapSeconds` remains the compatibility/presentation value for either form.

## Unified track and persistence model

Each logical track gets a deterministic `local:cue:<hash>` id and carries:

```ts
cueRange: {
  startSeconds: number
  endSeconds: number
  pregapSeconds: number
  virtualPregapSeconds: number
  sourcePregapSeconds: number
}
cueSheetPath: string
cueEncoding: 'utf-8-bom' | 'utf-8' | 'gbk' | 'gb18030'
```

These fields survive library reconciliation, queue virtualization, native queue preparation, and
versioned playback-session save/restore. Queue identity is the logical id/index, not the audio
path, because adjacent CUE tracks intentionally share one source.

The incremental file index includes a hash of sibling CUE names, sizes, and mtimes. Adding,
editing, or removing a CUE therefore reparses the affected directory's audio entries without
requiring a full manual scan. Playback-session writes reject malformed ranges; on load the
versioned persistence layer can recover the last valid backup instead of restoring a segment as
an accidental whole-file Track.

## Playback behavior

- Renderer and native positions are relative to the logical track. Seeks are clamped to its logical
  duration and translated past any virtual prefix to the absolute source offset. The native
  decoder emits real silence for an explicit `PREGAP`; local playback has no HTMLAudio fallback.
- The native decoder stops exactly at `endSeconds`. It preloads the next logical range even when
  it uses the same source file and promotes it without reopening the output device when gapless
  playback is eligible. A preloaded virtual pregap is never consumed underneath the preceding
  track; enabling crossfade cannot shorten or overlap that silence prefix.
- ReplayGain/R128 metadata is copied into every logical Track and native queue item. Runtime tag
  refresh and preload promotion compare source plus CUE range, preventing one same-file track from
  overwriting another track's gain.
- PCM pregap samples remain exact zero after ReplayGain, routing, volume and dither. DoP emits the
  canonical DSD idle pattern with alternating `0x05`/`0xfa` markers and resets marker phase after
  seek. Because a DoP payload is always MSB-first, that pattern appears as `0x96` in both payload
  bytes — `0x69` is the same pattern written LSB-first, which is what a native DSD path emits when
  the backend's bit order is LSB-first.
- DSD segment accounting uses byte-frame units on Native DSD and carrier frames on DoP, so a CUE
  boundary cannot overrun by the eight DSD samples packed into one byte.

The native runtime gate covers same-source preload/promotion, crossfade isolation, ReplayGain
transition, exact PCM/DoP/Native-DSD pregap output, relative seek clamping, absolute decoder
offsets, and DoP marker restart. Physical-device gapless behavior remains part of the opt-in
real-device release smoke, not the default no-device test gate.
