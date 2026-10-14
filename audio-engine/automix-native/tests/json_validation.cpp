#include "AutoMixJsonValidation.h"
#include <cstdio>
#include <cstdlib>
using twilight::audio::AutoMixJsonValidation;
int main() {
  for (const char *s : {"{}", "{\"a\":[1,-2.3e-4,true,false,null,{}]}",
                        "{\"voice\":[{\"start\":1}]}"})
    if (!AutoMixJsonValidation(std::string(s)).valid())
      return 1;
  for (const char *s :
       {"{\"a\":NaN}", "{\"a\":1x}", "{\"a\":1,}", "{\"a\":[1,]}", "{\"a\":01}",
        "{\"a\":trueX}", "{\"a\":1,\"a\":2}", "{\"a\":1,\"\\u0061\":2}",
        "{\"a\":{]}", "{}garbage", "[1]", "{\"a\":\"\\x\"}", "{\"a\":1e}",
        "{\"a\":\"\n\"}"})
    if (AutoMixJsonValidation(std::string(s)).valid())
      return 1;
  puts("PASS complete JSON grammar and duplicate field rejection");
  return 0;
}
