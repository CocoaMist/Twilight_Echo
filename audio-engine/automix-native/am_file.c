#include "am_file.h"

#include <stdlib.h>
#if defined(_WIN32)
#include <wchar.h>
#include <windows.h>
#endif
FILE *ta_am_open_read(const char *path) {
  if (!path) return NULL;
#if defined(_WIN32)
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (!n || n > 32768) return NULL;
  wchar_t *wide = malloc((size_t)n * sizeof(wchar_t));
  if (!wide) return NULL;
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, n)) {
    free(wide);
    return NULL;
  }
  FILE *result = _wfopen(wide, L"rb");
  free(wide);
  return result;
#else
  return fopen(path, "rb");
#endif
}
