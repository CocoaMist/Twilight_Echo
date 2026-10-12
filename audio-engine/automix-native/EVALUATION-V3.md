# 1.3.0-automix.3 / enhancement 2.2 evaluation

The current uncommitted working tree was preserved. Native DSP, planning,
model weights, formats and release gates are unchanged from automix.2.
See `stems/MEMORY-2.2.md` for the worker and host changes.

The Windows x64 evaluation player adds persisted Off/256/512/1024/2048 MiB stem
cache capacities (512 MiB legacy/default), stream-hashes PCM materials, waits
for worker close on cancellation/timeout and clears stale results before retry.
The optional enhancement keeps every runtime/model binary and legal notice from
2.1. Full cache hits avoid torch/CUDA, and v2 cache/material tickets remain valid.

Same-machine tests use the frozen 2.1 worker, three repetitions of CPU/GPU
cold/full-hit/partial-hit cases, with sample-exact four-stem and recomposed PCM
comparisons. Mono 44.1 kHz, stereo 96 kHz, 32-second transitions, GPU allocation
failure, cache corruption, old cache reuse, budget/LRU and controlled disk-full
injection passed. Cache/full inference resource claims come only from the
dedicated sequential benchmark. Other packaging/fault/audio tests can overlap.

40 focused tests, 220 main playback tests, 30 settings tests and 5 Python worker
tests passed (sets overlap). Typechecking, evaluation build, packaged dependency
closure and source/model digest validation passed. The final archive was freshly
extracted; 4,938 file digests, 135 unchanged binaries and 102 unchanged legal
notices were verified. A real paused native engine accepted source-bound stem
materials from that extracted worker, launched outside its directory.

Three real-device base-path transitions validated pause/resume, time mapping,
single queue promotion and zero underruns/deadline misses. The new listening
pair renders both base and actual GPU-enhanced audio with the same selection,
native C/SSE2/AVX2 render paths and audition gain. Human listening is pending.

Delivery metadata and Chinese resource report are under the task's `outputs`
directory; hashes and resource medians are also recorded in
`validation.json.evaluationV3Memory`. Version 2.0/2.1/automix.2 artifacts remain.
No installed application was overwritten, and the optional pack was not installed.

Formal publication, 24-hour device stress, online-account acceptance and the
preannotated 80% long-mix suitability gate remain closed. This evaluation does
not change or retrospectively pass historical stress failures.
