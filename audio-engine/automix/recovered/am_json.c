#include "am_json.h"
#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static am_json *make(am_jtype t){am_json *v=calloc(1,sizeof(*v));if(v)v->type=t;return v;}
am_json *am_jnull(void){return make(AM_JNULL);}
am_json *am_jbool(int b){am_json *v=make(AM_JBOOL);if(v)v->number=!!b;return v;}
am_json *am_jnumber(double n){am_json *v=make(isfinite(n)?AM_JNUMBER:AM_JNULL);if(v)v->number=n;return v;}
am_json *am_jstring(const char *s){am_json *v=make(AM_JSTRING);if(v){v->string=strdup(s?s:"");if(!v->string){free(v);return NULL;}}return v;}
am_json *am_jarray(void){return make(AM_JARRAY);}
am_json *am_jobject(void){return make(AM_JOBJECT);}
void am_json_free(am_json *v){if(!v)return;for(size_t i=0;i<v->count;i++){am_json_free(v->items[i]);if(v->keys)free(v->keys[i]);}free(v->items);free(v->keys);free(v->string);free(v);}
int am_jappend(am_json *a,am_json *v){if(!a||a->type!=AM_JARRAY||!v)return -1;am_json **p=realloc(a->items,(a->count+1)*sizeof(*p));if(!p)return -1;a->items=p;a->items[a->count++]=v;return 0;}
int am_jset(am_json *o,const char *key,am_json *v){
 if(!o||o->type!=AM_JOBJECT||!v)return -1;
 for(size_t i=0;i<o->count;i++)if(!strcmp(o->keys[i],key)){am_json_free(o->items[i]);o->items[i]=v;return 0;}
 char *name=strdup(key);if(!name)return -1;
 am_json **items=realloc(o->items,(o->count+1)*sizeof(*items));if(!items){free(name);return -1;}o->items=items;
 char **keys=realloc(o->keys,(o->count+1)*sizeof(*keys));if(!keys){free(name);return -1;}o->keys=keys;
 o->items[o->count]=v;o->keys[o->count++]=name;return 0;
}
const am_json *am_jget(const am_json *o,const char *key){if(o&&o->type==AM_JOBJECT)for(size_t i=0;i<o->count;i++)if(!strcmp(o->keys[i],key))return o->items[i];return NULL;}
const char *am_jstr(const am_json *v,const char *d){return v&&v->type==AM_JSTRING?v->string:d;}
double am_jnum(const am_json *v,double d){return v&&v->type==AM_JNUMBER?v->number:d;}
int am_jboolean(const am_json *v,int d){return v&&v->type==AM_JBOOL?(int)v->number:d;}
typedef struct {char *s;size_t n,cap;int bad;} buffer;
static void put(buffer *b,const char *s,size_t n){if(b->bad)return;if(n>SIZE_MAX-b->n-1){b->bad=1;return;}size_t need=b->n+n+1;if(need>b->cap){size_t cap=b->cap?b->cap:128;while(cap<need){if(cap>SIZE_MAX/2){cap=need;break;}cap*=2;}char *p=realloc(b->s,cap);if(!p){b->bad=1;return;}b->s=p;b->cap=cap;}memcpy(b->s+b->n,s,n);b->n+=n;b->s[b->n]=0;}
static void ch(buffer *b,char c){put(b,&c,1);}
static void quote(buffer *b,const char *s){ch(b,'"');for(const unsigned char *p=(const unsigned char*)s;*p;p++){char temp[7];switch(*p){case '"':put(b,"\\\"",2);break;case '\\':put(b,"\\\\",2);break;case '\n':put(b,"\\n",2);break;case '\r':put(b,"\\r",2);break;case '\t':put(b,"\\t",2);break;default:if(*p<32){snprintf(temp,sizeof temp,"\\u%04x",*p);put(b,temp,6);}else ch(b,(char)*p);}}ch(b,'"');}
static void encode(buffer *b,const am_json *v){if(!v){put(b,"null",4);return;}char temp[64];switch(v->type){case AM_JNULL:put(b,"null",4);break;case AM_JBOOL:put(b,v->number?"true":"false",v->number?4:5);break;case AM_JNUMBER:snprintf(temp,sizeof temp,"%.17g",v->number);put(b,temp,strlen(temp));break;case AM_JSTRING:quote(b,v->string);break;case AM_JARRAY:case AM_JOBJECT:ch(b,v->type==AM_JARRAY?'[':'{');for(size_t i=0;i<v->count;i++){if(i)ch(b,',');if(v->type==AM_JOBJECT){quote(b,v->keys[i]);ch(b,':');}encode(b,v->items[i]);}ch(b,v->type==AM_JARRAY?']':'}');break;}}
char *am_json_encode(const am_json *v){buffer b={0};encode(&b,v);if(b.bad){free(b.s);return NULL;}return b.s;}
am_json *am_json_clone(const am_json *v){if(!v)return am_jnull();am_json *o=make(v->type);if(!o)return NULL;o->number=v->number;if(v->string){o->string=strdup(v->string);if(!o->string){am_json_free(o);return NULL;}}for(size_t i=0;i<v->count;i++){am_json *x=am_json_clone(v->items[i]);int rc=v->type==AM_JOBJECT?am_jset(o,v->keys[i],x):am_jappend(o,x);if(rc){am_json_free(x);am_json_free(o);return NULL;}}return o;}
typedef struct {const char *start,*p;char *error;size_t error_size;int failed;} parser;
static void fail(parser *p,const char *s){if(!p->failed&&p->error_size)snprintf(p->error,p->error_size,"%s at byte%zu",s,(size_t)(p->p-p->start));p->failed=1;}
static void ws(parser *p){while(*p->p&&isspace((unsigned char)*p->p))p->p++;}
static int hex4(parser *p,unsigned *out){unsigned v=0;for(int i=0;i<4;i++){unsigned char c=(unsigned char)*p->p;if(!c){fail(p,"Incomplete unicode escape");return -1;}p->p++;int d=c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1;if(d<0){fail(p,"Invalid unicode escape");return -1;}v=(v<<4)|(unsigned)d;}*out=v;return 0;}
static void utf8(buffer *b,unsigned c){if(c<128)ch(b,(char)c);else if(c<2048){ch(b,(char)(0xc0|(c>>6)));ch(b,(char)(0x80|(c&63)));}else if(c<65536){ch(b,(char)(0xe0|(c>>12)));ch(b,(char)(0x80|((c>>6)&63)));ch(b,(char)(0x80|(c&63)));}else{ch(b,(char)(0xf0|(c>>18)));ch(b,(char)(0x80|((c>>12)&63)));ch(b,(char)(0x80|((c>>6)&63)));ch(b,(char)(0x80|(c&63)));}}
static char *string(parser *p){
 if(*p->p!='"'){fail(p,"Expected string");return NULL;}
 p->p++;buffer b={0};
 while(*p->p&&*p->p!='"'){
  unsigned char c=(unsigned char)*p->p++;
  if(c<32){fail(p,"Control byte in string");break;}
  if(c!='\\'){ch(&b,(char)c);continue;}
  /* A final backslash leaves p at the terminator; never consume that NUL. */
  if(!*p->p){fail(p,"Incomplete escape");break;}
  c=(unsigned char)*p->p++;
  switch(c){
   case '"':case '\\':case '/':ch(&b,(char)c);break;
   case 'b':ch(&b,'\b');break;case 'f':ch(&b,'\f');break;
   case 'n':ch(&b,'\n');break;case 'r':ch(&b,'\r');break;case 't':ch(&b,'\t');break;
   case 'u':{
    unsigned code;if(hex4(p,&code))break;
    if(code>=0xd800&&code<=0xdbff){
     /* The second byte is examined only after a non-NUL backslash. */
     if(p->p[0]!='\\'||p->p[1]!='u'){fail(p,"Missing low surrogate");break;}
     p->p+=2;unsigned low;if(hex4(p,&low))break;
     if(low<0xdc00||low>0xdfff){fail(p,"Invalid low surrogate");break;}
     code=0x10000+((code-0xd800)<<10)+(low-0xdc00);
    }else if(code>=0xdc00&&code<=0xdfff){fail(p,"Unpaired surrogate");break;}
    if(code==0){fail(p,"Embedded NUL unsupported");break;}
    utf8(&b,code);break;
   }
   default:fail(p,"Invalid escape");break;
  }
  if(p->failed)break;
 }
 if(!p->failed){if(*p->p!='"')fail(p,"Unterminated string");else p->p++;}
 if(b.bad&&!p->failed)fail(p,"Out of memory");
 if(p->failed){free(b.s);return NULL;}
 if(!b.s)b.s=strdup("");
 if(!b.s)fail(p,"Out of memory");
 return b.s;
}
static am_json *value(parser *p,unsigned depth){
 if(p->failed)return NULL;
 ws(p);if(depth>128){fail(p,"JSON nesting limit");return NULL;}
 if(*p->p=='"'){
  char *s=string(p);if(!s)return NULL;
  am_json *v=make(AM_JSTRING);if(v)v->string=s;else{free(s);fail(p,"Out of memory");}return v;
 }
 if(*p->p=='{'||*p->p=='['){
  int object=*p->p++=='{';char end=object?'}':']';
  am_json *v=make(object?AM_JOBJECT:AM_JARRAY);if(!v){fail(p,"Out of memory");return NULL;}
  ws(p);if(*p->p==end){p->p++;return v;}
  while(!p->failed){
   char *key=NULL;
   if(object){
    key=string(p);if(!key)break;ws(p);
    if(*p->p!=':'){free(key);fail(p,"Expected colon");break;}
    p->p++;
   }
   am_json *x=value(p,depth+1);
   if(!x){free(key);if(!p->failed)fail(p,"Out of memory");break;}
   int rc=object?am_jset(v,key,x):am_jappend(v,x);free(key);
   if(rc){am_json_free(x);fail(p,"Out of memory");break;}
   ws(p);if(*p->p==end){p->p++;return v;}
   if(*p->p!=','){fail(p,"Expected comma");break;}
   p->p++;ws(p);
  }
  am_json_free(v);return NULL;
 }
 if(!strncmp(p->p,"null",4)){p->p+=4;return am_jnull();}
 if(!strncmp(p->p,"true",4)){p->p+=4;return am_jbool(1);}
 if(!strncmp(p->p,"false",5)){p->p+=5;return am_jbool(0);}
 const char *begin=p->p;if(*p->p=='-')p->p++;
 if(*p->p=='0')p->p++;
 else{if(!isdigit((unsigned char)*p->p)){fail(p,"Expected JSON value");return NULL;}while(isdigit((unsigned char)*p->p))p->p++;}
 if(*p->p=='.'){p->p++;if(!isdigit((unsigned char)*p->p)){fail(p,"Invalid fraction");return NULL;}while(isdigit((unsigned char)*p->p))p->p++;}
 if(*p->p=='e'||*p->p=='E'){p->p++;if(*p->p=='+'||*p->p=='-')p->p++;if(!isdigit((unsigned char)*p->p)){fail(p,"Invalid exponent");return NULL;}while(isdigit((unsigned char)*p->p))p->p++;}
 errno=0;char *endptr;double number=strtod(begin,&endptr);
 if(endptr!=p->p||!isfinite(number)){fail(p,"Number out of range");return NULL;}
 return am_jnumber(number);
}
am_json *am_json_parse(const char *text,char *error,size_t n){
 if(error&&n)error[0]=0;
 if(!text){if(error&&n)snprintf(error,n,"Missing JSON input");return NULL;}
 parser p={text,text,error,error?n:0,0};am_json *v=value(&p,0);
 /* Syntax errors stop at a valid byte/terminator. Never scan after failure. */
 if(p.failed||!v){if(!p.failed)fail(&p,"Out of memory");am_json_free(v);return NULL;}
 ws(&p);
 if(*p.p){fail(&p,"Trailing JSON content");am_json_free(v);return NULL;}
 return v;
}
