#include "dsp/PcmToDsdModulator.h"
#include "dsp/DspWorkspaceProcessors.h"
#include "core/AudioPipelineDsdUtils.h"
#include "decoder/DopPackerUtils.h"
#include <ebur128.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <vector>

using namespace twilight::audio;
using Clock = std::chrono::steady_clock;
static bool tracking = false;
static size_t mallocCalls = 0, callocCalls = 0, freeCalls = 0, allocatedBytes = 0;
extern "C" void* __real_malloc(size_t);
extern "C" void* __real_calloc(size_t, size_t);
extern "C" void __real_free(void*);
extern "C" void* __wrap_malloc(size_t n) {
  if (tracking) { ++mallocCalls; allocatedBytes += n; }
  return __real_malloc(n);
}
extern "C" void* __wrap_calloc(size_t n, size_t s) {
  if (tracking) { ++callocCalls; allocatedBytes += n * s; }
  return __real_calloc(n, s);
}
extern "C" void __wrap_free(void* p) {
  if (tracking && p) ++freeCalls;
  __real_free(p);
}
static void resetCounts() { mallocCalls = callocCalls = freeCalls = allocatedBytes = 0; }
static double ms(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
static double quantile(std::vector<double> values, double q) {
  std::sort(values.begin(), values.end());
  return values[std::min(values.size()-1, size_t(q * (values.size()-1)))];
}

int main() {
  // Each block represents 256 input PCM frames. Backend frame counts differ
  // for Native DSD / DoP, but the represented audio deadline is identical.
  for (int rate : {48000, 192000}) for (int channels : {2, 8}) for (int target : {64,128,256}) {
    PcmToDsdModulator modulator;
    std::string error;
    if (!modulator.configure({rate, channels, target}, &error)) return 1;
    for (int scenario = 0; scenario < 3; ++scenario) {
    const size_t frames = scenario == 0 ? 256 :
        256 * (scenario == 1 ? 16 : 8) / modulator.upsampleRatio();
    const char* transport = scenario == 0 ? "component-256-pcm" : scenario == 1 ? "dop-256-carrier" : "native-256-bytes";
    std::vector<float> input(frames * channels);
    for (size_t i = 0; i < input.size(); ++i) input[i] = float(0.3 * std::sin(i * 0.07));
    const size_t bytes = modulator.outputBytesPerChannel(frames);
    std::vector<std::vector<uint8_t>> output(channels, std::vector<uint8_t>(bytes));
    std::vector<uint8_t*> pointers;
    for (auto& channel : output) pointers.push_back(channel.data());
    for (int i=0;i<64;++i) modulator.process(input.data(), frames, pointers.data(), bytes);
    std::vector<double> times;
    size_t misses=0;
    for (int i=0;i<512;++i) {
      const auto start=Clock::now();
      if (modulator.process(input.data(), frames, pointers.data(), bytes)!=bytes) return 2;
      const double elapsed=ms(start); times.push_back(elapsed);
      if(elapsed>frames*1000.0/rate) ++misses;
    }
    std::cout<<"{\"kind\":\"pcmToDsd\",\"rate\":"<<rate<<",\"channels\":"<<channels
      <<",\"target\":"<<target<<",\"frames\":"<<frames<<",\"transport\":\""<<transport<<"\",\"samples\":512,\"deadlineMs\":"<<frames*1000.0/rate
      <<",\"p50Ms\":"<<quantile(times,.5)<<",\"p99Ms\":"<<quantile(times,.99)
      <<",\"peakMs\":"<<*std::max_element(times.begin(),times.end())<<",\"misses\":"<<misses<<"}\n";
    }
  }

  // These are the exact helpers called by AudioPipeline::renderTyped. The
  // control path clears this vector without reserving its initial capacity.
  const size_t channels=2, frames=256;
  std::vector<uint8_t> planar(frames*channels,0x69), native, dop;
  DsdStreamInfo info; info.channelCount=2; info.packing=DsdPacking::DsfPlanarBlocks; info.bitOrder=DsdBitOrder::MsbFirst;
  const auto nativeBefore=native.capacity();
  render::dsdBytesToInterleavedResizeOnly(planar.data(),planar.size(),info,AudioSampleFormat::DsdInt8Msb1,&native);
  const auto nativeAfter=native.capacity();
  size_t marker=0;
  const auto dopBefore=dop.capacity();
  dop::packDopFramesResizeOnly(planar.data(),planar.size(),2,DsdPacking::DsfPlanarBlocks,DsdBitOrder::MsbFirst,
      AudioSampleFormat::Int24In32Interleaved,marker,&dop);
  const auto dopAfter=dop.capacity();
  std::cout<<"{\"kind\":\"renderBufferGrowth\",\"nativeCapacityBefore\":"<<nativeBefore
      <<",\"nativeCapacityAfter\":"<<nativeAfter<<",\"dopCapacityBefore\":"<<dopBefore
      <<",\"dopCapacityAfter\":"<<dopAfter<<"}\n";

  // Match AudioPipeline's allocated channel stride and its shorter rendered
  // PCM block. Packers infer a compact stride from byteCount / channels.
  for (bool isDop : {false,true}) {
    PcmToDsdModulator modulator;std::string error;
    if(!modulator.configure({48000,2,256},&error)) return 3;
    const size_t bufferFrames=256;
    const size_t reservedBytes=modulator.outputBytesPerChannel(bufferFrames);
    const size_t pcmFrames=bufferFrames*(isDop?16:8)/modulator.upsampleRatio();
    const size_t writtenBytes=modulator.outputBytesPerChannel(pcmFrames);
    std::vector<uint8_t> padded(reservedBytes*2,0), compact(writtenBytes*2), actual, expected;
    uint8_t* ptrs[2]={padded.data(),padded.data()+reservedBytes};
    std::vector<float> pcm(pcmFrames*2);
    for(size_t i=0;i<pcmFrames;i++){pcm[i*2]=float(.2*std::sin(i*.1));pcm[i*2+1]=float(.3*std::cos(i*.2));}
    if(modulator.process(pcm.data(),pcmFrames,ptrs,reservedBytes)!=writtenBytes) return 4;
    std::copy_n(ptrs[0],writtenBytes,compact.data());
    std::copy_n(ptrs[1],writtenBytes,compact.data()+writtenBytes);
    size_t actualMarker=0,expectedMarker=0;
    if(isDop) {
      dop::packDopFramesResizeOnly(padded.data(),writtenBytes*2,2,DsdPacking::DsfPlanarBlocks,DsdBitOrder::MsbFirst,
        AudioSampleFormat::Int24In32Interleaved,actualMarker,&actual);
      dop::packDopFramesResizeOnly(compact.data(),writtenBytes*2,2,DsdPacking::DsfPlanarBlocks,DsdBitOrder::MsbFirst,
        AudioSampleFormat::Int24In32Interleaved,expectedMarker,&expected);
    } else {
      render::dsdBytesToInterleavedResizeOnly(padded.data(),writtenBytes*2,info,AudioSampleFormat::DsdInt8Msb1,&actual);
      render::dsdBytesToInterleavedResizeOnly(compact.data(),writtenBytes*2,info,AudioSampleFormat::DsdInt8Msb1,&expected);
    }
    size_t differences=0;
    for(size_t i=0;i<actual.size();i++) if(actual[i]!=expected[i]) ++differences;
    if(differences==0) return 5;
    std::cout<<"{\"kind\":\"pcmToDsdPlanarStride\",\"transport\":\""<<(isDop?"dop":"native")
      <<"\",\"reservedChannelBytes\":"<<reservedBytes<<",\"writtenChannelBytes\":"<<writtenBytes
      <<",\"packedOutputBytes\":"<<actual.size()<<",\"differentBytes\":"<<differences<<"}\n";
  }

  LoudnessMeterProcessor meter;
  DspConfig config; config.enabled=true; config.meterEnabled=true;
  AudioFormat format; format.sampleRate=48000; format.channelCount=2;
  meter.configure(config); meter.prepare(format);
  std::vector<float> signal(256*2);
  for(size_t i=0;i<signal.size();++i) signal[i]=float(.2*std::sin(i*.13));
  for (int endSeconds : {180,600}) {
    static int beginSeconds=0;
    resetCounts();
    const int blocks=(endSeconds-beginSeconds)*48000/256;
    for(int i=0;i<blocks;++i) {
      tracking=true; meter.process(signal.data(),256); tracking=false;
    }
    const auto processMalloc=mallocCalls, processCalloc=callocCalls, processFree=freeCalls, processBytes=allocatedBytes;
    resetCounts();
    std::vector<double> queries;
    for(int i=0;i<32;++i) {
      const auto start=Clock::now();
      tracking=true;
      volatile double result=meter.integratedLufs()+meter.loudnessRangeLu();
      tracking=false; (void)result;
      queries.push_back(ms(start));
    }
    std::cout<<"{\"kind\":\"meter\",\"simulatedBeginSeconds\":"<<beginSeconds
      <<",\"simulatedEndSeconds\":"<<endSeconds<<",\"processMallocCalls\":"<<processMalloc
      <<",\"processCallocCalls\":"<<processCalloc<<",\"processFreeCalls\":"<<processFree
      <<",\"processAllocatedBytes\":"<<processBytes<<",\"querySamples\":32,\"queryMallocCalls\":"<<mallocCalls
      <<",\"queryFreeCalls\":"<<freeCalls<<",\"queryAllocatedBytes\":"<<allocatedBytes
      <<",\"queryP50Ms\":"<<quantile(queries,.5)<<",\"queryPeakMs\":"<<*std::max_element(queries.begin(),queries.end())<<"}\n";
    beginSeconds=endSeconds;
  }
  // Library-supported fixed-histogram variant, for feasibility evidence only.
  auto* histogram=ebur128_init(2,48000,EBUR128_MODE_I|EBUR128_MODE_LRA|EBUR128_MODE_M|EBUR128_MODE_S|EBUR128_MODE_HISTOGRAM);
  resetCounts();
  for(int i=0;i<180*48000/256;++i) {
    tracking=true; ebur128_add_frames_float(histogram,signal.data(),256); tracking=false;
  }
  std::cout<<"{\"kind\":\"meterHistogramLibraryProbe\",\"simulatedSeconds\":180,\"mallocCalls\":"<<mallocCalls
      <<",\"callocCalls\":"<<callocCalls<<",\"freeCalls\":"<<freeCalls<<"}\n";
  ebur128_destroy(&histogram);
}
