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
struct Window {double start,end;bool vocalKnown{};std::vector<double> beats,downbeats;std::vector<Stable> stable;const am_json* raw;};
Window window(const Json& root,const char* side,double duration) {
  if(!root||number(root.get(),"schemaVersion")!=1||number(root.get(),"analysisVersion")!=analysisVersion||!boolean(root.get(),"available")||
      std::string_view(am_jstr(am_jget(root.get(),"provenance"),""))!="independent-beat-this-yamnet-v1"||
      std::abs(number(root.get(),"durationSeconds")-duration)>.1)throw std::invalid_argument("feature_identity_mismatch");
  const auto* hashes=am_jget(root.get(),"modelHashes");
  if(std::string_view(am_jstr(am_jget(hashes,"beatThis"),""))!="10b8a43f58ec08dec4cf3c0df3ae4c62b8c51b4d96449c318af7f2aa76dc574f"||
      std::string_view(am_jstr(am_jget(hashes,"yamnet"),""))!="564a1406a3173634aedc049863403e581c1fabf2b0e2c22515d924d3ffb160e5")throw std::invalid_argument("feature_model_mismatch");
  const auto* raw=am_jget(am_jget(root.get(),"windows"),side);
  Window result{number(raw,"sourceStart"),number(raw,"sourceEnd"),boolean(raw,"vocalKnown"),{},{},{},raw};
  if(result.start<0||result.end<=result.start||result.end>duration+.02||result.end-result.start>45.02)throw std::invalid_argument("invalid_feature_window");
  for(const char* key:{"key","phraseBoundaries"}) {const auto* v=am_jget(raw,key);if(!v||v->type!=AM_JNULL)throw std::invalid_argument("unvalidated_feature_capability");}
  if(number(raw,"energyHopSeconds")!=.02)throw std::invalid_argument("invalid_feature_energy_hop");
  const auto* energy=array(raw,"energyDbfs",2251);
  for(size_t i=0;i<energy->count;++i)if(energy->items[i]->type!=AM_JNUMBER||!std::isfinite(energy->items[i]->number)||energy->items[i]->number<-120||energy->items[i]->number>120)throw std::invalid_argument("invalid_feature_energy");
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
  const double max=std::min({config.max_transition_seconds,outDuration*.1,inDuration*.1});
  result.candidates.push_back(fallback(outDuration,std::min(4.,max)));
  result.reason="analysis_unavailable_conservative_crossfade";
  if(outFeatures.empty()||inFeatures.empty())return result;
  try {
    if(outFeatures.size()>512*1024||inFeatures.size()>512*1024)throw std::invalid_argument("feature_resource_limit");
    char error[256]{};Json a(am_json_parse(outFeatures.c_str(),error,sizeof error)),b(am_json_parse(inFeatures.c_str(),error,sizeof error));
    const auto out=window(a,"tail",outDuration),in=window(b,"head",inDuration);
    // Phrase/key classifiers remain unknown. Preserve the source boundaries;
    // no active musical content can be skipped by this feature revision.
    // Only independently confident, non-vocal, near-identical tempo windows
    // enter the recovered filtered-direct scoring path. No native dBFS signal
    // or nil is inferred. Other routes keep their missing inputs unavailable.
    for(const auto& os:out.stable)for(const auto& is:in.stable) {
      if(os.confidence<.8||is.confidence<.8)continue;
      double alias=1,distance=std::abs(std::log(os.bpm/is.bpm));unsigned aliasIndex=1;
      for(auto [value,index]:{std::pair{.5,0u},std::pair{2.,2u}}) {
        const double d=std::abs(std::log(os.bpm/(is.bpm*value)));
        if(d<distance) {distance=d;alias=value;aliasIndex=index;}
      }
      if(distance>.01)continue;
      // Include the actual head prefix instead of requiring a beat at t=0.
      // Align the outgoing downbeat with a known early incoming downbeat.
      // Keep at most one four-beat bar (and two seconds) beyond a confirmed
      // tail interval. This preserves the short decay after its last event.
      // Aliases describe beat interpretation; both source clocks stay unity.
      if(os.end<outDuration-std::min(2.,4*60/os.bpm))continue;
      for(const double anchor:in.downbeats) {
      if(anchor<is.start||anchor>is.end||anchor>std::min(2.,2*60/is.bpm))continue;
      for(size_t i=0;i<out.downbeats.size();++i) {
        const double start=out.downbeats[i]-anchor,length=outDuration-start;
        if(start<os.start-60/os.bpm||length<1||length>max||!nonVocal(out,start,outDuration)||!nonVocal(in,0,length))continue;
        const auto beatCount=std::count_if(in.beats.begin(),in.beats.end(),[length](double t){return t>=0&&t<length;});
        int64_t normalized=0;
        if(am_normalized_incoming_beats(beatCount,alias,&normalized)!=AM_SCORING_OK||normalized<4||length>is.end)continue;
        TAE_AM_CandidateV1 c=fallback(outDuration,length);
        c.scoring.style_id=8;c.scoring.path=AM_PATH_FILTERED_DIRECT;c.bpm=os.bpm;c.alias_index=aliasIndex;
        auto& signals=c.scoring.signals;
        signals.strict_tempo_compatible={true,false,false,true};
        signals.incoming_beat_count={true,false,false,beatCount};
        signals.tempo_alias={true,false,false,alias};
        if(result.candidates.size()==4096)throw std::length_error("candidate_resource_limit");
        result.candidates.push_back(c);
      }
      }
    }
    result.reason=result.candidates.size()>1?"independent_confident_beat_regions":"insufficient_confident_regions";
  } catch(const std::exception& e) {result.candidates.resize(1);result.reason=e.what();}
  return result;
}
}
