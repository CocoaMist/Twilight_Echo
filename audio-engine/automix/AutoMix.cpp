#include "AutoMix.h"
#include "EmbeddedAssets.h"
#include "Kernels.h"
#include "TransitionEffects.h"
#include "vendor/signalsmith-stretch.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string_view>
#include <vector>

namespace {
static_assert(sizeof(TAE_AM_ConfigV1)==40 && offsetof(TAE_AM_ConfigV1,max_transition_seconds)==24);
static_assert(sizeof(am_ramp)==136 && offsetof(am_ramp,curve)==128);
static_assert(sizeof(am_rate_map)==80 && offsetof(am_rate_map,has_rate)==72);
constexpr std::uint64_t maxPcmBytes=128ULL*1024*1024;
constexpr std::size_t maxCandidates=4096;
template<class T> bool version(const T* value) {return value&&value->size==sizeof(T)&&value->abi_version==TAE_AM_ABI_VERSION;}
struct JsonFree {void operator()(am_json* p) const {am_json_free(p);}};
using Json=std::unique_ptr<am_json,JsonFree>;
struct Plan {
  TAE_AM_ConfigV1 config{};TAE_AM_CandidateV1 candidate{};am_compiled_style style{};
  ~Plan(){am_compiled_style_free(&style);}
};
struct Prepared {
  TAE_AM_PreparedInfoV1 info{};
  am_rate_map maps[2]{};
  std::vector<float> outgoing,incoming,outGain,inGain;
};
bool validConfig(const TAE_AM_ConfigV1* c) {
  return version(c)&&c->enabled<=1&&c->allow_intelligent_skip<=1&&std::isfinite(c->max_transition_seconds)&&c->max_transition_seconds>0&&c->max_transition_seconds<=12&&c->max_buffer_bytes>0&&c->max_buffer_bytes<=maxPcmBytes;
}
std::uint64_t sourceFrame(double seconds,unsigned rate) {
  const double frame=seconds*rate;
  if(!std::isfinite(frame)||frame<0||frame>=static_cast<double>(INT64_MAX)) throw std::invalid_argument("Invalid source frame");
  return static_cast<std::uint64_t>(std::floor(frame));
}
std::uint64_t playbackFrame(double seconds,unsigned rate) {return sourceFrame(seconds+(.5/rate),rate);}
struct ReadChannel {
  const TAE_AM_PcmViewV1* pcm;std::int64_t base;unsigned channel;
  float operator[](std::size_t frame) const {
    const auto source=base+static_cast<std::int64_t>(frame);
    return source<0||static_cast<uint64_t>(source)<pcm->source_first_frame||static_cast<uint64_t>(source)-pcm->source_first_frame>=pcm->frames?0:pcm->samples[(source-pcm->source_first_frame)*pcm->channels+channel];
  }
};
struct ReadChannels {
  const TAE_AM_PcmViewV1* pcm;std::int64_t base;
  ReadChannel operator[](unsigned channel) const {return {pcm,base,channel};}
};
struct WriteChannels {
  float* data;unsigned channels;
  struct Channel {float* data;unsigned stride;float& operator[](std::size_t i) const{return data[i*stride];}};
  Channel operator[](unsigned channel) const{return {data+channel,channels};}
};
bool validPcm(const TAE_AM_PcmViewV1* p) {
  return version(p)&&p->samples&&p->frames&&p->frames<=maxPcmBytes/sizeof(float)/std::max(p->channels,1u)&&p->source_first_frame<=INT64_MAX-p->frames&&p->channels>=1&&p->channels<=2&&p->sample_rate>=44100&&p->sample_rate<=192000;
}
TAE_AM_SourceWindowV1 sourceWindow(const Plan& plan,unsigned side,unsigned rate) {
  const auto& map=plan.style.maps[side];
  const auto first=sourceFrame(map.source.start,rate),end=sourceFrame(map.source.end,rate);
  if(end<first)throw std::invalid_argument("Invalid source range");
  // Pinned default preset has a 120 ms block and 30 ms interval. 300 ms
  // bounds its history and analytic 0.92–1.08 lookahead, with one processing
  // block of rounding margin. Querying does not instantiate an FFT workspace.
  const uint64_t context=map.has_rate&&(map.first!=1||map.last!=1)?static_cast<uint64_t>(std::ceil(.3*rate))+256:0;
  const auto start=first>context?first-context:0;
  if(end>INT64_MAX-context)throw std::invalid_argument("Invalid context range");
  return {sizeof(TAE_AM_SourceWindowV1),TAE_AM_ABI_VERSION,start,end+context-start,first,end};
}
void prepareSide(const Plan& plan,const TAE_AM_PcmViewV1& pcm,unsigned side,float trackGain,Prepared& output,uint64_t budget) {
  const auto& map=plan.style.maps[side];const auto frames=output.info.frames;
  const auto start=playbackFrame(map.playback_start,pcm.sample_rate),length=playbackFrame(map.duration,pcm.sample_rate);
  const auto sourceStart=sourceFrame(map.source.start,pcm.sample_rate),sourceEnd=sourceFrame(map.source.end,pcm.sample_rate);
  if(sourceStart<pcm.source_first_frame||sourceEnd>pcm.source_first_frame+pcm.frames) throw std::invalid_argument("PCM window does not cover the compiled source range");
  auto& samples=side?output.incoming:output.outgoing;auto& gains=side?output.inGain:output.outGain;
  const auto effectBudget=twilight::automix::TransitionEffects::maximumMemoryBytes(pcm.sample_rate,pcm.channels,&plan.style.sides[side]);
  if(output.info.memory_bytes+effectBudget>budget)throw std::length_error("Transition effect memory limit");
  twilight::automix::TransitionEffects effects(pcm.sample_rate,pcm.channels,&plan.style.sides[side]);
  const bool variable=map.has_rate&&(map.first!=1||map.last!=1);
  if(variable&&(std::min(map.first,map.last)<.92||std::max(map.first,map.last)>1.08)) throw std::invalid_argument("Natural playback rate exceeds 0.92–1.08");
  const auto required=sourceWindow(plan,side,pcm.sample_rate);
  if(required.source_first_frame<pcm.source_first_frame||required.source_first_frame+required.frames>pcm.source_first_frame+pcm.frames)
    throw std::invalid_argument("PCM window does not cover stretch context");
  std::vector<float> stretched;
  std::uint64_t transient=0;
  if(variable&&length) {
    // Pinned Signalsmith 1.3.2 default-preset allocation audit includes STFT,
    // FFT plans and band/prediction state. Four seconds underestimated that
    // workspace; 24 seconds plus 1 MiB bounds the tested six-rate matrix with
    // margin. Preparation may reject a long high-rate plan before allocation.
    const uint64_t workspace=24ULL*pcm.sample_rate*pcm.channels*sizeof(float)+1024*1024;
    if(output.info.memory_bytes+effectBudget+length*pcm.channels*sizeof(float)+workspace>budget)
      throw std::length_error("Transition stretch memory limit");
    signalsmith::stretch::SignalsmithStretch<float> stretch(0x4155544F);
    stretch.presetDefault(pcm.channels,static_cast<float>(pcm.sample_rate));
    const auto inputLatency=static_cast<std::uint64_t>(stretch.inputLatency()),outputLatency=static_cast<std::uint64_t>(stretch.outputLatency());
    transient=(length+outputLatency)*pcm.channels*sizeof(float);
    if(output.info.memory_bytes+effects.memoryBytes()+transient+workspace>budget)
      throw std::length_error("Transition preparation memory limit");
    stretched.resize((length+outputLatency)*pcm.channels);
    const auto history=static_cast<uint64_t>(stretch.seekLength());
    const auto historyStart=static_cast<int64_t>(sourceStart)+static_cast<int64_t>(inputLatency)-static_cast<int64_t>(history);
    if(historyStart>=0&&static_cast<uint64_t>(historyStart)<pcm.source_first_frame)
      throw std::invalid_argument("Insufficient stretch history");
    stretch.seek(ReadChannels{&pcm,historyStart},static_cast<int>(history),map.first);
    std::uint64_t inputCursor=sourceStart+inputLatency;
    // Quantize each analytic source boundary once. Never accumulate truncated
    // per-block frame deltas, which drift and can replay the incoming prefix.
    for(std::uint64_t frame=0;frame<length+outputLatency;) {
      const auto block=std::min<std::uint64_t>(128,length+outputLatency-frame);
      const double processingTime=map.playback_start+static_cast<double>(frame+block)/pcm.sample_rate;
      const auto next=sourceFrame(am_source_from_playback(processingTime,&map),pcm.sample_rate)+inputLatency;
      if(next<inputCursor||next-inputCursor>256||next>pcm.source_first_frame+pcm.frames) throw std::invalid_argument("Invalid variable source clock or lookahead");
      stretch.process(ReadChannels{&pcm,static_cast<int64_t>(inputCursor)},static_cast<int>(next-inputCursor),WriteChannels{stretched.data()+frame*pcm.channels,pcm.channels},static_cast<int>(block));
      inputCursor=next;frame+=block;
    }
    std::move(stretched.begin()+outputLatency*pcm.channels,stretched.end(),stretched.begin());
    stretched.resize(length*pcm.channels);
  }
  if(output.info.memory_bytes+effects.memoryBytes()+transient>budget) throw std::length_error("Transition effect memory limit");
  std::array<float,2> frameSamples{};
  for(std::uint64_t frame=0;frame<length&&start+frame<frames;++frame) {
    const auto destination=(start+frame)*pcm.channels;
    if(variable) for(unsigned c=0;c<pcm.channels;++c) frameSamples[c]=stretched[frame*pcm.channels+c];
    else for(unsigned c=0;c<pcm.channels;++c) frameSamples[c]=sourceStart+frame<sourceEnd?ReadChannel{&pcm,static_cast<int64_t>(sourceStart),c}[frame]:0;
    const double time=am_source_from_playback(map.playback_start+static_cast<double>(frame)/pcm.sample_rate,&map);
    effects.process(frameSamples.data(),time,plan.candidate.bpm);
    const double gain=am_control(&plan.style.sides[side],"out_gain",time,1)*trackGain;
    if(!std::isfinite(gain)) throw std::invalid_argument("Non-finite transition gain");
    for(unsigned c=0;c<pcm.channels;++c) {
      if(!std::isfinite(frameSamples[c])) throw std::invalid_argument("Non-finite transition PCM");
      samples[destination+c]=frameSamples[c];gains[destination+c]=static_cast<float>(gain);
    }
  }
}
}
extern "C" {
int TAE_AM_ExperimentalPlayerAllowed(void) {
#if defined(TAE_AM_ASM)
  if(const auto* explicitFlag=std::getenv("TAE_AUTOMIX_EXPERIMENTAL"))
    return std::string_view(explicitFlag)=="1";
#if defined(TAE_AM_EXPERIMENTAL_PLAYER)
  return 1;
#endif
#endif
  return 0;
}
void TAE_AM_DefaultConfig(TAE_AM_ConfigV1* c) {
  if(c) *c={sizeof(*c),TAE_AM_ABI_VERSION,0,0,1,12,maxPcmBytes};
}
TAE_AM_Result TAE_AM_Select(const TAE_AM_CandidateV1* candidates,size_t count,uint64_t seed,int hasSeed,am_score_result* scores,TAE_AM_SelectionV1* selected) {
  if(!version(selected)||count>maxCandidates||(count&&(!candidates||!scores))) return count>maxCandidates?TAE_AM_RESOURCE_LIMIT:TAE_AM_INVALID;
  *selected={sizeof(*selected),TAE_AM_ABI_VERSION,UINT64_MAX,count,0,0,AM_SELECTION_NO_POSITIVE_CANDIDATE};
  try {
    std::vector<am_selection_candidate> inputs;inputs.reserve(count);
    for(size_t i=0;i<count;++i) {
      if(!version(candidates+i)) return TAE_AM_INVALID;
      if(am_evaluate_candidate(&candidates[i].scoring,scores+i)!=AM_SCORING_OK) return TAE_AM_INVALID;
      const auto route=am_default_route(candidates[i].scoring.style_id);
      inputs.push_back({route.algorithm,route.style_id,scores[i].score_known,scores[i].score,i});
      selected->known_score_count+=scores[i].score_known?1:0;
    }
    am_selection_result result{};
    const auto error=am_select_candidates(inputs.data(),count,AM_SELECT_NATIVE_WEIGHTED,hasSeed!=0,seed,&result);
    selected->selection_status=result.status;selected->has_chosen=result.has_chosen;selected->chosen_index=result.chosen_index;
    am_selection_result_free(&result);
    return error==AM_SCORING_OK?TAE_AM_OK:error==AM_SCORING_OVERFLOW?TAE_AM_RESOURCE_LIMIT:TAE_AM_INVALID;
  } catch(...) {return TAE_AM_INTERNAL;}
}
TAE_AM_Result TAE_AM_Compile(const TAE_AM_ConfigV1* config,const TAE_AM_CandidateV1* candidate,TAE_AM_Plan* output) {
  if(output)*output=nullptr;
  if(!output||!validConfig(config)||!version(candidate)||!std::isfinite(candidate->bpm)||candidate->bpm<20||candidate->bpm>300||candidate->outgoing_start<0||candidate->incoming_start<0) return TAE_AM_INVALID;
  try {
    char error[256]{};Json catalogue(am_json_parse(amTransitionCatalogue,error,sizeof error));Json parameters(am_jobject());
    if(!catalogue||!parameters) return TAE_AM_INTERNAL;
    am_jset(parameters.get(),"bpm",am_jnumber(candidate->bpm));am_jset(parameters.get(),"beat_length",am_jnumber(60/candidate->bpm));am_jset(parameters.get(),"dynamic_beat_length",am_jnumber(60/candidate->bpm));
    auto plan=std::make_unique<Plan>();plan->config=*config;plan->candidate=*candidate;
    if(am_compile_style(catalogue.get(),candidate->scoring.style_id,{candidate->outgoing_start,candidate->scoring.outgoing_end},{candidate->incoming_start,candidate->scoring.incoming_end},parameters.get(),candidate->unstructured!=0,candidate->outgoing_bars,candidate->incoming_bars,candidate->alias_index,&plan->style,error,sizeof error)) return TAE_AM_INVALID;
    if(!std::isfinite(plan->style.horizon)||plan->style.horizon<=0||plan->style.horizon>config->max_transition_seconds) return TAE_AM_RESOURCE_LIMIT;
    am_kernel_initialize();*output=plan.release();return TAE_AM_OK;
  } catch(...) {return TAE_AM_INTERNAL;}
}
void TAE_AM_DestroyPlan(TAE_AM_Plan plan) {delete static_cast<Plan*>(plan);}
TAE_AM_Result TAE_AM_GetSourceWindow(TAE_AM_Plan opaque,uint32_t side,uint32_t rate,TAE_AM_SourceWindowV1* window) {
  if(!opaque||side>1||rate<44100||rate>192000||!version(window))return TAE_AM_INVALID;
  try {*window=sourceWindow(*static_cast<const Plan*>(opaque),side,rate);return TAE_AM_OK;}
  catch(...) {return TAE_AM_INVALID;}
}
TAE_AM_Result TAE_AM_Prepare(TAE_AM_Plan opaque,const TAE_AM_PcmViewV1* out,const TAE_AM_PcmViewV1* in,float outGain,float inGain,TAE_AM_Prepared* result,TAE_AM_PreparedInfoV1* info) {
  if(result)*result=nullptr;
  if(!opaque||!result||!version(info)||!validPcm(out)||!validPcm(in)||!std::isfinite(outGain)||!std::isfinite(inGain)||outGain<0||inGain<0) return TAE_AM_INVALID;
  if(out->sample_rate!=in->sample_rate||out->channels!=in->channels) return TAE_AM_UNSUPPORTED;
  try {
    const auto& plan=*static_cast<Plan*>(opaque);const auto frames=playbackFrame(plan.style.horizon,out->sample_rate);
    const auto borrowedBytes=(out->frames*out->channels+in->frames*in->channels)*sizeof(float);
    if(borrowedBytes>=plan.config.max_buffer_bytes)return TAE_AM_RESOURCE_LIMIT;
    const auto budget=plan.config.max_buffer_bytes-borrowedBytes;
    const auto samples=frames*out->channels;
    if(!frames||samples>budget/(4*sizeof(float))) return TAE_AM_RESOURCE_LIMIT;
    auto buffer=std::make_unique<Prepared>();
    buffer->maps[0]=plan.style.maps[0];buffer->maps[1]=plan.style.maps[1];
    buffer->info={sizeof(*info),TAE_AM_ABI_VERSION,frames,samples*4*sizeof(float),sourceFrame(plan.style.maps[1].source.end,in->sample_rate),sourceFrame(plan.style.maps[0].source.end,out->sample_rate),out->sample_rate,out->channels,plan.style.style_id,static_cast<double>(frames)/out->sample_rate,plan.style.maps[0].source.start,plan.style.maps[1].source.start};
    buffer->outgoing.resize(samples);buffer->incoming.resize(samples);buffer->outGain.resize(samples);buffer->inGain.resize(samples);
    prepareSide(plan,*out,0,outGain,*buffer,budget);prepareSide(plan,*in,1,inGain,*buffer,budget);
    *info=buffer->info;*result=buffer.release();return TAE_AM_OK;
  } catch(const std::length_error&) {return TAE_AM_RESOURCE_LIMIT;}
  catch(const std::invalid_argument&) {return TAE_AM_INVALID;}
  catch(...) {return TAE_AM_INTERNAL;}
}
void TAE_AM_DestroyPrepared(TAE_AM_Prepared p) {delete static_cast<Prepared*>(p);}
TAE_AM_Result TAE_AM_InspectPrepared(TAE_AM_Prepared opaque,TAE_AM_MixEvidenceV1* evidence) {
  if(!opaque||!version(evidence))return TAE_AM_INVALID;
  const auto& p=*static_cast<const Prepared*>(opaque);
  const auto hop=std::max(1u,p.info.sample_rate/50),channels=p.info.channels;
  const auto energy=[&](uint64_t first,uint64_t end,unsigned side) {
    const auto& samples=side?p.incoming:p.outgoing;const auto& gain=side?p.inGain:p.outGain;
    double peakChannel=0;
    for(unsigned c=0;c<channels;++c) {
      double sum=0;for(auto f=first;f<end;++f) {const auto i=f*channels+c;const double x=double(samples[i])*gain[i];sum+=x*x;}
      peakChannel=std::max(peakChannel,sum/(end-first));
    }
    return peakChannel;
  };
  double peak[2]{};
  for(uint64_t first=0;first<p.info.frames;first+=hop)for(unsigned side=0;side<2;++side)
    peak[side]=std::max(peak[side],energy(first,std::min<uint64_t>(first+hop,p.info.frames),side));
  // Each contribution must exceed -48 dBFS and remain within 24 dB of its
  // own prepared peak. This is a measurable eligibility floor, not a hearing
  // or naturalness score; quiet tails cannot inflate the musical-mix count.
  const double threshold[2]{std::max(std::pow(10.,-4.8),peak[0]*std::pow(10.,-2.4)),
                            std::max(std::pow(10.,-4.8),peak[1]*std::pow(10.,-2.4))};
  uint64_t total=0,run=0,longest=0;
  for(uint64_t first=0;first<p.info.frames;first+=hop) {
    const auto end=std::min<uint64_t>(first+hop,p.info.frames);
    if(energy(first,end,0)>=threshold[0]&&energy(first,end,1)>=threshold[1]) {total+=end-first;run+=end-first;longest=std::max(longest,run);}
    else run=0;
  }
  *evidence={sizeof(*evidence),TAE_AM_ABI_VERSION,double(total)/p.info.sample_rate,double(longest)/p.info.sample_rate};
  return TAE_AM_OK;
}
size_t TAE_AM_MixPrepared(TAE_AM_Prepared opaque,uint64_t first,float* output,size_t frames) {
  const auto* p=static_cast<const Prepared*>(opaque);if(!p||!output||first>=p->info.frames) return 0;
  frames=std::min<std::uint64_t>(frames,p->info.frames-first);const auto n=frames*p->info.channels,offset=first*p->info.channels;
  std::memcpy(output,p->outgoing.data()+offset,n*sizeof(float));
  am_mix(output,p->incoming.data()+offset,p->outGain.data()+offset,p->inGain.data()+offset,n);return frames;
}
uint64_t TAE_AM_PreparedSourceFrame(TAE_AM_Prepared opaque,uint32_t side,uint64_t frame) {
  const auto* p=static_cast<const Prepared*>(opaque);
  if(!p||side>1)return 0;
  if(frame>=p->info.frames)return side?p->info.incoming_resume_frame:p->info.outgoing_end_frame;
  const auto& map=p->maps[side];
  const double source=am_source_from_playback(static_cast<double>(frame)/p->info.sample_rate,&map);
  return static_cast<uint64_t>(std::floor(std::clamp(source,map.source.start,map.source.end)*p->info.sample_rate));
}
size_t TAE_AM_ReadPreparedSide(TAE_AM_Prepared opaque,uint32_t side,uint64_t first,float* output,size_t frames) {
  const auto* p=static_cast<const Prepared*>(opaque);
  if(!p||side>1||!output||first>=p->info.frames)return 0;
  frames=std::min<uint64_t>(frames,p->info.frames-first);
  const auto& samples=side?p->incoming:p->outgoing;
  std::memcpy(output,samples.data()+first*p->info.channels,frames*p->info.channels*sizeof(float));
  return frames;
}
}
