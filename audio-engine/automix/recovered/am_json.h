#ifndef AM_JSON_H
#define AM_JSON_H
#include <stddef.h>
typedef enum {AM_JNULL,AM_JBOOL,AM_JNUMBER,AM_JSTRING,AM_JARRAY,AM_JOBJECT} am_jtype;
typedef struct am_json {
    am_jtype type; double number; char *string;
    struct am_json **items; char **keys; size_t count;
} am_json;
am_json *am_json_parse(const char *text,char *error,size_t error_size);
char *am_json_encode(const am_json *value);
void am_json_free(am_json *value);
am_json *am_jnull(void);
am_json *am_jbool(int value);
am_json *am_jnumber(double value);
am_json *am_jstring(const char *value);
am_json *am_jarray(void);
am_json *am_jobject(void);
int am_jappend(am_json *array,am_json *value);
int am_jset(am_json *object,const char *key,am_json *value);
const am_json *am_jget(const am_json *object,const char *key);
const char *am_jstr(const am_json *value,const char *fallback);
double am_jnum(const am_json *value,double fallback);
int am_jboolean(const am_json *value,int fallback);
am_json *am_json_clone(const am_json *value);
#endif
