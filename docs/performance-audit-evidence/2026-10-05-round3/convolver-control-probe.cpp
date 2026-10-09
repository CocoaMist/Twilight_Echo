#include "dsp/ConvolverProcessor.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <vector>
using namespace twilight::audio;
using Clock = std::chrono::steady_clock;
static double ms(Clock::time_point start) { return std::chrono::duration<double,std::milli>(Clock::now()-start).count(); }
static void u16(std::ofstream& file, uint16_t n) { char b[2]={char(n),char(n>>8)}; file.write(b,2); }
static void u32(std::ofstream& file, uint32_t n) { char b[4]={char(n),char(n>>8),char(n>>16),char(n>>24)}; file.write(b,4); }
static double median(std::vector<double> x) { std::sort(x.begin(),x.end()); return x[x.size()/2]; }
int main(int argc,char** argv) {
  if(argc!=2) return 1;
  for(int rate:{48000,192000}) for(int channels:{2,8}) {
    const uint32_t frames=rate*8;
    const auto path=std::filesystem::path(argv[1])/std::string("twilight-audit3-ir-"+std::to_string(rate)+".wav");
    { std::ofstream file(path,std::ios::binary);file.write("RIFF",4);u32(file,36+frames*4);file.write("WAVEfmt ",8);
      u32(file,16);u16(file,3);u16(file,1);u32(file,rate);u32(file,rate*4);u16(file,4);u16(file,32);
      file.write("data",4);u32(file,frames*4);
      for(uint32_t i=0;i<frames;i++){const float x=i==0?1.0f:float(.001*std::exp(-double(i)/rate));file.write(reinterpret_cast<const char*>(&x),4);} }
    ConvolverProcessor node;DspConfig config;config.enabled=true;config.convolverEnabled=true;
    AudioFormat format;format.sampleRate=rate;format.channelCount=channels;node.configure(config);node.prepare(format);
    std::string error;
    const auto loadStart=Clock::now();if(!node.loadImpulseResponse(path.string(),&error)){std::cerr<<error;return 2;}
    const double loadMs=ms(loadStart);
    std::vector<double> configureTimes,prepareTimes;
    for(int i=0;i<5;i++) {
      config.eqPreampDb=i*.1; // Only an unrelated EQ field changes.
      auto start=Clock::now();node.configure(config);configureTimes.push_back(ms(start));
      start=Clock::now();node.prepare(format);prepareTimes.push_back(ms(start));
    }
    const auto info=node.info();
    std::cout<<"{\"kind\":\"convolverControlRebuild\",\"rate\":"<<rate<<",\"channels\":"<<channels
      <<",\"irSeconds\":8,\"samples\":5,\"initialLoadMs\":"<<loadMs
      <<",\"unrelatedConfigP50Ms\":"<<median(configureTimes)<<",\"unrelatedConfigPeakMs\":"<<*std::max_element(configureTimes.begin(),configureTimes.end())
      <<",\"sameFormatPrepareP50Ms\":"<<median(prepareTimes)<<",\"sameFormatPreparePeakMs\":"<<*std::max_element(prepareTimes.begin(),prepareTimes.end())
      <<",\"memoryBytes\":"<<info.memoryBytes<<",\"active\":"<<(node.isActive()?"true":"false")<<"}\n";
  }
}
