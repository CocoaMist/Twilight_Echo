#ifndef TWILIGHT_AM_FILE_H
#define TWILIGHT_AM_FILE_H
#include <stdio.h>
/* Worker-only UTF-8 path handling, including Windows installations. */
FILE *ta_am_open_read(const char *utf8_path);
#endif
