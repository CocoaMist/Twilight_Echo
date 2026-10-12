# AutoMix evaluation 1.3.0-automix.4

Rule version `twilight-rules-3` improves selection and window merging on the
unchanged frozen 36-pair corpus. Existing uncommitted work is preserved.
The source files remain under `D:/Project/Twilight_Echo`; the two desktop
AutoMix directories are reference material.

| Executed preparation/rendering metric | .2 / .3 | .4 |
| --- | ---: | ---: |
| Natural intelligent preparation | 12/36 | 26/36 (72.2%) |
| DJ intelligent preparation | 23/36 | 34/36 (94.4%) |
| DJ output lasting at least 16 seconds | 15/36 | 19/36 (52.8%) |

Natural consists of 25 original-speed content-boundary handoffs and one
beat-aligned transition. DJ consists of 19 beat-aligned long mixes and 15
original-speed short handoffs; pair-06 and pair-33 retain speed-limit fallback.
Short content handoffs are included in intelligent preparation, not in beat
alignment or long-mix coverage. These unannotated pairs do not establish the
80% preannotated suitable-pair gate, or human listening acceptance.

## Implementation

`AutoMixAdapter.cpp` assigns overlapping timestamps to the window with the
greatest distance from its edges, using consistent ownership for beats,
downbeats, energy and voice coverage. Edge predictions cannot override a
better-context window. Within the owning window, overlapping voice evidence
uses the maximum voice probability and maximum independent music score;
missing voice coverage remains unknown. `tools/merge_windows.py` mirrors the
production implementation; corpus evaluation checks both views against the
actual C++ JSON parser through the developer exporter.

`am_plan.c` scans the complete analyzed boundary for confirmed silence, instead
of stopping at three seconds. Music evidence requires at least 0.5 seconds of
audible frames with a positive music score, so silent padding and a quiet fade
do not veto an otherwise musical handoff. Two-to-eight-second original-speed
candidates may finish outgoing words in their first half and introduce incoming
words in their second half; unknown voice coverage, outgoing words in the
second half, or incoming words in the first half still reject that candidate.
Incoming fades must reach audible music by the end of the candidate.

The tempo target is clamped to the intersection of the two permitted ranges.
This corrects rejection when the geometric mean lies just outside a limit but
a valid common target exists. Natural remains within +/-4% and DJ within
/-12%; tempo-fold interpretations do not expand the audio-speed limit.

`am_dj.inc` searches 4/8/12/16-bar candidates with 65 exit and 33 entry slots.
Only relevant nearby downbeats consume the bounded search budget. Every
candidate uses the shared complete preparation-peak estimate, including source
context, FFT/stretch workspace and effects, under the aggregate 128 MiB
reservation. Selection applies the live earliest-start boundary while searching,
allowing a shorter valid candidate when a longer one is already too late.

The TypeScript host, native pipeline and device harness all use rule version 3.
Model weights, graph version, inference and optional stem-worker ABI are
unchanged. Enhancement pack 2.2 remains compatible; this corpus evaluation
uses the base audio path, with no new stem-enhancement or model-training claim.

## Evidence and reproduction

Corpus SHA-256:
`ee2c8f460725307331ee76fe866ef0a4b1d9ea332083eb6b8fc595827cb31520`.
Raw analysis from the earlier evaluation is reused after verifying the baseline
report, both real source digests and each window's source identity. This is a
new selection/preparation/render run, not a new model-inference run.

From the checkout, the following PowerShell command reruns the corpus into a
new scratch/output directory. Existing outputs are retained for comparison.

```powershell
$evaluationRoot = 'C:/Users/XOS/Documents/Codex/2026-10-11/c-users-xos-desktop-automix-c-2'
& 'D:/TwilightEchoDependencies/automix/venv/Scripts/python.exe' `
  'audio-engine/automix-native/tools/evaluate_rules3.py' `
  --corpus 'D:/TwilightEchoDependencies/automix/evidence/real-pairs/corpus.json' `
  --baseline 'C:/Users/XOS/Documents/Codex/2026-10-11/a-u/work/v2-listening' `
  --probe "$evaluationRoot/work/native-build/automix_pair_probe.exe" `
  --windows-probe 'D:/TwilightEchoDependencies/builds/audio-engine-mingw/twilight_audio_performance_gate.exe' `
  --output "$evaluationRoot/work/reproduction-listening" `
  --scratch "$evaluationRoot/work/reproduction-render"
```

The corpus tool renders real source PCM through native C, SSE2 and AVX2
planning/stretch/mix paths, verifies identical plans, sample differences,
source-frame endpoints and interior limiting, and saves 144 before/after WAVs.
PCM extraction/resampling in this offline corpus tool uses libsndfile and
torchaudio; real playback uses the production decoder, tested separately.

Executed checks: full current MinGW CTest 46 passes plus one ASIO cross-DLL
environment skip; six native checks; 40 focused AutoMix tests; three device
harness provenance tests; evaluation typecheck/build and relevant lint.
The packaged main/preload/renderer and real native utility processes passed
mode/cache persistence and runtime-provenance checks. Dependency closure
(241 packages), executable branding and ZIP integrity passed. No new MSVC run
is inferred from historical MSVC checks.

Three silent real WASAPI runs use the packaged engine: pair-14 Natural,
pair-20 DJ and pair-26 DJ. Each verifies preparation, pause freezing both
clocks, one queue promotion, consumed-source continuation and zero callback
deadline misses/underruns. A first device attempt stopped on a test assertion
that compared rounded JSON seconds with an unrounded frame fraction. Its
record is retained; the corrected assertion compares restored integer source
frames, and the complete rerun passes all three pairs.

## Delivery and remaining gates

Artifacts, Chinese instructions, listening page, checksums and reports are in
`C:/Users/XOS/Documents/Codex/2026-10-11/c-users-xos-desktop-automix-c-2/outputs`.
The Windows x64 .4 ZIP contains the tested stripped native DLL with SHA-256
`c845ae37984613075e808bf8c18e4af1ae1fa5952bff2559a08e6c2abd918a0e`.
The optional enhancement pack need not be downloaded again.

The initial development staging attempt returned EBUSY because the existing
player owned the old DLL. After the user closed it, the ignored development
runtime was successfully staged from the verified build. All three runtime
digests match the build; addon loading and rule-version probing pass. The new
DLL accepts version 3 analysis windows and rejects stale version 2 requests.
Future staging uses:

```powershell
node scripts/stage-audio-engine.cjs --build-dir 'D:/TwilightEchoDependencies/builds/audio-engine-mingw'
```

The packaged application already includes rule version 3. Human listening,
preannotated suitable-pair coverage, a completed new-engine 24-hour stress run,
real online-account acceptance and formal publication remain pending. The
earlier failed long-duration run remains a failure. Default mode and release
acceptance remain Off and false.
