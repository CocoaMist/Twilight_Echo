#include "TransitionEffects.h"
#include "EmbeddedAssets.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <numbers>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace twilight::automix {
namespace {
struct Parameter { double minimum, maximum, value; };
const auto& parameterDefaults() {
  static const auto values=[] {
    std::map<std::string,Parameter,std::less<>> result;
    char error[256]{};
    auto* root=am_json_parse(amParameterDescriptors,error,sizeof error);
    if(!root)throw std::runtime_error("Invalid embedded AutoMix parameter descriptors");
    const auto* rows=am_jget(root,"parameters");
    if(rows)for(std::size_t i=0;i<rows->count;++i) {
      const auto* row=rows->items[i];const auto* range=am_jget(row,"value_range");
      if(range&&range->count==2)result.emplace(am_jstr(am_jget(row,"style_parameter_id"),""),Parameter{
        am_jnum(range->items[0],0),am_jnum(range->items[1],1),am_jnum(am_jget(row,"default_value"),0)});
    }
    am_json_free(root);
    if(result.size()!=69)throw std::runtime_error("Incomplete AutoMix parameter descriptors");
    return result;
  }();
  return values;
}
// Explicit independent calibration. The private AU ordinal table has not been
// recovered; production candidate policy excludes REMIX_FX until parity exists.
double independentBeats(double ordinal,bool delay=false) {
  constexpr std::array<double,8> straight={4,2,1,.5,.25,.125,.0625,.03125};
  const auto index=static_cast<unsigned>(std::clamp(std::floor(ordinal),0.,delay?23.:15.));
  if(delay)return straight[index/3]*(index%3==1?1.5:index%3==2?2./3:1.);
  return straight[index%8]*(index>=8?2./3:1.);
}
struct Filter {
  double z1{},z2{},b0{1},b1{},b2{},a1{},a2{};
  void set(double hz,double q,unsigned rate,unsigned type) {
    hz=std::clamp(hz,5.,rate*.475);q=std::clamp(q,.3,8.);
    const double w=2*std::numbers::pi*hz/rate,c=std::cos(w),alpha=std::sin(w)/(2*q),norm=1/(1+alpha);
    if(type==2) { b0=alpha*norm;b1=0;b2=-b0; }
    else {b0=(type==1?(1+c):(1-c))*.5*norm;b1=(type==1?-(1+c):(1-c))*norm;b2=b0;}
    a1=-2*c*norm;a2=(1-alpha)*norm;
  }
  float tick(float x) {const double y=b0*x+z1;z1=b1*x-a1*y+z2;z2=b2*x-a2*y;return static_cast<float>(y);}
};
struct Delay {
  std::vector<float> ring;std::size_t cursor{};
  explicit Delay(std::size_t samples):ring(samples) {}
  float read(double lag) const {
    lag=std::clamp(lag,1.,static_cast<double>(ring.size()-2));
    const auto integral=static_cast<std::size_t>(lag);const auto a=(cursor+ring.size()-integral)%ring.size(),b=(a+ring.size()-1)%ring.size();
    return static_cast<float>(ring[a]+(ring[b]-ring[a])*(lag-integral));
  }
  void push(float x) {ring[cursor]=x;if(++cursor==ring.size()) cursor=0;}
};
struct Fdn {
  std::vector<Delay> lines;std::array<double,8> low{};
  explicit Fdn(unsigned rate) {
    lines.reserve(8);for(std::size_t i=0;i<8;++i)lines.emplace_back(rate+4);
  }
  float tick(float x,double rt60Low,double rt60High,unsigned rate,double minimum,double maximum,double reflections) {
    std::array<double,8> taps{},delays{};double sum=0;
    const double lowpass=1-std::exp(-2*std::numbers::pi*3500/rate);
    minimum=std::clamp(minimum,.001,.99);maximum=std::clamp(std::max(minimum,maximum),minimum,.99);
    const auto seed=static_cast<uint32_t>(std::clamp(reflections,0.,65535.));
    for(std::size_t i=0;i<8;++i) {
      uint32_t h=seed+static_cast<uint32_t>(i+1)*0x9e3779b9u;h^=h>>16;h*=0x7feb352du;h^=h>>15;
      const double fraction=seed?(h&0xffff)/65535.:(i+.5)/8;
      delays[i]=minimum+(maximum-minimum)*fraction;taps[i]=lines[i].read(delays[i]*rate);sum+=taps[i];
    }
    for(std::size_t i=0;i<8;++i) {
      // Orthogonal Householder feedback; stable for all allowed decay times.
      const double feedback=taps[i]-.25*sum;low[i]+=lowpass*(feedback-low[i]);
      const double delay=delays[i];
      const double gl=std::pow(.001,delay/std::clamp(rt60Low,.05,12.)),gh=std::pow(.001,delay/std::clamp(rt60High,.05,12.));
      lines[i].push(static_cast<float>(x*.2+low[i]*gl+(feedback-low[i])*gh));
    }
    return static_cast<float>(sum*.125);
  }
  std::size_t bytes() const {std::size_t n=0;for(const auto& line:lines) n+=line.ring.capacity()*sizeof(float);return n;}
};
}
struct TransitionEffects::Impl {
  unsigned rate,channels;const am_side* side;std::uint64_t frames{};
  bool hasLow{},hasHigh{},hasDelay{},hasReverb{},hasRemix{};
  bool passthrough{true};
  std::vector<Filter> low,high,delayLow,remixA,remixB,noiseLow;
  std::vector<Delay> delay,flanger,repeat;
  std::vector<Fdn> reverb;
  double previousLow{-1},previousHigh{-1},previousDelayLow{-1},previousA{-1},previousB{-1};
  bool repeaterWasOn{};std::size_t repeatStart{},repeatLength{},repeatCursor{};
  double gaterPhase{},flangerPhase{};
  bool phaseSyncWasOn{};uint32_t noiseSeed{0x4155544f};
  const std::map<std::string,Parameter,std::less<>>& defaults;
  Impl(unsigned sr,unsigned ch,const am_side* s):rate(sr),channels(ch),side(s),low(ch),high(ch),delayLow(ch),remixA(ch),remixB(ch),noiseLow(ch),defaults(parameterDefaults()) {
    for(std::size_t i=0;i<s->count;++i) {
      const std::string name=s->processors[i].name;
      hasLow|=name=="LOW_PASS";hasHigh|=name=="HI_PASS";hasDelay|=name=="AUX_DELAY";hasReverb|=name=="AUX_REVERB";hasRemix|=name=="REMIX_FX";
      if(name!="TIME_STRETCHING"&&name!="RECEIVE_MIXER")passthrough=false;
      for(std::size_t r=0;r<s->processors[i].count;++r) {
        const std::string_view parameter=s->processors[i].ramps[r].parameter;
        if(parameter!="ts_rate"&&parameter!="out_gain")passthrough=false;
      }
    }
    // Clock/stretch and envelope gain run in PrepareSide. A pure envelope
    // template has no filter/delay/modulation state to evaluate per sample.
    for(const char* parameter:{"player_gain","fx_mixer_dry"}) {
      const auto found=defaults.find(parameter);
      if(found!=defaults.end()&&found->second.value!=1)passthrough=false;
    }
    for(unsigned c=0;c<ch;++c) {
      if(hasDelay||hasRemix) delay.emplace_back(sr*2+4);
      if(hasRemix) {flanger.emplace_back(sr/10+4);repeat.emplace_back(sr*2+4);}
      if(hasReverb||hasRemix) reverb.emplace_back(sr);
    }
  }
  double v(const char* p,double t,double fallback) const {
    const auto found=defaults.find(p);
    const auto value=am_control(side,p,t,found==defaults.end()?fallback:found->second.value);
    if(!std::isfinite(value))throw std::invalid_argument("Non-finite AutoMix effect parameter");
    // Preserve descriptor defaults exactly (the recovered LP default is even
    // above its descriptor maximum). Each DSP primitive bounds its own domain.
    return value;
  }
  bool on(const char* name,double t) const {
    for(std::size_t i=0;i<side->count;++i) {const auto& p=side->processors[i];if(std::string_view(p.name)==name&&t>=p.placement.start&&t<p.placement.end) return true;}
    return false;
  }
};
TransitionEffects::TransitionEffects(unsigned rate,unsigned channels,const am_side* side):impl_(std::make_unique<Impl>(rate,channels,side)) {}
TransitionEffects::~TransitionEffects()=default;
std::size_t TransitionEffects::maximumMemoryBytes(unsigned sr,unsigned ch,const am_side* side) noexcept {
  bool delay=false,remix=false,reverb=false;
  for(size_t i=0;side&&i<side->count;++i) {
    const std::string_view name=side->processors[i].name;
    delay|=name=="AUX_DELAY";remix|=name=="REMIX_FX";reverb|=name=="AUX_REVERB";
  }
  size_t total=sizeof(Impl)+6*ch*sizeof(Filter)+256*1024; // descriptor initialization scratch upper allowance
  if(delay||remix)total+=ch*(sizeof(Delay)+(sr*2+4)*sizeof(float));
  if(remix)total+=ch*(2*sizeof(Delay)+(sr/10+4+sr*2+4)*sizeof(float));
  if(reverb||remix)total+=ch*(sizeof(Fdn)+8*(sizeof(Delay)+(sr+4)*sizeof(float)));
  return total;
}
std::size_t TransitionEffects::memoryBytes() const noexcept {
  std::size_t total=sizeof(Impl)+6*impl_->channels*sizeof(Filter);
  for(const auto* list:{&impl_->delay,&impl_->flanger,&impl_->repeat}) for(const auto& d:*list) total+=sizeof(Delay)+d.ring.capacity()*sizeof(float);
  for(const auto& f:impl_->reverb) total+=sizeof(Fdn)+f.lines.capacity()*sizeof(Delay)+f.bytes();return total;
}
void TransitionEffects::process(float* frame,double t,double bpm) {
  auto& e=*impl_;if(e.passthrough)return;
  const bool update=(e.frames++%32)==0;
  const bool lowOn=e.hasLow&&e.on("LOW_PASS",t),highOn=e.hasHigh&&e.on("HI_PASS",t);
  const bool delayOn=e.hasDelay&&e.on("AUX_DELAY",t),reverbOn=e.hasReverb&&e.on("AUX_REVERB",t),remix=e.hasRemix&&e.on("REMIX_FX",t);
  bpm=std::clamp(e.v("remixfx_beats_per_minute",t,bpm),20.,300.);
  const bool phaseSync=remix&&e.v("remixfx_lfo_phase_sync",t,0)>.5;
  if(phaseSync&&!e.phaseSyncWasOn)e.gaterPhase=e.flangerPhase=0;
  e.phaseSyncWasOn=phaseSync;
  const double lp=e.v("lp_cutoff_freq",t,20000),hp=e.v("hp_cutoff_freq",t,20);
  const double resonance=e.v("lp_reso",t,0),highResonance=e.v("hp_reso",t,0);
  const double inputGain=e.v("player_gain",t,1);
  const double delayTime=std::clamp(e.v("fx_delay_delay_time",t,60/bpm),.0001,2.);
  const double delayWet=delayOn?std::clamp(e.v("fx_delay_dry_wet",t,50)/100.,0.,1.):0;
  const double delayFeedback=std::clamp(e.v("fx_delay_feedback",t,35)/100.,-.9,.9);
  const double delayCutoff=e.v("fx_delay_lp_cutoff_frequency",t,3000);
  const double reverbWet=reverbOn?std::clamp(e.v("fx_reverb_dry_wet",t,30)/100.,0.,1.):0;
  const double decayLow=e.v("fx_reverb_low_frequency_decay_time",t,2),decayHigh=e.v("fx_reverb_high_frequency_decay_time",t,1);
  const double minimumDelay=e.v("fx_reverb_min_delay_time",t,.008),maximumDelay=e.v("fx_reverb_max_delay_time",t,.106),reflections=e.v("fx_reverb_randomize_reflections",t,0);
  const double wet=e.v("fx_mixer_wet",t,1),dry=e.v("fx_mixer_dry",t,1),send=e.v("send_mixer_gain",t,1);
  const bool fa=remix&&e.v("remixfx_filter_a_on",t,0)>.5,fb=remix&&e.v("remixfx_filter_b_on",t,0)>.5;
  const double ca=e.v("remixfx_filter_a_cutoff",t,1000),cb=e.v("remixfx_filter_b_cutoff",t,1000);
  const bool repeaterOn=remix&&e.v("remixfx_repeater_on",t,0)>.5;
  if(repeaterOn&&!e.repeaterWasOn) {
    e.repeatLength=std::clamp<std::size_t>(static_cast<std::size_t>(e.rate*60/bpm*independentBeats(e.v("remixfx_repeater_rate",t,1))),1,e.repeat[0].ring.size()-2);
    e.repeatStart=(e.repeat[0].cursor+e.repeat[0].ring.size()-e.repeatLength)%e.repeat[0].ring.size();e.repeatCursor=0;
  }
  e.repeaterWasOn=repeaterOn;
  const double repeatMix=std::clamp(e.v("remixfx_repeater_mix",t,1),0.,1.);
  const bool flangerOn=remix&&e.v("remixfx_flanger_on",t,0)>.5,gaterOn=remix&&e.v("remixfx_gater_on",t,0)>.5;
  const double flangeLag=e.rate*.001*std::clamp(.1+20*e.v("remixfx_flanger_center",t,0)+10*e.v("remixfx_flanger_depth",t,0)*std::sin(2*std::numbers::pi*e.flangerPhase),.05,50.);
  const double gate=e.gaterPhase<std::clamp(e.v("remixfx_gater_pw",t,.5),.02,.98)?1:1-std::clamp(e.v("remixfx_gater_depth",t,1),0.,1.);
  const double noiseLevel=gaterOn?std::clamp(e.v("remixfx_gater_noise_level",t,0),0.,1.):0;
  if(update) for(unsigned c=0;c<e.channels;++c) {
    e.low[c].set(lp,.707*std::pow(10.,resonance/20),e.rate,0);e.high[c].set(hp,.707*std::pow(10.,highResonance/20),e.rate,1);
    e.delayLow[c].set(delayCutoff,.707,e.rate,false);
    e.remixA[c].set(ca,.707+7*e.v("remixfx_filter_a_resonance",t,0),e.rate,static_cast<unsigned>(e.v("remixfx_filter_a_type",t,0)));
    e.remixB[c].set(cb,.707+7*e.v("remixfx_filter_b_resonance",t,0),e.rate,static_cast<unsigned>(e.v("remixfx_filter_b_type",t,0)));
    e.noiseLow[c].set(20*std::pow(1000.,std::clamp(e.v("remixfx_gater_noise_cutoff",t,0),0.,1.)),.707,e.rate,false);
  }
  for(unsigned c=0;c<e.channels;++c) {
    float x=static_cast<float>(frame[c]*inputGain);if(lowOn)x=e.low[c].tick(x);if(highOn)x=e.high[c].tick(x);
    float aux=0;
    if(e.hasDelay||e.hasRemix) {
      const bool remixDelay=remix&&e.v("remixfx_delay_on",t,0)>.5;
      const double lag=remixDelay?60/bpm*independentBeats(e.v("remixfx_delay_rate",t,10),true):delayTime;
      float echo=e.delayLow[c].tick(e.delay[c].read(e.rate*lag));
      const double feedback=remixDelay?std::clamp(e.v("remixfx_delay_feedback",t,.35),-.9,.9):delayFeedback;
      e.delay[c].push(static_cast<float>((delayOn||remixDelay?x*send:0)+echo*feedback));
      aux+=static_cast<float>(echo*(remixDelay?std::clamp(e.v("remixfx_delay_level",t,.5),0.,1.):delayWet));
    }
    if(e.hasReverb||e.hasRemix) {
      const bool remixReverb=remix&&e.v("remixfx_reverb_on",t,0)>.5;
      const double rt=remixReverb?e.v("remixfx_reverb_time",t,2):decayLow;
      const double reverbSend=remixReverb?std::clamp(e.v("remixfx_reverb_send",t,1),0.,1.):send;
      const float rv=e.reverb[c].tick(reverbOn||remixReverb?static_cast<float>(x*reverbSend):0,rt,decayHigh,e.rate,minimumDelay,maximumDelay,reflections);
      aux+=static_cast<float>(rv*(remixReverb?e.v("remixfx_reverb_wet",t,1):reverbWet*std::pow(10.,e.v("fx_reverb_gain",t,1)/20)));
      if(remixReverb)x=static_cast<float>(x*std::clamp(e.v("remixfx_reverb_dry",t,1),0.,1.));
    }
    if(fa)x=e.remixA[c].tick(x);if(fb)x=e.remixB[c].tick(x);
    if(e.hasRemix) {
      if(repeaterOn) {float loop=e.repeat[c].ring[(e.repeatStart+e.repeatCursor)%e.repeat[c].ring.size()];x=static_cast<float>(x*(1-repeatMix)+loop*repeatMix);}
      else e.repeat[c].push(x);
      const float delayed=e.flanger[c].read(flangeLag);
      e.flanger[c].push(static_cast<float>(x+delayed*std::clamp(e.v("remixfx_flanger_feedback",t,.2),-.9,.9)));
      if(flangerOn) x+=static_cast<float>(delayed*std::clamp(e.v("remixfx_flanger_mix",t,.5),0.,1.));
      if(gaterOn) {
        e.noiseSeed^=e.noiseSeed<<13;e.noiseSeed^=e.noiseSeed>>17;e.noiseSeed^=e.noiseSeed<<5;
        const float noise=e.noiseLow[c].tick(static_cast<float>((double(e.noiseSeed)/UINT32_MAX*2-1)*noiseLevel));
        x=static_cast<float>(x*gate+noise*(1-gate));
      }
    }
    // Independent parallel wet path; auxiliary states continue decaying outside
    // placement. Apple private effect sound and parameter calibration unresolved.
    frame[c]=static_cast<float>(x*dry+aux*wet);
  }
  if(repeaterOn&&++e.repeatCursor==e.repeatLength)e.repeatCursor=0;
  e.flangerPhase=std::fmod(e.flangerPhase+bpm/60/e.rate/independentBeats(e.v("remixfx_flanger_rate",t,1)),1.);
  e.gaterPhase=std::fmod(e.gaterPhase+bpm/60/e.rate/independentBeats(e.v("remixfx_gater_rate",t,1)),1.);
}
} // namespace twilight::automix
