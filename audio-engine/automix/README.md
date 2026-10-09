# AutoMix native integration

This is an experimental Windows x64 integration, default off. Stable enablement
is blocked until the release checklist below is completed. For manual in-app
acceptance, configure `TAE_AM_EXPERIMENTAL_PLAYER=ON`; this build allows the
settings switch without an environment variable and still reports
`stableRelease=false`. The option defaults to OFF for ordinary builds.
Alternatively start a validation process with `TAE_AUTOMIX_EXPERIMENTAL=1`.
An explicit startup value of `0` disables the build opt-in. Changing Node's
environment after startup does not reliably change MinGW's CRT environment.

After building the application and staging the runtime, run
`node scripts/automix-controls-smoke.cjs --report <report.json>` from the project
root to verify the actual application, isolated audio service and settings
switch before the first Play. This uses a temporary user profile and hidden
windows, clicks the real settings controls, and never starts audio playback.
Use `--renderer-url http://localhost:5173/` with a running development renderer
to cover `pnpm dev`, and `--delay-renderer-ms 1500` to exercise late renderer
initialization after startup readiness notifications.

## Boundaries and ownership

`AutoMix.h` defines ABI 1 with explicit size/version fields. Source coordinates
are seconds; prepared PCM coordinates are interleaved float32 frames at the
prepared sample rate. Handles are owned by the preparation/control thread and
retired after the audio callback acknowledges its stream epoch. Borrowed PCM
views live through Prepare only. No pointers or PCM are sent through IPC.

The handwritten GAS files use the Windows x64 ABI and `.seh` unwind directives.
SSE2 is the baseline; AVX2 dispatch requires CPU and OS context-save support.
Scoring preserves arithmetic order (`-fno-fast-math`, `-ffp-contract=off`). The
prefixed C oracle is linked only to differential tests. Duplicate candidates
and unknown scores are retained by the scoring/selection API.

`evidence-manifest.json` maps 11 scoring paths to raw disassembly addresses and
SHA-256 identities. Regenerate it with `scripts/automix-evidence-manifest.cjs
--reference <automix-c>`. `compiled-asm` is a compilation reference, not evidence.
The reference package supplies no license; it has not been labeled MIT. Apple
frameworks, original executables/models and development snapshots are excluded
from the application asset staging allowlist.

## Independent analysis and policy

Analysis version 4 deliberately retains unknown key and phrase
boundaries. Beat This small0 and YAMNet run through the pinned ORT CPU C API, one
thread per inference without spinning. Analysis runs in the isolated service,
not the playback process. Current-tail and next-head requests are serialized;
the service decodes at most 45 seconds for each window. The cache contains only
validated features, keyed by file identity, analysis version and model hashes.
Stability fits observed eight-interval spans on sliding windows, accounts for
the model's 20 ms endpoint quantization, and rejects individual missing or
irregular intervals. Merged tempo uses the full observed span. Version 1/2/3
cache entries are rejected. Events beyond the last beat are never synthesized.
Regional energy uses the louder original channel at the original PCM rate;
mono cancellation and high-frequency removal cannot authorize silence skips.
Precise analysis seeks to integer decoded output frames, with one second of preroll,
global resampling phase alignment and trimming of codec priming. Discontinuous
or missing frame timestamps reject intelligent preparation. At most 45 seconds
are analyzed per window; seek preroll is decoded solely to establish history.

For online sources, the owning main-process provider registers actual content
identity, actual quality, known duration and seekability. NetEase supplies this
only for complete official non-trial responses with a content hash and size.
The coordinator refreshes authorization before reading cached features, after
analysis and again when delivering both tracks. Unknown providers/identity,
changed content/quality and expired authorization retain conservative playback.
Short signed URLs are never cache identities. Preparation and continuation
decode the refreshed URL, while the queue retains its original logical source.

`CandidatePlanner.cpp` is an independent region generator, not an Apple Song
adapter. Its production policy permits filtered-direct style 8 only
when both windows have stability confidence >=0.8 and reciprocal source-rate
ramps stay within 0.92–1.08 (including half/double beat interpretation),
and covered vocal probability <0.15 on at least one side (two concurrent vocal
parts or unknown overlap remain excluded). All repeated
stable-region pairs survive. Complex private-AU styles, Apple loudness relation
codes, native event indexes and native nils are never synthesized.
The rate ratio is interpreted incoming BPM / outgoing BPM. Source spans use
`Li=Lo/q`, outgoing rates `1→q`, incoming rates `1/q→1`, and a shared playback
horizon `Lo*log(q)/(q-1)`. Prefix-aware downbeat alignment preserves the incoming
music. The adapter's compensated-tempo eligibility is independent product
policy; Apple's strict-tempo classifier remains unrecovered.
Tail coverage may extend at most six seconds beyond its last stable interval;
extension beyond two seconds additionally requires non-vocal coverage and peak
energy <=-24 dBFS. This retains an observed decay. This is independent policy;
aliases never double or halve either track's playback speed.
Selection first admits the highest eligible product tier: beat/tempo mix,
unaligned musical overlap, boundary cleanup, then conservative fading. Within
that tier the unchanged recovered assembly scorer/selector chooses from every
candidate, including duplicate regions. Natural-mode beat candidates retain
style 8 for recovered scoring but render catalogue template 7, with its complete
equal-power envelopes and full reciprocal rate ramps. The assignment is our
product rule; templates, recovered scoring and default routing are unchanged.
It avoids the strongly masked incoming entry observed with filtered template 8
on fading real-file tails. Unaligned musical overlap uses the
recovered style-1 equal-power envelopes at 4/6/8 seconds; it is explicitly labelled
as unaligned rather than beat mixing. Transition length is capped at half of
each track's duration, independently of the 10% silence-skip budget.
Both musical tiers require an input-energy estimate >=2 seconds, then actual
prepared evidence >=2 seconds total and >=1 second continuously. In 20 ms cells,
each post-effect/envelope/track-gain contribution must exceed -48 dBFS and remain
within 24 dB of its own regional peak. This is an eligibility floor, not listening
quality. A selected tier that fails preparation/evidence falls to a lower tier;
one candidate is prepared per tier. No extra work is added to the callback.
Status and diagnostics distinguish `beat_mix`, `musical_overlap`,
`boundary_cleanup` and `conservative`, with measured overlap, maximum tempo
adjustment and actual incoming resume/outgoing end source times.
Recovered soft-skip style 5 is also available for independently confirmed quiet
decays or verified boundary silence; it needs no fabricated native key, tempo
or loudness categories. This path is at most two seconds, with the same vocal
overlap protection. Quiet decay requires a last-second peak <=-35 dBFS and a
>=6 dB drop from the preceding two seconds. These are independent product
thresholds, not recovered Apple classifier thresholds.

When intelligent skipping is allowed, only contiguous head/tail cells <=-60
dBFS with complete non-vocal coverage can be skipped. At least 500 ms of silence
is required; 100 ms around content is retained. Each side is limited to 12
seconds and 10% of track duration. A fully silent analysis window with no observed
content boundary is not skippable. Missing/partial energy, unknown vocals and
active musical decay preserve their boundaries. Disabling skipping retains
complete source boundaries. The analysis deadline includes the possible tail
skip, and a ready fallback remains armed throughout replacement preparation.
The fallback
is at most four seconds of constant-power fading, subject to album/CUE/repeat,
duration, DSP order and output-format checks. All 24 catalogue templates remain
available to offline rendering and verification.

`TransitionEffects.cpp` provides independent effects, not Apple AU sound parity.
The 69 recovered parameter defaults are used verbatim. Filter cutoff is Hz;
filter types 0/1/2 are independently calibrated LP/HP/BP. Private remix ordinal
rates use a documented independent subdivision table: 4,2,1,1/2,1/4,1/8,1/16,
1/32 beats, with straight/dotted/triplet delay variants. Normalized flanger
center/depth map to 0.1–20.1 ms and 0–10 ms. These mappings are not verified Apple
behavior and REMIX_FX stays excluded from automatic selection.

## Playback

The preparation worker independently decodes, normalizes, stretches/effects and
prepares both tracks plus a positioned/prerolled continuation decoder. The
callback reads immutable PCM, uses assembly mixing/clocks, and applies common
user DSP once. It performs no decode, inference, allocation, destruction, file
access or blocking lock for AutoMix. The queue pair, preparation serial, source
identities, configuration revision and output-format lifetime reject stale work.
Analysis cannot replace a plan within the sum of the maximum transition length,
maximum allowed tail skip and two seconds from the end, or after it starts.
The per-pair attempt is fixed at that deadline.
A ready conservative buffer stays available during intelligent preparation.
Failed or late replacements retain it. Plan revisions reject earlier worker
results. Replacement withdraws the old render pointer before advancing its
retirement epoch.

Manual Next adopts the current incoming source time and reads the prepared
incoming remainder at unity envelope, then joins the already positioned decoder.
Changing the following preload keeps this current-track continuation. Other
transport discontinuities retire the old plan. Queue promotion happens once.

`TAE_AM_GetSourceWindow` returns nominal source bounds and the additional
history/lookahead required by variable-rate preparation. The pinned Signalsmith
default preset uses the full seek history; context is bounded by 300 ms plus
256 frames on either side. Missing context rejects preparation. The decoder
may pad only after confirmed EOF and after decoding every nominal sample.
Context changes neither the analytic source clock nor the continuation frame.

AutoMix forces PCM and temporarily suspends Direct/DSD passthrough without
changing saved preferences. Disabling uses the latest preferences. A custom DSP
graph is rejected when its normalization/common-processing order cannot be split.
Canonical output reports `automix_active` and `outputPerfect=false` during actual
processing. Settings expose preparation, readiness, mixing and degradation.

Memory limits include borrowed input windows, owned PCM and the continuation
decoder's PCM ring/read scratch. Retired prepared PCM and continuation buffers
is subtracted from the next job's budget. Effect allocations are preflighted.
Actual C++ allocation peaks are measured for 24 templates, six sample rates,
and long 192 kHz mono/stereo preparation. The pinned Signalsmith workspace
allowance is 24 PCM seconds plus 1 MiB; the former four-second allowance was
insufficient. Long high-rate plans can be rejected before workspace allocation.
This allocation audit excludes codec internals, OS and allocator metadata; a complete
pipeline memory audit is still required. The 16 MiB feature cache uses
conservative UTF-16 accounting; disk entries are checksum-protected and atomically
written, with a 512 MiB limit.

## Reproduce and validate

Use the project MinGW wrappers for configure/build/test; do not substitute a
different vcpkg environment. `stage-automix-assets.cjs --source <model directory>`
verifies the three pinned SHA-256 assets and stages the lock file and licenses.
Python, original checkpoints and conversion fixtures are development-only.

Tests cover scoring/selection boundaries, 24 templates, clocks, SIMD guards,
prepared chunk parity, six sample rates, unknown feature signals, duplicate
regions, transport cancellation, manual Next and cache/analysis races. Real
WASAPI smoke uses an explicitly selected endpoint and low volume. Timing reports
bound p99.9 in 0.1% buffer-period histogram bins; bucket 1001 means above deadline.
AutoMix timing excludes common DSP, sums all measured portions of one callback,
and uses the whole callback's buffer period (including manual Next handover).
The legacy `autoMixSegmentCount` field now counts callbacks with measured AutoMix
work. Short smoke measurements do not
constitute a statistically adequate performance matrix or listening gate.

`automix-music-probe.cjs` analyzes local files and uses the native development
`twilight_automix_plan_probe` to inspect actual candidates. It stores only
features and source identities, with listening ratings left unassigned.
`--reuse-manifest <previous manifest>` replans existing features without model
inference. Its musical coverage counts are estimates, separated from cleanup.
`twilight_ffmpeg_decoder_tests --automix-pair-probe <pair.json> [--wav <preview.wav>]`
decodes a real pair, verifies prepared evidence and follows the same tier
fallback. Optional local WAV previews use fixed -6 dB gain and are not full-song
or listening acceptance. The application probe supports `--require-mix-kind`,
`--min-audible-overlap` and `--min-tempo-adjustment`; continuation checks use the
actual source resume position rather than the stretched playback duration.
`automix-playback-smoke.cjs --features <pair.json> --require-style 8` verifies
intelligent playback with those features. The native probe's `--benchmark 1000`
measures warmed candidate generation, assembly selection and template compile;
it excludes host cache I/O and audio preparation.

If the running player holds the old DLL, prepare a separate runtime using
`stage-audio-engine.cjs --build-dir <build> --output-dir <prepared-runtime>` and
`stage-automix-assets.cjs --source <models> --target <prepared-runtime>/automix`.
Default staging can be run after the player closes. Separate staging does not
change the runtime currently loaded by the player.
`TAE_AUDIO_ENGINE_STAGE_DIR=<prepared-runtime>` selects the same isolated output
when running the MinGW build wrapper or the full no-device gate. Set
`TWILIGHT_LOUDNESS_NATIVE_BINDING` to that runtime's addon for native loudness
tests, so they also exercise the newly built artifact.

`automix-online-smoke.mjs` serves local music over HTTP Range in a separate
process, expires the original URL before preparation, and verifies refreshed
native analysis, mixing and continuation on the selected WASAPI endpoint. This
development fixture does not validate a real online provider account.
`twilight_ffmpeg_decoder_tests --precise-seek-probe <file>` compares four source
positions against continuous decoding at all six sample rates. The regular
decoder tests also cover fractional resampling and repeated seeks in WAV.
`twilight_ffmpeg_decoder_tests --automix-boundary-probe <file>` compares head
and tail preparation plus continuation with continuous decoding at all six
rates, including a variable-rate template. It reports decoded/rendered error
without assigning subjective listening scores. The regular decoder suite runs
the same preparation/continuation checks on WAV.

## Stable release checklist (currently incomplete)

- [ ] Validated key/phrase capabilities and broader natural candidate generation.
- [x] Main-process online refresh/content-quality identity integration and
      expired-URL HTTP-range fixture (real provider playback still untested).
- [ ] Original-source sample precision and stretch/delay boundary audit.
- [ ] Peak-memory allocator audit and cancellation/worker-restart soak.
- [ ] Listening/lyric statistics for both simultaneously audible source clocks.
- [ ] 100 fixed music pairs, full-track assessment and >=95% natural listening.
- [ ] Six sample rates x four buffer sizes: p99.9 AutoMix <=10%, full callback
      <=80%, existing mean <=65%, and cached planning p99 <=50 ms.
- [ ] Actual WASAPI long-run/device-switch validation and 24-hour soak.
- [ ] ASIO hardware validation (deferred at the user's request).
- [x] Complete no-real-device gate, including the context/continuation changes.
- [ ] Packaged build and release manifest review.

Disable AutoMix to return to normal playback. Stable enablement remains blocked
while these requirements are unverified; an experimental smoke pass does not
change that gate.
