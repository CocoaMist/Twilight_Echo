# AutoMix validation record — 2026-10-09

Status: experimental Windows x64, default off. Stable release gates remain
incomplete. This record describes executed checks; it is not a release approval.

## MSVC build and preparation registration

MSVC Debug and MinGW Release each pass the 35 standalone registered checks.
Preparation retains every original assertion across 24 template cases, six
sample rates, mono/stereo resource limits, fractional boundaries and selection.
Each workload has its own CTest entry under the existing 180-second timeout;
assertions remain enabled. MSVC takes 330.68 seconds in total with two workers;
its longest case takes 122.36 seconds. MinGW takes 105.25 seconds in total.
The standalone checks do not configure original-model parity fixtures.

The MSVC build enables C11 atomics specifically for `Kernels.c`. Embedded JSON
uses null-terminated byte arrays to preserve the asset bytes without exceeding
MSVC string-literal limits. No asset or playback policy changes are included.

## Executed checks

- Recovered arithmetic: 96,000 score cases and 3,000 selection cases compared
  with the C oracle; 24 template compilation, 10,000 clock round trips and
  SSE2/AVX2 guards/chunk parity pass.
- Native preparation: 24 templates, six PCM sample rates, actual C++ allocation
  tracking and realtime mix `new`/`delete` checks pass. At 192 kHz, the long mono
  case peaks at 57,054,312 allocated bytes plus 19,968,000 borrowed PCM bytes.
  The corresponding stereo case is rejected by the resource preflight; its
  measured partial allocation peak is 90,779,748 plus 39,936,000 borrowed bytes.
  Codec/OS/allocator metadata is outside this allocation audit.
- Pair lifecycle: promotion, manual Next with prepared continuation, cancellation,
  feature revisions, intelligent replacement failure/deadline/seek and successful
  replacement pass. Ready fallback buffers survive failed/late replacements.
- Clock lifecycle: deterministic tests cover pause and PCM-to-DoP reroute while
  a `config-applied` callback is in progress. The clock refreshes its snapshot
  and reads lifecycle flags after regaining the transport lock.
- Analysis revision 3: last complete beat window, confident contiguous-region
  merging, tempo discontinuities, short/invalid inputs and half/double beat
  interpretation pass. Revision 1/2 feature cache entries are rejected.
- Precise PCM seek: WAV continuous-decode parity covers six rates, Native/Ultra
  resampling, five positions including EOF and repeated seeks. Actual FLAC
  (`Cloudier - Set Free`) and MP3 (`ak+q - Axium Crisis`) compare four positions
  at each of the six rates, with maximum PCM error zero in both files. Codec
  priming is handled at source start. Missing/discontinuous frame timestamps
  reject precise seek. This is evidence for these files/codecs, not proof for
  every compressed container or the complete stretch boundary.
- Preparation context/continuation: WAV and the actual FLAC/MP3 files above
  pass six rates and four templates (0, 1, 8, 17). Each real file tests head and
  tail source windows. Independently positioned decode is compared with
  continuous decode; the prepared mix is compared with the continuous-source
  render, and the continuation begins at the exact nominal incoming end.
  Maximum decoded and rendered PCM errors are zero in these runs. Unity
  processing also joins the last half-open source sample to the next sample.
  Minimum-context and larger-view renders are identical; insufficient stretch
  context is rejected. These checks prove the tested source/clock boundaries,
  not perceptual stretch quality or Apple effect sound parity.
- Beat This/YAMNet fixed original-model fixtures pass native frontend, inference
  and event parity. Model assets remain pinned to the lock file SHA-256 values.
- Online identity/coordinator/manager checks: 15 pass; ordinary plugin suite:
  493 registered, 492 pass and one skip, plus nine font-registry checks pass.
  NCM official actual-quality identity, URL-cache refresh, trial/incomplete
  metadata fallback and managed-local-file checks are included (74 NCM tests).
  Audio-manager suite: 441 pass on the final delivery-refresh sources in the
  completed no-device aggregate.
  Staging/toolchain:
  55 pass. Node/web type checks and application build/renderer budgets pass.
- Full native registration: 43 tests; 42 execute and pass, one ASIO cross-DLL
  test is skipped. A PCM/DoP clock-snapshot race observed during one run was
  repaired and given a deterministic regression test. The complete project
  `test:no-real-device` aggregate passes on the context/continuation sources;
  its native segment takes 254.79 seconds. Type checks, application build and
  renderer budgets pass (625 files, 8,907,800 font bytes). The deprecated
  mini-player structural assertion was updated to the effective-theme contract;
  the player material behavior was preserved. Packaged distribution validation
  remains separate and incomplete.

## Actual music and WASAPI

Music root: `D:\Music`. First 48 sorted files analyzed with revision 2; the
native candidate generator admits one ordered pair under current conservative
policy. No listening ratings are assigned by the probe.
Those revision-2 features are historical evidence and are not accepted by
revision 3. The HTTP fixture below freshly analyzes the selected pair with
revision 3.

Headphone: `耳机 (2- FRANSUN CX31993 HiFi-Audio)`.
Endpoint: `{0.0.0.00000000}.{066e3c32-e9ce-418d-9122-a558f1837123}`.

Intelligent smoke: `Cloudier - Set Free.flac` → `Avans - All In.flac`, style 8,
approximately 3.18 seconds. It observes mixing, canonical `automix_active`, one
queue promotion and incoming continuation after the already played overlap.
Volume is 0.02. The short run records 1,094 callbacks, 319 callbacks with measured
AutoMix work and no deadline miss. p99.9 histogram upper bounds are 0.3% of the
callback period for the full callback and 0.2% for AutoMix, excluding common DSP.
These are short-run measurements, **not release performance passes**.

The requested shared-mode buffer is 256 frames at 48 kHz. The device reports
4,800 frames of output buffering and observed callback periods average about
10 ms. It must not be counted as hardware validation of a 256-frame callback.

Warmed native candidate generation, selection and template compilation for the
same pair: 1,000 iterations, p99 10.668 ms and maximum 10.946 ms. Host cache I/O,
authorization, IPC and audio preparation are excluded from this measurement.

## Development online fixture

`http-online-smoke-v3.json`: actual music served by a local HTTP Range server;
original URLs expire before delivery. The main-process registry, online resolver
and coordinator refresh the actual content/quality identity before cache access
and final delivery; native preparation and continuation read the refreshed URL.
The test observes style 8 mixing, canonical output diagnosis, exactly one queue
promotion and continuation with the original logical queue source. It passes
with 41 refreshed Range requests. Two actual native model analyses take about
2–3 seconds each on this machine. Features remain in memory in this fixture.
No real online provider account/playback, subjective quality, full song or
24-hour playback is covered by this test.
The latest context-enabled build is rechecked in
`http-online-smoke-v3-context.json`, also passing with 41 refreshed Range requests.

## Evidence files on this machine

`D:\TwilightEchoDependencies\automix\` contains:

- `latest-native-tests.log`, `latest-automix-runtime-tests.log`,
  `latest-clock-race-tests.log`, `latest-preparation-audit.log`.
- `latest-automix-ts-tests.log`, `latest-staging-tests.log`,
  `latest-typecheck.log`, `latest-app-build.log`.
- `music-probe-v2/manifest.json`, `wasapi-intelligent-latest.json`,
  `cached-native-planning.json`, `listening-100-pairs.json`.
- `latest-online-tests.log`, `latest-plugin-suite.log`,
  `latest-ncm-online-tests.log`, `precise-seek-flac.log`, `precise-seek-mp3.log`,
  `http-online-smoke-v3.json`, `latest-no-real-device.log`.
- `latest-context-preparation.log`, `latest-pcm-boundaries.log`,
  `boundary-flac-v1.log`, `boundary-mp3-v1.log`,
  `latest-context-runtime.log`, `latest-no-real-device-resume2.log`,
  `latest-no-real-device-final.log`, `http-online-smoke-v3-context.json`,
  `validation-2026-10-09.json` (artifact hashes and executed-gate inventory).
- `staged-runtime/`: separately staged native binaries, dependency closure,
  capability manifests and verified AutoMix assets. Refresh staging after a
  new native build before using these artifacts.

The earlier default staging attempt was blocked by the running player's DLL
lock. After the player exited, the user requested DLL staging and in-app manual
acceptance. The new runtime is now staged into `resources/audio-engine`, with
verified model assets and refreshed capability manifests. Existing SMTC/VST3
helpers are preserved. The previous runtime is backed up at
`D:\TwilightEchoDependencies\automix\backup-before-manual-acceptance-20261009\audio-engine`.

## In-app manual acceptance build

The Windows x64 build uses `TAE_AM_EXPERIMENTAL_PLAYER=ON`. AutoMix is available
in Settings → Playback and through settings search without a startup environment
variable. Its saved configuration defaults to off and `stableRelease` remains
false. Ordinary clean builds default the compile option to OFF. A startup
`TAE_AUTOMIX_EXPERIMENTAL=0` disables this build's experimental permission.

The staged addon was checked in separate fresh Node processes with no startup
flag and with the explicit disable flag. Initial playback information exposes
the permission before the first Play; enabling and disabling immediately update
both AutoMix status and playback information. The disabled process rejects
enablement. These checks do not start playback or alter saved user settings.
Asset hashes are verified against the repository lock, analysis revision 3.

For this build, application type checks/build and renderer budgets pass, as do
441 audio-manager tests and 21 DSP/mini-player tests. Native controls pass both
with the default build permission and the startup disable override. AutoMix
promotion/cancellation/replacement/source-refresh cases and the two clock-race
regressions pass. The arithmetic differential suite passes again (96,000 scores,
3,000 selections, 24 templates, clock and SIMD checks). Build, application-stage
and isolated-stage DLL/addon/helper hashes match. A compiler subprocess launch
failure during the first build attempt was resolved by retrying with four
parallel jobs. Detailed per-build evidence is in `manual-acceptance-runtime.json`
and `latest-manual-acceptance-*.log` under
the evidence directory above. The earlier complete no-device aggregate remains
historical evidence for its recorded build; it is not counted as a full rerun
of the manual-acceptance build.

Manual listening is pending. Current automatic playback selects the validated
style-8 policy or conservative style-1 fade; intelligent skipping remains
unavailable. Album/CUE boundaries and repeat modes can intentionally prevent
a transition. No new hardware playback was performed for this staging request.

### Idle settings integration repair

The first staged build passed native binding checks but its application manager
did not read AutoMix status while `nativePlaybackActive=false`. The renderer
therefore received no experimental permission before the first Play and disabled
the switch. Two regression cases reproduce that missing status on the old host
code. The host now reads fresh independent status through service RPC while
idle and after startup, service readiness and configuration changes. It retains
the app's source/queue/position/volume and discards responses from before a
service crash.

The repaired application passes 444 audio-manager checks, including three
AutoMix idle/service/restart regressions; four playback-settings checks and the
application type checks/build also pass. `scripts/automix-controls-smoke.cjs`
starts the complete built application with an isolated temporary profile and
the real staged runtime. It verifies a clickable AutoMix settings switch before
the first Play, then clicks enable/disable and checks agreement between DOM
state and native status. No music is played and the user's settings are not
modified. The report is `manual-acceptance-idle-ui.json`, with
`latest-manual-acceptance-idle-*.log` recording the host regression and build
checks. This is controls/integration evidence, not listening or hardware
performance acceptance.

### Development renderer startup repair

The user's `pnpm dev` process loads the staged DLL at the expected application
path. The same local development renderer reproduced the remaining failure:
native status reported `experimentalAllowed=true` while the real AutoMix DOM
control stayed disabled. Its renderer subscribed after startup readiness events
and never fetched the missing playback settings status. The earlier built-app
fixture did not cover this development startup ordering.

The renderer's output-state initialization and refresh now fetch playback
settings status directly. AutoMix-only merging preserves an existing source,
position, queue index, volume and transport state. The regression is registered
in `test:playback-routing`. The focused renderer/controller/HMR suite passes
92 checks and test-ownership/gate checks pass 13; application type checks/build
and renderer budgets pass again.

`manual-acceptance-dev-ui-before.json` records the native-allowed/UI-disabled
failure, and `manual-acceptance-dev-ui-after.json` records the successful fix on
the user's development server. Separate complete application fixtures verify
both a development renderer and the built renderer with 1,500 ms delayed page
loading. In both fixtures the control is usable before Play, and real DOM
enable/disable agrees with native status. Their reports are
`manual-acceptance-dev-ui-delayed.json` and
`manual-acceptance-build-ui-delayed.json`; corresponding logs use
`latest-manual-acceptance-dev-*.log` and
`latest-manual-acceptance-build-ui-delayed.log`. Fixtures use temporary profiles
and perform no music playback. The delayed development fixture uses an isolated
local Vite server; it does not require the user's development process to remain
running during the test.

## Application playback repair (2026-10-09)

A complete application probe reproduced saved AutoMix enablement while native
status remained disabled (`configRevision=0`), followed by a separate preload
failure under the saved bit-perfect-first policy (`gaplessBlockedReason=format_mismatch`).
DSP commits could also withdraw a ready pair without scheduling its replacement.
Earlier controls-only probes did not exercise these playback paths.

Successful DSP acknowledgements now synchronize native AutoMix independently of
decorated graph revision state. Concurrent startup acknowledgements do not send
duplicate configs, and service recovery reapplies the saved config. Native graph
commits immediately rebuild the conservative pair. AutoMix permits both sources
to convert to the common PCM render format under bit-perfect-first, and retains
its preload when the separate gapless preference is disabled. Feature identity,
deadlines and source windows use decoder duration rather than rounded queue
display metadata. Application diagnostics now record configured and actual
AutoMix state, pair revision, style, duration, reason and feature delivery.

`scripts/automix-app-playback-smoke.cjs` runs the real built application, renderer
IPC, coordinator, analysis/cache and utility service with a temporary profile.
It accepts an isolated runtime for verification without changing the user's app.
`manual-acceptance-app-playback-before.json` captures disabled native playback;
`manual-acceptance-app-smart-diagnostics.json` captures the format blocker.
`manual-acceptance-app-smart-after-format.json` confirms style 8, 3.24 seconds of
mixing, one queue promotion and incoming continuation at 3.41248 seconds, with
rounded queue durations and the same WASAPI headphones. Playback probes are
muted (`volume=0`); they verify render execution, not subjective listening quality.

The audio-manager suite passes 444 checks, the focused DSP suite passes four,
and application typechecking/build/budgets pass. The native suite passed all
43 registrations before the final format change, with the ASIO ABI cross-DLL
case skipped. After the final native changes, the complete runtime queue suite,
callback performance gate and assembly differential suite were rebuilt and
passed again. New native regressions cover DSP rearming, different source
formats with gapless disabled, and rounded metadata with analyzed style 8.

The staged DLL SHA-256 is
`1f7d3313b4f4c4b37ab377b636b45673dffc7dd144d7c88e30f740b30277f3ac`.
The previous DLL/addon/manifests are backed up under
`D:\TwilightEchoDependencies\automix\backup-before-playback-fix-20261009`.
The pending listening, music-pair matrix, real ASIO and long-run gates below
remain unclaimed.

`manual-acceptance-app-staged-conservative.json` verifies the application using
the updated project runtime: style 1, a four-second overlap, and incoming
continuation at 4.05962 seconds for the user's earlier MP3/FLAC track pair.
The staged settings-controls probe also passes. These probes are muted and
retain the same listening limitations. `manual-acceptance-playback-fix-runtime.json`
records final runtime hashes, backup location and verification coverage.

## Playback bar handoff repair (2026-10-09)

The real renderer store and PlayerBar DOM reproduced an AutoMix handoff in
which native playback had continued at 4.18 seconds in the incoming track,
but a later `start-file` notification reset the renderer clock to zero.
The clock then rejected the incoming timestamps during its transition guard.
The previous application probe directly loaded the engine queue and therefore
did not establish a renderer queue or verify the playback bar.

Native tick fanout now publishes the identity-bearing playback snapshot before
scalar time/duration notifications. `start-file` requests a fresh snapshot and
retains the position already confirmed by that snapshot. The intentional-track
guard expires relative to its first confirmation rather than extending with
every playing tick; accepted native handoffs guard their incoming identity
against delayed outgoing snapshots. Queue promotion and source-clock mapping
remain native operations; this repair does not change audio rendering or trim
policy and requires no DLL replacement.

`scripts/automix-app-playback-smoke.cjs --player-bar` starts an isolated Vite
renderer and the built main/preload application with a temporary user profile.
It calls the actual store's `playTrackFromPosition`, observes the standard bar's
track identity, slider and time labels, and checks continuation for two seconds
after promotion. `player-bar-before.json` records the failing DOM clock;
`player-bar-final.json` records the corrected handoff for
Kobaryo - Vicious Heroism -Traitor Version- / Kobaryo,USAO - Sulyvahn, with
rounded queue durations and the user's WASAPI headphones. The probe is muted;
it verifies application playback synchronization, not listening quality.

Playback routing passes 705 checks and audio management passes 445. The focused
handoff/store/clock/manager suite passes 262 checks, including both event orders,
continued incoming progress, delayed outgoing snapshots and bounded guards.
Application type checks, build and renderer budgets pass. Evidence and logs
are in `D:\TwilightEchoDependencies\automix\player-bar-*.json` / `player-bar-*.log`.

## Independent candidate expansion (2026-10-09)

The former production generator admitted only filtered-direct style 8, required
both sides to be non-vocal, and rejected a tail without sufficiently recent
stable beats. Its single-interval tempo estimator also treated the model's
20 ms event quantization as tempo/stability variation. These restrictions were
in the independent generator; the recovered assembly scores were not changed.

Analysis revision 4 uses sliding eight-interval spans, an explicit one-frame
quantization tolerance and maximum phase residual. Missing/irregular events
still split stable runs; merged tempo is recomputed over the complete observed
span. Full-band energy is computed from the louder original PCM channel.
The ONNX models, model input/output processing and their hashes are unchanged.
Revision 3 cache entries cannot be reused as revision 4 features.

The generator now also admits recovered soft-skip style 5 (reference dispatcher
`0x227474a3c`, `automix-c/reference-python/candidate_paths.py` and
`automix-c/src/am_scoring.c`). This score requires no native key/tempo/loudness
signals. Its independently chosen source windows support at most two seconds
of filter/gain overlap for confirmed boundary silence or quiet decay. These
windows/thresholds are product policy, not recovered Apple region generation.
Both styles require at least one side to have covered non-vocal classification.
Only confirmed boundary silence is skipped; active decay remains included.
No content boundary, incomplete energy or unknown vocal coverage forbids a skip.
Native capabilities and status now consistently advertise the supported scope
as confirmed boundary silence; key/phrase capability stays unavailable.

`music-probe-v4-final/manifest.json` records the same 48 source files used by
`music-probe-v2/manifest.json`, all available for analysis, with 2,256 directed
non-self pairs. The former policy selected one intelligent pair. Revision 4
selects 2,162: 2,159 style 5 and three style 8; 94 retain conservative fading
(88 tempo mismatch and six insufficient tail beat coverage). Of the style 5
pairs, 2,128 use confirmed silence boundaries and 31 use quiet decay.
The 95.83% candidate coverage is not a listening-quality success rate. Files
were the first 48 in the probe's sorted library list, not a random or genre-
balanced evaluation set. Pair fixtures are capped at 16; the manifest retains
every selected pair's feature paths and source boundaries for reproduction.

The complete MinGW native CTest run passes 74 cases, with the ASIO ABI cross-DLL
case skipped. It includes all 24 templates, six PCM rates, model/frontend
parity registrations, callback performance, resources and differential scoring.
After the final capability change, engine smoke, runtime queue, callback
performance, assembly differential and candidate tests were rebuilt and passed
again. New regressions cover quantized 140 BPM, faulty events, two vocal parts,
unknown features, whole-window silence, quiet decay versus flat quiet content,
disable-skip boundaries, duplicate candidates and early queue promotion.
The promotion test verifies a 20-second source with tail/head silence hands off
at 18.1 seconds, continues the incoming source around 2.9 seconds, and emits
one track-start event. A native `AnalyzeAutoMix` synthetic stereo WAV check
confirms opposite-phase active channels remain approximately -20 dBFS, while
actual silence is -120 dBFS. Audio management passes 445 tests, focused
settings/cache/coordinator checks pass 11, and application typecheck, build and
renderer budgets pass.

Application playback probes use the real store, PlayerBar DOM, main/preload
and utility process on the user's WASAPI headphones, with rounded display
durations and validated revision 4 cache entries:

- `candidate-expansion-app-trim.json`: style 5 on Cytus2 Title Mix / Horizon
  Blue; planned outgoing end 244.574285714 seconds, last observed outgoing
  position 244.554 seconds, incoming silence start 1.38 seconds plus two
  seconds of overlap. First incoming observation is 3.56973 seconds; the bar
  follows that source and continues for another two seconds. One queue switch.
- `candidate-expansion-app-staged-beat.json`: the actual staged project runtime
  selects style 8 on Aqu3ra / Horizon Blue with 5.96 seconds of overlap,
  outgoing end 212.4 seconds and incoming start 1.38 seconds. First incoming
  observation is 7.51 seconds, and the bar advances to 9.5133 seconds. One
  queue switch. Polling checks tolerate 0.6 seconds and do not prove sample-
  exact hardware timing.
- `candidate-expansion-staged-controls.json`: before the first Play, the
  settings enable/disable native AutoMix and acknowledge the enabled silence-
  skipping checkbox. Controls wait for each pending configuration to finish.
- `candidate-expansion-cached-planning.json`: 1,000 cached native generation,
  selection and compilation iterations on a measured style 8 pair have p99
  8.763 ms. Host cache I/O and audio preparation are excluded.

All playback probes are muted (`volume=0`): they prove execution and progress
handoff, not subjective naturalness, full-song listening or long-run playback.
Real ASIO remains untested as requested. The release gate is still false.
Evidence and build/test logs are under `D:\TwilightEchoDependencies\automix`.

The updated DLL is staged in `resources/audio-engine`, SHA-256
`d7f5aa5ff0b984785269c60ec9feddab4cc857a3eaedb55c167da43e04f702f3`.
The unchanged addon and model files retain their hashes. Old DLL, capability
manifests and analysis lock are preserved in
`D:\TwilightEchoDependencies\automix\backup-before-candidate-expansion-20261009-233725`.
Same-volume file renames preserve the existing player's mapped old DLL;
no user process was terminated or loaded image overwritten. Restart the player
to load the new DLL and built host. Destination manifests were regenerated
against the complete project runtime, including its existing VST3/SMTC modules,
and verified against actual files. `candidate-expansion-staging.json` records
final checksums and the backup. To revert, fully close the player, restore the
backed-up DLL/manifests/lock and rebuild the host from the matching analysis
revision; preserve the revision 4 feature cache because it is isolated by version.

## 2026-10-10 musical mixing, candidate policy 4

The earlier 95.8% non-fallback candidate figure mostly represented style-5
boundary cleanup. It is not evidence of musical mixing or natural listening.
This iteration separates musical overlap from cleanup in selection, status,
diagnostics and the settings page. Analysis revision 4 and model hashes remain
unchanged; existing revision-4 feature caches remain usable.

Natural beat candidates retain recovered style-8 scoring but render the existing
catalogue's template 7, with complete equal-power envelopes and reciprocal
pitch-preserving rate ramps. This is an independent product assignment, not a
recovered Apple style router. The original filtered template 8 yielded only
0.44 seconds of measured dual-track contribution on one 10.4-second real-file
plan, whereas template 7 yielded 7.42 seconds on that pair. Source rate and
reciprocal rate are both bounded to 0.92–1.08. Half/double aliases interpret
events; they do not double playback speed. No active musical boundary is cut.

Unaligned musical candidates use recovered style-1 envelopes for 4/6/8-second
windows. Independent eligibility requires complete energy coverage, non-vocal
coverage on at least one side, and at least two seconds of estimated dual-track
energy. Prepared contributions, after stretch, effects, gain and envelopes,
must also pass at least two seconds total and one second continuously in 20 ms
cells. Each side must exceed -48 dBFS and remain within 24 dB of its regional
peak. This floor measures contributions; it is not a listening score. Failed
musical tiers descend to a lower tier and cannot retain a musical label on a
conservative result. Pure clock/envelope templates bypass unused effect-state
evaluation; the unity prepared source samples are checked for exact equality.

Evidence under `D:\TwilightEchoDependencies\automix`:

- `musical-mix-plans-final/manifest.json`: the same 48 local tracks, 2,256
  directed pairs; 22 beat-tempo candidates, 2,025 unaligned musical candidates,
  144 cleanup candidates and 65 conservative pairs. These are input-side
  estimates and do not apply album/queue policy or measure listening quality.
- `musical-mix-rendered/report.json`: 24 selected/systematically sampled real
  pairs; six prepared beat mixes, 16 prepared unaligned overlaps and two cleanup
  results. Musical contributions overlap for 2.16–7.42 seconds. PCM is finite.
  This selected sample is not a library-wide rendered coverage rate.
- `musical-mix-app-beat_mix.json`, `musical-mix-app-musical_overlap.json`:
  complete application/IPC/coordinator/native/WASAPI playback, with cached real
  features and rounded queue durations. Both pass one queue switch, incoming
  source continuation and visible PlayerBar progress checks. Settings distinguish
  the actual kind and display measured overlap. The beat case uses 2.85335%
  maximum tempo adjustment and resumes its incoming source at 10.2609 seconds,
  rather than at its 10.4059-second playback horizon. All hardware probes are
  muted and make no listening claim; DOM polling has 0.6-second tolerance.
- `musical-mix-staged-playback.json`, `musical-mix-staged-controls.json`: the
  installed project runtime passes the same real beat-mix playback check and
  settings enable/disable/skip controls. The user's player is not terminated.
- `musical-mix-native-tests.log`: 74 native tests pass; the existing ASIO ABI
  cross-DLL fixture is skipped. This includes recovered differential checks,
  24 templates, six preparation rates, allocation limits and existing controlled
  performance gates. `musical-mix-final-native-regressions.log` additionally
  passes full runtime/candidate tests after the final fallback-reason change,
  including tempo source clocks, one-shot promotion and inconsistent energy
  features that must not promote silent prepared PCM.
- `musical-mix-audio-manager.log`: 445 tests pass.
  `musical-mix-focused-tests.log`: 37 coordinator/cache/settings tests pass.
  Typecheck, application build and renderer budgets pass.
- `musical-mix-cached-planning.json`: 1,000 warmed native generation/selection/
  compilation iterations, p99 14.143 ms; host cache I/O and audio preparation
  are excluded. This is not the hardware callback performance matrix.
- `musical-mix-final-report.json`: consolidated scope, evidence and limitations.

Staged DLL SHA-256:
`0f2cb39e70f4dedb6e074c7784c1141eb303046ea5aaedabad4baf150ad4d484`.
The full project capability manifests are regenerated and checked. Same-volume
renames preserve any mapped old image; old DLL/manifests/policy lock are backed
up in `D:\TwilightEchoDependencies\automix\backup-before-musical-mix-20261010-003752`.
`musical-mix-staging.json` records checksums. Restart the player to load the new
runtime. To revert, fully close the player and restore the backed-up files;
revision-4 features remain valid. Optional local previews contain only the
transition, at fixed -6 dB gain, and are not full-song acceptance.

Subjective naturalness, 100 fixed full-song pairs, the actual callback matrix,
24-hour soak, real ASIO and complete Apple/private-effect parity remain untested.
Stable release remains false; this is the authorized manual-acceptance build.

## Remaining release gates

Key/phrase estimation; additional validated scored styles and musical-region
selection; real online-provider
playback; original-source sample boundary proof across the format matrix and
stretch; dual-track lyric/listening
accounting; complete pipeline memory/restart/device-change soak; six rates × four
actual callback sizes with adequate tail samples; full host cached-planning p99;
100 classified music pairs with full-song/manual assessment and >=95% natural
transitions; at least 24 hours of real-device playback; packaging and release
manifest gates. Real ASIO validation is deferred at the user's request.

Until these gates pass, `stableRelease` stays false. The manual-acceptance build
allows experimental in-app use; other test processes can opt in with startup
`TAE_AUTOMIX_EXPERIMENTAL=1`. Disabling AutoMix restores the latest saved output
preferences and normal playback.
