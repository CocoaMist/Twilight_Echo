#include "am_analysis.h"

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Recovered sources and formula details are retained in the prototype's
 * evidence/v4-stability-final and evidence/v4-analysis-bridge inventories.
 * This is independently written C; no Apple private function is called. */

static int fail(char *error, size_t capacity, const char *message, size_t position) {
    if (error && capacity) snprintf(error, capacity, "%s at record %zu", message, position);
    return -1;
}
static am_int_query iq(am_query_state state, int64_t value) {
    am_int_query result = {state, value}; return result;
}
static am_double_query dq(am_query_state state, double value) {
    am_double_query result = {state, value}; return result;
}
static am_window_query wq(am_query_state state, double start, double end) {
    am_window_query result = {state, start, end}; return result;
}
static double round_ms(double value) { return nearbyint(value * 1000.0) / 1000.0; }
static int valid_range(const am_native_range *range) {
    return range && range->has_source_range && isfinite(range->source_start)
        && isfinite(range->source_end) && range->source_start >= 0
        && range->source_end >= range->source_start;
}
static int64_t event_index(const am_event *event, unsigned kind) {
    if (kind == AM_INDEX_BEAT) return event->beat_index;
    if (kind == AM_INDEX_DOWNBEAT) return event->downbeat_index;
    if (kind == AM_INDEX_SEGMENT) return event->segment_index;
    return event->section_index;
}
static int has_index(const am_event *event, unsigned kind) {
    return event && (event->index_mask & kind) && event_index(event, kind) >= 0;
}

/* 0x22744b834: every recognized rank advances beat; rank>=1/2/3 advances
 * downbeat/segment/section. Source order and cumulative higher indexes persist.
 * Native 0x22743aba8 relabeling and 0x22743b418 final endpoints are not implied. */
int am_rebuild_flex_indexes(const am_event *src, size_t count, am_event *dst,
                           char *error, size_t error_capacity) {
    int64_t counters[4] = {-1, -1, -1, -1};
    if (count && (!src || !dst)) return fail(error, error_capacity, "missing ordered Flex input/destination", 0);
    for (size_t i = 0; i < count; ++i) {
        if (!src[i].has_time || !isfinite(src[i].time * 1000.0)
            || !src[i].has_rank || src[i].rank > 3)
            return fail(error, error_capacity, "missing finite decoded time/rank", i);
        for (unsigned level = 0; level <= src[i].rank; ++level) {
            if (counters[level] == INT64_MAX)
                return fail(error, error_capacity, "native index overflow", i);
            ++counters[level];
        }
        dst[i] = src[i];
        dst[i].time = round_ms(src[i].time);
        dst[i].index_mask = 0;
        for (unsigned level = 0; level < 4; ++level)
            if (counters[level] >= 0) dst[i].index_mask |= 1u << level;
        dst[i].beat_index = counters[0]; dst[i].downbeat_index = counters[1];
        dst[i].segment_index = counters[2]; dst[i].section_index = counters[3];
    }
    return 0;
}

am_int_query am_native_region_count(const am_native_range *range, unsigned kind) {
    if ((kind != AM_INDEX_BEAT && kind != AM_INDEX_DOWNBEAT && kind != AM_INDEX_SEGMENT && kind != AM_INDEX_SECTION)
        || !valid_range(range) || !has_index(&range->start_event, kind) || !has_index(&range->end_event, kind))
        return iq(AM_QUERY_MISSING, 0);
    int64_t a = event_index(&range->start_event, kind), b = event_index(&range->end_event, kind);
    return b >= a ? iq(AM_QUERY_VALUE, b - a) : iq(AM_QUERY_MISSING, 0);
}

am_int_query am_matching_bar_count(const am_native_range *outgoing, const am_native_range *incoming,
                                  am_double_query alias) {
    am_int_query a = am_native_region_count(outgoing, AM_INDEX_DOWNBEAT);
    am_int_query b = am_native_region_count(incoming, AM_INDEX_DOWNBEAT);
    if (a.state != AM_QUERY_VALUE || b.state != AM_QUERY_VALUE || alias.state != AM_QUERY_VALUE
        || (alias.value != 0.5 && alias.value != 1.0 && alias.value != 2.0))
        return iq(AM_QUERY_MISSING, 0);
    if (alias.value == 2.0 && b.value > INT64_MAX / 2) return iq(AM_QUERY_MISSING, 0);
    int64_t normalized = alias.value == 0.5 ? b.value / 2 : alias.value == 2.0 ? b.value * 2 : b.value;
    return normalized == a.value ? a : iq(AM_QUERY_NIL, 0);
}

am_double_query am_stable_region_tempo(const am_stability_region *region) {
    if (!region) return dq(AM_QUERY_MISSING, 0);
    if (region->average_tempo.state == AM_QUERY_NIL) return dq(AM_QUERY_NIL, 0);
    if (region->average_tempo.state == AM_QUERY_VALUE)
        return isfinite(region->average_tempo.value) && region->average_tempo.value > 0
            ? region->average_tempo : dq(AM_QUERY_MISSING, 0);
    am_int_query bars = am_native_region_count(&region->range, AM_INDEX_DOWNBEAT);
    if (bars.state != AM_QUERY_VALUE || bars.value <= 0 || region->beats_per_bar <= 0)
        return dq(AM_QUERY_MISSING, 0);
    double mean = (region->range.source_end - region->range.source_start) / (double)bars.value;
    if (!isfinite(mean * 1000.0)) return dq(AM_QUERY_MISSING, 0);
    mean = round_ms(mean);
    double bpm = 60.0 / (mean / (double)region->beats_per_bar);
    return mean > 0 && isfinite(bpm * 2.0) ? dq(AM_QUERY_VALUE, nearbyint(bpm * 2.0) * 0.5)
        : dq(AM_QUERY_MISSING, 0);
}

/* 0x227436f40: +/-5 BPM duration bounds, each floored to milliseconds. */
static int coarse_bounds(const am_native_range *anchor, double *low, double *high) {
    am_int_query q = am_native_region_count(anchor, AM_INDEX_BEAT);
    am_int_query bars = am_native_region_count(anchor, AM_INDEX_DOWNBEAT);
    double mean = (anchor->source_end - anchor->source_start) / (double)bars.value;
    double bpm = 60.0 / (mean / (double)q.value);
    if (bpm <= 5.0 || !isfinite(bpm)) return -1;
    double a = 60.0 / (bpm + 5.0) * (double)q.value;
    double b = 60.0 / (bpm - 5.0) * (double)q.value;
    if (!isfinite(a * 1000.0) || !isfinite(b * 1000.0)) return -1;
    *low = floor(a * 1000.0) / 1000.0; *high = floor(b * 1000.0) / 1000.0;
    return 0;
}
static void publish_region(am_stability_region *regions, size_t *count,
                           const am_native_range *first, const am_native_range *last,
                           int64_t q, double reference, size_t group) {
    int64_t bars = last->end_event.downbeat_index - first->start_event.downbeat_index;
    if (bars < 5) return; /* 0x227436b18 / 0x227436be8: native minimum DB span 5. */
    am_stability_region region;
    memset(&region, 0, sizeof(region));
    region.range.start_event = first->start_event; region.range.end_event = last->end_event;
    region.range.start_event.time = first->source_start; region.range.start_event.has_time = 1;
    region.range.end_event.time = last->source_end; region.range.end_event.has_time = 1;
    region.range.has_source_range = 1; region.range.source_start = first->source_start;
    region.range.source_end = last->source_end;
    region.beats_per_bar = q; region.bar_count = bars;
    region.reference_bar_duration = reference; region.coarse_group = group;
    region.average_tempo = am_stable_region_tempo(&region);
    if (region.average_tempo.state == AM_QUERY_VALUE) regions[(*count)++] = region;
}

int am_build_stability_regions(const am_native_range *bars, size_t count,
                              am_stability_region **regions, size_t *region_count,
                              char *error, size_t error_capacity) {
    if (!regions || !region_count) return fail(error, error_capacity, "missing output pointers", 0);
    *regions = NULL; *region_count = 0;
    if (count && !bars) return fail(error, error_capacity, "missing final native Song bars", 0);
    if (count > SIZE_MAX / sizeof(am_stability_region)) return fail(error, error_capacity, "bar array too large", 0);
    for (size_t i = 0; i < count; ++i) {
        am_int_query q = am_native_region_count(&bars[i], AM_INDEX_BEAT);
        am_int_query n = am_native_region_count(&bars[i], AM_INDEX_DOWNBEAT);
        if (!valid_range(&bars[i]) || q.state != AM_QUERY_VALUE || n.state != AM_QUERY_VALUE
            || q.value <= 0 || n.value <= 0 || bars[i].source_end <= bars[i].source_start
            || !isfinite((bars[i].source_end - bars[i].source_start) * 1000.0))
            return fail(error, error_capacity, "missing positive native endpoint span", i);
        if ((bars[i].start_event.has_time && bars[i].start_event.time != bars[i].source_start)
            || (bars[i].end_event.has_time && bars[i].end_event.time != bars[i].source_end))
            return fail(error, error_capacity, "native endpoint/source time disagreement", i);
        if (i && (bars[i-1].source_end != bars[i].source_start
            || bars[i-1].end_event.beat_index != bars[i].start_event.beat_index
            || bars[i-1].end_event.downbeat_index != bars[i].start_event.downbeat_index))
            return fail(error, error_capacity, "nonconsecutive native Song bars", i);
    }
    if (!count) return 0;
    am_stability_region *output = calloc(count, sizeof(*output));
    if (!output) return fail(error, error_capacity, "cannot allocate stability regions", 0);
    size_t group = 0, first = 0, output_count = 0;
    while (first < count) { /* 0x2274354f0 coarse anchor/following group pass. */
        double low, high;
        if (coarse_bounds(&bars[first], &low, &high)) {
            free(output); return fail(error, error_capacity, "native coarse anchor BPM must exceed 5", first);
        }
        int64_t q = bars[first].end_event.beat_index - bars[first].start_event.beat_index;
        int64_t anchor_bars = bars[first].end_event.downbeat_index - bars[first].start_event.downbeat_index;
        double reference = (bars[first].source_end - bars[first].source_start) / (double)anchor_bars;
        size_t stop = first + 1;
        for (; stop < count; ++stop) {
            int64_t candidate_q = bars[stop].end_event.beat_index - bars[stop].start_event.beat_index;
            double duration = round_ms(bars[stop].source_end - bars[stop].source_start);
            if (candidate_q != q || duration < low || duration > high) break;
        }
        size_t run_first = first, run_last = first;
        /* 0x2274363ac: refinement reference remains the coarse first bar even
         * after splitting. Constant 0x2274df1a8 is precisely 0.04 seconds. */
        for (size_t i = first + 1; i < stop; ++i) {
            int64_t candidate_q = bars[i].end_event.beat_index - bars[i].start_event.beat_index;
            double delta = round_ms(fabs(round_ms(bars[i].source_end - bars[i].source_start) - round_ms(reference)));
            if (candidate_q == q && delta <= 0.04) run_last = i;
            else {
                publish_region(output, &output_count, &bars[run_first], &bars[run_last], q, reference, group);
                run_first = run_last = i;
            }
        }
        publish_region(output, &output_count, &bars[run_first], &bars[run_last], q, reference, group);
        first = stop; ++group;
    }
    *regions = output; *region_count = output_count;
    return 0;
}

am_double_query am_tempo_for_downbeat(const am_stability_region *regions, size_t count,
                                    am_map_state map_state, am_int_query index) {
    if (map_state != AM_MAP_PRESENT || index.state != AM_QUERY_VALUE || index.value < 0 || (count && !regions))
        return dq(AM_QUERY_MISSING, 0);
    for (size_t i = 0; i < count; ++i) {
        const am_native_range *range = &regions[i].range;
        if (!has_index(&range->start_event, AM_INDEX_DOWNBEAT) || !has_index(&range->end_event, AM_INDEX_DOWNBEAT))
            return dq(AM_QUERY_MISSING, 0);
        if (range->start_event.downbeat_index <= index.value && index.value < range->end_event.downbeat_index)
            return am_stable_region_tempo(&regions[i]);
    }
    return dq(AM_QUERY_NIL, 0);
}

am_window_query am_leading_vocal_window(const am_event *events, size_t count,
                                       am_map_state structure_state, const am_native_range *candidate) {
    if (structure_state != AM_MAP_PRESENT || (count && !events) || !valid_range(candidate)
        || !has_index(&candidate->start_event, AM_INDEX_BEAT)) return wq(AM_QUERY_MISSING, 0, 0);
    int64_t target = candidate->start_event.beat_index - 4;
    for (size_t i = 0; i < count; ++i) {
        if (!has_index(&events[i], AM_INDEX_BEAT)) return wq(AM_QUERY_MISSING, 0, 0);
        if (events[i].beat_index == target) {
            if (!events[i].has_time || !isfinite(events[i].time) || events[i].time < 0) return wq(AM_QUERY_MISSING, 0, 0);
            return wq(AM_QUERY_VALUE, 0, events[i].time);
        }
    }
    return wq(AM_QUERY_NIL, 0, 0);
}

am_int_query am_query_vocal_strength(const am_vocal_interval *intervals, size_t count,
                                    am_map_state map_state, double start, double end) {
    if (map_state != AM_MAP_PRESENT || (count && !intervals) || !isfinite(start) || !isfinite(end) || end < start)
        return iq(AM_QUERY_MISSING, 0);
    int64_t strength = 5;
    for (size_t i = 0; i < count; ++i) {
        const am_vocal_interval *interval = &intervals[i];
        if (!interval->has_time || !isfinite(interval->start) || !isfinite(interval->end)) return iq(AM_QUERY_MISSING, 0);
        if (end >= interval->start && interval->end >= start) {
            if (!interval->has_strength || interval->strength > 4) return iq(AM_QUERY_MISSING, 0);
            if (strength == 5 || (int64_t)interval->strength > strength) strength = interval->strength;
        }
    }
    return iq(AM_QUERY_VALUE, strength);
}

am_loudness_query am_query_loudness(const am_loudness_sample *samples, size_t count,
                                  am_map_state map_state, double start, double end) {
    am_loudness_query result = {AM_QUERY_MISSING, map_state, 0, 0};
    if (map_state != AM_MAP_PRESENT || (count && !samples) || !isfinite(start) || !isfinite(end) || end < start) return result;
    double total = 0;
    for (size_t i = 0; i < count; ++i) {
        if (!samples[i].has_time || !samples[i].has_value || !isfinite(samples[i].time) || !isfinite(samples[i].value)) return result;
        if (samples[i].time >= start && samples[i].time <= end) {
            total += samples[i].value; ++result.sample_count;
        }
    }
    if (!isfinite(total)) { result.sample_count = 0; return result; }
    result.state = result.sample_count ? AM_QUERY_VALUE : AM_QUERY_NIL;
    if (result.sample_count) result.mean = total / (double)result.sample_count;
    return result;
}

am_int_query am_aligned_vocal_overlap(const am_int_query *outgoing, size_t outgoing_count,
                                     const am_int_query *incoming, size_t incoming_count,
                                     am_map_state alignment_state) {
    if (alignment_state == AM_MAP_NIL) return iq(AM_QUERY_VALUE, 1);
    if (alignment_state != AM_MAP_PRESENT || outgoing_count != incoming_count
        || (outgoing_count && (!outgoing || !incoming))) return iq(AM_QUERY_MISSING, 0);
    int64_t maximum = 5;
    for (size_t i = 0; i < outgoing_count; ++i) {
        if (outgoing[i].state == AM_QUERY_MISSING || incoming[i].state == AM_QUERY_MISSING) return iq(AM_QUERY_MISSING, 0);
        if (outgoing[i].state == AM_QUERY_NIL || incoming[i].state == AM_QUERY_NIL
            || outgoing[i].value == 5 || incoming[i].value == 5) continue;
        if (outgoing[i].value < 0 || incoming[i].value < 0 || outgoing[i].value > 4 || incoming[i].value > 4)
            return iq(AM_QUERY_MISSING, 0);
        int64_t minimum = outgoing[i].value < incoming[i].value ? outgoing[i].value : incoming[i].value;
        if (maximum == 5 || minimum > maximum) maximum = minimum;
    }
    return iq(AM_QUERY_VALUE, maximum != 0 && maximum != 5);
}

static int valid_tonality(am_tonality tonality) {
    return tonality.state == AM_MAP_PRESENT && tonality.tonic >= 0 && tonality.tonic < 12
        && tonality.mode >= AM_ANALYSIS_KEY_MAJOR && tonality.mode <= AM_ANALYSIS_KEY_NEUTRAL;
}
am_analysis_key_relation am_analysis_tonality_relationship(am_tonality outgoing, am_tonality incoming) {
    static const int major[] = {0,7,2,9,4,11,6,1,8,3,10,5};
    static const int minor[] = {9,4,11,6,1,8,3,10,5,0,7,2};
    if (!valid_tonality(outgoing) || !valid_tonality(incoming)) return AM_ANALYSIS_KEY_RELATION_UNKNOWN;
    if (outgoing.tonic == incoming.tonic && outgoing.mode == incoming.mode) return AM_ANALYSIS_KEY_RELATION_IDENTICAL;
    if (outgoing.mode == AM_ANALYSIS_KEY_NEUTRAL || incoming.mode == AM_ANALYSIS_KEY_NEUTRAL) return AM_ANALYSIS_KEY_RELATION_INCOMPATIBLE;
    const int *a = outgoing.mode == AM_ANALYSIS_KEY_MAJOR ? major : minor;
    const int *b = incoming.mode == AM_ANALYSIS_KEY_MAJOR ? major : minor;
    int x = 0, y = 0;
    while (a[x] != outgoing.tonic) ++x;
    while (b[y] != incoming.tonic) ++y;
    if (outgoing.mode != incoming.mode) return x == y ? AM_ANALYSIS_KEY_RELATION_RELATIVE : AM_ANALYSIS_KEY_RELATION_INCOMPATIBLE;
    int delta = (x - y + 12) % 12;
    return delta == 1 || delta == 11 ? AM_ANALYSIS_KEY_RELATION_NEIGHBOURING : AM_ANALYSIS_KEY_RELATION_INCOMPATIBLE;
}
am_int_query am_analysis_key_gate(am_tonality outgoing, am_tonality incoming, int identical_only,
                        am_double_query outgoing_melodicness, am_double_query incoming_melodicness) {
    if (outgoing.state == AM_MAP_NIL || incoming.state == AM_MAP_NIL) return iq(AM_QUERY_VALUE, 0);
    am_analysis_key_relation relation = am_analysis_tonality_relationship(outgoing, incoming);
    if (relation == AM_ANALYSIS_KEY_RELATION_UNKNOWN) return iq(AM_QUERY_MISSING, 0);
    if (relation == AM_ANALYSIS_KEY_RELATION_IDENTICAL || (!identical_only
        && (relation == AM_ANALYSIS_KEY_RELATION_RELATIVE || relation == AM_ANALYSIS_KEY_RELATION_NEIGHBOURING))) return iq(AM_QUERY_VALUE, 1);
    am_double_query attributes[2] = {outgoing_melodicness, incoming_melodicness};
    int unresolved = 0;
    for (size_t i = 0; i < 2; ++i) {
        if (attributes[i].state == AM_QUERY_MISSING) unresolved = 1;
        if (attributes[i].state == AM_QUERY_VALUE) {
            if (!isfinite(attributes[i].value)) return iq(AM_QUERY_MISSING, 0);
            if (attributes[i].value < 0.25 || attributes[i].value > 1.0) return iq(AM_QUERY_VALUE, 1);
        }
    }
    return iq(unresolved ? AM_QUERY_MISSING : AM_QUERY_VALUE, 0);
}

am_double_query am_tempo_alias(am_double_query outgoing, am_double_query incoming) {
    static const double aliases[] = {0.5, 1.0, 2.0};
    if (outgoing.state != AM_QUERY_VALUE || incoming.state != AM_QUERY_VALUE
        || !isfinite(outgoing.value) || !isfinite(incoming.value) || outgoing.value <= 0 || incoming.value <= 0)
        return dq(AM_QUERY_MISSING, 0);
    double difference = log(incoming.value) - log(outgoing.value), best = INFINITY, alias = 0.5;
    for (size_t i = 0; i < 3; ++i) {
        double distance = fabs(difference + log(aliases[i]));
        if (distance < best) { best = distance; alias = aliases[i]; }
    }
    return dq(AM_QUERY_VALUE, alias);
}
am_int_query am_tempo_compatible(am_double_query outgoing, am_double_query incoming, double threshold) {
    if (outgoing.state == AM_QUERY_NIL || incoming.state == AM_QUERY_NIL) return iq(AM_QUERY_VALUE, 0);
    am_double_query alias = am_tempo_alias(outgoing, incoming);
    if (alias.state != AM_QUERY_VALUE || !isfinite(threshold) || threshold < 0) return iq(AM_QUERY_MISSING, 0);
    double distance = fabs(log(incoming.value) + log(alias.value) - log(outgoing.value));
    return iq(AM_QUERY_VALUE, distance <= threshold);
}
am_double_query am_analysis_leading_vocal_factor(am_int_query strength) {
    return dq(AM_QUERY_VALUE, strength.state == AM_QUERY_VALUE && (strength.value == 3 || strength.value == 4) ? 0.75 : 1.0);
}
am_double_query am_analysis_trailing_loudness_ratio(am_loudness_query region, am_loudness_query trailing) {
    if (region.state == AM_QUERY_MISSING || trailing.state == AM_QUERY_MISSING) return dq(AM_QUERY_MISSING, 0);
    if (region.state != AM_QUERY_VALUE || trailing.state != AM_QUERY_VALUE || region.mean >= 0 || trailing.mean >= 0)
        return dq(AM_QUERY_NIL, 0);
    double ratio = region.mean / trailing.mean;
    return isfinite(ratio) ? dq(AM_QUERY_VALUE, ratio) : dq(AM_QUERY_MISSING, 0);
}
am_int_query am_analysis_outgoing_loudness_significant(am_loudness_query query) {
    if (query.map_state == AM_MAP_NIL) return iq(AM_QUERY_VALUE, 1);
    if (query.map_state == AM_MAP_UNKNOWN || query.state == AM_QUERY_MISSING) return iq(AM_QUERY_MISSING, 0);
    return iq(AM_QUERY_VALUE, query.state == AM_QUERY_VALUE && query.mean > -15.0);
}
am_window_query am_loudness_window(double start, double end, double a, double b) {
    if (!isfinite(start) || !isfinite(end) || end < start || !isfinite(a) || !isfinite(b)) return wq(AM_QUERY_MISSING, 0, 0);
    double lower = start + a * (end - start), upper = start + (a + b) * (end - start);
    return isfinite(lower) && isfinite(upper) && upper >= lower ? wq(AM_QUERY_VALUE, lower, upper) : wq(AM_QUERY_MISSING, 0, 0);
}
