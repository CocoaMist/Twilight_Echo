#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Win64 ABI: offsets are asserted by the C bridge; never marshal pointers over IPC. */
typedef struct am_kernel_candidate {
  int64_t path, style, flags, matching_bars, incoming_beats, outgoing_beats;
  double target_bars, alias;
  int64_t leading_strength;
  double region_db, trailing_db, trailing_span;
  int64_t relation;
} am_kernel_candidate;
typedef struct am_kernel_factors { double values[6]; uint64_t count; } am_kernel_factors;
void am_k_path_factors(const am_kernel_candidate*, am_kernel_factors*);
double am_k_score(double base, const void* strided_factors, size_t count, double delta, double* product);
int am_k_weight(double score, int64_t* weight);
int am_k_modulo(uint64_t seed, int64_t bound, uint64_t* index);
int am_k_rank_compare(const void*, const void*);
int am_k_group(int algorithm);
void am_k_route(int64_t id, void* route);
void am_k_stable_sort(void* ranked, void* scratch, size_t count);
int am_k_add_weight(int64_t total, int64_t weight, int64_t* result);
size_t am_k_weighted_pick(const int64_t* weights, size_t count, uint64_t draw);
void am_k_mix_sse2(float* out, const float* in, const float* out_gain, const float* in_gain, size_t samples);
void am_k_mix_avx2(float* out, const float* in, const float* out_gain, const float* in_gain, size_t samples);
void am_mix(float* out, const float* in, const float* out_gain, const float* in_gain, size_t samples);
int am_kernel_avx2_available(void);
void am_kernel_initialize(void);
#ifdef __cplusplus
}
#endif
