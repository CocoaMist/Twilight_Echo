#ifndef AM_BRIDGE_H
#define AM_BRIDGE_H

#include <stddef.h>
#include <stdint.h>
#include "am_json.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Independently implemented JSON adapter for recovered native query operators.
 * Returns an owned {signals, missing_inputs, provenance} object, or NULL and an
 * error. Free the result with am_json_free(). No audio/model/function executes.
 *
 * regions.outgoing/incoming require actual start_event/end_event native indexes
 * and source_range:[start,end]. The adapter never derives native indexes from
 * beat-array positions. JSON indexes must be exact nonnegative integers <=2^53-1.
 * track.native_analysis holds explicit structure.events, beat_stability_regions,
 * tonality.main, scalar_attributes.<name>.main, vocal_activity_map and loudness_map.
 * Explicit nil maps differ from unavailable maps. Optional canonical
 * vocal_intervals/loudness_curve are used only when the native key is absent.
 *
 * regions.native_signals supplies explicit native gate/query results; counts,
 * alias and target cannot be overridden there. Use regions.tempo_alias (0.5/1/2)
 * and positive regions.target_bar_count for explicit native parameters.
 * regions.aligned_vocal_windows requires already natively aligned, equal-length
 * outgoing/incoming arrays of [start,end]; this adapter does not infer alignment.
 *
 * matching_bar_count:null with matching_bar_count_available:true is a known
 * native nil (unequal counts), retained in signals. Unknown required fields are
 * omitted and named in missing_inputs; optional unknowns are separately listed
 * in provenance.optional_unresolved_inputs. Explicit supplied values preserve
 * their JSON types for the scoring adapter to validate.
 */
am_json *am_bridge_candidate_signals(const am_json *outgoing,
                                     const am_json *incoming,
                                     const char *path, int64_t style_id,
                                     const am_json *regions,
                                     char *error, size_t cap);

#ifdef __cplusplus
}
#endif
#endif
