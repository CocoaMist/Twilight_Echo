# AutoMix enhancement 2.2

This worker keeps the 2.1 runtime, htdemucs checkpoint, FP32 inference, 7.8 s
segments, 25% overlap, shifts=0 and complete source transition context. Material
and cache tickets remain version 2. Python bytecode output is disabled.

Both input digests, source ranges, model digest and cache arrays are validated
before importing torch. A full cache hit imports NumPy only and never initializes
CUDA. A partial hit imports the pinned inference runtime and computes only the
missing deck. NumPy OpenBLAS is limited to one thread before import; torch keeps
four threads. The model object is reused for the two decks, then the isolated
process exits.

`streaming_apply` reproduces Demucs 4.0.1 single-model unity bag semantics. It
keeps global normalization and resampling; triangular weights are generated on
the compute device, multiplied there, and accumulated on the input's CPU device
in the original offset order. Each chunk is released immediately. Do not move
weight multiplication to CPU or resample each chunk separately: these changes
would change the samples.

Input PCM and cache arrays use read-only memory maps. Validation and envelope
generation operate in 65,536-frame blocks at absolute sample positions. Mixing
preserves 2.1's float32 addition followed by float64 gains and final float32
interleaving. Inference still requires whole-context normalization/resampling;
it is not advertised as a constant-memory model.

The optional request field `cacheBudgetBytes` defaults to 536,870,912. The player
offers Off/256/512/1024/2048 MiB. Existing settings migrate to 512 MiB. LRU eviction
counts data and metadata, reserves space before writing, skips oversized entries,
protects pending hits, and removes interrupted temporary files. Cache writes are
best-effort; PCM output errors cause ordinary base-mix fallback. The host waits
for worker close before clearing busy ownership and controlled temporary files.

The player hashes returned materials in 256 KiB reads from one open handle and
checks the exact length, selection/model ticket, original identity and range.
Native validation, original PCM joins, time mapping and limiter remain intact.

Diagnostics report cache/inference/partial-cache paths, model/runtime stages,
per-deck inference and recomposition time, working-set peak, private committed
peak and CUDA allocated/reserved peaks. Private commit is not physical RAM.

Reproducible tests: run `test_worker.py` with the pinned Python 3.11 runtime, and
`pnpm run test:twilight-automix`. Delivery evidence compares the fixed 2.1 worker
against 2.2 on the same machine, three repeats per cold/full/partial cache scenario
on CPU and GPU. Require sample-exact stem and PCM comparisons. Formal listening,
24-hour device and publication gates stay closed.
