#pragma once
/* Versioned native C boundary. Seconds are source-domain seconds unless named
 * playback; PCM is interleaved float32. All handles are owned by the creator,
 * destroyed on a preparation/control thread after callback epoch retirement.
 * This ABI is in-process only; never pass pointers or structs over IPC. */
#include <stddef.h>
#include <stdint.h>
#include "recovered/am_scoring.h"
#ifdef __cplusplus
extern "C" {
#endif
#define TAE_AM_ABI_VERSION 1u
typedef enum TAE_AM_Result {
  TAE_AM_OK=0, TAE_AM_INVALID=1, TAE_AM_UNSUPPORTED=2,
  TAE_AM_RESOURCE_LIMIT=3, TAE_AM_INTERNAL=4
} TAE_AM_Result;
typedef struct TAE_AM_ConfigV1 {
  uint32_t size, abi_version;
  uint64_t revision;
  uint32_t enabled, allow_intelligent_skip;
  double max_transition_seconds;
  uint64_t max_buffer_bytes;
} TAE_AM_ConfigV1;
typedef struct TAE_AM_CandidateV1 {
  uint32_t size, abi_version;
  double outgoing_start, incoming_start;
  uint32_t unstructured, alias_index;
  double outgoing_bars, incoming_bars, bpm;
  am_candidate_input scoring;
} TAE_AM_CandidateV1;
typedef struct TAE_AM_SelectionV1 {
  uint32_t size, abi_version;
  uint64_t chosen_index, generated_count, known_score_count;
  uint32_t has_chosen, selection_status;
} TAE_AM_SelectionV1;
typedef struct TAE_AM_PcmViewV1 {
  uint32_t size, abi_version;
  const float* samples; // borrowed, lifetime covers Prepare; never retained
  uint64_t frames, source_first_frame;
  uint32_t sample_rate, channels;
} TAE_AM_PcmViewV1;
typedef struct TAE_AM_PreparedInfoV1 {
  uint32_t size, abi_version;
  uint64_t frames, memory_bytes, incoming_resume_frame, outgoing_end_frame;
  uint32_t sample_rate, channels;
  int64_t style_id;
  double transition_seconds, outgoing_source_start, incoming_source_start;
} TAE_AM_PreparedInfoV1;
typedef struct TAE_AM_SourceWindowV1 {
  uint32_t size, abi_version;
  uint64_t source_first_frame, frames, nominal_first_frame, nominal_end_frame;
} TAE_AM_SourceWindowV1;
typedef void* TAE_AM_Plan;
typedef void* TAE_AM_Prepared;
void TAE_AM_DefaultConfig(TAE_AM_ConfigV1* config);
/* Build opt-in for manual acceptance, independent of stable-release approval.
 * An explicit startup TAE_AUTOMIX_EXPERIMENTAL=0 always disables this opt-in. */
int TAE_AM_ExperimentalPlayerAllowed(void);
/* Every input survives scoring, including duplicates and unknown scores.
 * score_results is caller-owned[count], returned for diagnostics as well. */
TAE_AM_Result TAE_AM_Select(const TAE_AM_CandidateV1* candidates, size_t count,
  uint64_t seed, int has_seed, am_score_result* score_results, TAE_AM_SelectionV1* selection);
TAE_AM_Result TAE_AM_Compile(const TAE_AM_ConfigV1* config,
  const TAE_AM_CandidateV1* candidate, TAE_AM_Plan* plan);
void TAE_AM_DestroyPlan(TAE_AM_Plan plan);
/* Background-only. Decode the whole returned window, including stretch context.
 * Only frames beyond a decoder-confirmed EOF may be zero padded. Context never
 * changes the nominal end or the incoming continuation position. */
TAE_AM_Result TAE_AM_GetSourceWindow(TAE_AM_Plan plan, uint32_t side,
  uint32_t sample_rate, TAE_AM_SourceWindowV1* window);
TAE_AM_Result TAE_AM_Prepare(TAE_AM_Plan plan, const TAE_AM_PcmViewV1* outgoing,
  const TAE_AM_PcmViewV1* incoming, float outgoing_track_gain, float incoming_track_gain,
  TAE_AM_Prepared* prepared, TAE_AM_PreparedInfoV1* info);
void TAE_AM_DestroyPrepared(TAE_AM_Prepared prepared);
/* Realtime-safe: immutable buffer reads, memcpy and assembly only. No clipping
 * or user DSP here. Host executes its output DSP once after this mix. */
size_t TAE_AM_MixPrepared(TAE_AM_Prepared prepared, uint64_t first_frame,
  float* output, size_t frames);
/* Transport Next adopts the already audible incoming clock. Read its prepared
 * continuation at unity envelope, then hand off to the pre-positioned decoder. */
size_t TAE_AM_ReadPreparedSide(TAE_AM_Prepared prepared,uint32_t side,
  uint64_t first_frame,float* output,size_t frames);
/* Analytic source clock quantized once to the prepared PCM sample rate. */
uint64_t TAE_AM_PreparedSourceFrame(TAE_AM_Prepared prepared, uint32_t side,
  uint64_t playback_frame);
#ifdef __cplusplus
}
#endif
