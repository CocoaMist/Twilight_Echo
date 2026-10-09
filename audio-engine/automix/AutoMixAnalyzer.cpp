#include "AutoMixAnalyzer.h"
#include "ModelRuntime.h"
#include "FeaturePostprocess.h"
#include "../decoder/FFmpegDecoder.h"
#include "../utils/JsonUtils.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <iomanip>
#include <memory>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace twilight::audio {
namespace {
constexpr const char* beatHash="10b8a43f58ec08dec4cf3c0df3ae4c62b8c51b4d96449c318af7f2aa76dc574f";
constexpr const char* yamnetHash="564a1406a3173634aedc049863403e581c1fabf2b0e2c22515d924d3ffb160e5";
std::string unavailable(const std::string& reason) {
  return "{\"schemaVersion\":1,\"analysisVersion\":"+std::to_string(twilight::automix::analysisVersion)+",\"available\":false,\"reason\":\""+json_utils::escape(reason)+"\"}";
}
void eventsJson(std::ostream& json,const std::vector<double>& times,double offset) {
  json<<'[';for(size_t i=0;i<times.size();++i) {if(i)json<<',';json<<times[i]+offset;}json<<']';
}
#if defined(TAE_HAS_FFMPEG)
std::vector<float> decode(FFmpegDecoder& decoder,double start,double seconds,unsigned rate) {
  std::string error;AudioFormat format;format.sampleRate=rate;format.channelCount=1;format.bitDepth=32;format.sampleFormat=AudioSampleFormat::Float32Interleaved;
  if(!decoder.setOutputFormat(format,&error)||!decoder.seekOutputFrame(static_cast<uint64_t>(std::floor(start*rate)),&error)) throw std::runtime_error(error.empty()?"AutoMix source is not seekable":error);
  const auto count=static_cast<size_t>(std::floor(seconds*rate));std::vector<float> pcm(count);size_t used=0;
  while(used<count&&!decoder.eof()) {
    const auto read=decoder.readFrames(pcm.data()+used,std::min<size_t>(4096,count-used),&error);
    if(!error.empty()) throw std::runtime_error(error);if(!read)break;used+=read;
  }
  pcm.resize(used);
  if(!std::all_of(pcm.begin(),pcm.end(),[](float x){return std::isfinite(x);}))throw std::runtime_error("AutoMix decoded non-finite PCM");return pcm;
}
twilight::automix::ModelRuntime* models(const std::string& path,std::string& error) {
  static thread_local std::string loadedPath;
  static thread_local std::unique_ptr<twilight::automix::ModelRuntime> loaded;
  if(path.empty()){error="model_assets_not_configured";return nullptr;}
  try {if(!loaded||loadedPath!=path) {const std::u8string utf8(path.begin(),path.end());loaded=std::make_unique<twilight::automix::ModelRuntime>(std::filesystem::path(utf8));loadedPath=path;}return loaded.get();}
  catch(const std::exception& e){error=e.what();return nullptr;}
}
std::string windowJson(FFmpegDecoder& decoder,double start,double duration,twilight::automix::ModelRuntime* runtime,const std::string& modelError) {
  const auto pcm=decode(decoder,start,duration,22050);if(pcm.empty())throw std::runtime_error("AutoMix analysis window is empty");
  std::ostringstream json;json<<std::setprecision(12)<<"{\"sourceStart\":"<<start<<",\"sourceEnd\":"<<start+double(pcm.size())/22050;
  // Independent regional mean-square energy in 20ms cells. This is dBFS,
  // never whole-track LUFS and never Apple's native loudness_map calibration.
  json<<",\"energyDbfs\":[";
  for(size_t first=0;first<pcm.size();first+=441) {
    const auto end=std::min(pcm.size(),first+441);double energy=0;for(size_t i=first;i<end;++i)energy+=double(pcm[i])*pcm[i];
    if(first)json<<',';json<<std::max(-120.,10*std::log10(std::max(1e-12,energy/(end-first))));
  }
  json<<"],\"energyHopSeconds\":0.02,\"key\":null,\"phraseBoundaries\":null";
  twilight::automix::BeatEvents events;std::string beatError=modelError;
  if(runtime) try {auto mel=twilight::automix::beatThisFrontend(pcm);events=runtime->beats(mel);beatError.clear();}catch(const std::exception& e){beatError=e.what();}
  if(beatError.empty()) {
    json<<",\"beatKnown\":true,\"beats\":";eventsJson(json,events.beats,start);json<<",\"downbeats\":";eventsJson(json,events.downbeats,start);
    // Independent stability contract; retain the final complete interval
    // window and merge confident coverage without inventing events.
    json<<",\"stableRegions\":[";bool first=true;
    for(const auto& region:twilight::automix::stableBeatRegions(events.beats)) {
      if(!first)json<<',';first=false;json<<"{\"start\":"<<start+region.start<<",\"end\":"<<start+region.end<<",\"bpm\":"<<region.bpm<<",\"confidence\":"<<region.confidence<<'}';
    }
    json<<']';
  } else json<<",\"beatKnown\":false,\"beats\":null,\"downbeats\":null,\"stableRegions\":null,\"beatReason\":\""<<json_utils::escape(beatError)<<'"';
  std::string vocalError=modelError;std::vector<float> tags;
  if(runtime) try {tags=runtime->musicTags(twilight::automix::yamnetFrontend(decode(decoder,start,duration,16000)));vocalError.clear();}catch(const std::exception& e){vocalError=e.what();}
  if(vocalError.empty()) {
    constexpr std::array<size_t,9> voiceTags={0,24,25,29,30,31,32,249,250};json<<",\"vocalKnown\":true,\"vocalWindows\":[";
    for(size_t i=0;i<tags.size()/521;++i) {
      float probability=0;for(auto tag:voiceTags)probability=std::max(probability,tags[i*521+tag]);
      if(i)json<<',';json<<"{\"start\":"<<start+i*.48<<",\"end\":"<<std::min(start+duration,start+i*.48+.96)<<",\"probability\":"<<probability<<'}';
    }
    json<<']';
  } else json<<",\"vocalKnown\":false,\"vocalWindows\":null,\"vocalReason\":\""<<json_utils::escape(vocalError)<<'"';
  json<<'}';return json.str();
}
#endif
}
std::string analyzeAutoMixJson(const std::string& source,const std::string& options) {
#if defined(TAE_HAS_FFMPEG)
  if(source.empty()||options.size()>16384) return unavailable("invalid_analysis_request");
  try {
    FFmpegDecoder decoder;std::string error;
    if(!decoder.open(source,&error))return unavailable(error.empty()?"source_open_failed":error);
    const auto stream=decoder.streamInfo();const auto duration=stream.durationSeconds;
    if(!std::isfinite(duration)||duration<=0) return unavailable("known_duration_required");
    const std::string segment=json_utils::fieldString(options,"segment").value_or("both");
    if(segment!="head"&&segment!="tail"&&segment!="both")return unavailable("invalid_analysis_segment");
    auto root=json_utils::fieldString(options,"modelDirectory").value_or("");
    if(root.empty())if(const auto* value=std::getenv("TAE_AUTOMIX_ASSETS"))root=value;
    std::string modelError;auto* runtime=models(root,modelError);const auto seconds=std::min(45.,duration);
    std::ostringstream json;json<<std::setprecision(12)<<"{\"schemaVersion\":1,\"analysisVersion\":"<<twilight::automix::analysisVersion<<",\"available\":true,\"durationSeconds\":"<<duration
      <<",\"provenance\":\"independent-beat-this-yamnet-v1\",\"modelHashes\":{\"beatThis\":\""<<beatHash<<"\",\"yamnet\":\""<<yamnetHash<<"\"},\"windows\":{";
    bool emitted=false;if(segment!="tail") {json<<"\"head\":"<<windowJson(decoder,0,seconds,runtime,modelError);emitted=true;}
    if(segment!="head") {if(emitted)json<<',';json<<"\"tail\":"<<windowJson(decoder,std::max(0.,duration-seconds),seconds,runtime,modelError);}
    json<<"}}";return json.str();
  } catch(const std::exception& e){return unavailable(e.what());}
  catch(...){return unavailable("analysis_internal_error");}
#else
  (void)source;(void)options;return unavailable("ffmpeg_unavailable");
#endif
}
}
