#include "Kernels.h"
#include "recovered/am_scoring.h"
extern "C" {
#include "recovered/am_timing.h"
am_scoring_error am_ref_evaluate_candidate(const am_candidate_input*, am_score_result*);
am_scoring_error am_ref_native_score_weight(double, int64_t*);
am_scoring_error am_ref_native_modulo_index(uint64_t, int64_t, uint64_t*);
am_scoring_error am_ref_select_candidates(const am_selection_candidate*, size_t, am_selection_mode, bool, uint64_t, am_selection_result*);
void am_ref_selection_result_free(am_selection_result*);
double am_ref_rate_integral(double, const am_rate_map*);
double am_ref_rate_inverse(double, const am_rate_map*);
double am_ref_playback_from_source(double, const am_rate_map*);
double am_ref_source_from_playback(double, const am_rate_map*);
double am_ref_curve_value(const am_ramp*, double);
int am_ref_compile_style(const am_json*, int64_t, am_range, am_range, const am_json*, int, double, double, unsigned, am_compiled_style*, char*, size_t);
void am_ref_compiled_style_free(am_compiled_style*);
}
#include <algorithm>
#include <array>
#include <bit>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <limits>
#include <random>
#include <vector>

static std::mt19937_64 rng(0x4d69785477696c69ULL);
static bool same(double a, double b) {
  return (std::isnan(a) && std::isnan(b)) || std::bit_cast<uint64_t>(a)==std::bit_cast<uint64_t>(b);
}
static void near(double a, double b) {
  if(same(a,b)) return;
  if(!std::isfinite(a)||!std::isfinite(b)||std::abs(a-b)>2e-12*std::max({1.,std::abs(a),std::abs(b)})) {
    std::fprintf(stderr,"numeric mismatch %.17g vs %.17g\n",a,b); std::abort();
  }
}
template<class T> static void optional(T& s) {
  unsigned choice=rng()%10;
  s.has_value=choice!=0; s.is_nil=choice==1; s.invalid=choice==2;
}
static void scores() {
  size_t count=0; auto ids=am_default_style_ids(&count); assert(count==16);
  for(size_t route=0;route<count;++route) for(int n=0;n<6000;++n) {
    am_candidate_input c{}; am_candidate_input_init(&c);
    c.style_id=ids[route]; c.path=am_default_route(c.style_id).path;
    c.outgoing_end=double(rng()%100000)/100.; c.incoming_end=double(rng()%100000)/100.; c.positional_enabled=(rng()%2)!=0;
    auto& s=c.signals;
    auto boolean=[](am_signal_bool& x){optional(x);x.value=(rng()%2)!=0;};
    boolean(s.strict_tempo_compatible); boolean(s.loose_tempo_compatible); boolean(s.tonalities_compatible);
    boolean(s.vocal_overlap_incompatible); boolean(s.outgoing_loudness_significant);
    auto integer=[](am_signal_i64& x,int64_t value){optional(x);x.value=value;};
    integer(s.matching_bar_count,int64_t(rng()%40)-2);
    integer(s.incoming_beat_count,n%71==0?INT64_MAX:int64_t(rng()%128)-2);
    integer(s.outgoing_beat_count,int64_t(rng()%128)-2);
    integer(s.incoming_leading_strength,int64_t(rng()%8)-1);
    integer(s.incoming_loudness_relation_code,int64_t(rng()%67)-2);
    auto number=[](am_signal_double& x,double value){optional(x);x.value=value;};
    constexpr double aliases[]={.5,1.,2.,.75}; number(s.tempo_alias,aliases[rng()%4]);
    number(s.target_bar_count,double(rng()%20)-1);
    number(s.incoming_region_loudness,-double(rng()%400)/10.);
    number(s.incoming_trailing_loudness,-double(rng()%600)/10.);
    number(s.trailing_span_seconds,double(rng()%101)/10.);
    if(n%79==0) s.incoming_region_loudness.value=std::numeric_limits<double>::quiet_NaN();
    if(n%83==0) c.outgoing_end=std::numeric_limits<double>::infinity();
    am_score_result a{},b{};
    assert(am_evaluate_candidate(&c,&a)==am_ref_evaluate_candidate(&c,&b));
    if(a.status!=b.status||a.score_known!=b.score_known||a.missing_inputs!=b.missing_inputs||a.invalid_inputs!=b.invalid_inputs||a.factor_count!=b.factor_count) {
      std::fprintf(stderr,"score status route=%lld n=%d status=%d/%d factors=%zu/%zu invalid=%llu/%llu\n",(long long)c.style_id,n,a.status,b.status,a.factor_count,b.factor_count,(unsigned long long)a.invalid_inputs,(unsigned long long)b.invalid_inputs); std::abort();
    }
    for(size_t i=0;i<a.factor_count;++i) { assert(std::string(a.factors[i].name)==b.factors[i].name); assert(same(a.factors[i].value,b.factors[i].value)); }
    assert(same(a.base,b.base)); assert(same(a.product,b.product)); assert(same(a.score,b.score));
  }
}
static void selection() {
  constexpr double edge[]={0.,-0.,-1.,.0009,.001,1.,9223372036854775.,9223372036854776.,1e300,
    std::numeric_limits<double>::infinity(),std::numeric_limits<double>::quiet_NaN()};
  for(double v:edge) { int64_t a=999,b=999; assert(am_native_score_weight(v,&a)==am_ref_native_score_weight(v,&b)); assert(a==b); }
  for(uint64_t seed: {uint64_t(0),uint64_t(1),uint64_t(INT64_MAX),UINT64_MAX})
    for(int64_t bound:{int64_t(-1),int64_t(0),int64_t(1),int64_t(65537),INT64_MAX}) {
      uint64_t a=123,b=123; assert(am_native_modulo_index(seed,bound,&a)==am_ref_native_modulo_index(seed,bound,&b)); assert(a==b);
    }
  for(int test=0;test<3000;++test) {
    std::vector<am_selection_candidate> c(rng()%80);
    for(size_t i=0;i<c.size();++i) c[i]={static_cast<am_algorithm>(int(rng()%9)-1),int64_t(rng()%25),(rng()%5)!=0,double(int(rng()%30)-5)/1000.,i};
    if(c.size()>2&&test%19==0) {c[0]={AM_ALGORITHM_DANCE,17,true,8e15,0};c[1]=c[0];c[2]=c[0];}
    // Deliberate duplicates and equal scores must retain their input positions.
    if(c.size()>5) { c[4]=c[3];c[4].input_index=4; }
    auto mode=(test%2)?AM_SELECT_BEST:AM_SELECT_NATIVE_WEIGHTED; uint64_t seed=rng(); bool has=test%3!=0;
    am_selection_result a{},b{};
    assert(am_select_candidates(c.data(),c.size(),mode,has,seed,&a)==am_ref_select_candidates(c.data(),c.size(),mode,has,seed,&b));
    assert(a.status==b.status&&a.has_chosen==b.has_chosen&&a.chosen_index==b.chosen_index&&a.preference_group==b.preference_group);
    assert(a.ranking_count==b.ranking_count&&a.preferred_count==b.preferred_count&&a.total_weight==b.total_weight&&a.draw==b.draw);
    for(size_t i=0;i<a.ranking_count;++i) assert(a.ranking_indices[i]==b.ranking_indices[i]);
    for(size_t i=0;i<a.preferred_count;++i) { assert(a.preferred_indices[i]==b.preferred_indices[i]);if(a.weights&&b.weights) assert(a.weights[i]==b.weights[i]); }
    am_selection_result_free(&a); am_ref_selection_result_free(&b);
  }
}
static void timing() {
  for(unsigned curve:{0u,1u,2u,64u,65u,66u,128u,129u}) {
    am_ramp r{};r.start=2.;r.end=9.;r.first=curve==129?.01:1.;r.last=curve==129?20000.:0.;r.curve=curve;
    for(int i=-10;i<=100;++i) near(am_curve_value(&r,i*.1),am_ref_curve_value(&r,i*.1));
    r.end=r.start; near(am_curve_value(&r,2.),am_ref_curve_value(&r,2.));
  }
  for(int i=0;i<10000;++i) {
    am_rate_map m{};m.source={3.,30.};m.window={5.,25.};m.first=.92+(rng()%160)/1000.;m.last=i%3?1.08-(rng()%160)/1000.:m.first+1e-7;m.has_rate=1;m.playback_start=.25;
    double s=double(rng()%40000)/1000.;
    near(am_rate_integral(s,&m),am_ref_rate_integral(s,&m));
    near(am_rate_inverse(s,&m),am_ref_rate_inverse(s,&m));
    double t=am_playback_from_source(s,&m);
    near(t,am_ref_playback_from_source(s,&m));
    near(am_source_from_playback(t,&m),am_ref_source_from_playback(t,&m));
    assert(std::abs(am_source_from_playback(t,&m)-s)*192000. < 1.);
  }
  std::ifstream f(AM_ASSET_DIR "/TransitionStyles.json");std::string text{std::istreambuf_iterator<char>(f),{}};char err[512]{};
  auto catalog=am_json_parse(text.c_str(),err,sizeof err);assert(catalog&&catalog->count==24);
  auto parameters=am_jobject();am_jset(parameters,"beat_length",am_jnumber(.5));
  am_jset(parameters,"dynamic_beat_length",am_jnumber(.5));am_jset(parameters,"bpm",am_jnumber(120.));
  for(size_t i=0;i<catalog->count;++i) for(int mode=0;mode<2;++mode) {
    int64_t id=int64_t(am_jnum(am_jget(catalog->items[i],"id"),-1));
    am_compiled_style a{},b{};
    if(am_compile_style(catalog,id,{200.,212.},{0.,12.3},parameters,mode,8.,8.,1,&a,err,sizeof err)!=0) {
      std::fprintf(stderr,"template %lld mode %d: %s\n",(long long)id,mode,err);std::abort();
    }
    assert(am_ref_compile_style(catalog,id,{200.,212.},{0.,12.3},parameters,mode,8.,8.,1,&b,err,sizeof err)==0);
    near(a.horizon,b.horizon); near(a.reference,b.reference);
    for(int side=0;side<2;++side) for(int n=0;n<=100;++n) {
      double t=a.horizon*n/100.;near(am_source_from_playback(t,&a.maps[side]),am_ref_source_from_playback(t,&b.maps[side]));
    }
    am_compiled_style_free(&a);am_ref_compiled_style_free(&b);
  }
  am_json_free(parameters);am_json_free(catalog);
}
static void mixing() {
  am_kernel_initialize();
  for(size_t n=0;n<1025;++n) {
    std::vector<float> a(n+8),b(n+8),ga(n+8),gb(n+8),expected(n+8);
    for(size_t i=0;i<a.size();++i) {a[i]=float(int(rng()%1000)-500)/500.;b[i]=float(int(rng()%1000)-500)/500.;ga[i]=float(rng()%1000)/1000.;gb[i]=float(rng()%1000)/1000.;expected[i]=a[i];}
    for(size_t i=1;i<=n;++i) {const float x=a[i]*ga[i],y=b[i]*gb[i];expected[i]=x+y;}
    auto baseline=a;
    am_mix(a.data()+1,b.data()+1,ga.data()+1,gb.data()+1,n);assert(a==expected);
#ifdef TAE_AM_ASM
    a=baseline;am_k_mix_sse2(a.data()+1,b.data()+1,ga.data()+1,gb.data()+1,n);assert(a==expected);
    if(am_kernel_avx2_available()) {a=baseline;am_k_mix_avx2(a.data()+1,b.data()+1,ga.data()+1,gb.data()+1,n);assert(a==expected);}
#endif
  }
}
int main() { scores();selection();timing();mixing();std::puts("AutoMix: 96000 score cases, 3000 selections, 24 templates, clocks and SIMD guards passed"); }
