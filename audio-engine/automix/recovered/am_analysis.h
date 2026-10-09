#ifndef AM_ANALYSIS_H
#define AM_ANALYSIS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* MISSING: cannot evaluate. NIL: evaluated native optional with no value.
 * VALUE: evaluated and value is meaningful (including 0 or false). */
typedef enum { AM_QUERY_MISSING = 0, AM_QUERY_NIL = 1, AM_QUERY_VALUE = 2 } am_query_state;
typedef enum { AM_MAP_UNKNOWN = 0, AM_MAP_NIL = 1, AM_MAP_PRESENT = 2 } am_map_state;
typedef struct { am_query_state state; double value; } am_double_query;
typedef struct { am_query_state state; int64_t value; } am_int_query;
typedef struct { am_query_state state; double start, end; } am_window_query;

enum { AM_INDEX_BEAT = 1, AM_INDEX_DOWNBEAT = 2, AM_INDEX_SEGMENT = 4, AM_INDEX_SECTION = 8 };
typedef struct {
    double time;
    double amplitude;
    int has_time, has_rank, has_amplitude;
    unsigned rank;                  /* 0 short, 1 medium, 2 long, 3 extraLong */
    unsigned index_mask;
    int64_t beat_index, downbeat_index, segment_index, section_index;
} am_event;

typedef struct {
    am_event start_event, end_event;
    int has_source_range;
    double source_start, source_end;
} am_native_range;

typedef struct {
    am_native_range range;
    int64_t beats_per_bar, bar_count;
    double reference_bar_duration;
    size_t coarse_group;
    am_double_query average_tempo;
} am_stability_region;

typedef struct {
    double start, end;
    int has_time, has_strength;
    unsigned strength;             /* categorical native byte 0..4; never a probability */
} am_vocal_interval;

typedef struct { double time, value; int has_time, has_value; } am_loudness_sample;
typedef struct { am_query_state state; am_map_state map_state; double mean; size_t sample_count; } am_loudness_query;
typedef enum { AM_ANALYSIS_KEY_MAJOR = 0, AM_ANALYSIS_KEY_MINOR = 1, AM_ANALYSIS_KEY_NEUTRAL = 2 } am_analysis_key_mode;
typedef struct { am_map_state state; int tonic; am_analysis_key_mode mode; } am_tonality;
typedef enum { AM_ANALYSIS_KEY_RELATION_UNKNOWN = 0, AM_ANALYSIS_KEY_RELATION_IDENTICAL, AM_ANALYSIS_KEY_RELATION_RELATIVE, AM_ANALYSIS_KEY_RELATION_NEIGHBOURING, AM_ANALYSIS_KEY_RELATION_INCOMPATIBLE } am_analysis_key_relation;

/* Raw Flex stage only. Does not manufacture final Song endpoint/relabeling.
 * Caller owns dst[count]. On failure returns -1 and explains missing input. */
int am_rebuild_flex_indexes(const am_event *src, size_t count, am_event *dst,
                           char *error, size_t error_capacity);
/* Requires actual final native SongBar indexes and consecutive endpoints.
 * On success caller owns *regions and frees it with free(). Empty is valid. */
int am_build_stability_regions(const am_native_range *bars, size_t count,
                              am_stability_region **regions, size_t *region_count,
                              char *error, size_t error_capacity);

am_int_query am_native_region_count(const am_native_range *range, unsigned index_kind);
am_int_query am_matching_bar_count(const am_native_range *outgoing, const am_native_range *incoming,
                                  am_double_query tempo_alias);
am_double_query am_stable_region_tempo(const am_stability_region *region);
am_double_query am_tempo_for_downbeat(const am_stability_region *regions, size_t count,
                                    am_map_state map_state, am_int_query downbeat_index);
am_window_query am_leading_vocal_window(const am_event *events, size_t count,
                                       am_map_state structure_state, const am_native_range *candidate);
am_int_query am_query_vocal_strength(const am_vocal_interval *intervals, size_t count,
                                    am_map_state map_state, double start, double end);
am_loudness_query am_query_loudness(const am_loudness_sample *samples, size_t count,
                                  am_map_state map_state, double start, double end);
/* Aligned arrays must have equal lengths. Explicit nil whole structure/maps
 * return incompatible=true; unknown or unequal arrays remain MISSING. */
am_int_query am_aligned_vocal_overlap(const am_int_query *outgoing, size_t outgoing_count,
                                     const am_int_query *incoming, size_t incoming_count,
                                     am_map_state alignment_state);
am_analysis_key_relation am_analysis_tonality_relationship(am_tonality outgoing, am_tonality incoming);
am_int_query am_analysis_key_gate(am_tonality outgoing, am_tonality incoming, int identical_only,
                        am_double_query outgoing_melodicness, am_double_query incoming_melodicness);
am_double_query am_tempo_alias(am_double_query outgoing_bpm, am_double_query incoming_bpm);
am_int_query am_tempo_compatible(am_double_query outgoing_bpm, am_double_query incoming_bpm, double threshold);
am_double_query am_analysis_leading_vocal_factor(am_int_query strength);
am_double_query am_analysis_trailing_loudness_ratio(am_loudness_query region, am_loudness_query trailing);
am_int_query am_analysis_outgoing_loudness_significant(am_loudness_query query);
am_window_query am_loudness_window(double start, double end, double a, double b);

#ifdef __cplusplus
}
#endif
#endif
