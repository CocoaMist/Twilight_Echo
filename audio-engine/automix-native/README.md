# Twilight AutoMix native core

The latest evaluation is **1.3.0-automix.8**, using `twilight-rules-5`.
On the unchanged 36-pair corpus, intelligent preparation is 27/36 Natural
and 34/36 DJ; 22 DJ transitions last at least 16 seconds. A new original-speed
short release route requires nearby positive music, uninterrupted decay,
known voice coverage and a verified mixed envelope. Existing successful
plans retain their strategy and source mapping. See [EVALUATION-V8.md](EVALUATION-V8.md)
for eligibility, reference findings, reproduction and executed checks.
These are preparation/rendering counts; human listening and preannotated
suitable-pair coverage remain pending.

The optional paired-stem arrangement and detected Auto/GPU/CPU controls remain
available; see [EVALUATION-V6.md](EVALUATION-V6.md) and [EVALUATION-V7.md](EVALUATION-V7.md).
The records below and earlier evaluation documents retain their original
limitations. The current tested runtime is shipped in the .8 evaluation package.

Production numerical kernels are handwritten Win64 NASM, with a complete C11
reference and explicit SSE2/AVX2 dispatch. The existing engine owns transport;
this module owns bounded analysis, planning and prepared audio.

Only the allowlisted, publicly licensed Beat This small0 and YAMNet assets may
be converted or staged. Development uses ONNX/PyTorch/TensorFlow for export and
comparison; the product does not load those runtimes. Conversion outputs bind
the source digest, graph ABI, tensor geometry and numerical profile.

`validation.json` records executed gates. A missing device/account/listening
rating is an unfinished gate, never a pass. The mode remains off by default.

## Implementation order

1. Independent C11 reference, fixed graph conversion and numerical fixtures.
2. Handwritten kernels, dispatch and reference/model/audio differential checks.
3. Prepared two-stream transport, cancellation and authorized online sources.
4. Natural/DJ modes, real music, packaged distribution and long-duration gates.

The protected research package is not a dependency, build input or release asset.

## Earlier acceptance status

The native two-deck callback path is connected. Both Win64 toolchains pass six
native checks; the complete engine suite has 46 passes and one ASIO fixture skip.
Native transport fixtures cover unequal tempos and sample rates, exact incoming
continuation, pause, cancelled overlaps, stale identities and Chinese-path CUE
ranges. The 48 kHz / 44.1 kHz fixture compares continuation samples after actual
resampling. Four real MP3/FLAC format combinations also pass natural/DJ CUE
transport and sample comparisons with Native/Ultra resampling. Local CUE and
AutoMix source seeks use the decoder's exact PCM frame grid; an ordinary
approximate seek cannot become a valid plan simply by enabling AutoMix later.
Three-track 5.1 playback checks clean router reuse; incoming decoder
continuation preserves its routing history. The stripped packaged engine has
completed a 53.54-second natural/DJ check on a real WASAPI device.

The audio-manager suite passes 443 checks, the online/provider regression 188,
the focused AutoMix suite 32, and release-artifact tests 60. Actual packaged
background inference passes through the production scheduler and identical
worker/chunks over Node IPC, including cancellation and recovery. AutoMix stays
at one scheduled worker even when the pool permits four. This adapter check
does not establish full Electron application or analysis-worker long-run acceptance.

Formal delivery acceptance remains false. Manual evaluation builds expose both
modes independently of that gate. The original fixed 36 unannotated music pairs
produced two natural and three DJ transitions. The region-based planner now
renders one beat-aligned and eleven instrumental-outro natural transitions,
plus seven beat-aligned DJ transitions on that identical corpus. Original-speed
outro transitions are recorded separately and never counted as beat coverage.
These counts do not establish 80% coverage of preannotated suitable pairs. Voice classification,
human preference, the remaining playback matrix, real online accounts,
full application stress and installer installation still need acceptance.

Provider resolution revisions preserve actual quality when the endpoint supplies
it; absent actual quality stays unknown. Completed provider cache files use their
actual SHA-256 and native file leases. When AutoMix and provider caching are
enabled, the bundled NCM provider can prepare a fresh authorized source within
10 seconds, returning the complete local file for both playback and analysis.
Preparation is cancellable, single-concurrency, streamed to disk, limited to
256 MiB, and rejects truncated/expired/mismatched data. Disabled caching, an
already-playing direct stream or failed preparation retains normal playback.
Before publication it also requires recognized audio headers, covering HTTP 200
error pages and missing audio geometry. Inspection shares the cancellation and
10-second deadline and closes its stream before Windows rename/removal. Real
MP3/FLAC byte-preservation checks pass, but header inspection is not a full decode.
No real account or startup-latency acceptance has been claimed.

An isolated Windows unpacked build passes the seven-file public asset allowlist,
241-package dependency closure, executable branding, native model analysis and
the device short run. Capability inspection uses a bounded child process so
Windows can release temporary DLLs before packaging cleanup. Six existing
locked metadata dependencies are declared explicitly for reliable pnpm package
collection. Installer installation and packaged CPU fallback remain pending.
GNU strip preserves input timestamps so identical native inputs produce stable
package digests; two actual stripping runs verify this. The current unpacked
evaluation package is `D:/TwilightEchoDependencies/automix/package-automix-rhythm-evaluation/win-unpacked`.

Development listening artifacts and device reports are kept outside the checkout
at `D:/TwilightEchoDependencies/automix/evidence`. The previous 24-hour native
device attempt failed after 33,561.39 seconds and 2,507 completed cycles with
"Playback stopped before native handoff". Its final result is
`device-reproducible-final-soak-24h.json`. It used an earlier DLL and lacks a
failure playback snapshot, so neither the cause nor a fix is established.
The soak harness now saves the active cycle, playback state and native diagnostic
log before cleanup on failure. Verified reused analysis binds the original
report, corpus, public model graphs and actual source identities. The earlier
`device-soak-24h.json` attempt was deliberately stopped after 1954.88 seconds
because it used the previous DLL. `device-package-soak-24h.json` and
`device-release-candidate-soak-24h.json` were also superseded and remain incomplete.
No completed stress result is inferred from its launch or intermediate progress.

## Manual evaluation

The Windows evaluation application is
`D:/TwilightEchoDependencies/automix/package-automix-rhythm-evaluation/win-unpacked/TwilightEcho.exe`.
Close the previous application, start this version, and choose Natural or DJ in
Settings / Playback / Twilight AutoMix before starting a queue. New profiles
still default to Off. Preparation and fallback status remain visible; selecting
a mode does not guarantee an intelligent transition for every song pair.
Enabling during PCM playback also prepares the next source and realigns an
approximate source cursor when necessary, preserving pause. Later seeks use the
exact source-frame path. The checkout's ignored development runtime has been
updated to this engine; already-running processes still require a restart.

Development builds expose the same evaluation control. A production build must
explicitly set `TWILIGHT_AUTOMIX_EVALUATION=1` when running `pnpm run build` to
expose it. Main and renderer use the same compile-time policy; ordinary builds
remain closed while `TWILIGHT_AUTOMIX_RELEASE_READY` is false. Evaluation builds
must include the current native engine and the seven allowlisted public assets.
The checkout's `resources/audio-engine` binaries and public assets are now staged
to the same native version as the evaluation package.

The selector and persistence pass an actual Vue/Electron UI test. The isolated
application smoke loads the packaged main/preload/renderer and real Electron
native utility processes, checking Off/Natural/DJ and startup restoration. It
does not establish listening quality or full application stress acceptance.
Run `node scripts/automix-evaluation-smoke.cjs --package UNPACKED_APP --output REPORT_JSON`
to repeat that check. Typecheck/build, 443 audio-manager checks, 32 focused
AutoMix checks and the actual settings/policy component regressions pass. Package assets,
241-package dependency closure and exact native binary provenance also pass.

An earlier evaluation package could load a stale checkout addon when launched
from the project directory: utility processes have no main-process app singleton
or resourcesPath. The loader now anchors packaged workers to the directory of
their own ASAR archive and refuses fallback to a checkout. Development workers
also resolve their build/source location. The application smoke preserves the
caller's launch directory and PATH; it must pass from both the project and an
unrelated empty directory. Its report verdict is asserted in addition to the
process exit code, because application quit handlers can produce exit code zero
after a failed smoke assertion.

The playback fix keeps decoded fractional durations authoritative for both
decks, round-trips timing JSON, and waits for a matching decoded preload before
analysis. Explicit preparation/status/transport reads update the same service
cache consumed by normal ticks. Failed preparation retains its original reason
after cleanup cancellation; the settings page explains normal fallback. Metadata
responses have a separate bounded 8 MiB allowance for embedded cover art, while
ordinary control responses retain their 1 MiB limit.

`--playback EXTERNAL_PAIRS_JSON` additionally runs the actual packaged
main/preload/renderer, authorized real sources, production model workers and a
real shared WASAPI device. It checks analysis, native preparation, submission,
pause/freeze/resume, single queue advancement and consumed-source continuation.
DJ fixtures can require a measured source/output tempo change. An explicitly
labelled fallback fixture checks that rounded library ranges no longer fail or
hide the actual reason. This is silent transport verification; it does not pass
the 36-pair suitability/listening gate or the 24-hour gate. All six current
packaged application fixtures pass: five real prepared transitions (four
beat-aligned, one original-speed outro) and one expected low-confidence fallback.
Pause freezes both clocks, promotion happens once, and incoming playback continues
from the consumed source position. The real device reported zero deadline misses
and underruns; playback is silent and provides no listening verdict. The previous
failed soak uses a different DLL and cannot validate this new playback binary.

The current packaged DLL also passes a 64.15-second real-device check with five
natural/DJ cycles and zero deadline misses/underruns. Its new silent shared-WASAPI
24-hour attempt is `rhythm-current-device-soak-24h.json`; process and exact binary
provenance are in `rhythm-current-device-soak-process.json`. A `.stop` sibling of
the report requests termination. Its final verdict must be read before claiming
continuous operation or memory acceptance; starting it is not a passed gate.

Keep listening ratings and suitable-pair annotations in the external evidence
directory. Human acceptance and the 24-hour final report remain pending;
evaluation availability must never update those gates automatically.

## Reproducible development checks

- `pnpm run test:twilight-automix` checks analysis scheduling, cached coverage,
  online revision invalidation, native recovery and the public asset allowlist.
  It also verifies complete online cache publication and cancellation cleanup.
- `tools/render_pairs.py CORPUS OUTPUT --create-manifest MUSIC_DIRECTORY` fixes
  an unannotated corpus before inference. Run it again with `--dll`, `--assets`
  and `--probe` to create four audio comparisons and a local listening page.
  For planner-only changes, `--reuse-analysis-from OLD_EVIDENCE` verifies the
  unchanged corpus, source SHA-256, public graphs, original analysis DLL digest
  and binary features before reuse. Reports explicitly record that inference
  was reused; the packaged application is tested with its own native analysis.
- `tools/verify_listening.py CORPUS EVIDENCE_DIRECTORY RATINGS_JSON` checks
  source/render digests, prior suitability labels, category coverage, complete
  human ratings and the explicit human verdict. It never enables release.
- `scripts/automix-native-device-soak.cjs` requires a concrete device ID and
  verified real-pair inputs. A short run cannot pass its 24-hour gate.
- `node --experimental-strip-types --import ./scripts/register-renderer-aliases.mjs
  scripts/automix-analysis-worker-smoke.mjs --package UNPACKED_APP --corpus
  CORPUS_JSON --output REPORT_JSON` verifies the packaged worker/chunk digests,
  executes real native inference through the production scheduler over Node IPC,
  and checks single concurrency, active cancellation and recovery.

The local listening page and WAV artifacts are available for human comparison;
no listening preference or suitability verdict has been recorded.

## Region-based planner and audio joins

`am_rhythm.c` estimates tempo from real Beat This events inside each candidate
region. A regression on 50-fps timestamps avoids the median-interval bias at
tempos such as 160 BPM. Contiguous stable evidence and occasional missed events
are tested separately from global confidence. Half/double beat correspondence
does not double or halve playback speed; natural/DJ limits remain ±4%/±8%.
Candidate scoring uses local active energy, vocal activity, reliable key
compatibility, duration and processing magnitude. Unknown evidence stays unknown.

Codec tails that decode up to one 50-fps analysis frame short of metadata are
cached under their actual end, with partial coverage retained. Reuse binds the
same source bytes, CUE range, model, parameters and window start; it never
extends a middle window or marks the missing tail complete. The native planner
keeps its own boundary guard. This resolves a real MP3 with a 12-ms short tail
whose valid analysis previously failed cache publication before planning.

Natural mode also permits a clean original-speed instrumental outro transition
when both voice ranges are covered, the intro/outro are classified as music,
and the outgoing boundary has measured decay or confirmed silence. Flat or
unknown/vocal boundaries retain regular playback. Its tempo/confidence are
zero, its strategy is visible in the UI, and DJ never uses that strategy.

Prepared variable-speed lanes blend to real decoded PCM on smooth 20-ms edge
windows. Source mapping alone cannot remove a vocoder's waveform phase offset.
Exact gain endpoints preserve the decoded samples at both joins. Predicted
mixed peaks feed an offline look-ahead gain envelope using C11 and handwritten
Win64 SSE2 instructions on both CPU paths. The prepared overlap body has a
0.98 sample-peak ceiling, a 60-ms attack and a 300-ms release. Exact joins relax
the ceiling in the first/last 10 ms; hot source samples may remain there. This
does not certify intersample true peaks or peaks after user deck DSP/routing.
The callback consumes only immutable precomputed gains; ordinary playback,
volume, EQ and resampling parameters are unchanged by these improvements.

Latest local numerical/render evidence is under
`D:/TwilightEchoDependencies/automix/evidence/rhythm-improvement/source-joined-renders`.
All 36 pairs render on C/SSE2/AVX2 with identical strategies and frame bounds;
19 chosen transitions have zero source-join sample error, maximum body peak
0.9800002 and maximum CPU sample difference 3.58e-7. No listening verdict follows
from these numbers. Full application and final package observations are recorded
separately in `validation.json`; release acceptance remains false.
