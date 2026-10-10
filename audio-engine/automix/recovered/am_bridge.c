#include "am_bridge.h"
#include "am_analysis.h"
#include "am_scoring.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Native schema/addresses were recovered from this machine's AutoMix image;
 * analysis_bridge.py is a reference implementation, not an executed dependency.
 * Ordinary PCM-derived beat positions and continuous model features are never
 * promoted to native Song indexes, vocal categories, or aligned windows here.
 */
typedef struct { int oom; } json_context;
typedef struct {
    am_map_state structure_state, events_state, stable_state, vocal_state, loud_state;
    am_event *events; size_t event_count;
    am_stability_region *stable; size_t stable_count;
    am_vocal_interval *vocal; size_t vocal_count;
    am_loudness_sample *loud; size_t loud_count;
    const char *vocal_source, *loud_source;
    am_tonality key;
    am_double_query melodicness;
} track_queries;

static const am_json *get(const am_json *value, const char *name) {
    return am_jget(value, name);
}
static const am_json *get_alias(const am_json *value, const char *name, const char *camel) {
    const am_json *item = get(value, name);
    return item ? item : get(value, camel);
}
static int number(const am_json *value, double *out) {
    if (!value || value->type != AM_JNUMBER || !isfinite(value->number)) return 0;
    *out = value->number; return 1;
}
static int native_index(const am_json *value, int64_t *out) {
    double x;
    /* am_json stores doubles. Beyond this bound source integer identity is not
     * recoverable, even when an individual large even value is representable. */
    if (!number(value, &x) || x < 0 || x > 9007199254740991.0 || floor(x) != x) return 0;
    *out = (int64_t)x; return 1;
}
static am_json *object(json_context *ctx) {
    am_json *result = am_jobject(); if (!result) ctx->oom = 1; return result;
}
static am_json *array(json_context *ctx) {
    am_json *result = am_jarray(); if (!result) ctx->oom = 1; return result;
}
static void put(json_context *ctx, am_json *parent, const char *name, am_json *value) {
    if (!value || !parent || am_jset(parent, name, value) != 0) {
        am_json_free(value); ctx->oom = 1;
    }
}
static void append(json_context *ctx, am_json *parent, am_json *value) {
    if (!value || !parent || am_jappend(parent, value) != 0) {
        am_json_free(value); ctx->oom = 1;
    }
}
static void text_field(json_context *ctx, am_json *parent, const char *name, const char *text) {
    put(ctx, parent, name, am_jstring(text));
}
static void remove_field(am_json *parent, const char *name) {
    if (!parent || parent->type != AM_JOBJECT) return;
    for (size_t i = 0; i < parent->count; ++i) {
        if (strcmp(parent->keys[i], name) != 0) continue;
        free(parent->keys[i]); am_json_free(parent->items[i]);
        size_t remaining = parent->count - i - 1;
        if (remaining) {
            memmove(parent->keys + i, parent->keys + i + 1, remaining * sizeof(*parent->keys));
            memmove(parent->items + i, parent->items + i + 1, remaining * sizeof(*parent->items));
        }
        --parent->count; return;
    }
}
static const char *query_status(am_query_state state) {
    return state == AM_QUERY_VALUE ? "queried" : state == AM_QUERY_NIL ? "native_optional_nil" : "missing_input";
}
static const char *map_status(am_map_state state) {
    return state == AM_MAP_PRESENT ? "present" : state == AM_MAP_NIL ? "native_nil" : "unavailable";
}
static am_json *int_value(am_int_query query) {
    return query.state == AM_QUERY_VALUE ? am_jnumber((double)query.value) : am_jnull();
}
static am_json *double_value(am_double_query query) {
    return query.state == AM_QUERY_VALUE ? am_jnumber(query.value) : am_jnull();
}
static am_json *window_value(json_context *ctx, double start, double end) {
    am_json *result = array(ctx);
    append(ctx, result, am_jnumber(start)); append(ctx, result, am_jnumber(end));
    return result;
}
static am_json *double_detail(json_context *ctx, am_double_query query, const char *label) {
    am_json *result = object(ctx);
    text_field(ctx, result, "status", query_status(query.state));
    put(ctx, result, "available", am_jbool(query.state != AM_QUERY_MISSING));
    put(ctx, result, label, double_value(query)); return result;
}
static am_json *vocal_detail(json_context *ctx, am_int_query query, const track_queries *track) {
    am_json *result = object(ctx);
    text_field(ctx, result, "status", query.state == AM_QUERY_VALUE && query.value == 5
               ? "native_missing_byte_5_no_hits" : query_status(query.state));
    put(ctx, result, "available", am_jbool(query.state != AM_QUERY_MISSING));
    put(ctx, result, "strength", int_value(query));
    text_field(ctx, result, "map_state", map_status(track->vocal_state));
    text_field(ctx, result, "source", track->vocal_source); return result;
}
static am_json *loud_detail(json_context *ctx, am_loudness_query query, const track_queries *track) {
    am_json *result = object(ctx);
    text_field(ctx, result, "status", query_status(query.state));
    put(ctx, result, "available", am_jbool(query.state != AM_QUERY_MISSING));
    put(ctx, result, "map_available", query.map_state == AM_MAP_UNKNOWN ? am_jnull()
        : am_jbool(query.map_state == AM_MAP_PRESENT));
    put(ctx, result, "mean", query.state == AM_QUERY_VALUE ? am_jnumber(query.mean) : am_jnull());
    put(ctx, result, "sample_count", am_jnumber((double)query.sample_count));
    text_field(ctx, result, "source", track->loud_source); return result;
}

static am_event parse_event(const am_json *value) {
    am_event result = {0};
    result.has_time = number(get_alias(value, "time", "song_time"), &result.time);
    static const char *const names[] = {"beat_index", "downbeat_index", "segment_index", "section_index"};
    static const char *const aliases[] = {"beatIndex", "downbeatIndex", "segmentIndex", "sectionIndex"};
    int64_t *indexes[] = {&result.beat_index, &result.downbeat_index, &result.segment_index, &result.section_index};
    for (unsigned i = 0; i < 4; ++i)
        if (native_index(get_alias(value, names[i], aliases[i]), indexes[i])) result.index_mask |= 1u << i;
    return result;
}
static int parse_window(const am_json *value, double *start, double *end, int nonnegative) {
    return value && value->type == AM_JARRAY && value->count == 2
        && number(value->items[0], start) && number(value->items[1], end)
        && (!nonnegative || *start >= 0) && *end >= *start;
}
static am_native_range parse_range(const am_json *value) {
    am_native_range result = {0};
    result.start_event = parse_event(get(value, "start_event"));
    result.end_event = parse_event(get(value, "end_event"));
    result.has_source_range = parse_window(get(value, "source_range"), &result.source_start, &result.source_end, 1);
    return result;
}
static void *records(json_context *ctx, size_t count, size_t size) {
    if (!count) return NULL;
    if (count > SIZE_MAX / size) { ctx->oom = 1; return NULL; }
    void *result = calloc(count, size); if (!result) ctx->oom = 1; return result;
}
static am_double_query parse_optional_number(const am_json *value) {
    am_double_query result = {AM_QUERY_MISSING, 0};
    if (value && value->type == AM_JNULL) result.state = AM_QUERY_NIL;
    else if (number(value, &result.value)) result.state = AM_QUERY_VALUE;
    return result;
}
static am_tonality parse_key(const am_json *native) {
    am_tonality result = {AM_MAP_UNKNOWN, 0, AM_ANALYSIS_KEY_MAJOR};
    const am_json *tonality = get(native, "tonality");
    if (tonality && tonality->type == AM_JNULL) { result.state = AM_MAP_NIL; return result; }
    const am_json *main = get(tonality, "main");
    int64_t tonic;
    const char *mode = am_jstr(get(main, "mode"), "");
    if (!native_index(get(main, "tonic"), &tonic) || tonic > 11) return result;
    if (strcmp(mode, "major") == 0) result.mode = AM_ANALYSIS_KEY_MAJOR;
    else if (strcmp(mode, "minor") == 0) result.mode = AM_ANALYSIS_KEY_MINOR;
    else if (strcmp(mode, "neutral") == 0) result.mode = AM_ANALYSIS_KEY_NEUTRAL;
    else return result;
    result.tonic = (int)tonic; result.state = AM_MAP_PRESENT; return result;
}
static unsigned parse_strength(const am_json *value, int *known) {
    static const char *const labels[] = {"veryLow", "low", "medium", "high", "veryHigh"};
    int64_t code;
    *known = 0;
    if (native_index(value, &code) && code <= 4) { *known = 1; return (unsigned)code; }
    if (value && value->type == AM_JSTRING)
        for (unsigned i = 0; i < 5; ++i)
            if (strcmp(value->string, labels[i]) == 0) { *known = 1; return i; }
    return 0;
}
static void parse_track(json_context *ctx, const am_json *track, track_queries *result) {
    memset(result, 0, sizeof(*result));
    const am_json *native = get(track, "native_analysis");
    const am_json *structure = get(native, "structure");
    result->structure_state = !structure ? AM_MAP_UNKNOWN : structure->type == AM_JNULL
        ? AM_MAP_NIL : structure->type == AM_JOBJECT ? AM_MAP_PRESENT : AM_MAP_UNKNOWN;
    const am_json *events = get(structure, "events");
    if (events && events->type == AM_JARRAY) {
        result->events_state = AM_MAP_PRESENT; result->event_count = events->count;
        result->events = records(ctx, events->count, sizeof(*result->events));
        if (ctx->oom) return;
        for (size_t i = 0; i < events->count; ++i) result->events[i] = parse_event(events->items[i]);
    }
    const am_json *stable = get(structure, "beat_stability_regions");
    if (stable && stable->type == AM_JARRAY) {
        result->stable_state = AM_MAP_PRESENT; result->stable_count = stable->count;
        result->stable = records(ctx, stable->count, sizeof(*result->stable));
        if (ctx->oom) return;
        for (size_t i = 0; i < stable->count; ++i) {
            am_stability_region *record = result->stable + i;
            const am_json *value = stable->items[i];
            record->range = parse_range(value);
            native_index(get(value, "beats_per_bar"), &record->beats_per_bar);
            const am_json *average = get(value, "average_tempo");
            if (average) {
                if (average->type == AM_JOBJECT) average = get(average, "bpm");
                record->average_tempo = parse_optional_number(average);
                /* An explicitly invalid average is not permission to substitute
                 * a recomputed tempo. VALUE+NaN makes the native query unresolved. */
                if (record->average_tempo.state == AM_QUERY_MISSING)
                    record->average_tempo = (am_double_query){AM_QUERY_VALUE, NAN};
            }
        }
    }
    const am_json *vocal = get(native, "vocal_activity_map");
    result->vocal_source = "native_analysis.vocal_activity_map";
    if (!vocal) { vocal = get(track, "vocal_intervals"); result->vocal_source = "supplied canonical vocal_intervals"; }
    else if (vocal->type == AM_JNULL) result->vocal_state = AM_MAP_NIL;
    if (vocal && vocal->type == AM_JARRAY) {
        result->vocal_state = AM_MAP_PRESENT; result->vocal_count = vocal->count;
        result->vocal = records(ctx, vocal->count, sizeof(*result->vocal));
        if (ctx->oom) return;
        for (size_t i = 0; i < vocal->count; ++i) {
            am_vocal_interval *record = result->vocal + i;
            const am_json *value = vocal->items[i];
            record->has_time = number(get(value, "start"), &record->start)
                && number(get(value, "end"), &record->end);
            record->strength = parse_strength(get_alias(value, "strength_code", "strength"), &record->has_strength);
        }
    }
    const am_json *loud_map = get(native, "loudness_map");
    const am_json *loud;
    result->loud_source = "native_analysis.loudness_map";
    if (loud_map) {
        if (loud_map->type == AM_JNULL) result->loud_state = AM_MAP_NIL;
        loud = get(loud_map, "samples");
    } else {
        loud = get(track, "loudness_curve"); result->loud_source = "supplied canonical loudness_curve";
    }
    if (loud && loud->type == AM_JARRAY) {
        result->loud_state = AM_MAP_PRESENT; result->loud_count = loud->count;
        result->loud = records(ctx, loud->count, sizeof(*result->loud));
        if (ctx->oom) return;
        for (size_t i = 0; i < loud->count; ++i) {
            am_loudness_sample *record = result->loud + i;
            const am_json *value = loud->items[i];
            record->has_time = number(get(value, "time"), &record->time);
            record->has_value = number(get(value, "value"), &record->value);
        }
    }
    result->key = parse_key(native);
    const am_json *attributes = get(native, "scalar_attributes");
    result->melodicness = parse_optional_number(get(get(attributes, "melodicness"), "main"));
}
static void free_track(track_queries *track) {
    free(track->events); free(track->stable); free(track->vocal); free(track->loud);
}
static am_int_query lower_downbeat(const am_native_range *range) {
    am_int_query result = {AM_QUERY_MISSING, 0};
    if (range->has_source_range && (range->start_event.index_mask & AM_INDEX_DOWNBEAT)) {
        result.state = AM_QUERY_VALUE; result.value = range->start_event.downbeat_index;
    }
    return result;
}
static uint64_t required_signals(am_candidate_path path, int64_t style) {
    const uint64_t strict = AM_SIGNAL_BIT(AM_SIGNAL_STRICT_TEMPO);
    const uint64_t bars = AM_SIGNAL_BIT(AM_SIGNAL_MATCHING_BAR_COUNT);
    const uint64_t beats = AM_SIGNAL_BIT(AM_SIGNAL_OUTGOING_BEAT_COUNT)
        | AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_BEAT_COUNT) | AM_SIGNAL_BIT(AM_SIGNAL_TEMPO_ALIAS);
    switch (path) {
        case AM_PATH_DANCE_ORIGINAL: return strict | bars;
        case AM_PATH_DANCE_SHIFTED: return strict | bars | AM_SIGNAL_BIT(AM_SIGNAL_TONALITIES_COMPATIBLE);
        case AM_PATH_FILTERED_DIRECT:
            return style == 9 ? strict | bars | AM_SIGNAL_BIT(AM_SIGNAL_TONALITIES_COMPATIBLE)
                | AM_SIGNAL_BIT(AM_SIGNAL_VOCAL_OVERLAP_INCOMPATIBLE)
                : strict | AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_BEAT_COUNT) | AM_SIGNAL_BIT(AM_SIGNAL_TEMPO_ALIAS);
        case AM_PATH_FILTERED_SHIFTED: return strict | bars | AM_SIGNAL_BIT(AM_SIGNAL_LOOSE_TEMPO);
        case AM_PATH_HIPHOP_DIRECT: case AM_PATH_HIPHOP_SHIFTED: return beats;
        case AM_PATH_POP_SCALED_SHIFTED: return beats | AM_SIGNAL_BIT(AM_SIGNAL_OUTGOING_LOUDNESS_SIGNIFICANT);
        case AM_PATH_SMART_CROSSFADE: return AM_SIGNAL_BIT(AM_SIGNAL_INCOMING_LOUDNESS_RELATION_CODE)
            | AM_SIGNAL_BIT(AM_SIGNAL_TRAILING_SPAN_SECONDS);
        default: return 0;
    }
}
static int allowed_signal(const char *name) {
    static const char *const allowed[] = {
        "strict_tempo_compatible", "loose_tempo_compatible", "tonalities_compatible",
        "incoming_leading_strength", "incoming_region_loudness", "incoming_trailing_loudness",
        "outgoing_loudness_significant", "vocal_overlap_incompatible",
        "incoming_loudness_relation_code", "trailing_span_seconds"
    };
    for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); ++i)
        if (strcmp(name, allowed[i]) == 0) return 1;
    return 0;
}
static am_json *sources(json_context *ctx) {
    static const struct { const char *name; const char *addresses[3]; } entries[] = {
        {"matching_bar_count", {"0x22745c4a0", "0x227462334", "0x227434fe4"}},
        {"index_getters", {"0x22743400c", "0x22743407c", NULL}},
        {"local_tempo", {"0x227435210", "0x227435328", NULL}},
        {"stable_tempo", {"0x227435e80", "0x227436194", "0x2274362b8"}},
        {"leading_window", {"0x227452d34", "0x227452e30", "0x227453008"}},
        {"vocal_query", {"0x227442408", "0x227472578", NULL}},
        {"loudness_query", {"0x227432e4c", "0x227432ee4", NULL}},
        {"trailing_loudness", {"0x2274533c8", "0x227453970", NULL}},
        {"outgoing_loudness", {"0x227453034", NULL, NULL}},
        {"vocal_overlap", {"0x227462b2c", "0x2274426d4", NULL}},
        {"tempo_relationship", {"0x227438348", "0x227437fe4", NULL}}
    };
    am_json *result = object(ctx);
    for (size_t i = 0; i < sizeof(entries) / sizeof(entries[0]); ++i) {
        am_json *values = array(ctx);
        for (size_t j = 0; j < 3 && entries[i].addresses[j]; ++j)
            append(ctx, values, am_jstring(entries[i].addresses[j]));
        put(ctx, result, entries[i].name, values);
    }
    return result;
}

am_json *am_bridge_candidate_signals(const am_json *outgoing, const am_json *incoming,
                                     const char *path_name, int64_t style_id,
                                     const am_json *regions, char *error, size_t cap) {
    if (error && cap) error[0] = '\0';
    const char *failure = NULL;
    am_candidate_path path = am_path_from_name(path_name);
    am_style_route route = am_default_route(style_id);
    if (path == AM_PATH_UNKNOWN || !route.default_generated || route.path != path) {
        if (error && cap) snprintf(error, cap, "Unconfirmed native path/style pair");
        return NULL;
    }
    if (!regions || regions->type != AM_JOBJECT) {
        if (error && cap) snprintf(error, cap, "regions must be an object");
        return NULL;
    }
    const am_json *supplied = get(regions, "native_signals");
    if (supplied && supplied->type != AM_JOBJECT) {
        if (error && cap) snprintf(error, cap, "native_signals must be an object");
        return NULL;
    }
    const am_json *explicit_alias = get(regions, "tempo_alias");
    double alias_number = 0;
    if (explicit_alias && (!number(explicit_alias, &alias_number)
        || (alias_number != 0.5 && alias_number != 1 && alias_number != 2))) {
        if (error && cap) snprintf(error, cap, "Explicit native tempo_alias must be 0.5, 1 or 2");
        return NULL;
    }
    const am_json *target = get(regions, "target_bar_count");
    double target_number = 0;
    if (target && (!number(target, &target_number) || target_number <= 0)) {
        if (error && cap) snprintf(error, cap, "target_bar_count must be positive and finite");
        return NULL;
    }

    json_context ctx = {0};
    am_json *result = object(&ctx), *signals = object(&ctx), *details = object(&ctx);
    am_json *provenance = object(&ctx), *missing = array(&ctx), *optional = array(&ctx);
    track_queries out = {0}, in = {0};
    if (ctx.oom) goto cleanup;
    parse_track(&ctx, outgoing, &out); parse_track(&ctx, incoming, &in);
    if (ctx.oom) goto cleanup;
    am_native_range out_range = parse_range(get(regions, "outgoing"));
    am_native_range in_range = parse_range(get(regions, "incoming"));

    /* 0x22743400c/43407c: endpoint indexes, not event-array counts. */
    am_int_query out_beats = am_native_region_count(&out_range, AM_INDEX_BEAT);
    am_int_query in_beats = am_native_region_count(&in_range, AM_INDEX_BEAT);
    if (out_beats.state == AM_QUERY_VALUE) put(&ctx, signals, "outgoing_beat_count", int_value(out_beats));
    if (in_beats.state == AM_QUERY_VALUE) put(&ctx, signals, "incoming_beat_count", int_value(in_beats));
    am_double_query out_tempo = am_tempo_for_downbeat(out.stable, out.stable_count, out.stable_state, lower_downbeat(&out_range));
    am_double_query in_tempo = am_tempo_for_downbeat(in.stable, in.stable_count, in.stable_state, lower_downbeat(&in_range));
    put(&ctx, details, "outgoing_tempo", double_detail(&ctx, out_tempo, "tempo"));
    put(&ctx, details, "incoming_tempo", double_detail(&ctx, in_tempo, "tempo"));
    am_double_query alias = am_tempo_alias(out_tempo, in_tempo);
    if (alias.state == AM_QUERY_VALUE) {
        am_int_query strict = am_tempo_compatible(out_tempo, in_tempo, 0.16);
        am_int_query loose = am_tempo_compatible(out_tempo, in_tempo, 0.287);
        put(&ctx, signals, "tempo_alias", double_value(alias));
        if (strict.state == AM_QUERY_VALUE) put(&ctx, signals, "strict_tempo_compatible", am_jbool(strict.value != 0));
        if (loose.state == AM_QUERY_VALUE) put(&ctx, signals, "loose_tempo_compatible", am_jbool(loose.value != 0));
        am_json *relationship = object(&ctx);
        put(&ctx, relationship, "alias", double_value(alias));
        put(&ctx, relationship, "log_distance", am_jnumber(fabs(log(in_tempo.value) + log(alias.value) - log(out_tempo.value))));
        put(&ctx, relationship, "strict_threshold", am_jnumber(0.16));
        put(&ctx, relationship, "loose_threshold", am_jnumber(0.287));
        text_field(&ctx, relationship, "tie_rule", "first minimal distance in half/one/two order");
        put(&ctx, details, "tempo_relationship", relationship);
    }
    if (explicit_alias) {
        alias = (am_double_query){AM_QUERY_VALUE, alias_number};
        put(&ctx, signals, "tempo_alias", double_value(alias));
        text_field(&ctx, details, "tempo_alias", "explicit native candidate parameter; compatibility still uses queried tempos");
    }
    am_int_query matched = am_matching_bar_count(&out_range, &in_range, alias);
    put(&ctx, signals, "matching_bar_count_available", am_jbool(matched.state != AM_QUERY_MISSING));
    if (matched.state != AM_QUERY_MISSING) put(&ctx, signals, "matching_bar_count", int_value(matched));
    am_json *bars = object(&ctx);
    text_field(&ctx, bars, "status", matched.state == AM_QUERY_VALUE ? "matched"
               : matched.state == AM_QUERY_NIL ? "native_optional_nil_counts_unequal" : "missing_native_indexes_or_alias");
    put(&ctx, bars, "available", am_jbool(matched.state != AM_QUERY_MISSING));
    put(&ctx, bars, "count", int_value(matched));
    am_int_query out_bars = am_native_region_count(&out_range, AM_INDEX_DOWNBEAT);
    am_int_query in_bars = am_native_region_count(&in_range, AM_INDEX_DOWNBEAT);
    put(&ctx, bars, "outgoing", int_value(out_bars)); put(&ctx, bars, "incoming", int_value(in_bars));
    am_int_query normalized = {AM_QUERY_MISSING, 0};
    if (in_bars.state == AM_QUERY_VALUE && alias.state == AM_QUERY_VALUE) {
        normalized.state = AM_QUERY_VALUE;
        normalized.value = alias.value == 0.5 ? in_bars.value / 2 : alias.value == 2 ? in_bars.value * 2 : in_bars.value;
    }
    put(&ctx, bars, "normalized_incoming", int_value(normalized)); put(&ctx, details, "matching_bars", bars);

    am_int_query keys = am_analysis_key_gate(out.key, in.key, path == AM_PATH_DANCE_SHIFTED, out.melodicness, in.melodicness);
    if (keys.state == AM_QUERY_VALUE) put(&ctx, signals, "tonalities_compatible", am_jbool(keys.value != 0));
    am_json *key_detail = object(&ctx);
    text_field(&ctx, key_detail, "status", query_status(keys.state));
    text_field(&ctx, key_detail, "outgoing_state", map_status(out.key.state));
    text_field(&ctx, key_detail, "incoming_state", map_status(in.key.state));
    put(&ctx, key_detail, "identical_only", am_jbool(path == AM_PATH_DANCE_SHIFTED));
    text_field(&ctx, key_detail, "melodicness", "explicit scalar_attributes.melodicness.main; unavailable relaxation remains unknown");
    put(&ctx, details, "key", key_detail);

    /* 0x227452d34: the window is [0,time(beat(lowerBeatIndex-4))]. */
    am_window_query leading = am_leading_vocal_window(in.events, in.event_count, in.events_state, &in_range);
    am_json *leading_detail = object(&ctx);
    text_field(&ctx, leading_detail, "status", leading.state == AM_QUERY_NIL ? "native_optional_nil_no_preceding_beat" : query_status(leading.state));
    put(&ctx, leading_detail, "available", am_jbool(leading.state != AM_QUERY_MISSING));
    put(&ctx, leading_detail, "window", leading.state == AM_QUERY_VALUE
        ? window_value(&ctx, leading.start, leading.end) : am_jnull());
    if (in_range.start_event.index_mask & AM_INDEX_BEAT)
        put(&ctx, leading_detail, "target_beat_index", am_jnumber((double)(in_range.start_event.beat_index - 4)));
    put(&ctx, details, "leading_window", leading_detail);
    am_int_query leading_strength = {AM_QUERY_MISSING, 0};
    put(&ctx, signals, "incoming_leading_strength", am_jnull());
    if (leading.state == AM_QUERY_VALUE) {
        leading_strength = am_query_vocal_strength(in.vocal, in.vocal_count, in.vocal_state, leading.start, leading.end);
        if (leading_strength.state == AM_QUERY_VALUE && leading_strength.value != 5)
            put(&ctx, signals, "incoming_leading_strength", int_value(leading_strength));
        put(&ctx, details, "leading_vocal_query", vocal_detail(&ctx, leading_strength, &in));
    }

    put(&ctx, signals, "incoming_region_loudness", am_jnull());
    put(&ctx, signals, "incoming_trailing_loudness", am_jnull());
    am_loudness_query incoming_loud[2] = {
        {AM_QUERY_MISSING, in.loud_state, 0, 0}, {AM_QUERY_MISSING, in.loud_state, 0, 0}
    };
    double loud_windows[2][2];
    if (in_range.has_source_range && am_loudness_windows(in_range.source_start, in_range.source_end, path, style_id, loud_windows) == AM_SCORING_OK) {
        am_json *incoming_detail = object(&ctx), *windows = array(&ctx);
        const char *const labels[] = {"region", "trailing"};
        const char *const names[] = {"incoming_region_loudness", "incoming_trailing_loudness"};
        for (size_t i = 0; i < 2; ++i) {
            incoming_loud[i] = am_query_loudness(in.loud, in.loud_count, in.loud_state, loud_windows[i][0], loud_windows[i][1]);
            if (incoming_loud[i].state == AM_QUERY_VALUE) put(&ctx, signals, names[i], am_jnumber(incoming_loud[i].mean));
            append(&ctx, windows, window_value(&ctx, loud_windows[i][0], loud_windows[i][1]));
            put(&ctx, incoming_detail, labels[i], loud_detail(&ctx, incoming_loud[i], &in));
        }
        put(&ctx, incoming_detail, "windows", windows);
        text_field(&ctx, incoming_detail, "bounds", "native windows are not clipped; closed sample selection without interpolation");
        put(&ctx, details, "incoming_loudness", incoming_detail);
    }
    if (out_range.has_source_range) {
        am_loudness_query query = am_query_loudness(out.loud, out.loud_count, out.loud_state, out_range.source_start, out_range.source_end);
        put(&ctx, details, "outgoing_loudness", loud_detail(&ctx, query, &out));
        am_int_query significant = am_analysis_outgoing_loudness_significant(query);
        if (significant.state == AM_QUERY_VALUE)
            put(&ctx, signals, "outgoing_loudness_significant", am_jbool(significant.value != 0));
    }

    /* 0x227462b2c nil branch precedes native alignment/query construction. */
    const am_json *aligned = get(regions, "aligned_vocal_windows");
    if (out.structure_state == AM_MAP_NIL || in.structure_state == AM_MAP_NIL
        || out.vocal_state == AM_MAP_NIL || in.vocal_state == AM_MAP_NIL) {
        put(&ctx, signals, "vocal_overlap_incompatible", am_jbool(1));
        am_json *overlap = object(&ctx);
        text_field(&ctx, overlap, "status", "confirmed_missing_native_structure_or_map_branch");
        text_field(&ctx, overlap, "source", "0x227462b2c"); put(&ctx, details, "vocal_overlap", overlap);
    } else if (aligned && aligned->type == AM_JOBJECT) {
        const am_json *out_windows = get(aligned, "outgoing"), *in_windows = get(aligned, "incoming");
        am_json *overlap = object(&ctx);
        if (!out_windows || !in_windows || out_windows->type != AM_JARRAY
            || in_windows->type != AM_JARRAY || out_windows->count != in_windows->count) {
            text_field(&ctx, overlap, "status", "unresolved_alignment_shape_or_unequal_lengths");
        } else {
            size_t n = out_windows->count;
            am_int_query *a = records(&ctx, n, sizeof(*a)), *b = records(&ctx, n, sizeof(*b));
            if (ctx.oom) { free(a); free(b); am_json_free(overlap); goto cleanup; }
            am_json *query_sides = array(&ctx);
            for (unsigned side = 0; side < 2; ++side) {
                const track_queries *track = side ? &in : &out;
                const am_json *side_windows = side ? in_windows : out_windows;
                am_int_query *queries = side ? b : a;
                am_json *side_details = array(&ctx);
                for (size_t i = 0; i < n; ++i) {
                    double start, end;
                    if (!parse_window(side_windows->items[i], &start, &end, 0)) {
                        failure = "Aligned vocal window must be [finite start,end] with end >= start";
                        am_json_free(side_details); am_json_free(query_sides); am_json_free(overlap);
                        free(a); free(b); goto cleanup;
                    }
                    queries[i] = am_query_vocal_strength(track->vocal, track->vocal_count, track->vocal_state, start, end);
                    append(&ctx, side_details, vocal_detail(&ctx, queries[i], track));
                }
                append(&ctx, query_sides, side_details);
            }
            am_int_query value = am_aligned_vocal_overlap(a, n, b, n, AM_MAP_PRESENT);
            if (value.state == AM_QUERY_VALUE) put(&ctx, signals, "vocal_overlap_incompatible", am_jbool(value.value != 0));
            text_field(&ctx, overlap, "status", value.state == AM_QUERY_VALUE ? "queried" : "unresolved_vocal_query");
            text_field(&ctx, overlap, "window_alignment", "explicitly supplied native alignment; equal-length arrays only");
            put(&ctx, overlap, "queries", query_sides); free(a); free(b);
        }
        put(&ctx, details, "vocal_overlap", overlap);
    }

    if (supplied && supplied->count) {
        am_json *supplied_detail = object(&ctx), *fields = array(&ctx), *ignored = array(&ctx);
        for (size_t i = 0; i < supplied->count; ++i) {
            const char *name = supplied->keys[i];
            if (allowed_signal(name)) {
                put(&ctx, signals, name, am_json_clone(supplied->items[i])); append(&ctx, fields, am_jstring(name));
            } else append(&ctx, ignored, am_jstring(name));
        }
        put(&ctx, supplied_detail, "fields", fields); put(&ctx, supplied_detail, "ignored_fields", ignored);
        const am_json *caller = get(regions, "native_signal_provenance");
        put(&ctx, supplied_detail, "provenance", caller ? am_json_clone(caller) : am_jstring("caller asserted native query results"));
        put(&ctx, details, "supplied_native_signals", supplied_detail);
    }
    if (target) put(&ctx, signals, "target_bar_count", am_jnumber(target_number));
    uint64_t required = required_signals(path, style_id);
    for (unsigned i = 0; i < AM_SIGNAL_COUNT; ++i) {
        if (!(required & AM_SIGNAL_BIT(i))) continue;
        const char *name = am_signal_name((am_signal_id)i);
        const am_json *value = get(signals, name);
        if (!value || (value->type == AM_JNULL && i != AM_SIGNAL_MATCHING_BAR_COUNT)) {
            append(&ctx, missing, am_jstring(name)); remove_field(signals, name);
        }
    }
    /* Explicit caller query results resolve optional unknowns; original query
     * availability remains visible in provenance.queries, even when overridden. */
    if ((leading.state == AM_QUERY_MISSING || (leading.state == AM_QUERY_VALUE && leading_strength.state == AM_QUERY_MISSING))
        && !get(supplied, "incoming_leading_strength")) append(&ctx, optional, am_jstring("incoming_leading_strength"));
    const char *const loud_names[] = {"incoming_region_loudness", "incoming_trailing_loudness"};
    for (size_t i = 0; i < 2; ++i)
        if ((!in_range.has_source_range || (incoming_loud[i].state == AM_QUERY_MISSING && incoming_loud[i].map_state != AM_MAP_NIL))
            && !get(supplied, loud_names[i])) append(&ctx, optional, am_jstring(loud_names[i]));
    text_field(&ctx, provenance, "method", "independent C implementation of recovered native query operators");
    put(&ctx, provenance, "sources", sources(&ctx));
    text_field(&ctx, provenance, "native_indexes", "explicit exact endpoint values only; no array-length reconstruction; JSON integers <= 2^53-1");
    text_field(&ctx, provenance, "stability_runs", "explicit native beat_stability_regions required; recovered final-bar constructor is separately exposed by am_analysis");
    text_field(&ctx, provenance, "smart_relationship", "native query/window generation unresolved; explicit native_signals required");
    text_field(&ctx, provenance, "execution", "bridge performs JSON parsing and recovered arithmetic only; no model/audio/native private function");
    put(&ctx, provenance, "queries", details); details = NULL;
    put(&ctx, provenance, "optional_unresolved_inputs", optional); optional = NULL;
    put(&ctx, result, "signals", signals); signals = NULL;
    put(&ctx, result, "missing_inputs", missing); missing = NULL;
    put(&ctx, result, "provenance", provenance); provenance = NULL;

cleanup:
    free_track(&out); free_track(&in);
    am_json_free(signals); am_json_free(details); am_json_free(provenance);
    am_json_free(missing); am_json_free(optional);
    if (ctx.oom || failure) {
        if (error && cap) snprintf(error, cap, "%s", failure ? failure : "Cannot allocate candidate bridge result");
        am_json_free(result); return NULL;
    }
    return result;
}
