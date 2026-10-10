#ifndef AM_SCORING_H
#define AM_SCORING_H

/* C11 ports of candidate_paths.py, native_routing.py and selection.py.
 * No Apple framework, model, file or process is executed by this API.
 * Zero-initialized signals mean unavailable input, not a native nil result.
 * has_value && is_nil represents a known native optional nil. invalid lets
 * a JSON bridge retain a malformed type without converting it to zero.
 * Counts and relation enums remain signed 64-bit integers, never doubles. */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct { bool has_value, is_nil, invalid, value; } am_signal_bool;
typedef struct { bool has_value, is_nil, invalid; int64_t value; } am_signal_i64;
typedef struct { bool has_value, is_nil, invalid; double value; } am_signal_double;

typedef enum {
    AM_SCORING_OK = 0, AM_SCORING_INVALID_ARGUMENT, AM_SCORING_OVERFLOW,
    AM_SCORING_OUT_OF_MEMORY, AM_SCORING_UNSUPPORTED
} am_scoring_error;

typedef enum {
    AM_GATE_UNKNOWN = 0, AM_GATE_FALSE, AM_GATE_TRUE, AM_GATE_INVALID
} am_gate_result;

typedef enum {
    AM_ALGORITHM_UNKNOWN = -1,
    AM_ALGORITHM_DANCE = 0, AM_ALGORITHM_HIPHOP, AM_ALGORITHM_POP,
    AM_ALGORITHM_FILTERED, AM_ALGORITHM_SMART, AM_ALGORITHM_DEAD_AIR,
    AM_ALGORITHM_SOFT_SKIP, AM_ALGORITHM_FALLBACK
} am_algorithm;

typedef enum {
    AM_PATH_UNKNOWN = -1,
    AM_PATH_DANCE_ORIGINAL = 0, AM_PATH_DANCE_SHIFTED,
    AM_PATH_FILTERED_DIRECT, AM_PATH_FILTERED_SHIFTED,
    AM_PATH_HIPHOP_DIRECT, AM_PATH_HIPHOP_SHIFTED,
    AM_PATH_POP_SCALED_SHIFTED, AM_PATH_SMART_CROSSFADE,
    AM_PATH_DEAD_AIR, AM_PATH_FALLBACK_CROSSFADE, AM_PATH_SOFT_SKIP,
    AM_PATH_COUNT
} am_candidate_path;

typedef enum {
    AM_SIGNAL_STRICT_TEMPO = 0, AM_SIGNAL_LOOSE_TEMPO,
    AM_SIGNAL_TONALITIES_COMPATIBLE, AM_SIGNAL_MATCHING_BAR_COUNT,
    AM_SIGNAL_OUTGOING_BEAT_COUNT, AM_SIGNAL_INCOMING_BEAT_COUNT,
    AM_SIGNAL_TEMPO_ALIAS, AM_SIGNAL_TARGET_BAR_COUNT,
    AM_SIGNAL_INCOMING_LEADING_STRENGTH, AM_SIGNAL_INCOMING_REGION_LOUDNESS,
    AM_SIGNAL_INCOMING_TRAILING_LOUDNESS, AM_SIGNAL_VOCAL_OVERLAP_INCOMPATIBLE,
    AM_SIGNAL_INCOMING_LOUDNESS_RELATION_CODE, AM_SIGNAL_TRAILING_SPAN_SECONDS,
    AM_SIGNAL_OUTGOING_LOUDNESS_SIGNIFICANT, AM_SIGNAL_OUTGOING_END,
    AM_SIGNAL_INCOMING_END, AM_SIGNAL_COUNT
} am_signal_id;

#define AM_SIGNAL_BIT(signal_id) (UINT64_C(1) << (signal_id))
#define AM_SCORE_MAX_FACTORS 6

typedef struct {
    am_signal_bool strict_tempo_compatible;
    am_signal_bool loose_tempo_compatible;
    am_signal_bool tonalities_compatible;
    am_signal_i64 matching_bar_count;
    am_signal_i64 outgoing_beat_count;
    am_signal_i64 incoming_beat_count;
    am_signal_double tempo_alias;
    am_signal_double target_bar_count; /* absent -> 8; explicit nil invalid */
    am_signal_i64 incoming_leading_strength; /* categories 0..4, unknown 5 */
    am_signal_double incoming_region_loudness;
    am_signal_double incoming_trailing_loudness;
    am_signal_bool vocal_overlap_incompatible;
    am_signal_i64 incoming_loudness_relation_code;
    am_signal_double trailing_span_seconds;
    am_signal_bool outgoing_loudness_significant;
} am_candidate_signals;

typedef struct {
    am_candidate_path path;
    int64_t style_id;
    double outgoing_end, incoming_end;
    bool positional_enabled; /* initializer sets the Python default true */
    am_candidate_signals signals;
} am_candidate_input;

typedef enum {
    AM_SCORE_SCORED = 0, AM_SCORE_UNSUPPORTED_PATH,
    AM_SCORE_MISSING_UPSTREAM_SIGNALS, AM_SCORE_INVALID_UPSTREAM_SIGNALS,
    AM_SCORE_INVALID_UPSTREAM_REGION, AM_SCORE_INVALID_UPSTREAM_RELATION,
    AM_SCORE_ARITHMETIC_ERROR
} am_candidate_status;

typedef struct { const char *name; double value; } am_score_factor;
typedef struct {
    am_candidate_status status;
    bool score_known;
    double base, product, boundary_delta, score;
    uint64_t missing_inputs, invalid_inputs;
    size_t factor_count;
    am_score_factor factors[AM_SCORE_MAX_FACTORS];
    const char *evidence, *reason;
} am_score_result;

void am_candidate_input_init(am_candidate_input *input);
const char *am_path_name(am_candidate_path path);
am_candidate_path am_path_from_name(const char *name);
const char *am_signal_name(am_signal_id signal);
const char *am_candidate_status_name(am_candidate_status status);
const char *am_algorithm_name(am_algorithm algorithm);
am_scoring_error am_evaluate_candidate(const am_candidate_input *input,
                                      am_score_result *result);

typedef struct {
    int64_t style_id;
    bool catalogue_member, default_generated;
    am_algorithm algorithm;
    int complexity; /* -1 if not recovered in the native default catalogue */
    am_candidate_path path;
    double base_score;
} am_style_route;

am_style_route am_default_route(int64_t style_id);
const int64_t *am_catalog_style_ids(size_t *count);
const int64_t *am_default_style_ids(size_t *count);

typedef struct {
    bool has_values, is_nil, invalid;
    const uint8_t *values; /* null + count=0 is a known empty array */
    size_t count;
} am_complexity_array;

am_gate_result am_complexity_gate(am_algorithm algorithm,
                                 am_signal_i64 maximum_complexity,
                                 am_complexity_array outgoing,
                                 am_complexity_array incoming);
typedef enum { AM_ATTRIBUTE_ACOUSTICNESS = 0, AM_ATTRIBUTE_DANCEABILITY } am_attribute;
am_gate_result am_attribute_gate(am_attribute attribute, am_signal_double query);

typedef struct {
    am_signal_double outgoing_start, outgoing_end, incoming_end;
    am_signal_double minimum_outgoing_start, minimum_outgoing_end;
    am_signal_double computed_maximum_incoming_end;
} am_region_bounds_input;
am_gate_result am_region_bounds_gate(const am_region_bounds_input *input);
am_gate_result am_candidate_postfilter(am_signal_bool song_pair_accepts,
                                      am_signal_bool criteria_accepts);

/* Additional recovered arithmetic helpers; these do not generate analysis. */
double am_leading_vocal_factor(am_signal_i64 strength);
bool am_trailing_loudness_ratio(am_signal_double region, am_signal_double trailing,
                               double *ratio);
am_gate_result am_outgoing_loudness_significant(am_signal_double region_mean,
                                              am_signal_bool map_available);
am_scoring_error am_normalized_incoming_beats(int64_t beat_count, double alias,
                                            int64_t *normalized);
typedef struct { int64_t start, end; } am_beat_region;
am_scoring_error am_scale_incoming_region(am_beat_region incoming,
                                         int64_t outgoing_beat_count, double alias,
                                         am_signal_i64 beat_event_count,
                                         am_beat_region *result, bool *available);
am_scoring_error am_shift_region_pair(am_beat_region outgoing,
                                     am_beat_region incoming,
                                     int64_t outgoing_bars, int64_t incoming_bars,
                                     double alias, am_signal_i64 outgoing_event_count,
                                     am_signal_i64 incoming_event_count,
                                     am_beat_region *out_result,
                                     am_beat_region *in_result, bool *available);
void am_shift_bars_for(am_candidate_path path, int64_t style_id,
                       int64_t *outgoing_bars, int64_t *incoming_bars);
am_scoring_error am_loudness_windows(double start, double end,
                                    am_candidate_path path, int64_t style_id,
                                    double windows[2][2]);
am_gate_result am_vocal_overlap_incompatible(const int *outgoing, size_t outgoing_count,
                                           bool outgoing_available, const int *incoming,
                                           size_t incoming_count, bool incoming_available);

typedef struct {
    int alias_index; double alias, effective_incoming_bpm, log_distance;
    bool identical, compatible;
} am_tempo_result;
am_scoring_error am_tempo_relationship(double outgoing_bpm, double incoming_bpm,
                                      double threshold, am_tempo_result *result);
typedef enum { AM_KEY_MAJOR = 0, AM_KEY_MINOR, AM_KEY_NEUTRAL } am_key_mode;
typedef struct { bool known; int tonic; am_key_mode mode; } am_key;
typedef enum {
    AM_TONALITY_UNKNOWN = 0, AM_TONALITY_IDENTICAL, AM_TONALITY_RELATIVE,
    AM_TONALITY_NEIGHBOURING, AM_TONALITY_INCOMPATIBLE
} am_tonality_relation;
am_tonality_relation am_tonality_relationship(am_key outgoing, am_key incoming);
am_gate_result am_key_gate(am_key outgoing, am_key incoming, bool identical_only,
                          am_signal_double outgoing_melodicness,
                          am_signal_double incoming_melodicness);

typedef struct {
    am_algorithm algorithm;
    int64_t style_id;
    bool score_known;
    double score;
    size_t input_index; /* caller identity; arrays below contain input positions */
} am_selection_candidate;
typedef enum { AM_SELECT_NATIVE_WEIGHTED = 0, AM_SELECT_BEST } am_selection_mode;
typedef enum {
    AM_SELECTION_NO_POSITIVE_CANDIDATE = 0,
    AM_SELECTION_SINGLE_PREFERRED_CANDIDATE,
    AM_SELECTION_ZERO_WEIGHT_FIRST_CANDIDATE,
    AM_SELECTION_UNRESOLVED_NATIVE_SEED,
    AM_SELECTION_WEIGHTED_NATIVE_MODULO,
    AM_SELECTION_BEST_CONVENIENCE,
    AM_SELECTION_INVALID_INPUT,
    AM_SELECTION_WEIGHT_OVERFLOW,
    AM_SELECTION_ALLOCATION_FAILURE
} am_selection_status;
typedef struct {
    am_selection_status status;
    bool has_chosen, weights_evaluated, has_draw;
    size_t chosen_index; /* position in the caller's candidate array */
    int preference_group; /* -1 empty; 0 algorithms0..3; 1 algorithms4..6; 2 algo7 */
    size_t ranking_count, preferred_count, missing_score_count, nonpositive_count;
    size_t *ranking_indices, *preferred_indices;
    int64_t *weights, total_weight;
    uint64_t draw;
} am_selection_result;

/* Result owns its arrays; zero-init before first use and free before reuse.
 * Stable sort: score descending, style ID ascending, ties input position.
 * Nothing is deduplicated. has_seed=false does not invent native entropy.
 * BEST is explicit independent convenience after recovered preference/ranking. */
am_scoring_error am_select_candidates(const am_selection_candidate *candidates,
                                     size_t count, am_selection_mode mode,
                                     bool has_seed, uint64_t native_seed,
                                     am_selection_result *result);
void am_selection_result_free(am_selection_result *result);
const char *am_selection_status_name(am_selection_status status);
am_scoring_error am_native_score_weight(double score, int64_t *weight);
am_scoring_error am_native_modulo_index(uint64_t native_seed, int64_t upper_bound,
                                       uint64_t *index);
uint64_t am_seed_from_millisecond_counts(int64_t outgoing_ms, int64_t incoming_ms);

/* Region-independent policy fallback for an autonomous prototype planner.
 * This is NOT an Apple candidate-generation/ML path: unknown gate receives an
 * explicit configurable discount; native nils must first be resolved by the
 * caller. Only the recovered style base and endpoint preference are reused. */
am_scoring_error am_policy_baseline_score(int64_t style_id,
                                        am_gate_result tempo_gate,
                                        am_gate_result key_gate, bool key_required,
                                        double unknown_factor, double outgoing_end,
                                        double incoming_end, am_score_result *result);

#ifdef __cplusplus
}
#endif
#endif
