# AutoMix evaluation 1.3.0-automix.5

`twilight-rules-4` adds an independent original-speed DJ tail-overlap route.
The frozen 36-pair manifest and raw public-model analysis are unchanged. This
is an optimization of Twilight's own planner and prepared transport; neither
reference project is a runtime dependency or a source transplant.

## Reference findings and implementation

The relevant Java sources under
`C:/Users/XOS/Desktop/automix/src/main/java/dev/t1m3/qplayer/audio/mix/` are
`Chooser.java`, `RouteScore.java`, `RouteGates.java`, and `AutoCue.java`.
`RouteGates` gives overlap/ring-out routes independent loudness and trailing-span
requirements, while long plain blends still require tempo compatibility.
`RouteScore` requires all necessary factors; positional bonuses cannot rescue
an invalid route. `AutoCue.evaluate` examines the mixed envelope, energy motion,
vocal overlap and discarded material when ranking positions.

The C reference's `src/am_scoring.c` smart-crossfade branch similarly depends on
incoming loudness relation and trailing duration. Its
`windows/contracts/pair-eligibility-contract.md` distinguishes unknown, nil and
invalid evidence. `WINDOWS-HANDOFF-v13.md` explicitly leaves end-to-end model,
service and final-song equivalence unfinished. The Java README also documents
unavailable beat/stem model loading in that offline release. Those limitations
prevent treating route declarations as proven audio quality.

Twilight applies these ideas with its existing, source-bound analysis and PCM:

- Beat routes retain priority and the existing DJ +/-12% speed bound. Natural
  retains +/-4%, its eight-second limit and exactly the previous selections.
- When beat routes fail, `am_tail.inc` considers 16/20/24-second original-speed
  overlaps ending at the actual non-silent tail. It never shortens the outgoing
  track to find a convenient earlier ending. The start remains within the last
  min(60 seconds, 25% of track length), after 20 seconds / 20% of the track.
- Incoming entries are the verified beginning or at most 32 safe downbeats
  within the first 20 seconds / 25%. Skipped material must have known low voice
  activity; a clean entry cannot justify discarding an earlier vocal intro.
- Both lanes need complete voice coverage, >=85% active frames and >=80% frames
  with positive independent music-class evidence. Outgoing words cannot occupy
  the second half; incoming words cannot occupy the first half.
- Outgoing decay must reach 6 dB. Audible entry/exit levels must exceed -50 dBFS
  and differ by at most 12 dB. Predicted one-second mixed energy must remain
  within 5 dB of the interpolation between those endpoint levels.
- At least half the selected span must have both lanes above -55 dBFS and within
  24 dB of the louder source endpoint, after the actual crossfade gain curve.
  Quiet padding alone cannot produce a long-mix count.
- In the central half, at least one lane must have sparse full-band (>3 dB)
  rises in <=2.5% of 20 ms cells and low-band (>3 dB) rises in <=4% of cells.
  These are measured transient proxies, not a percussion detector or a proof
  of rhythmic compatibility. Their limitations still require human listening.
- The route uses clean rendering, speed 1/1 and honest BPM/confidence 0/0.
  It shares the complete 128 MiB source/DSP preparation budget and live minimum
  start bound. Unsupported evidence keeps the existing short fallback.

Ranking rewards jointly audible music and continuous mixed energy, and
penalizes vocal activity and skipped instrumental content. Duration alone has
no positive score. Native selection and playback status share one strategy-name
function; main/renderer/harness use rule version 4 and display `tail-overlap`
separately from beat alignment. Version 3 requests are rejected by the new host.

## Frozen-corpus results

| Measure | .4 / rules 3 | .5 / rules 4 |
| --- | ---: | ---: |
| Natural intelligent preparation | 26/36 | 26/36 |
| DJ intelligent preparation | 34/36 | 34/36 |
| DJ overlap >=16 seconds | 19/36 (52.8%) | 22/36 (61.1%) |
| DJ beat-aligned long mixes | 19 | 19 |
| DJ original-speed long tail overlaps | 0 | 3 |
| DJ original-speed short handoffs | 15 | 12 |
| DJ speed-limit fallbacks | 2 | 2 |

The new tail-overlap plans are pair-12 (24 seconds), pair-15 (24 seconds), and
pair-17 (16 seconds). Independently decoded stereo PCM, the exact gain correction
and verified prepared shared headroom show 15.68, 16.90 and 12.52 seconds of
jointly audible music respectively. Incoming entries are 1.94, 0 and 0 seconds.
The existing 19 beat-aligned long plans and all Natural plans are preserved.
These are preparation/rendering counts, not suitability or listening ratings.

## Reproduction and executed checks

`tools/evaluate_rules3.py` now accepts `--rule-version` and `--comparison` while
preserving its old defaults. Supply the unchanged original raw-analysis cache
as `--baseline`, the .4 listening directory as `--comparison`, rule version
`twilight-rules-4`, the built pair probe and production C++ window exporter.
Use new output/scratch directories to preserve previous evidence.

The evaluator verifies source and manifest digests, raw-window provenance,
production JSON ownership against the Python merge mirror, identical C/SSE2/AVX2
plans, full PCM renders, endpoint sample joins, finite samples and body peaks
<=0.9801. The new tail PCM witness also verifies that shared headroom explains
the actual prepared output before measuring each lane's audible contribution.

Seven standalone native checks pass. The full MinGW suite passes 47 checks;
the existing ASIO ABI cross-DLL fixture is skipped. Tail fixtures cover valid
rendering, unknown voice/music/spectral evidence, coverage holes, dense
transients, hidden low-band pulses, vocal intro preservation, silence padding,
energy holes, late preparation and full memory reservations. The host transport
fixture rejects rule 3 requests. Audio manager (445), focused AutoMix (40),
release artifacts (60) and device harness provenance (3) tests pass. Evaluation
typecheck/build, relevant lint, packaged application/restore, 241-package
dependency closure and executable branding checks also pass.

Three silent real WASAPI handoffs use the stripped .5 packaged runtime and
the source-verified analysis windows for pair-12, pair-15 and pair-17. Each
checks the actual `tail-overlap` selection, pause freezing both clocks, a single
queue promotion, incoming source continuation and zero callback deadline misses
or underruns. The desktop/mobile listening page and its three-new/22-long
filters pass. Development runtime staging matches the build digests; the addon
loads, parses rule 4 windows and rejects rule 3. No user process was terminated.

## Acceptance boundaries

The evaluation remains off by default and formal release acceptance remains
false. The source/model formats did not change; cached analysis reuse is recorded
explicitly, with no claim of fresh model inference. Public locked models remain
the only shipped analysis assets. Human listening, preannotated suitable-pair
coverage, a completed 24-hour application/device run, real online-account
acceptance and formal publication remain pending. Earlier failure and evaluation
records remain intact. The optional enhancement pack remains compatible.
