#include "am_scoring.h"
#ifdef TAE_AM_ASM
#include "../Kernels.h"
_Static_assert(sizeof(am_kernel_candidate)==104, "kernel ABI");
_Static_assert(offsetof(am_kernel_candidate, relation)==96, "kernel relation ABI");
_Static_assert(sizeof(am_score_factor)==16, "factor stride ABI");
#endif

#include <inttypes.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *const path_names[AM_PATH_COUNT] = {
    "dance-original", "dance-shifted", "filtered-direct", "filtered-shifted",
    "hiphop-direct", "hiphop-shifted", "pop-scaled-shifted", "smart-crossfade",
    "dead-air", "fallback-crossfade", "soft-skip"
};
static const char *const path_evidence[AM_PATH_COUNT] = {
    "0x22745b338", "0x22745b980", "0x227461768", "0x227461f04",
    "0x227466860", "0x227466f28", "0x227469f58", "0x227470e0c",
    "0x22746ad10", "0x22746c7a4", "0x227474a3c"
};
static const char *const signal_names[AM_SIGNAL_COUNT] = {
    "strict_tempo_compatible", "loose_tempo_compatible", "tonalities_compatible",
    "matching_bar_count", "outgoing_beat_count", "incoming_beat_count",
    "tempo_alias", "target_bar_count", "incoming_leading_strength",
    "incoming_region_loudness", "incoming_trailing_loudness",
    "vocal_overlap_incompatible", "incoming_loudness_relation_code",
    "trailing_span_seconds", "outgoing_loudness_significant",
    "outgoing_end", "incoming_end"
};
static const char *const algorithm_names[8] = {
    "dance", "hiphop", "pop", "filtered", "smart", "dead-air", "soft-skip",
    "fallback-crossfade"
};
/* 0x2274c7280: packed immediate 0x0002010203030303, low-byte first. */
static const int algorithm_complexities[8] = {3, 3, 3, 3, 2, 1, 2, 0};
static const int64_t catalog_ids[] = {
    0, 1, 2, 3, 33, 4, 44, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20, 22
};
/* Constructor order, including the native order within each family. */
static const int64_t default_ids[] = {
    17, 19, 15, 18, 16, 20, 8, 9, 12, 3, 33, 4, 44, 0, 5, 1
};

const char *am_path_name(am_candidate_path path) {
    return path >= 0 && path < AM_PATH_COUNT ? path_names[path] : "unknown";
}

am_candidate_path am_path_from_name(const char *name) {
    if (!name) return AM_PATH_UNKNOWN;
    for (int i = 0; i < AM_PATH_COUNT; ++i)
        if (strcmp(name, path_names[i]) == 0) return (am_candidate_path)i;
    return AM_PATH_UNKNOWN;
}

const char *am_signal_name(am_signal_id signal) {
    return signal >= 0 && signal < AM_SIGNAL_COUNT ? signal_names[signal] : "unknown";
}

const char *am_algorithm_name(am_algorithm algorithm) {
    return algorithm >= 0 && algorithm < 8 ? algorithm_names[algorithm] : "unknown";
}

const char *am_candidate_status_name(am_candidate_status status) {
    static const char *const names[] = {
        "scored", "unsupported_style_path", "missing_upstream_signals",
        "invalid_upstream_signals", "invalid_upstream_region",
        "invalid_upstream_relation", "arithmetic_error"
    };
    return status >= 0 && status < 7 ? names[status] : "unknown";
}

void am_candidate_input_init(am_candidate_input *input) {
    if (!input) return;
    memset(input, 0, sizeof(*input));
    input->path = AM_PATH_UNKNOWN;
    input->positional_enabled = true;
}

const int64_t *am_catalog_style_ids(size_t *count) {
    if (count) *count = sizeof(catalog_ids) / sizeof(catalog_ids[0]);
    return catalog_ids;
}

const int64_t *am_default_style_ids(size_t *count) {
    if (count) *count = sizeof(default_ids) / sizeof(default_ids[0]);
    return default_ids;
}

am_style_route am_default_route(int64_t id) {
#ifdef TAE_AM_ASM
    _Static_assert(sizeof(am_style_route)==32 && offsetof(am_style_route, algorithm)==12 && offsetof(am_style_route, base_score)==24, "route ABI");
    am_style_route route;
    am_k_route(id, &route);
    return route;
#else
    /* 0x227484b08 binds eight strategies; their static styleIDs arrays contain
     * only these 16 IDs. Catalogue membership alone establishes no scorer. */
    am_style_route route = {
        .style_id = id, .algorithm = AM_ALGORITHM_UNKNOWN,
        .complexity = -1, .path = AM_PATH_UNKNOWN
    };
    for (size_t i = 0; i < sizeof(catalog_ids) / sizeof(catalog_ids[0]); ++i)
        if (catalog_ids[i] == id) route.catalogue_member = true;
    switch (id) {
        case 19: route.algorithm = AM_ALGORITHM_DANCE;
                 route.path = AM_PATH_DANCE_ORIGINAL; route.base_score = 17; break;
        case 17: route.algorithm = AM_ALGORITHM_DANCE;
                 route.path = AM_PATH_DANCE_SHIFTED; route.base_score = 17; break;
        case 18: route.algorithm = AM_ALGORITHM_HIPHOP;
                 route.path = AM_PATH_HIPHOP_DIRECT; route.base_score = 100; break;
        case 15: route.algorithm = AM_ALGORITHM_HIPHOP;
                 route.path = AM_PATH_HIPHOP_SHIFTED; route.base_score = 100; break;
        case 16: case 20: route.algorithm = AM_ALGORITHM_POP;
                 route.path = AM_PATH_POP_SCALED_SHIFTED; route.base_score = 50; break;
        case 8: case 9: route.algorithm = AM_ALGORITHM_FILTERED;
                 route.path = AM_PATH_FILTERED_DIRECT;
                 route.base_score = id == 9 ? 50 : 20; break;
        case 12: route.algorithm = AM_ALGORITHM_FILTERED;
                 route.path = AM_PATH_FILTERED_SHIFTED; route.base_score = 20; break;
        case 3: case 33: case 4: case 44: route.algorithm = AM_ALGORITHM_SMART;
                 route.path = AM_PATH_SMART_CROSSFADE; route.base_score = 10; break;
        case 0: route.algorithm = AM_ALGORITHM_DEAD_AIR;
                 route.path = AM_PATH_DEAD_AIR; route.base_score = 1; break;
        case 5: route.algorithm = AM_ALGORITHM_SOFT_SKIP;
                 route.path = AM_PATH_SOFT_SKIP; route.base_score = 10; break;
        case 1: route.algorithm = AM_ALGORITHM_FALLBACK;
                 route.path = AM_PATH_FALLBACK_CROSSFADE; route.base_score = 1; break;
        default: return route;
    }
    route.default_generated = true;
    route.complexity = algorithm_complexities[route.algorithm];
    return route;
#endif
}

static bool number_known(am_signal_double signal) {
    return signal.has_value && !signal.is_nil && !signal.invalid;
}

static bool bool_true(am_signal_bool signal) {
    return signal.has_value && !signal.is_nil && !signal.invalid && signal.value;
}

static bool number_invalid(am_signal_double signal) {
    return signal.has_value && (signal.invalid ||
           (!signal.is_nil && !isfinite(signal.value)));
}

static am_gate_result bool_gate(am_signal_bool signal) {
    if (signal.has_value && signal.invalid) return AM_GATE_INVALID;
    if (!signal.has_value || signal.is_nil) return AM_GATE_UNKNOWN;
    return signal.value ? AM_GATE_TRUE : AM_GATE_FALSE;
}

static am_gate_result gate_pair(am_gate_result a, am_gate_result b) {
    if (a == AM_GATE_INVALID || b == AM_GATE_INVALID) return AM_GATE_INVALID;
    if (a == AM_GATE_FALSE || b == AM_GATE_FALSE) return AM_GATE_FALSE;
    if (a == AM_GATE_TRUE && b == AM_GATE_TRUE) return AM_GATE_TRUE;
    return AM_GATE_UNKNOWN;
}

static am_gate_result array_contains_complexity(am_complexity_array array,
                                               uint8_t required) {
    if (array.has_values && array.invalid) return AM_GATE_INVALID;
    if (!array.has_values || array.is_nil) return AM_GATE_UNKNOWN;
    if (array.count > 0 && !array.values) return AM_GATE_INVALID;
    bool found = false;
    for (size_t i = 0; i < array.count; ++i) {
        if (array.values[i] > 3) return AM_GATE_INVALID;
        if (array.values[i] == required) found = true;
    }
    return found ? AM_GATE_TRUE : AM_GATE_FALSE;
}

am_gate_result am_complexity_gate(am_algorithm algorithm,
                                 am_signal_i64 maximum_complexity,
                                 am_complexity_array outgoing,
                                 am_complexity_array incoming) {
    /* 0x227454c8c: max >= requirement; 0x22745550c: both song arrays must
     * contain that exact byte. StylingSong witness +0x48 supplies the array. */
    if (algorithm < 0 || algorithm >= 8) return AM_GATE_INVALID;
    const uint8_t required = (uint8_t)algorithm_complexities[algorithm];
    am_gate_result maximum = AM_GATE_UNKNOWN;
    if (maximum_complexity.has_value) {
        if (maximum_complexity.invalid || (!maximum_complexity.is_nil &&
            (maximum_complexity.value < 0 || maximum_complexity.value > 3)))
            maximum = AM_GATE_INVALID;
        else if (!maximum_complexity.is_nil)
            maximum = maximum_complexity.value >= required ? AM_GATE_TRUE : AM_GATE_FALSE;
    }
    return gate_pair(maximum, gate_pair(array_contains_complexity(outgoing, required),
                                       array_contains_complexity(incoming, required)));
}

am_gate_result am_attribute_gate(am_attribute attribute, am_signal_double query) {
    /* 0x22744eac4 / 0x22744ee2c, witness +0x80 acousticness / +0x88
     * danceability. Known optional nil passes; unavailable data stays unknown. */
    if (attribute != AM_ATTRIBUTE_ACOUSTICNESS && attribute != AM_ATTRIBUTE_DANCEABILITY)
        return AM_GATE_INVALID;
    if (number_invalid(query)) return AM_GATE_INVALID;
    if (!query.has_value) return AM_GATE_UNKNOWN;
    if (query.is_nil) return AM_GATE_TRUE; /* confirmed optional nil passes */
    const bool accepted = attribute == AM_ATTRIBUTE_ACOUSTICNESS
        ? (query.value < 0.85 || query.value > 1.0)
        : (query.value >= 0.3 && query.value <= 1.0);
    return accepted ? AM_GATE_TRUE : AM_GATE_FALSE;
}

static am_gate_result bound_compare(am_signal_double candidate,
                                    am_signal_double boundary, bool minimum) {
    if (number_invalid(candidate) || number_invalid(boundary)) return AM_GATE_INVALID;
    if (!number_known(candidate) || !number_known(boundary)) return AM_GATE_UNKNOWN;
    return (minimum ? candidate.value >= boundary.value : candidate.value < boundary.value)
        ? AM_GATE_TRUE : AM_GATE_FALSE;
}

am_gate_result am_region_bounds_gate(const am_region_bounds_input *input) {
    /* 0x22744f34c outgoing >= minima; 0x22744fbfc incoming strictly < max.
     * The maximum is already computed by witness +0x98, not raw duration. */
    if (!input) return AM_GATE_INVALID;
    return gate_pair(bound_compare(input->outgoing_start, input->minimum_outgoing_start, true),
        gate_pair(bound_compare(input->outgoing_end, input->minimum_outgoing_end, true),
                  bound_compare(input->incoming_end, input->computed_maximum_incoming_end, false)));
}

am_gate_result am_candidate_postfilter(am_signal_bool song_pair_accepts,
                                      am_signal_bool criteria_accepts) {
    /* 0x2274580f0: 0x22744f140 && 0x227430e84, after score generation. */
    return gate_pair(bool_gate(song_pair_accepts), bool_gate(criteria_accepts));
}

double am_leading_vocal_factor(am_signal_i64 strength) {
    /* 0x227452774: high/veryHigh (3/4) -> 0.75; optional nil -> 1. */
    return strength.has_value && !strength.is_nil && !strength.invalid &&
           (strength.value == 3 || strength.value == 4) ? 0.75 : 1.0;
}

bool am_trailing_loudness_ratio(am_signal_double region, am_signal_double trailing,
                               double *ratio) {
    /* 0x2274533c8: raw negative dB means divided without normalization. */
    if (!ratio || !number_known(region) || !number_known(trailing) ||
        !isfinite(region.value) || !isfinite(trailing.value) ||
        region.value >= 0 || trailing.value >= 0) return false;
    *ratio = region.value / trailing.value;
    return true; /* no native clamp, including ratios greater than one */
}

am_gate_result am_outgoing_loudness_significant(am_signal_double region_mean,
                                              am_signal_bool map_available) {
    /* 0x227453034: missing map passes, known nil query fails; strict > -15. */
    if (map_available.has_value && map_available.invalid) return AM_GATE_INVALID;
    if (!map_available.has_value) return AM_GATE_UNKNOWN;
    if (map_available.is_nil || !map_available.value) return AM_GATE_TRUE;
    if (number_invalid(region_mean)) return AM_GATE_INVALID;
    if (!region_mean.has_value) return AM_GATE_UNKNOWN;
    if (region_mean.is_nil) return AM_GATE_FALSE;
    return region_mean.value > -15.0 ? AM_GATE_TRUE : AM_GATE_FALSE;
}

static bool alias_valid(double alias) { return alias == 0.5 || alias == 1.0 || alias == 2.0; }

am_scoring_error am_normalized_incoming_beats(int64_t beat_count, double alias,
                                            int64_t *normalized) {
    /* Native enum aliases 0/1/2: integer divide2 / unchanged / multiply2.
     * This is count normalization, not floating-point tempo interpolation. */
    if (!normalized || beat_count < 0 || !alias_valid(alias)) return AM_SCORING_INVALID_ARGUMENT;
    if (alias == 0.5) *normalized = beat_count / 2;
    else if (alias == 1.0) *normalized = beat_count;
    else {
        if (beat_count > INT64_MAX / 2) return AM_SCORING_OVERFLOW;
        *normalized = beat_count * 2;
    }
    return AM_SCORING_OK;
}

typedef struct { bool has_value, is_nil, invalid; } field_state;
#define FIELD_STATE(field) ((field_state){(field).has_value, (field).is_nil, (field).invalid})

static field_state signal_state(const am_candidate_signals *s, am_signal_id id) {
    switch (id) {
        case AM_SIGNAL_STRICT_TEMPO: return FIELD_STATE(s->strict_tempo_compatible);
        case AM_SIGNAL_LOOSE_TEMPO: return FIELD_STATE(s->loose_tempo_compatible);
        case AM_SIGNAL_TONALITIES_COMPATIBLE: return FIELD_STATE(s->tonalities_compatible);
        case AM_SIGNAL_MATCHING_BAR_COUNT: return FIELD_STATE(s->matching_bar_count);
        case AM_SIGNAL_OUTGOING_BEAT_COUNT: return FIELD_STATE(s->outgoing_beat_count);
        case AM_SIGNAL_INCOMING_BEAT_COUNT: return FIELD_STATE(s->incoming_beat_count);
        case AM_SIGNAL_TEMPO_ALIAS: return FIELD_STATE(s->tempo_alias);
        case AM_SIGNAL_TARGET_BAR_COUNT: return FIELD_STATE(s->target_bar_count);
        case AM_SIGNAL_INCOMING_LEADING_STRENGTH: return FIELD_STATE(s->incoming_leading_strength);
        case AM_SIGNAL_INCOMING_REGION_LOUDNESS: return FIELD_STATE(s->incoming_region_loudness);
        case AM_SIGNAL_INCOMING_TRAILING_LOUDNESS: return FIELD_STATE(s->incoming_trailing_loudness);
        case AM_SIGNAL_VOCAL_OVERLAP_INCOMPATIBLE: return FIELD_STATE(s->vocal_overlap_incompatible);
        case AM_SIGNAL_INCOMING_LOUDNESS_RELATION_CODE: return FIELD_STATE(s->incoming_loudness_relation_code);
        case AM_SIGNAL_TRAILING_SPAN_SECONDS: return FIELD_STATE(s->trailing_span_seconds);
        case AM_SIGNAL_OUTGOING_LOUDNESS_SIGNIFICANT: return FIELD_STATE(s->outgoing_loudness_significant);
        default: return (field_state){false, false, false};
    }
}

static uint64_t required_signals(am_candidate_path path, int64_t style_id) {
    const uint64_t strict = AM_SIGNAL_BIT(AM_SIGNAL_STRICT_TEMPO);
    const uint64_t bars = AM_SIGNAL_BIT(AM_SIGNAL_MATCHING_BAR_COUNT);
    const uint64_t key = AM_SIGNAL_BIT(AM_SIGNAL_TONALITIES_COMPATIBLE);
    const uint64_t beats = AM_SIGNAL_BIT(AM_SIGNAL_OUTGOING_BEAT_COUNT) |
        AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_BEAT_COUNT) | AM_SIGNAL_BIT(AM_SIGNAL_TEMPO_ALIAS);
    switch (path) {
        case AM_PATH_DANCE_ORIGINAL: return strict | bars;
        case AM_PATH_DANCE_SHIFTED: return strict | bars | key;
        case AM_PATH_FILTERED_DIRECT:
            return style_id == 9 ? strict | key | bars | AM_SIGNAL_BIT(AM_SIGNAL_VOCAL_OVERLAP_INCOMPATIBLE)
                 : strict | AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_BEAT_COUNT) | AM_SIGNAL_BIT(AM_SIGNAL_TEMPO_ALIAS);
        case AM_PATH_FILTERED_SHIFTED: return strict | bars | AM_SIGNAL_BIT(AM_SIGNAL_LOOSE_TEMPO);
        case AM_PATH_HIPHOP_DIRECT: case AM_PATH_HIPHOP_SHIFTED: return beats;
        case AM_PATH_POP_SCALED_SHIFTED: return beats | AM_SIGNAL_BIT(AM_SIGNAL_OUTGOING_LOUDNESS_SIGNIFICANT);
        case AM_PATH_SMART_CROSSFADE:
            return AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_LOUDNESS_RELATION_CODE) | AM_SIGNAL_BIT(AM_SIGNAL_TRAILING_SPAN_SECONDS);
        default: return 0;
    }
}

static bool nil_is_missing(am_signal_id id) {
    return id == AM_SIGNAL_OUTGOING_BEAT_COUNT || id == AM_SIGNAL_INCOMING_BEAT_COUNT ||
           id == AM_SIGNAL_TEMPO_ALIAS || id == AM_SIGNAL_INCOMING_LOUDNESS_RELATION_CODE ||
           id == AM_SIGNAL_TRAILING_SPAN_SECONDS;
}

static void add_factor(am_score_result *result, const char *name, double value) {
    result->factors[result->factor_count++] = (am_score_factor){name, value};
}

static void finish_score(am_score_result *result, double outgoing_end,
                          double incoming_end, bool positional_enabled) {
    /* 0x227456e54 + 0x227456d24: P=base*product; only P>0 receives
     * 0.001*(outUpper-inUpper). Signed preference is never clamped to zero. */
#ifdef TAE_AM_ASM
    result->boundary_delta = positional_enabled ? outgoing_end - incoming_end : 0.0;
    result->score = am_k_score(result->base, result->factors, result->factor_count, result->boundary_delta, &result->product);
#else
    result->product = result->base;
    for (size_t i = 0; i < result->factor_count; ++i)
        result->product *= result->factors[i].value;
    result->boundary_delta = positional_enabled ? outgoing_end - incoming_end : 0.0;
    result->score = result->product > 0
        ? result->product + 0.001 * result->boundary_delta : result->product;
#endif
    if (!isfinite(result->product) || !isfinite(result->boundary_delta) || !isfinite(result->score)) {
        result->status = AM_SCORE_ARITHMETIC_ERROR;
        result->score_known = false;
        result->reason = "Computed score is not finite; independent C API arithmetic guard";
    } else {
        result->status = AM_SCORE_SCORED;
        result->score_known = true;
    }
}

am_scoring_error am_evaluate_candidate(const am_candidate_input *input,
                                      am_score_result *result) {
    if (!input || !result) return AM_SCORING_INVALID_ARGUMENT;
    memset(result, 0, sizeof(*result));
    const am_style_route route = am_default_route(input->style_id);
    if (!route.default_generated || input->path != route.path) {
        result->status = AM_SCORE_UNSUPPORTED_PATH;
        result->reason = "No confirmed native direct entry for this style/path pair";
        return AM_SCORING_OK;
    }
    result->base = route.base_score;
    result->evidence = path_evidence[input->path];
    const am_candidate_signals *s = &input->signals;
    const double target = s->target_bar_count.has_value ? s->target_bar_count.value : 8.0;
    /* Python evaluates the optional target guard before missing required keys. */
    if (s->target_bar_count.has_value && (s->target_bar_count.is_nil ||
        s->target_bar_count.invalid || !isfinite(target) || target <= 0)) {
        result->status = AM_SCORE_INVALID_UPSTREAM_SIGNALS;
        result->invalid_inputs = AM_SIGNAL_BIT(AM_SIGNAL_TARGET_BAR_COUNT);
        return AM_SCORING_OK;
    }
    const uint64_t required = required_signals(input->path, input->style_id);
    for (int id = 0; id < AM_SIGNAL_COUNT; ++id) {
        if (!(required & AM_SIGNAL_BIT(id))) continue;
        const field_state state = signal_state(s, (am_signal_id)id);
        if (!state.has_value || (state.is_nil && nil_is_missing((am_signal_id)id)))
            result->missing_inputs |= AM_SIGNAL_BIT(id);
    }
    if (result->missing_inputs) {
        result->status = AM_SCORE_MISSING_UPSTREAM_SIGNALS;
        return AM_SCORING_OK;
    }
    for (int id = 0; id < AM_SIGNAL_COUNT; ++id)
        if ((required & AM_SIGNAL_BIT(id)) && signal_state(s, (am_signal_id)id).invalid)
            result->invalid_inputs |= AM_SIGNAL_BIT(id);
    if ((required & AM_SIGNAL_BIT(AM_SIGNAL_OUTGOING_BEAT_COUNT)) && s->outgoing_beat_count.value < 0)
        result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_OUTGOING_BEAT_COUNT);
    if ((required & AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_BEAT_COUNT)) && s->incoming_beat_count.value < 0)
        result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_BEAT_COUNT);
    if ((required & AM_SIGNAL_BIT(AM_SIGNAL_TEMPO_ALIAS)) && !alias_valid(s->tempo_alias.value))
        result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_TEMPO_ALIAS);
    if ((required & AM_SIGNAL_BIT(AM_SIGNAL_TRAILING_SPAN_SECONDS)) &&
        (!isfinite(s->trailing_span_seconds.value) || s->trailing_span_seconds.value < 0))
        result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_TRAILING_SPAN_SECONDS);
    if ((required & AM_SIGNAL_BIT(AM_SIGNAL_MATCHING_BAR_COUNT)) &&
        !s->matching_bar_count.is_nil && s->matching_bar_count.value < 0)
        result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_MATCHING_BAR_COUNT);
    if (number_invalid(s->incoming_region_loudness))
        result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_REGION_LOUDNESS);
    if (number_invalid(s->incoming_trailing_loudness))
        result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_TRAILING_LOUDNESS);
    if (!isfinite(input->outgoing_end)) result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_OUTGOING_END);
    if (!isfinite(input->incoming_end)) result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_END);
    if (result->invalid_inputs) {
        result->status = AM_SCORE_INVALID_UPSTREAM_SIGNALS;
        return AM_SCORING_OK;
    }
#ifdef TAE_AM_ASM
    if (input->path >= AM_PATH_HIPHOP_DIRECT && input->path <= AM_PATH_POP_SCALED_SHIFTED && s->outgoing_beat_count.value / 4 <= 0) {
        result->status = AM_SCORE_INVALID_UPSTREAM_REGION;
        result->reason = "Native caller assumes a positive outgoing bar count";
        return AM_SCORING_OK;
    }
    if ((input->path >= AM_PATH_HIPHOP_DIRECT && input->path <= AM_PATH_POP_SCALED_SHIFTED) || (input->path == AM_PATH_FILTERED_DIRECT && input->style_id != 9)) {
        int64_t normalized;
        if (am_normalized_incoming_beats(s->incoming_beat_count.value, s->tempo_alias.value, &normalized) != AM_SCORING_OK) {
            if (input->path == AM_PATH_FILTERED_DIRECT)
                add_factor(result, "strict_tempo", bool_true(s->strict_tempo_compatible) ? 1.0 : 0.0);
            result->status = AM_SCORE_INVALID_UPSTREAM_SIGNALS;
            result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_BEAT_COUNT);
            return AM_SCORING_OK;
        }
    }
    if (input->path == AM_PATH_SMART_CROSSFADE && (s->incoming_loudness_relation_code.value < 0 || s->incoming_loudness_relation_code.value > 63)) {
        result->status = AM_SCORE_INVALID_UPSTREAM_RELATION;
        result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_LOUDNESS_RELATION_CODE);
        return AM_SCORING_OK;
    }
    int64_t flags = (bool_true(s->strict_tempo_compatible) ? 1 : 0) | (bool_true(s->tonalities_compatible) ? 2 : 0) | (bool_true(s->loose_tempo_compatible) ? 4 : 0) | (s->strict_tempo_compatible.is_nil ? 8 : 0) | (!s->vocal_overlap_incompatible.is_nil && !bool_true(s->vocal_overlap_incompatible) ? 16 : 0) | (bool_true(s->outgoing_loudness_significant) ? 32 : 0);
    if (number_known(s->incoming_region_loudness) && number_known(s->incoming_trailing_loudness) && s->incoming_region_loudness.value < 0 && s->incoming_trailing_loudness.value < 0) flags |= 64;
    am_kernel_candidate args = {input->path, input->style_id, flags,
        s->matching_bar_count.has_value && !s->matching_bar_count.is_nil && !s->matching_bar_count.invalid ? s->matching_bar_count.value : -1,
        s->incoming_beat_count.value, s->outgoing_beat_count.value, target, s->tempo_alias.value,
        s->incoming_leading_strength.has_value && !s->incoming_leading_strength.is_nil && !s->incoming_leading_strength.invalid ? s->incoming_leading_strength.value : -1,
        s->incoming_region_loudness.value, s->incoming_trailing_loudness.value, s->trailing_span_seconds.value, s->incoming_loudness_relation_code.value};
    am_kernel_factors values = {0};
    am_k_path_factors(&args, &values);
    static const char *names[8][6] = {
        {"strict_tempo","matching_bars","leading_vocal"},
        {"strict_tempo","key","matching_bars","trailing_loudness"},
        {"strict_tempo","leading_vocal","incoming_bar_coverage","trailing_loudness"},
        {"tempo_rescue","matching_bars","leading_vocal","trailing_loudness"},
        {"leading_vocal","relative_bar_length","incoming_bar_coverage","trailing_loudness"},
        {"leading_vocal","relative_bar_length","incoming_bar_coverage","trailing_loudness"},
        {"outgoing_bars_equal_target","relative_bar_length","leading_vocal","outgoing_loudness","trailing_loudness"},
        {"incoming_loudness_relation","trailing_duration"}};
    static const char *nine[] = {"strict_tempo","key","matching_bars","no_vocal_overlap","leading_vocal","trailing_loudness"};
    for (size_t i=0; i<values.count; ++i) add_factor(result, input->path==AM_PATH_FILTERED_DIRECT && input->style_id==9 ? nine[i] : names[input->path][i], values.values[i]);
#else
    const double strict = bool_true(s->strict_tempo_compatible) ? 1.0 : 0.0;
    const double bars = s->matching_bar_count.has_value && !s->matching_bar_count.is_nil &&
                        !s->matching_bar_count.invalid && s->matching_bar_count.value >= 8 ? 1.0 : 0.0;
    const double vocal = am_leading_vocal_factor(s->incoming_leading_strength);
    double loudness = 1.0;
    (void)am_trailing_loudness_ratio(s->incoming_region_loudness,
                                   s->incoming_trailing_loudness, &loudness);
    int64_t out_bars = 0, in_bars = 0;
    double relative_length = 0.0, coverage = 0.0;
    if (input->path == AM_PATH_HIPHOP_DIRECT || input->path == AM_PATH_HIPHOP_SHIFTED ||
        input->path == AM_PATH_POP_SCALED_SHIFTED) {
        out_bars = s->outgoing_beat_count.value / 4;
        if (out_bars <= 0) {
            result->status = AM_SCORE_INVALID_UPSTREAM_REGION;
            result->reason = "Native caller assumes a positive outgoing bar count";
            return AM_SCORING_OK;
        }
        int64_t normalized;
        if (am_normalized_incoming_beats(s->incoming_beat_count.value, s->tempo_alias.value,
                                         &normalized) != AM_SCORING_OK) {
            result->status = AM_SCORE_INVALID_UPSTREAM_SIGNALS;
            result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_BEAT_COUNT);
            return AM_SCORING_OK;
        }
        in_bars = normalized / 4;
        relative_length = (double)in_bars / (double)out_bars >= 0.75 ? 1.0 : 0.0;
        coverage = (double)in_bars / target;
    }
    switch (input->path) {
        case AM_PATH_DANCE_ORIGINAL:
            add_factor(result, "strict_tempo", strict);
            add_factor(result, "matching_bars", bars);
            add_factor(result, "leading_vocal", vocal); break;
        case AM_PATH_DANCE_SHIFTED:
            add_factor(result, "strict_tempo", strict);
            add_factor(result, "key", bool_true(s->tonalities_compatible) ? 1 : 0);
            add_factor(result, "matching_bars", bars);
            add_factor(result, "trailing_loudness", loudness); break;
        case AM_PATH_FILTERED_DIRECT:
            add_factor(result, "strict_tempo", strict);
            if (input->style_id == 9) {
                add_factor(result, "key", bool_true(s->tonalities_compatible) ? 1 : 0);
                add_factor(result, "matching_bars", bars);
                add_factor(result, "no_vocal_overlap", !s->vocal_overlap_incompatible.is_nil &&
                    !bool_true(s->vocal_overlap_incompatible) ? 1 : 0);
                add_factor(result, "leading_vocal", vocal);
            } else {
                int64_t normalized;
                if (am_normalized_incoming_beats(s->incoming_beat_count.value, s->tempo_alias.value,
                                                &normalized) != AM_SCORING_OK) {
                    result->status = AM_SCORE_INVALID_UPSTREAM_SIGNALS;
                    result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_BEAT_COUNT);
                    return AM_SCORING_OK;
                }
                add_factor(result, "leading_vocal", vocal);
                add_factor(result, "incoming_bar_coverage", (double)(normalized / 4) / target);
            }
            add_factor(result, "trailing_loudness", loudness); break;
        case AM_PATH_FILTERED_SHIFTED:
            /* 0x227461f04: present strict=false AND loose=true; nil strict
             * is failure, not evidence that a tempo-rescue branch is valid. */
            add_factor(result, "tempo_rescue", !s->strict_tempo_compatible.is_nil &&
                !strict && bool_true(s->loose_tempo_compatible) ? 1 : 0);
            add_factor(result, "matching_bars", bars);
            add_factor(result, "leading_vocal", vocal);
            add_factor(result, "trailing_loudness", loudness); break;
        case AM_PATH_HIPHOP_DIRECT: case AM_PATH_HIPHOP_SHIFTED:
            add_factor(result, "leading_vocal", vocal);
            add_factor(result, "relative_bar_length", relative_length);
            add_factor(result, "incoming_bar_coverage", coverage);
            add_factor(result, "trailing_loudness", loudness); break;
        case AM_PATH_POP_SCALED_SHIFTED:
            add_factor(result, "outgoing_bars_equal_target", (double)out_bars == target ? 1 : 0);
            add_factor(result, "relative_bar_length", relative_length);
            add_factor(result, "leading_vocal", vocal);
            add_factor(result, "outgoing_loudness", bool_true(s->outgoing_loudness_significant) ? 1 : 0);
            add_factor(result, "trailing_loudness", loudness); break;
        case AM_PATH_SMART_CROSSFADE: {
            /* 0x227470e0c: 0..63 relation dispatch; 3/33 require code0,
             * 4/44 code!=0. IDs3/4 span>=5; 33/44 span<5. */
            const int64_t code = s->incoming_loudness_relation_code.value;
            if (code < 0 || code > 63) {
                result->status = AM_SCORE_INVALID_UPSTREAM_RELATION;
                result->invalid_inputs |= AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_LOUDNESS_RELATION_CODE);
                return AM_SCORING_OK;
            }
            const bool zero_relation = input->style_id == 3 || input->style_id == 33;
            const bool long_trailing = input->style_id == 3 || input->style_id == 4;
            add_factor(result, "incoming_loudness_relation", (code == 0) == zero_relation ? 1 : 0);
            add_factor(result, "trailing_duration", long_trailing
                ? (s->trailing_span_seconds.value >= 5 ? 1 : 0)
                : (s->trailing_span_seconds.value < 5 ? 1 : 0)); break;
        }
        case AM_PATH_DEAD_AIR: case AM_PATH_FALLBACK_CROSSFADE: case AM_PATH_SOFT_SKIP: break;
        default: result->status = AM_SCORE_UNSUPPORTED_PATH; return AM_SCORING_OK;
    }
#endif
    finish_score(result, input->outgoing_end, input->incoming_end, input->positional_enabled);
    return AM_SCORING_OK;
}

static bool add_i64(int64_t a, int64_t b, int64_t *result) {
    if ((b > 0 && a > INT64_MAX - b) || (b < 0 && a < INT64_MIN - b)) return false;
    *result = a + b; return true;
}

static bool multiply_positive_i64(int64_t a, int64_t positive, int64_t *result) {
    if (a > INT64_MAX / positive || a < INT64_MIN / positive) return false;
    *result = a * positive; return true;
}

static bool event_count_invalid(am_signal_i64 count) {
    return count.has_value && (count.invalid || (!count.is_nil && count.value < 0));
}

static bool endpoint_within_count(int64_t endpoint, am_signal_i64 count) {
    return !count.has_value || count.is_nil || endpoint < count.value;
}

am_scoring_error am_scale_incoming_region(am_beat_region incoming,
                                         int64_t outgoing_beat_count, double alias,
                                         am_signal_i64 beat_event_count,
                                         am_beat_region *result, bool *available) {
    /* 0x22743d8d4: end-anchored, complete-bar availability, then alias
     * conversion and quantization (4 beats for aliases<=1; 2 for alias2). */
    if (!result || !available || outgoing_beat_count < 0 || incoming.end < 0 ||
        !alias_valid(alias) || event_count_invalid(beat_event_count)) return AM_SCORING_INVALID_ARGUMENT;
    *available = false;
    int64_t target = outgoing_beat_count;
    if (alias == 0.5 && !multiply_positive_i64(outgoing_beat_count, 2, &target))
        return AM_SCORING_OVERFLOW;
    if (alias == 2.0) target = outgoing_beat_count / 2;
    const int64_t quantum = alias == 2.0 ? 2 : 4;
    const int64_t limit = incoming.end / 4 * 4;
    const int64_t length = (limit < target ? limit : target) / quantum * quantum;
    *result = (am_beat_region){incoming.end - length, incoming.end};
    *available = endpoint_within_count(result->end, beat_event_count);
    return AM_SCORING_OK;
}

am_scoring_error am_shift_region_pair(am_beat_region outgoing,
                                     am_beat_region incoming,
                                     int64_t outgoing_bars, int64_t incoming_bars,
                                     double alias, am_signal_i64 outgoing_event_count,
                                     am_signal_i64 incoming_event_count,
                                     am_beat_region *out_result,
                                     am_beat_region *in_result, bool *available) {
    /* 0x227452240 + 0x22743dea8: outgoing +=4*bars;
     * incoming +=4*bars/alias. Here binary aliases yield exact integer factors. */
    if (!out_result || !in_result || !available || !alias_valid(alias) ||
        event_count_invalid(outgoing_event_count) || event_count_invalid(incoming_event_count))
        return AM_SCORING_INVALID_ARGUMENT;
    *available = false;
    int64_t out_offset, in_offset;
    const int64_t incoming_multiplier = alias == 0.5 ? 8 : alias == 1.0 ? 4 : 2;
    if (!multiply_positive_i64(outgoing_bars, 4, &out_offset) ||
        !multiply_positive_i64(incoming_bars, incoming_multiplier, &in_offset) ||
        !add_i64(outgoing.start, out_offset, &out_result->start) ||
        !add_i64(outgoing.end, out_offset, &out_result->end) ||
        !add_i64(incoming.start, in_offset, &in_result->start) ||
        !add_i64(incoming.end, in_offset, &in_result->end)) return AM_SCORING_OVERFLOW;
    *available = out_result->start >= 0 && in_result->start >= 0 &&
        endpoint_within_count(out_result->end, outgoing_event_count) &&
        endpoint_within_count(in_result->end, incoming_event_count);
    return AM_SCORING_OK;
}

void am_shift_bars_for(am_candidate_path path, int64_t id,
                       int64_t *outgoing_bars, int64_t *incoming_bars) {
    int64_t out = 0, in = 0;
    if (path == AM_PATH_DANCE_SHIFTED && id == 17) out = in = 2;
    else if (path == AM_PATH_FILTERED_SHIFTED && id == 12) in = 4;
    else if (path == AM_PATH_HIPHOP_SHIFTED && id == 15) out = in = 1;
    else if (path == AM_PATH_POP_SCALED_SHIFTED && id == 16) in = 2;
    else if (path == AM_PATH_POP_SCALED_SHIFTED && id == 20) { out = 2; in = 1; }
    if (outgoing_bars) *outgoing_bars = out;
    if (incoming_bars) *incoming_bars = in;
}

am_scoring_error am_loudness_windows(double start, double end,
                                    am_candidate_path path, int64_t style_id,
                                    double windows[2][2]) {
    /* 0x227453970: actual query intervals may extend beyond selected regions. */
    if (!windows || !isfinite(start) || !isfinite(end) || end < start)
        return AM_SCORING_INVALID_ARGUMENT;
    double a = 0, b = 1, c = 1;
    if (path == AM_PATH_DANCE_SHIFTED) b = c = 8.0 / 9.0;
    else if (path == AM_PATH_HIPHOP_SHIFTED) a = -0.25;
    else if (path == AM_PATH_POP_SCALED_SHIFTED) {
        int64_t in_bars; am_shift_bars_for(path, style_id, NULL, &in_bars);
        a = -0.25 * (double)in_bars;
    }
    const double length = end - start;
    const double split = start + (a + b) * length;
    windows[0][0] = start + a * length; windows[0][1] = split;
    windows[1][0] = split; windows[1][1] = start + (a + b + c) * length;
    for (int i = 0; i < 2; ++i)
        for (int j = 0; j < 2; ++j)
            if (!isfinite(windows[i][j])) return AM_SCORING_OVERFLOW;
    return AM_SCORING_OK;
}

am_gate_result am_vocal_overlap_incompatible(const int *outgoing, size_t outgoing_count,
                                           bool outgoing_available, const int *incoming,
                                           size_t incoming_count, bool incoming_available) {
    /* 0x2274426d4: max(min(out_i,in_i)) != veryLow, ignoring query nil/5;
     * 0x227462b2c caller treats absent structure/map as incompatible. */
    if (!outgoing_available || !incoming_available) return AM_GATE_TRUE;
    if ((outgoing_count && !outgoing) || (incoming_count && !incoming)) return AM_GATE_INVALID;
    const size_t count = outgoing_count < incoming_count ? outgoing_count : incoming_count;
    bool overlap = false;
    for (size_t i = 0; i < count; ++i) {
        const int a = outgoing[i], b = incoming[i];
        if (a < -1 || a > 5 || b < -1 || b > 5) return AM_GATE_INVALID;
        if (a == -1 || b == -1 || a == 5 || b == 5) continue;
        if ((a < b ? a : b) != 0) overlap = true;
    }
    return overlap ? AM_GATE_TRUE : AM_GATE_FALSE;
}

am_scoring_error am_tempo_relationship(double outgoing_bpm, double incoming_bpm,
                                      double threshold, am_tempo_result *result) {
    /* 0x227438348 / 0x227437fe4: minimize distance in natural log BPM;
     * strict improvement preserves the first half/one/two alias on ties. */
    if (!result || !isfinite(outgoing_bpm) || !isfinite(incoming_bpm) ||
        outgoing_bpm <= 0 || incoming_bpm <= 0 || !isfinite(threshold) || threshold < 0)
        return AM_SCORING_INVALID_ARGUMENT;
    static const double aliases[3] = {0.5, 1.0, 2.0};
    const double out_log = log(outgoing_bpm);
    double smallest = INFINITY, effective = 0;
    int best = 0;
    for (int i = 0; i < 3; ++i) {
        const double adjusted = incoming_bpm * aliases[i];
        const double distance = adjusted > 0 && isfinite(adjusted)
            ? fabs(log(adjusted) - out_log) : INFINITY;
        if (distance < smallest) { smallest = distance; effective = adjusted; best = i; }
    }
    if (!isfinite(smallest)) return AM_SCORING_OVERFLOW;
    *result = (am_tempo_result){best, aliases[best], effective, smallest,
                              effective == outgoing_bpm, smallest <= threshold};
    return AM_SCORING_OK;
}

static bool key_valid(am_key key) {
    return key.tonic >= 0 && key.tonic <= 11 && key.mode >= AM_KEY_MAJOR && key.mode <= AM_KEY_NEUTRAL;
}

am_tonality_relation am_tonality_relationship(am_key outgoing, am_key incoming) {
    /* 0x227441d20; circles at 0x27ad8fda8/0x27ad8fde0 converted to C=0. */
    if (!outgoing.known || !incoming.known || !key_valid(outgoing) || !key_valid(incoming))
        return AM_TONALITY_UNKNOWN;
    if (outgoing.tonic == incoming.tonic && outgoing.mode == incoming.mode) return AM_TONALITY_IDENTICAL;
    if (outgoing.mode == AM_KEY_NEUTRAL || incoming.mode == AM_KEY_NEUTRAL) return AM_TONALITY_INCOMPATIBLE;
    static const int major[12] = {0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5};
    static const int minor[12] = {9, 4, 11, 6, 1, 8, 3, 10, 5, 0, 7, 2};
    const int *a_circle = outgoing.mode == AM_KEY_MAJOR ? major : minor;
    const int *b_circle = incoming.mode == AM_KEY_MAJOR ? major : minor;
    int a = 0, b = 0;
    for (int i = 0; i < 12; ++i) {
        if (a_circle[i] == outgoing.tonic) a = i;
        if (b_circle[i] == incoming.tonic) b = i;
    }
    if (outgoing.mode != incoming.mode) return a == b ? AM_TONALITY_RELATIVE : AM_TONALITY_INCOMPATIBLE;
    const int delta = (a - b + 12) % 12;
    return delta == 1 || delta == 11 ? AM_TONALITY_NEIGHBOURING : AM_TONALITY_INCOMPATIBLE;
}

am_gate_result am_key_gate(am_key outgoing, am_key incoming, bool identical_only,
                          am_signal_double outgoing_melodicness,
                          am_signal_double incoming_melodicness) {
    /* 0x22744f0b4 / 0x22744eebc: both tonalities must exist before the
     * melodicness relaxation (<0.25 OR >1) is considered. */
    if (!outgoing.known || !incoming.known) return AM_GATE_FALSE;
    if (!key_valid(outgoing) || !key_valid(incoming) || number_invalid(outgoing_melodicness) ||
        number_invalid(incoming_melodicness)) return AM_GATE_INVALID;
    const am_tonality_relation relation = am_tonality_relationship(outgoing, incoming);
    if (relation == AM_TONALITY_IDENTICAL || (!identical_only &&
        (relation == AM_TONALITY_RELATIVE || relation == AM_TONALITY_NEIGHBOURING))) return AM_GATE_TRUE;
    const bool weak_a = number_known(outgoing_melodicness) &&
        (outgoing_melodicness.value < 0.25 || outgoing_melodicness.value > 1.0);
    const bool weak_b = number_known(incoming_melodicness) &&
        (incoming_melodicness.value < 0.25 || incoming_melodicness.value > 1.0);
    return weak_a || weak_b ? AM_GATE_TRUE : AM_GATE_FALSE;
}

am_scoring_error am_native_score_weight(double score, int64_t *weight) {
#ifdef TAE_AM_ASM
    return (am_scoring_error)am_k_weight(score, weight);
#else

    /* 0x227476a9c multiplier at 0x2274d1e10 =1000.0;
     * 0x227476afc FCVTZS. Upper bound 2^63 is excluded before conversion. */
    if (!weight || !isfinite(score)) return AM_SCORING_INVALID_ARGUMENT;
    if (score <= 0) { *weight = 0; return AM_SCORING_OK; }
    const double scaled = score * 1000.0;
    if (!isfinite(scaled) || scaled >= 0x1p63) return AM_SCORING_OVERFLOW;
    *weight = (int64_t)scaled; /* C truncation toward zero, matching FCVTZS */
    return AM_SCORING_OK;
#endif
}

am_scoring_error am_native_modulo_index(uint64_t native_seed, int64_t upper_bound,
                                       uint64_t *index) {
#ifdef TAE_AM_ASM
    return (am_scoring_error)am_k_modulo(native_seed, upper_bound, index);
#else

    /* 0x227477c04..c24: unsigned UDIV/MSUB, no PRNG state update. */
    if (!index || upper_bound <= 0) return AM_SCORING_INVALID_ARGUMENT;
    *index = native_seed % (uint64_t)upper_bound;
    return AM_SCORING_OK;
#endif
}

uint64_t am_seed_from_millisecond_counts(int64_t outgoing_ms, int64_t incoming_ms) {
    /* 0x2274aabb8 decimal native Int descriptions, no separator;
     * 0x2274a64d4 UTF8 DJB2 starting5381 with wrapping UInt64.
     * 0x227477cbc FRINTX from seconds to integer milliseconds depends on FPCR:
     * this API takes those integer counts explicitly, not a guessed rounding. */
    char payload[64];
    const int length = snprintf(payload, sizeof(payload), "%" PRId64 "%" PRId64,
                                outgoing_ms, incoming_ms);
    uint64_t value = UINT64_C(5381);
    for (int i = 0; i < length; ++i) value = value * UINT64_C(33) + (unsigned char)payload[i];
    return value;
}

typedef struct { size_t index; double score; int64_t style_id; } ranked_candidate;

static int ranking_compare(const void *left, const void *right) {
#ifdef TAE_AM_ASM
    return am_k_rank_compare(left, right);
#else

    /* 0x2274775c8..5ec (insertion) / 0x2274771b8..1d8 (run sort):
     * result+0xf8 score descending; result+0x8 style ID ascending on equality. */
    const ranked_candidate *a = left, *b = right;
    if (a->score != b->score) return a->score > b->score ? -1 : 1;
    if (a->style_id != b->style_id) return a->style_id < b->style_id ? -1 : 1;
    return a->index == b->index ? 0 : a->index < b->index ? -1 : 1;
#endif
}

static int algorithm_group(am_algorithm algorithm) {
#ifdef TAE_AM_ASM
    return am_k_group(algorithm);
#else

    /* 0x227475f50: positive scores; algorithms<=3 preferred, otherwise
     * <=6, otherwise fallback>=7. Input API bounds recovered enum to0..7. */
    return algorithm <= AM_ALGORITHM_FILTERED ? 0 : algorithm <= AM_ALGORITHM_SOFT_SKIP ? 1 : 2;
#endif
}

static void selection_reset(am_selection_result *result) {
    memset(result, 0, sizeof(*result));
    result->preference_group = -1;
    result->chosen_index = SIZE_MAX;
}

void am_selection_result_free(am_selection_result *result) {
    if (!result) return;
    free(result->ranking_indices); free(result->preferred_indices); free(result->weights);
    selection_reset(result);
}

const char *am_selection_status_name(am_selection_status status) {
    static const char *const names[] = {
        "no_positive_candidate", "single_preferred_candidate", "zero_weight_first_candidate",
        "unresolved_native_seed", "weighted_native_modulo", "best_convenience",
        "invalid_input", "weight_overflow", "allocation_failure"
    };
    return status >= 0 && status < 9 ? names[status] : "unknown";
}

am_scoring_error am_select_candidates(const am_selection_candidate *candidates,
                                     size_t count, am_selection_mode mode,
                                     bool has_seed, uint64_t native_seed,
                                     am_selection_result *result) {
    if (!result) return AM_SCORING_INVALID_ARGUMENT;
    selection_reset(result);
    if ((count && !candidates) || (mode != AM_SELECT_NATIVE_WEIGHTED && mode != AM_SELECT_BEST)) {
        result->status = AM_SELECTION_INVALID_INPUT; return AM_SCORING_INVALID_ARGUMENT;
    }
    if (!count) return AM_SCORING_OK;
    if (count > SIZE_MAX / sizeof(ranked_candidate) || count > SIZE_MAX / sizeof(size_t) ||
        count > SIZE_MAX / sizeof(int64_t)) {
        result->status = AM_SELECTION_ALLOCATION_FAILURE; return AM_SCORING_OVERFLOW;
    }
    ranked_candidate *ranking = malloc(count * sizeof(*ranking));
    result->ranking_indices = malloc(count * sizeof(*result->ranking_indices));
    result->preferred_indices = malloc(count * sizeof(*result->preferred_indices));
    if (!ranking || !result->ranking_indices || !result->preferred_indices) {
        free(ranking); am_selection_result_free(result);
        result->status = AM_SELECTION_ALLOCATION_FAILURE; return AM_SCORING_OUT_OF_MEMORY;
    }
    size_t ranked_count = 0;
    for (size_t i = 0; i < count; ++i) {
        /* An unknown score is not a native candidate; do not invent a route for
         * catalogue-only IDs solely to carry unresolved diagnostics. */
        if (!candidates[i].score_known) { ++result->missing_score_count; continue; }
        if (!isfinite(candidates[i].score) || candidates[i].algorithm < 0 || candidates[i].algorithm >= 8) {
            free(ranking); am_selection_result_free(result);
            result->status = AM_SELECTION_INVALID_INPUT; return AM_SCORING_INVALID_ARGUMENT;
        }
        ranking[ranked_count++] = (ranked_candidate){i, candidates[i].score, candidates[i].style_id};
    }
#ifdef TAE_AM_ASM
    ranked_candidate *scratch = malloc(ranked_count * sizeof(*scratch));
    if (ranked_count && !scratch) {
        free(ranking); am_selection_result_free(result);
        result->status = AM_SELECTION_ALLOCATION_FAILURE; return AM_SCORING_OUT_OF_MEMORY;
    }
    _Static_assert(sizeof(ranked_candidate)==24, "ranked ABI");
    am_k_stable_sort(ranking, scratch, ranked_count);
    free(scratch);
#else
    qsort(ranking, ranked_count, sizeof(*ranking), ranking_compare);
#endif
    result->ranking_count = ranked_count;
    int group = 3;
    for (size_t i = 0; i < ranked_count; ++i) {
        const size_t index = ranking[i].index;
        result->ranking_indices[i] = index;
        if (candidates[index].score <= 0) { ++result->nonpositive_count; continue; }
        const int candidate_group = algorithm_group(candidates[index].algorithm);
        if (candidate_group < group) group = candidate_group;
    }
    if (group < 3) {
        result->preference_group = group;
        for (size_t i = 0; i < ranked_count; ++i) {
            const size_t index = ranking[i].index;
            if (candidates[index].score > 0 && algorithm_group(candidates[index].algorithm) == group)
                result->preferred_indices[result->preferred_count++] = index;
        }
    }
    free(ranking);
    if (!result->preferred_count) return AM_SCORING_OK;
    if (result->preferred_count == 1 || mode == AM_SELECT_BEST) {
        /* 0x227475b94..b98: count<2 bypasses weighting/seed lookup.
         * BEST for multiple candidates is the explicitly independent policy. */
        result->chosen_index = result->preferred_indices[0]; result->has_chosen = true;
        result->status = result->preferred_count == 1 ? AM_SELECTION_SINGLE_PREFERRED_CANDIDATE
                                                     : AM_SELECTION_BEST_CONVENIENCE;
        return AM_SCORING_OK;
    }
    result->weights = calloc(result->preferred_count, sizeof(*result->weights));
    if (!result->weights) {
        result->status = AM_SELECTION_ALLOCATION_FAILURE; return AM_SCORING_OUT_OF_MEMORY;
    }
    result->weights_evaluated = true;
    for (size_t i = 0; i < result->preferred_count; ++i) {
        const am_scoring_error error = am_native_score_weight(
            candidates[result->preferred_indices[i]].score, &result->weights[i]);
#ifdef TAE_AM_ASM
        const bool overflow = error != AM_SCORING_OK || am_k_add_weight(result->total_weight, result->weights[i], &result->total_weight) != 0;
#else
        const bool overflow = error != AM_SCORING_OK || result->weights[i] > INT64_MAX - result->total_weight;
#endif
        if (overflow) {
            free(result->weights); result->weights = NULL;
            result->weights_evaluated = false; result->total_weight = 0;
            result->status = AM_SELECTION_WEIGHT_OVERFLOW; return AM_SCORING_OVERFLOW;
        }
#ifndef TAE_AM_ASM
        result->total_weight += result->weights[i];
#endif
    }
    if (!result->total_weight) {
        /* 0x227476b50 ->0x227476cc0: zero sum falls back to first preferred. */
        result->has_chosen = true; result->chosen_index = result->preferred_indices[0];
        result->status = AM_SELECTION_ZERO_WEIGHT_FIRST_CANDIDATE; return AM_SCORING_OK;
    }
    if (!has_seed) { result->status = AM_SELECTION_UNRESOLVED_NATIVE_SEED; return AM_SCORING_OK; }
    (void)am_native_modulo_index(native_seed, result->total_weight, &result->draw);
    result->has_draw = true;
#ifdef TAE_AM_ASM
    const size_t picked = am_k_weighted_pick(result->weights, result->preferred_count, result->draw);
    if (picked < result->preferred_count) {
        result->chosen_index = result->preferred_indices[picked]; result->has_chosen = true;
    }
#else
    int64_t cumulative = 0;
    for (size_t i = 0; i < result->preferred_count; ++i) {
        cumulative += result->weights[i]; /* sum was checked above */
        /* 0x227476ba4..ba8: choose iff draw<cumulative; equality continues. */
        if (result->draw < (uint64_t)cumulative) {
            result->chosen_index = result->preferred_indices[i]; result->has_chosen = true; break;
        }
    }
#endif
    result->status = AM_SELECTION_WEIGHTED_NATIVE_MODULO;
    return AM_SCORING_OK;
}

static bool policy_gate_valid(am_gate_result gate) {
    return gate == AM_GATE_UNKNOWN || gate == AM_GATE_FALSE || gate == AM_GATE_TRUE;
}

am_scoring_error am_policy_baseline_score(int64_t style_id,
                                        am_gate_result tempo_gate,
                                        am_gate_result key_gate, bool key_required,
                                        double unknown_factor, double outgoing_end,
                                        double incoming_end, am_score_result *result) {
    if (!result || !policy_gate_valid(tempo_gate) || !policy_gate_valid(key_gate) ||
        !isfinite(unknown_factor) || unknown_factor < 0 || unknown_factor > 1 ||
        !isfinite(outgoing_end) || !isfinite(incoming_end)) return AM_SCORING_INVALID_ARGUMENT;
    memset(result, 0, sizeof(*result));
    const am_style_route route = am_default_route(style_id);
    if (!route.default_generated) {
        result->status = AM_SCORE_UNSUPPORTED_PATH; return AM_SCORING_UNSUPPORTED;
    }
    result->base = route.base_score;
    result->reason = "Independent region-independent planner policy; not recovered Apple generation/ML";
    if (route.algorithm <= AM_ALGORITHM_FILTERED || route.algorithm == AM_ALGORITHM_SOFT_SKIP)
        add_factor(result, "independent_tempo_gate", tempo_gate == AM_GATE_UNKNOWN ? unknown_factor
                   : tempo_gate == AM_GATE_TRUE ? 1 : 0);
    if (key_required)
        add_factor(result, "independent_key_gate", key_gate == AM_GATE_UNKNOWN ? unknown_factor
                   : key_gate == AM_GATE_TRUE ? 1 : 0);
    finish_score(result, outgoing_end, incoming_end, true);
    return AM_SCORING_OK;
}
