#ifndef TWILIGHT_AM_GRAPH_H
#define TWILIGHT_AM_GRAPH_H
#include <stdint.h>

#include "am_cancel.h"
#include "am_kernels.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct ta_am_graph ta_am_graph;
/* File loading and all allocation are worker-only. A graph is single-worker. */
ta_am_graph *ta_am_graph_load(const char *path, const ta_am_kernels *kernels, char *error,
                              size_t error_size);
void ta_am_graph_free(ta_am_graph *graph);
size_t ta_am_graph_input_count(const ta_am_graph *graph, unsigned input);
size_t ta_am_graph_output_count(const ta_am_graph *graph, unsigned output);
size_t ta_am_graph_memory(const ta_am_graph *graph);
/* Input/output buffers owned by caller; no allocation, file access or IPC. */
int ta_am_graph_run(ta_am_graph *graph, const float *input, size_t count,
                    const ta_am_cancel *cancel);
const float *ta_am_graph_output(const ta_am_graph *graph, unsigned output);
#ifdef __cplusplus
}
#endif
#endif
