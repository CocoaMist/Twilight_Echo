#ifndef AM_TIMING_H
#define AM_TIMING_H
#include "am_json.h"
#include <stdint.h>
typedef struct {double start,end;} am_range;
typedef struct {char parameter[96];double start,end,first,last;unsigned curve;} am_ramp;
typedef struct {char name[64];am_range placement;am_ramp *ramps;size_t count;} am_processor;
typedef struct {am_processor *processors;size_t count;} am_side;
typedef struct {
 am_range source,window;double first,last,playback_start,playback_end,duration;int has_rate;
} am_rate_map;
typedef struct {
 int64_t style_id;char name[128];double maximum_bar_count,offset_relative,offset_seconds;
 am_side sides[2];am_rate_map maps[2];double horizon,reference,bar_alias_scale;int unstructured;
} am_compiled_style;
double am_rate_integral(double source_time,const am_rate_map *map);
double am_rate_inverse(double stretched_elapsed,const am_rate_map *map);
double am_playback_from_source(double source_time,const am_rate_map *map);
double am_source_from_playback(double playback_time,const am_rate_map *map);
double am_curve_value(const am_ramp *ramp,double source_time);
double am_control(const am_side *side,const char *parameter,double source_time,double fallback);
int am_compile_style(const am_json *catalog,int64_t style_id,am_range outgoing,am_range incoming,
 const am_json *parameters,int unstructured,double outgoing_bars,double incoming_bars,unsigned alias_index,
 am_compiled_style *result,char *error,size_t capacity);
void am_compiled_style_free(am_compiled_style *style);
am_json *am_style_to_json(const am_compiled_style *style,double step);
double am_parameter_default(const am_json *descriptors,const char *style_parameter,double fallback);
#endif
