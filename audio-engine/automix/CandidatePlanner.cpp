#include "CandidatePlanner.h"
#include "FeaturePostprocess.h"
extern "C" {
#include "recovered/am_json.h"
}
#include <algorithm>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <string_view>

namespace twilight::automix {
namespace {
struct Free {void operator()(am_json* p)const{am_json_free(p);}};
using Json=std::unique_ptr<am_json,Free>;
double number(const am_json* object,const char* name) {
  const auto* value=am_jget(object,name);
  if(!value||value->type!=AM_JNUMBER||!std::isfinite(value->number))throw std::invalid_argument("invalid_feature_number");
  return value->number;
}
bool boolean(const am_json* object,const char* name) {
  const auto* value=am_jget(object,name);
  if(!value||value->type!=AM_JBOOL)throw std::invalid_argument("invalid_feature_boolean");
  return value->number!=0;
}
const am_json* array(const am_json* object,const char* name,size_t max) {
  const auto* value=am_jget(object,name);
  if(!value||value->type!=AM_JARRAY||value->count>max)throw std::invalid_argument("invalid_feature_array");
  return value;
}
struct Stable {double start,end,bpm,confidence;};
struct Window {double start,end;bool vocalKnown{};std::vector<double> beats,downbeats,energy;std::vector<Stable> stable;const am_json* raw;};
Window window(const Json& root,const char* side,double duration) {
  if(!root||number(root.get(),"schemaVersion")!=1||number(root.get(),"analysisVersion")!=analysisVersion||!boolean(root.get(),"available")||
      std::string_view(am_jstr(am_jget(root.get(),"provenance"),""))!="independent-beat-this-yamnet-v1"||
      std::abs(number(root.get(),"durationSeconds")-duration)>.1)throw std::invalid_argument("feature_identity_mismatch");
  const auto* hashes=am_jget(root.get(),"modelHashes");
  if(std::string_view(am_jstr(am_jget(hashes,"beatThis"),""))!="10b8a43f58ec08dec4cf3c0df3ae4c62b8c51b4d96449c318af7f2aa76dc574f"||
      std::string_view(am_jstr(am_jget(hashes,"yamnet"),""))!="564a1406a3173634aedc049863403e581c1fabf2b0e2c22515d924d3ffb160e5")throw std::invalid_argument("feature_model_mismatch");
  const auto* raw=am_jget(am_jget(root.get(),"windows"),side);
  Window result{number(raw,"sourceStart"),number(raw,"sourceEnd"),boolean(raw,"vocalKnown"),{},{},{},{},raw};
  if(result.start<0||result.end<=result.start||result.end>duration+.02||result.end-result.start>45.02)throw std::invalid_argument("invalid_feature_window");
  for(const char* key:{"key","phraseBoundaries"}) {const auto* v=am_jget(raw,key);if(!v||v->type!=AM_JNULL)throw std::invalid_argument("unvalidated_feature_capability");}
  if(number(raw,"energyHopSeconds")!=.02)throw std::invalid_argument("invalid_feature_energy_hop");
  const auto* energy=array(raw,"energyDbfs",2251);
  for(size_t i=0;i<energy->count;++i) {
    if(energy->items[i]->type!=AM_JNUMBER||!std::isfinite(energy->items[i]->number)||energy->items[i]->number<-120||energy->items[i]->number>120)throw std::invalid_argument("invalid_feature_energy");
    result.energy.push_back(energy->items[i]->number);
  }
  if(boolean(raw,"beatKnown")) {
    for(auto [key,dest]:{std::pair{"beats",&result.beats},std::pair{"downbeats",&result.downbeats}}) {
      const auto* times=array(raw,key,2251);
      for(size_t i=0;i<times->count;++i) {
        const auto* t=times->items[i];
        if(!t||t->type!=AM_JNUMBER||!std::isfinite(t->number)||t->number<result.start||t->number>result.end+.02||(!dest->empty()&&t->number<=dest->back()))throw std::invalid_argument("invalid_feature_events");
        dest->push_back(t->number);
      }
    }
    const auto* rows=array(raw,"stableRegions",96);
    for(size_t i=0;i<rows->count;++i) {
      const auto* row=rows->items[i];Stable s{number(row,"start"),number(row,"end"),number(row,"bpm"),number(row,"confidence")};
      if(s.start<result.start||s.end<=s.start||s.end>result.end+.02||s.bpm<40||s.bpm>300||s.confidence<0||s.confidence>1)throw std::invalid_argument("invalid_feature_stability");
      result.stable.push_back(s); // repeated intervals intentionally survive
    }
  }
  if(result.vocalKnown) {
    const auto* rows=array(raw,"vocalWindows",96);
    double previous=-1;
    for(size_t i=0;i<rows->count;++i) {
      const auto* row=rows->items[i];const double a=number(row,"start"),b=number(row,"end"),p=number(row,"probability");
      if(a<result.start||b<a||b>result.end+.1||p<0||p>1||a<previous)throw std::invalid_argument("invalid_feature_vocals");
      previous=a;
    }
  }
  return result;
}
bool nonVocal(const Window& w,double a,double b) {
  if(!w.vocalKnown||a<w.start||b>w.end+.02)return false;
  const auto* rows=am_jget(w.raw,"vocalWindows");double covered=a;
  for(size_t i=0;i<rows->count;++i) {
    const auto* r=rows->items[i];const double start=number(r,"start"),end=number(r,"end");
    if(end<=a||start>=b)continue;
    if(number(r,"probability")>=.15||start>covered+.02)return false;
    covered=std::max(covered,end);
  }
  return covered>=b-.02;
}
bool energyCovered(const Window& w) {
  return !w.energy.empty()&&w.energy.size()*.02>=w.end-w.start-1e-6;
}
double peakEnergy(const Window& w,double a,double b) {
  if(!energyCovered(w)||a<w.start||b>w.end+.0001||b<=a)return INFINITY;
  const auto first=static_cast<size_t>(std::max(0.,std::floor((a-w.start)/.02)));
  const auto end=std::min(w.energy.size(),static_cast<size_t>(std::ceil((b-w.start)/.02)));
  return first<end?*std::max_element(w.energy.begin()+first,w.energy.begin()+end):INFINITY;
}
double silenceSkip(const Window& w,double duration,bool head) {
  if(!energyCovered(w)||(head?std::abs(w.start)>.0001:std::abs(w.end-duration)>.0001))return 0;
  size_t cells=0;
  while(cells<w.energy.size()&&w.energy[head?cells:w.energy.size()-1-cells]<=-60)++cells;
  if(cells==w.energy.size())return 0; // no observed content boundary in this window
  const double silence=std::min(cells*.02,w.end-w.start);
  if(silence<.5)return 0;
  // Keep 100 ms of verified silence around real content, and never exceed the
  // user's source-skip budget. No active phrase or low-level decay is removed.
  const double skip=std::min({silence-.1,12.,duration*.1});
  if(!nonVocal(w,head?0:duration-skip,head?skip:duration))return 0;
  return skip;
}
double energyAt(const Window& w,double time) {
  if(!energyCovered(w)||time<w.start||time>=w.end)return -INFINITY;
  const auto cell=static_cast<size_t>((time-w.start)/.02);
  return cell<w.energy.size()?w.energy[cell]:-INFINITY;
}
double predictedOverlap(const Window& out,const Window& in,const TAE_AM_CandidateV1& c,double q) {
  const double lo=c.scoring.outgoing_end-c.outgoing_start;
  const double horizon=std::abs(q-1)<1e-8?lo:lo*std::log(q)/(q-1);
  const double outPeak=peakEnergy(out,c.outgoing_start,c.scoring.outgoing_end);
  const double inPeak=peakEnergy(in,c.incoming_start,c.scoring.incoming_end);
  if(!std::isfinite(outPeak)||!std::isfinite(inPeak))return 0;
  double joint=0;
  for(double t=.01;t<horizon;t+=.02) {
    const double offset=std::abs(q-1)<1e-8?t:lo*std::expm1((q-1)*t/lo)/(q-1);
    const double inOffset=offset/q;
    const bool equalPower=c.scoring.style_id==1||c.scoring.style_id==7;
    const double og=equalPower?std::sqrt(std::max(0.,1-offset/lo)):std::min(1.,(lo-offset)/.3);
    const double ig=equalPower?std::sqrt(offset/lo):std::min(1.,inOffset/.3);
    if(og>0&&ig>0&&energyAt(out,c.outgoing_start+offset)+20*std::log10(og)>=std::max(-48.,outPeak-24)&&
       energyAt(in,c.incoming_start+inOffset)+20*std::log10(ig)>=std::max(-48.,inPeak-24))joint+=.02;
  }
  // Input-side estimate only. The preparation worker verifies actual filtered,
  // stretched, envelope-weighted contributions before calling this a mix.
  return joint;
}
TAE_AM_CandidateV1 fallback(double a,double seconds) {
  TAE_AM_CandidateV1 c{};c.size=sizeof c;c.abi_version=TAE_AM_ABI_VERSION;c.alias_index=1;c.bpm=120;
  c.outgoing_start=a-seconds;c.incoming_start=0;
  am_candidate_input_init(&c.scoring);c.scoring.path=AM_PATH_FALLBACK_CROSSFADE;c.scoring.style_id=1;
  c.scoring.outgoing_end=a;c.scoring.incoming_end=seconds;
  return c;
}
}
CandidatePool generateCandidates(const TAE_AM_ConfigV1& config,double outDuration,double inDuration,const std::string& outFeatures,const std::string& inFeatures) {
  CandidatePool result;
  if(!std::isfinite(outDuration)||!std::isfinite(inDuration)||outDuration<10||inDuration<10) {result.reason="short_or_unknown_duration";return result;}
  const double max=std::min({config.max_transition_seconds,outDuration*.5,inDuration*.5});
  result.candidates.push_back(fallback(outDuration,std::min(4.,max)));
  result.quality.push_back({});
  result.reason="analysis_unavailable_conservative_crossfade";
  if(outFeatures.empty()||inFeatures.empty())return result;
  try {
    if(outFeatures.size()>512*1024||inFeatures.size()>512*1024)throw std::invalid_argument("feature_resource_limit");
    char error[256]{};Json a(am_json_parse(outFeatures.c_str(),error,sizeof error)),b(am_json_parse(inFeatures.c_str(),error,sizeof error));
    const auto out=window(a,"tail",outDuration),in=window(b,"head",inDuration);
    // Only verified channel-safe silence is skippable without phrase/key
    // classifiers. These features never become Apple native analysis signals.
    const double outSkip=config.allow_intelligent_skip?silenceSkip(out,outDuration,false):0;
    const double inStart=config.allow_intelligent_skip?silenceSkip(in,inDuration,true):0;
    const double outEnd=outDuration-outSkip;
    // Recovered soft-skip style 5 requires no native loudness/key/tempo signal.
    // An independently confirmed quiet decay (or boundary silence) supports its
    // short filter transition even when a tail no longer contains steady beats.
    const double shortLength=std::min(2.,max);
    const double tailPeak=peakEnergy(out,outEnd-1,outEnd);
    const double precedingPeak=peakEnergy(out,outEnd-3,outEnd-1);
    const bool quietDecay=std::isfinite(tailPeak)&&std::isfinite(precedingPeak)&&
        tailPeak<=-35&&precedingPeak>=tailPeak+6;
    const bool noClash=nonVocal(out,outEnd-shortLength,outEnd)||nonVocal(in,inStart,inStart+shortLength);
    if((outSkip>0||inStart>0||quietDecay)&&shortLength>=.3&&outEnd>=shortLength&&
        inStart+shortLength<=inDuration&&noClash) {
      auto c=fallback(outEnd,shortLength);c.incoming_start=inStart;c.scoring.incoming_end=inStart+shortLength;
      c.scoring.style_id=5;c.scoring.path=AM_PATH_SOFT_SKIP;
      result.candidates.push_back(c);
      result.quality.push_back({1,0,1,outSkip>0||inStart>0?"independent_silence_boundaries":"independent_quiet_outro"});
    }
    // Preserve all source music. With unmatched/unknown tempo, an independently
    // audible, non-vocal-overlap window can still use the recovered equal-power
    // envelope. It is explicitly labelled unaligned musical overlap.
    double previousLength=0;
    for(double requested:{4.,6.,8.}) {
      const double length=std::min(requested,max);
      if(length<4||length==previousLength)continue;previousLength=length;
      auto c=fallback(outEnd,length);c.incoming_start=inStart;c.scoring.incoming_end=inStart+length;
      if(!(nonVocal(out,outEnd-length,outEnd)||nonVocal(in,inStart,inStart+length)))continue;
      const double joint=predictedOverlap(out,in,c,1);
      if(joint<2)continue;
      result.candidates.push_back(c);result.quality.push_back({2,joint,1,"independent_musical_overlap"});
    }
    // Independently confident windows enter the recovered filtered-direct path
    // only when reciprocal rate ramps can align them within the product limit.
    // This is our compensated-tempo eligibility rule, not Apple's unrecovered
    // strict-tempo classifier. No native loudness signal or nil is inferred.
    bool confidentPair=false,tempoPair=false,tailPair=false,headPair=false,vocalPair=false;
    for(const auto& os:out.stable)for(const auto& is:in.stable) {
      if(os.confidence<.8||is.confidence<.8)continue;
      confidentPair=true;
      double alias=1,distance=std::abs(std::log(os.bpm/is.bpm));unsigned aliasIndex=1;
      for(auto [value,index]:{std::pair{.5,0u},std::pair{2.,2u}}) {
        const double d=std::abs(std::log(os.bpm/(is.bpm*value)));
        if(d<distance) {distance=d;alias=value;aliasIndex=index;}
      }
      const double q=is.bpm*alias/os.bpm;
      // Recovered reciprocal linear ramps keep interpreted beats synchronized:
      // sourceOut-startOut = q*(sourceIn-startIn). All actual rates are bounded.
      if(std::min(q,1/q)<.92||std::max(q,1/q)>1.08)continue;
      tempoPair=true;
      // Include the actual head prefix instead of requiring a beat at t=0.
      // Align the outgoing downbeat with a known early incoming downbeat.
      // Extend only over a short observed decay beyond the stable tail.
      // Aliases describe beat interpretation, never half/double source speed.
      const double tailGap=outEnd-os.end;
      if(tailGap>6)continue;
      if(tailGap>2&&(!nonVocal(out,os.end,outEnd)||peakEnergy(out,os.end,outEnd)>-24))continue;
      tailPair=true;
      for(const double anchor:in.downbeats) {
      if(anchor<is.start||anchor>is.end||anchor<inStart||anchor-inStart>std::min(2.,2*60/is.bpm))continue;
      headPair=true;
      for(size_t i=0;i<out.downbeats.size();++i) {
        const double start=out.downbeats[i]-q*(anchor-inStart),length=outEnd-start,inLength=length/q;
        const double horizon=std::abs(q-1)<1e-8?length:length*std::log(q)/(q-1);
        if(start<os.start-60/os.bpm||horizon<4||horizon>max||os.end-start<std::min(4*60/os.bpm,length*.5))continue;
        if(!(nonVocal(out,start,outEnd)||nonVocal(in,inStart,inStart+inLength)))continue;
        vocalPair=true;
        const auto beatCount=std::count_if(in.beats.begin(),in.beats.end(),[inStart,inLength](double t){return t>=inStart&&t<inStart+inLength;});
        int64_t normalized=0;
        if(am_normalized_incoming_beats(beatCount,alias,&normalized)!=AM_SCORING_OK||normalized<4||inStart+inLength>is.end)continue;
        TAE_AM_CandidateV1 c=fallback(outEnd,length);c.incoming_start=inStart;c.scoring.incoming_end=inStart+inLength;
        c.scoring.style_id=8;c.scoring.path=AM_PATH_FILTERED_DIRECT;c.bpm=os.bpm;c.alias_index=aliasIndex;
        auto& signals=c.scoring.signals;
        signals.strict_tempo_compatible={true,false,false,true};
        signals.incoming_beat_count={true,false,false,beatCount};
        signals.tempo_alias={true,false,false,alias};
        // Natural mode uses the recovered catalogue's full-envelope beat-mix
        // template 7. Its independent assignment is distinct from style 8's
        // recovered score; filtered entry often masks music in fading tails.
        auto render=c;render.scoring.style_id=7;
        const double joint=predictedOverlap(out,in,render,q);if(joint<2)continue;
        if(result.candidates.size()==4096)throw std::length_error("candidate_resource_limit");
        result.candidates.push_back(c);
        result.quality.push_back({3,joint,q,"independent_beat_tempo_mix",7});
      }
      }
    }
    const bool beatCandidate=std::any_of(result.candidates.begin(),result.candidates.end(),[](const auto& c){return c.scoring.style_id==8;});
    if(beatCandidate)result.reason="independent_beat_tempo_mix";
    else if(std::any_of(result.quality.begin(),result.quality.end(),[](const auto& q){return q.tier==2;}))result.reason="independent_musical_overlap";
    else if(result.candidates.size()>1)result.reason=outSkip>0||inStart>0?"independent_silence_boundaries":"independent_quiet_outro";
    else if(out.beats.empty()||in.beats.empty())result.reason="beat_events_unavailable";
    else if(!confidentPair)result.reason="stable_regions_unavailable";
    else if(!tempoPair)result.reason="tempo_mismatch_conservative";
    else if(!tailPair)result.reason="tail_beat_coverage_missing";
    else if(!headPair)result.reason="intro_beat_coverage_missing";
    else if(!vocalPair)result.reason="vocal_overlap_or_unknown";
    else result.reason="insufficient_confident_regions";
  } catch(const std::exception& e) {result.candidates.resize(1);result.quality.resize(1);result.reason=e.what();}
  return result;
}
size_t selectCandidate(const CandidatePool& pool,uint64_t seed,unsigned maximumTier) {
  if(pool.candidates.empty()||pool.quality.size()!=pool.candidates.size())throw std::invalid_argument("invalid_candidate_pool");
  unsigned tier=0;for(const auto& q:pool.quality)if(q.tier<=maximumTier)tier=std::max(tier,q.tier);
  std::vector<TAE_AM_CandidateV1> eligible;std::vector<size_t> indexes;
  for(size_t i=0;i<pool.candidates.size();++i)if(pool.quality[i].tier==tier) {eligible.push_back(pool.candidates[i]);indexes.push_back(i);}
  std::vector<am_score_result> scores(eligible.size());TAE_AM_SelectionV1 choice{sizeof choice,TAE_AM_ABI_VERSION};
  if(TAE_AM_Select(eligible.data(),eligible.size(),seed,1,scores.data(),&choice)!=TAE_AM_OK||!choice.has_chosen)
    throw std::runtime_error("candidate_selection_failed");
  return indexes[choice.chosen_index];
}
TAE_AM_CandidateV1 candidateForRendering(const CandidatePool& pool,size_t index) {
  auto c=pool.candidates.at(index);const auto style=pool.quality.at(index).renderStyle;
  if(style)c.scoring.style_id=style;
  return c;
}
}
