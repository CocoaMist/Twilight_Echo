#include "Kernels.h"
#include <stdatomic.h>
#ifdef TAE_AM_ASM
#include <cpuid.h>
#endif
typedef void (*mix_function)(float*,const float*,const float*,const float*,size_t);
static void scalar_mix(float* out,const float* in,const float* a,const float* b,size_t n) {
  for(size_t i=0;i<n;++i) { const float x=out[i]*a[i],y=in[i]*b[i]; out[i]=x+y; }
}
#ifdef TAE_AM_ASM
static _Atomic(mix_function) selected_mix=am_k_mix_sse2;
#else
static _Atomic(mix_function) selected_mix=scalar_mix;
#endif
int am_kernel_avx2_available(void) {
#ifdef TAE_AM_ASM
  __builtin_cpu_init();
  return __builtin_cpu_supports("avx2") != 0;
#else
  return 0;
#endif
}
void am_kernel_initialize(void) {
#ifdef TAE_AM_ASM
  atomic_store_explicit(&selected_mix, am_kernel_avx2_available()?am_k_mix_avx2:am_k_mix_sse2,memory_order_release);
#else
  atomic_store_explicit(&selected_mix,scalar_mix,memory_order_release);
#endif
}
void am_mix(float* out,const float* in,const float* a,const float* b,size_t n) {
  atomic_load_explicit(&selected_mix,memory_order_acquire)(out,in,a,b,n);
}
