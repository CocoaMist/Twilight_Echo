#include "AutoMix.h"
#include "TransitionEffects.h"
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>
static thread_local bool realtime=false;
static std::atomic<size_t> rtAllocations{};
static thread_local bool auditing=false;
static std::atomic<size_t> liveBytes{},peakBytes{};
static size_t persistentBytes=0;
struct alignas(std::max_align_t) AllocationHeader {void* raw;size_t bytes;bool counted;};
static void* allocate(size_t n,size_t alignment) {
  if(realtime)++rtAllocations;
  alignment=std::max(alignment,alignof(AllocationHeader));
  if(n>SIZE_MAX-alignment-sizeof(AllocationHeader))throw std::bad_alloc();
  auto* raw=std::malloc((n?n:1)+alignment+sizeof(AllocationHeader));if(!raw)throw std::bad_alloc();
  const auto address=(reinterpret_cast<uintptr_t>(raw)+sizeof(AllocationHeader)+alignment-1)&~(alignment-1);
  auto* header=reinterpret_cast<AllocationHeader*>(address)-1;
  *header={raw,n,auditing};
  if(auditing) {
    const auto current=liveBytes.fetch_add(n)+n;auto peak=peakBytes.load();
    while(peak<current&&!peakBytes.compare_exchange_weak(peak,current)) {}
  }
  return reinterpret_cast<void*>(address);
}
void* operator new(size_t n) {return allocate(n,alignof(std::max_align_t));}
void* operator new[](size_t n) {return ::operator new(n);}
void* operator new(size_t n,std::align_val_t a) {return allocate(n,static_cast<size_t>(a));}
void* operator new[](size_t n,std::align_val_t a) {return ::operator new(n,a);}
void operator delete(void* p) noexcept {
  assert(!realtime);if(!p)return;
  const auto* header=static_cast<AllocationHeader*>(p)-1;
  if(header->counted)liveBytes.fetch_sub(header->bytes);
  std::free(header->raw);
}
void operator delete[](void* p) noexcept {::operator delete(p);}
void operator delete(void* p,size_t) noexcept {::operator delete(p);}
void operator delete[](void* p,size_t) noexcept {::operator delete(p);}
void operator delete(void* p,std::align_val_t) noexcept {::operator delete(p);}
void operator delete[](void* p,std::align_val_t) noexcept {::operator delete(p);}
void operator delete(void* p,size_t,std::align_val_t) noexcept {::operator delete(p);}
void operator delete[](void* p,size_t,std::align_val_t) noexcept {::operator delete(p);}
static void beginAudit() {assert(liveBytes==persistentBytes);peakBytes=liveBytes.load();auditing=true;}
static void endAudit(unsigned rate,unsigned channels,int64_t style,size_t borrowed,size_t budget) {
  auditing=false;
  assert(peakBytes.load()+borrowed<=budget);
  std::printf("prepare allocation audit rate=%u channels=%u style=%lld peak=%zu borrowed=%zu budget=%zu\n",rate,channels,(long long)style,peakBytes.load(),borrowed,budget);
}
static TAE_AM_CandidateV1 candidate(int64_t id,double a,double b) {
  TAE_AM_CandidateV1 c{};c.size=sizeof c;c.abi_version=TAE_AM_ABI_VERSION;c.outgoing_start=a;c.incoming_start=b;c.alias_index=1;c.outgoing_bars=c.incoming_bars=8;c.bpm=120;
  am_candidate_input_init(&c.scoring);c.scoring.style_id=id;c.scoring.path=am_default_route(id).path;c.scoring.outgoing_end=a+2;c.scoring.incoming_end=b+2;return c;
}
int main() {
  TAE_AM_ConfigV1 config{};TAE_AM_DefaultConfig(&config);assert(config.enabled==0&&config.allow_intelligent_skip==1&&config.max_transition_seconds==12);
  // The shared parameter-default map has process lifetime. Measure it once
  // and retain its actual allocation bytes in every subsequent peak check.
  beginAudit();{am_side empty{};twilight::automix::TransitionEffects defaults(48000,2,&empty);}
  endAudit(48000,2,-1,0,config.max_buffer_bytes);persistentBytes=liveBytes.load();assert(persistentBytes<65536);
  std::vector<float> out(48000*4*2),in(out.size());
  for(size_t i=0;i<out.size();++i) {out[i]=static_cast<float>(.1*std::sin(i*.011));in[i]=static_cast<float>(.1*std::sin(i*.017));}
  TAE_AM_PcmViewV1 a{sizeof a,TAE_AM_ABI_VERSION,out.data(),out.size()/2,0,48000,2},b{sizeof b,TAE_AM_ABI_VERSION,in.data(),in.size()/2,0,48000,2};
  size_t count=0;const auto* ids=am_catalog_style_ids(&count);assert(count==24);
  for(size_t i=0;i<count;++i) {
    auto c=candidate(ids[i],.5,.25);
    TAE_AM_Plan plan{};assert(TAE_AM_Compile(&config,&c,&plan)==TAE_AM_OK&&plan);
    TAE_AM_Prepared prepared{};TAE_AM_PreparedInfoV1 info{};info.size=sizeof info;info.abi_version=TAE_AM_ABI_VERSION;
    beginAudit();const auto result=TAE_AM_Prepare(plan,&a,&b,1,1,&prepared,&info);
    endAudit(a.sample_rate,a.channels,ids[i],(a.frames*a.channels+b.frames*b.channels)*sizeof(float),config.max_buffer_bytes);
    if(result!=TAE_AM_OK){std::fprintf(stderr,"prepare style %lld result %d\n",(long long)ids[i],result);std::abort();}
    assert(info.frames==96000&&info.incoming_resume_frame==108000&&info.outgoing_end_frame==120000);
    std::vector<float> full(info.frames*2),chunked(full.size()),scratch(1024*2);
    realtime=true;assert(TAE_AM_MixPrepared(prepared,0,full.data(),info.frames)==info.frames);realtime=false;
    for(size_t frame=0;frame<info.frames;frame+=257) {
      realtime=true;auto n=TAE_AM_MixPrepared(prepared,frame,scratch.data(),std::min<size_t>(257,info.frames-frame));realtime=false;
      std::copy_n(scratch.begin(),n*2,chunked.begin()+frame*2);
    }
    assert(full==chunked);assert(std::all_of(full.begin(),full.end(),[](float x){return std::isfinite(x)&&std::abs(x)<8;}));
    assert(rtAllocations==0);
    TAE_AM_DestroyPrepared(prepared);TAE_AM_DestroyPlan(plan);
    assert(liveBytes==persistentBytes);
  }
  // Fractional half-open source boundaries and low budget, without rate change.
  auto c=candidate(1,.50001,.25001);c.scoring.incoming_end=c.incoming_start+1.99999;
  TAE_AM_Plan plan{};assert(TAE_AM_Compile(&config,&c,&plan)==TAE_AM_OK);
  TAE_AM_Prepared prepared{};TAE_AM_PreparedInfoV1 info{sizeof info,TAE_AM_ABI_VERSION};
  assert(TAE_AM_Prepare(plan,&a,&b,.5f,.25f,&prepared,&info)==TAE_AM_OK);
  assert(info.incoming_resume_frame==108000);assert(info.outgoing_end_frame==120000);
  TAE_AM_DestroyPrepared(prepared);TAE_AM_DestroyPlan(plan);
  config.max_buffer_bytes=1024;assert(TAE_AM_Compile(&config,&c,&plan)==TAE_AM_OK);
  assert(TAE_AM_Prepare(plan,&a,&b,1,1,&prepared,&info)==TAE_AM_RESOURCE_LIMIT&&prepared==nullptr);TAE_AM_DestroyPlan(plan);
  // Bounded pitch-preserving variable-rate preparation, all six target rates.
  for(unsigned rate:{44100u,48000u,88200u,96000u,176400u,192000u}) {
    const unsigned channels=2;std::vector<float> src(rate*3*channels);
    for(size_t i=0;i<src.size();++i) src[i]=static_cast<float>(.05*std::sin(2*3.141592653589793*440*(i/channels)/rate));
    a={sizeof a,TAE_AM_ABI_VERSION,src.data(),src.size()/channels,0,rate,channels};b=a;
    TAE_AM_DefaultConfig(&config);c=candidate(17,.3,.25);c.scoring.incoming_end=.25+2.05;
    assert(TAE_AM_Compile(&config,&c,&plan)==TAE_AM_OK);
    beginAudit();assert(TAE_AM_Prepare(plan,&a,&b,1,1,&prepared,&info)==TAE_AM_OK);
    endAudit(rate,channels,17,(a.frames*a.channels+b.frames*b.channels)*sizeof(float),config.max_buffer_bytes);
    assert(info.incoming_resume_frame==static_cast<uint64_t>(std::floor(2.3*rate)));
    // Preparing a minimum context window must produce exactly the same PCM
    // as a larger borrowed source. Missing real lookahead is rejected rather
    // than silently replacing the incoming continuation with zeros.
    TAE_AM_SourceWindowV1 windows[2]{{sizeof(TAE_AM_SourceWindowV1),TAE_AM_ABI_VERSION},{sizeof(TAE_AM_SourceWindowV1),TAE_AM_ABI_VERSION}};
    TAE_AM_PcmViewV1 cropped[2];
    for(unsigned side=0;side<2;++side) {
      assert(TAE_AM_GetSourceWindow(plan,side,rate,&windows[side])==TAE_AM_OK);
      const auto& w=windows[side];
      assert(w.nominal_first_frame>=w.source_first_frame&&w.nominal_end_frame<w.source_first_frame+w.frames);
      cropped[side]={sizeof(TAE_AM_PcmViewV1),TAE_AM_ABI_VERSION,src.data()+w.source_first_frame*channels,w.frames,w.source_first_frame,rate,channels};
    }
    std::vector<float> mixed(info.frames*channels);assert(TAE_AM_MixPrepared(prepared,0,mixed.data(),info.frames)==info.frames);
    assert(std::all_of(mixed.begin(),mixed.end(),[](float v){return std::isfinite(v);}));
    TAE_AM_Prepared minimum{};TAE_AM_PreparedInfoV1 minimumInfo{sizeof minimumInfo,TAE_AM_ABI_VERSION};
    assert(TAE_AM_Prepare(plan,&cropped[0],&cropped[1],1,1,&minimum,&minimumInfo)==TAE_AM_OK);
    std::vector<float> minimumMixed(mixed.size());
    assert(TAE_AM_MixPrepared(minimum,0,minimumMixed.data(),minimumInfo.frames)==minimumInfo.frames);
    assert(mixed==minimumMixed&&minimumInfo.incoming_resume_frame==info.incoming_resume_frame);
    TAE_AM_DestroyPrepared(minimum);
    auto missingLookahead=cropped[1];--missingLookahead.frames;
    assert(TAE_AM_Prepare(plan,&cropped[0],&missingLookahead,1,1,&minimum,&minimumInfo)==TAE_AM_INVALID&&minimum==nullptr);
    // Analytic source clocks never accumulate the caller's callback size.
    for(unsigned side=0;side<2;++side) {
      auto previous=TAE_AM_PreparedSourceFrame(prepared,side,0);
      assert(previous==windows[side].nominal_first_frame);
      for(uint64_t frame=1;frame<=info.frames;frame+=257) {
        const auto source=TAE_AM_PreparedSourceFrame(prepared,side,frame);
        assert(source>=previous&&source<=windows[side].nominal_end_frame);previous=source;
      }
      assert(TAE_AM_PreparedSourceFrame(prepared,side,info.frames)==windows[side].nominal_end_frame);
    }
    TAE_AM_DestroyPrepared(prepared);TAE_AM_DestroyPlan(plan);
    assert(liveBytes==persistentBytes);
    // Source origin has no previous audio. Signed history coordinates pad
    // before frame zero without wrapping into an enormous source index.
    c=candidate(17,.03,0);c.scoring.incoming_end=2.05;
    assert(TAE_AM_Compile(&config,&c,&plan)==TAE_AM_OK);
    assert(TAE_AM_Prepare(plan,&a,&b,1,1,&prepared,&info)==TAE_AM_OK);
    assert(TAE_AM_PreparedSourceFrame(prepared,1,0)==0);
    assert(info.incoming_resume_frame==static_cast<uint64_t>(std::floor(2.05*rate)));
    std::vector<float> originPcm(257*channels);
    assert(TAE_AM_ReadPreparedSide(prepared,1,0,originPcm.data(),257)==257);
    assert(std::all_of(originPcm.begin(),originPcm.end(),[](float v){return std::isfinite(v);}));
    TAE_AM_DestroyPrepared(prepared);TAE_AM_DestroyPlan(plan);assert(liveBytes==persistentBytes);
  }
  // Largest supported PCM rate, longest allowed transition, mono and stereo.
  // Includes actual Signalsmith/FFT C++ allocations rather than its allowance.
  for(unsigned channels:{1u,2u}) {
    constexpr unsigned rate=192000;std::vector<float> src(rate*13*channels,.01f);
    a={sizeof a,TAE_AM_ABI_VERSION,src.data(),src.size()/channels,0,rate,channels};b=a;
    TAE_AM_DefaultConfig(&config);c=candidate(17,.3,.25);
    c.scoring.outgoing_end=11.9;c.scoring.incoming_end=12.15;
    assert(TAE_AM_Compile(&config,&c,&plan)==TAE_AM_OK);
    beginAudit();const auto result=TAE_AM_Prepare(plan,&a,&b,1,1,&prepared,&info);
    assert(result==(channels==1?TAE_AM_OK:TAE_AM_RESOURCE_LIMIT));
    endAudit(rate,channels,17,(a.frames*a.channels+b.frames*b.channels)*sizeof(float),config.max_buffer_bytes);
    assert(channels==1||prepared==nullptr);
    TAE_AM_DestroyPrepared(prepared);TAE_AM_DestroyPlan(plan);assert(liveBytes==persistentBytes);
  }
  // Candidate identities are preserved across ABI and selection. No dedup.
  std::vector<TAE_AM_CandidateV1> inputs(8,candidate(1,1,0));std::vector<am_score_result> scores(inputs.size());
  TAE_AM_SelectionV1 choice{sizeof choice,TAE_AM_ABI_VERSION};
  assert(TAE_AM_Select(inputs.data(),inputs.size(),UINT64_MAX,1,scores.data(),&choice)==TAE_AM_OK);
  assert(choice.generated_count==8&&choice.known_score_count==8&&choice.has_chosen&&choice.chosen_index<8);
  std::puts("AutoMix prepared: 24 independent templates, SIMD chunk parity, source boundaries, six sample rates, RT zero allocation passed");
}
