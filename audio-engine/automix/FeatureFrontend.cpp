#include "FeatureFrontend.h"
#include "vendor/signalsmith-linear/fft.h"
#include <algorithm>
#include <cmath>
#include <complex>
#include <limits>
#include <numbers>
#include <stdexcept>

namespace twilight::automix {
namespace {
double slaney(double hz) {
  return hz < 1000 ? hz / (200. / 3.) : 15 + std::log(hz / 1000.) / (std::log(6.4) / 27.);
}
double inverseSlaney(double mel) {
  return mel < 15 ? mel * (200. / 3.) : 1000 * std::exp((mel - 15) * (std::log(6.4) / 27.));
}
std::size_t reflected(std::ptrdiff_t position, std::size_t size) {
  const auto period=static_cast<std::ptrdiff_t>(2*(size-1));
  auto p=position % period; if(p<0) p+=period;
  return static_cast<std::size_t>(p < static_cast<std::ptrdiff_t>(size) ? p : period-p);
}
void validate(std::span<const float> input,std::size_t maxSamples) {
  if(input.size()>maxSamples) throw std::length_error("AutoMix analysis window exceeds 45 seconds");
  if(!std::all_of(input.begin(),input.end(),[](float x){return std::isfinite(x);}))
    throw std::invalid_argument("Non-finite model PCM");
}
std::vector<float> melWeights(std::size_t fftSize,std::size_t bands,double rate,double low,double high,bool htk) {
  const std::size_t bins=fftSize/2+1;
  std::vector<float> weights(bands*bins);
  const auto scale=[htk](double x){return htk?1127.*std::log(1+x/700.):slaney(x);};
  const auto inverse=[htk](double x){return htk?700.*std::expm1(x/1127.):inverseSlaney(x);};
  const double a=scale(low),b=scale(high);
  for(std::size_t m=0;m<bands;++m) {
    const double left=inverse(a+(b-a)*m/(bands+1));
    const double centre=inverse(a+(b-a)*(m+1)/(bands+1));
    const double right=inverse(a+(b-a)*(m+2)/(bands+1));
    for(std::size_t k=0;k<bins;++k) {
      const double hz=k*rate/fftSize;
      // TensorFlow's triangular weights are linear in mel; torchaudio's are
      // linear in Hz after placing equally spaced Slaney mel centres.
      double w=htk?std::min((scale(hz)-scale(left))/(scale(centre)-scale(left)),(scale(right)-scale(hz))/(scale(right)-scale(centre)))
                   :std::min((hz-left)/(centre-left),(right-hz)/(right-centre));
      weights[m*bins+k]=static_cast<float>(std::max(0.,w));
    }
    if(htk) weights[m*bins]=0; // YAMNet excludes DC in its TF mel matrix.
  }
  return weights;
}
std::vector<double> peaks(std::span<const float> logits) {
  std::vector<double> events;
  double mean=0;std::size_t count=0;
  for(std::size_t i=0;i<logits.size();++i) {
    const std::size_t a=i>3?i-3:0,b=std::min(logits.size(),i+4);
    if(!(logits[i]>0)||logits[i]!=*std::max_element(logits.begin()+a,logits.begin()+b)) continue;
    // Exactly matches upstream deduplicate_peaks(width=1), including the use
    // of the running mean when checking adjacency and fractional event frames.
    if(count && static_cast<double>(i)-mean<=1.) {++count;mean+=(i-mean)/count;}
    else {if(count) events.push_back(mean/50.);mean=static_cast<double>(i);count=1;}
  }
  if(count) events.push_back(mean/50.);
  return events;
}
}
Spectrogram beatThisFrontend(std::span<const float> pcm) {
  validate(pcm,45*22050);
  if(pcm.size()<=512) throw std::invalid_argument("Beat This reflect padding needs more than 512 samples");
  constexpr std::size_t fftSize=1024,hop=441,bins=513,bands=128;
  Spectrogram result{pcm.size()/hop+1,bands,{}};result.values.resize(result.frames*bands);
  signalsmith::linear::FFT<double> fft(fftSize);
  std::vector<std::complex<double>> time(fftSize),freq(fftSize);
  std::vector<float> window(fftSize),magnitude(bins);
  const auto weights=melWeights(fftSize,bands,22050,30,11000,false);
  for(std::size_t i=0;i<fftSize;++i) window[i]=static_cast<float>(.5-.5*std::cos(2*std::numbers::pi*i/fftSize));
  for(std::size_t frame=0;frame<result.frames;++frame) {
    for(std::size_t i=0;i<fftSize;++i) time[i]=static_cast<double>(pcm[reflected(static_cast<std::ptrdiff_t>(frame*hop+i)-512,pcm.size())]*window[i]);
    fft.fft(time.data(),freq.data());
    for(std::size_t i=0;i<bins;++i) magnitude[i]=static_cast<float>(std::abs(freq[i])/32.);
    for(std::size_t m=0;m<bands;++m) {
      float sum=0;for(std::size_t k=0;k<bins;++k) sum+=magnitude[k]*weights[m*bins+k];
      result.values[frame*bands+m]=std::log1p(1000*sum);
    }
  }
  return result;
}
Spectrogram yamnetFrontend(std::span<const float> pcm) {
  validate(pcm,45*16000);
  constexpr std::size_t fftSize=512,windowSize=400,hop=160,bins=257,bands=64;
  // Official YAMNet pads to a whole number of 96-frame patches on a 48-frame
  // hop; every STFT is uncentred, periodic Hann, magnitude (not power).
  std::size_t samples=std::max<std::size_t>(15600,pcm.size());
  samples=15600+((samples-15600+7679)/7680)*7680;
  Spectrogram result{(samples-windowSize)/hop+1,bands,{}};result.values.resize(result.frames*bands);
  signalsmith::linear::FFT<double> fft(fftSize);
  std::vector<std::complex<double>> time(fftSize),freq(fftSize);
  std::vector<float> window(windowSize),magnitude(bins);
  const auto weights=melWeights(fftSize,bands,16000,125,7500,true);
  for(std::size_t i=0;i<windowSize;++i) window[i]=static_cast<float>(.5-.5*std::cos(2*std::numbers::pi*i/windowSize));
  for(std::size_t frame=0;frame<result.frames;++frame) {
    std::fill(time.begin(),time.end(),0);
    for(std::size_t i=0;i<windowSize;++i) {const auto sample=frame*hop+i;time[i]=sample<pcm.size()?pcm[sample]*window[i]:0;}
    fft.fft(time.data(),freq.data());
    for(std::size_t i=0;i<bins;++i) magnitude[i]=static_cast<float>(std::abs(freq[i]));
    for(std::size_t m=0;m<bands;++m) {
      float sum=0;for(std::size_t k=0;k<bins;++k) sum+=magnitude[k]*weights[m*bins+k];
      result.values[frame*bands+m]=std::log(sum+.001f);
    }
  }
  return result;
}
BeatEvents beatThisPostprocess(std::span<const float> beat,std::span<const float> downbeat) {
  if(beat.size()!=downbeat.size()||beat.size()>2251) throw std::invalid_argument("Invalid Beat This logit shape");
  if(!std::all_of(beat.begin(),beat.end(),[](float x){return std::isfinite(x);})||!std::all_of(downbeat.begin(),downbeat.end(),[](float x){return std::isfinite(x);}))
    throw std::invalid_argument("Non-finite Beat This output");
  BeatEvents result{peaks(beat),peaks(downbeat)};
  if(!result.beats.empty()) for(auto& t:result.downbeats) {
    const auto near=std::min_element(result.beats.begin(),result.beats.end(),[t](double a,double b){return std::abs(t-a)<std::abs(t-b);});t=*near;
  }
  std::sort(result.downbeats.begin(),result.downbeats.end());
  result.downbeats.erase(std::unique(result.downbeats.begin(),result.downbeats.end()),result.downbeats.end());
  return result;
}
} // namespace twilight::automix
