# AutoMix evaluation 1.3.0-automix.2

This iteration preserves the initial uncommitted checkout. The output is an
independent Windows x64 evaluation application and an optional Demucs package;
formal release acceptance remains false.

The coordinator now records stage timing, retries transient service failures
at 250 ms / 1 s, and separates request-scoped boundary priority from cancellable
whole-track analysis. Preparation uses live positions and a two-second commit
reserve. Source hashes, exact duration, CUE range and playback revisions bind
native selection tickets and bounded PCM material files.

Rule version `twilight-rules-2` adds bounded overlapping head/tail windows,
phrase selection, safe vocal crop guards, onset/low-band summaries and bass
handoff. DJ mixing lasts at most 32 seconds with both speeds within 12 percent;
the stretcher's former 8-percent rejection was corrected. Natural preserves
content and only skips confirmed silence. The native PCM joins and prepared
limiter remain verified across C, SSE2 and AVX2.

Material version 2 uses a single locked Demucs 4.0.1 htdemucs checkpoint
`955717e8-8726e21a.th` with SHA-256
`8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`.
Python 3.11.9 and PyTorch/torchaudio 2.8.0+cu128 live in the independent optional
package. The worker separates only real selected context using 7.8-second
segments, 25-percent overlap and no shifts, then recombines vocals/bass on the
source timeline before common native stretching. GPU is preferred, OOM falls
back to CPU, and the hard deadline falls back to base preparation. Both decks
must validate before either material deck can change. Cache size is 2 GiB.

Real device testing found that pause-after-reopen consumed source audio during
device startup. Rerouting now starts the pipeline paused before callbacks run,
including transport fallback recursion. The regression invokes callbacks during
backend startup, verifies the frozen cursor, and verifies subsequent resume.

The frozen unannotated D:\Music corpus (36 pairs, manifest SHA-256
`ee2c8f460725307331ee76fe866ef0a4b1d9ea332083eb6b8fc595827cb31520`)
keeps Natural success at 12/36 and raises DJ intelligent preparation from 7/36
to 23/36. Fifteen DJ transitions last at least 16 seconds. DJ fallback reasons
are six low-confidence beat cases and seven speed-limit cases. These results
do not establish the 80-percent target for previously annotated suitable pairs.

Executed validation: 37 focused AutoMix tests, 8 analysis-client cases, 229 related
playback/settings/service cases, current MinGW native CTest 46 passes plus one
ASIO cross-DLL environment skip, typecheck/build and relevant lint. Packaged
main/preload/renderer with actual utility processes pass different-directory
loading with matching runtime digests and three real musical handoffs. Device
short runs, four paused device switches, GPU/CPU/mono/stereo separation, corrupt
model/material, missing model, hard timeout and actual OOM fallback were tested.
No new MSVC verification is inferred from earlier MSVC records.

All user-facing packages, 144 listening WAVs, an offline comparison page,
Chinese instructions, hashes and executed reports are in
`C:/Users/XOS/Documents/Codex/2026-10-11/a-u/outputs`.
The final engine's freshly repeated pair-10 analysis and plans exactly match
the complete corpus run; the final host-only pause fix does not change numerical
analysis, planning or rendering.

Human listening, a completed new-engine 24-hour device/application stress run,
real online-account acceptance and formal release acceptance remain pending.
The earlier failed 24-hour run remains a failure; short runs cannot replace it.

Optional enhancement package 2.1 is a packaging-only, inference distribution.
Its lossless 7z archive is 1,985,257,469 bytes (47.7% below the 2.0 ZIP); extracted
files total 4,749,686,500 bytes (37.8% below 2.0). Compiler libraries/headers,
debug symbols, tests, type stubs and installer code are omitted. All 135 runtime
binaries and the worker match the original ZIP, as do all 102 legal notices.
The Python, torch/torchaudio, Demucs model and processing parameters are unchanged.
Cold CPU/stereo, CUDA/stereo and CPU/mono outputs match 2.0 sample-for-sample.
Cache reuse, actual CUDA OOM CPU fallback, missing/corrupt models and hard timeout
pass. The final extracted package loads from an empty working directory and
prepares enhanced native materials through the existing application service.
See `stems/PACKAGING.md` and the `outputs/验证报告/stem-slim-*` reports. This
packaging update does not alter the formal acceptance gates or install the pack
in the user's currently running development application.
