#include "PcmToDsdModulator.h"

#include <cmath>
#include <cstring>
#if defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
#include <emmintrin.h>
#endif

namespace twilight::audio {
namespace {

// Polyphase halfband interpolation stages (x2 each), ordered from the lowest
// rate (sharpest transition band) to the highest. Only the odd (non-trivial)
// polyphase branch is stored; the even branch is a pure delay of L/2 samples.
// Kaiser-windowed halfband prototypes, gain 1.0 per stage after the x2 factor
// applied in the odd branch.
constexpr double kStage0Taps[32] = {
    -0.000017280278879405677, 0.000071733966682320372, -0.00020010061550812086,
    0.00045804706923640616,   -0.00092407343378629169, 0.0017030720800332284,
    -0.0029302840773261858,   0.0047777397837853886,   -0.0074679848191883304,
    0.011305818660740147,     -0.016753654520878306,   0.024619933464822868,
    -0.036585857266917245,    0.057012359784754614,    -0.10198702254071014,
    0.31691610968090245,      0.31691610968090245,     -0.10198702254071014,
    0.057012359784754614,     -0.036585857266917245,   0.024619933464822868,
    -0.016753654520878306,    0.011305818660740147,    -0.0074679848191883304,
    0.0047777397837853886,    -0.0029302840773261858,  0.0017030720800332284,
    -0.00092407343378629169,  0.00045804706923640616,  -0.00020010061550812086,
    0.000071733966682320372,  -0.000017280278879405677};

constexpr double kStage1Taps[16] = {
    -0.00010545156748877497, 0.00076076737495495985, -0.0029063710917855879,
    0.0082106929675413321,   -0.019394331200854247,  0.041652989921742066,
    -0.091288727244801429,   0.31307396723287667,    0.31307396723287667,
    -0.091288727244801429,   0.041652989921742066,   -0.019394331200854247,
    0.0082106929675413321,   -0.0029063710917855879, 0.00076076737495495985,
    -0.00010545156748877497};

constexpr double kStage2Taps[8] = {
    -0.0010774745369430225, 0.012524010870251569, -0.061555277131918031, 0.30017322686906628,
    0.30017322686906628,    -0.061555277131918031, 0.012524010870251569, -0.0010774745369430225};

constexpr double kStage3Taps[6] = {
    0.0038137914567547629, -0.044784569577449439, 0.29074990464155565,
    0.29074990464155565,   -0.044784569577449439, 0.0038137914567547629};

struct HalfbandStageSpec {
  const double* taps;
  int tapCount;
  int historyOffset;
};

constexpr HalfbandStageSpec kStages[PcmToDsdModulator::kMaxHalfbandStages] = {
    {kStage0Taps, 32, 0},
    {kStage1Taps, 16, 64},
    {kStage2Taps, 8, 96},
    {kStage3Taps, 6, 112}};

template<int N>
void interpolate(const double* taps, double* history, int& position,
    const double* input, double* output, int count) {
  for (int i = 0; i < count; ++i) {
    position = position == 0 ? N - 1 : position - 1;
    history[position] = history[position + N] = input[i];
    const double* window = history + position;
    output[2 * i] = window[N / 2];
    double acc = 0.0;
    for (int k = 0; k < N; ++k) acc += taps[k] * window[k];
    output[2 * i + 1] = 2.0 * acc;
  }
}

// 5th-order CIFB feedback coefficients derived from a Butterworth NTF with
// out-of-band gain Hinf = 1.5 (Lee criterion). Stable for inputs up to
// +/-0.5 FS; the input is clamped to that range ahead of the loop.
constexpr double kFeedback[5] = {
    0.000665376009929, 0.0102388145120, 0.0740739567827, 0.316662811154, 0.807717848861};

// Integrator magnitude guard. Normal operation at +/-0.5 FS input keeps the
// largest state below ~2; anything past this bound means the loop has gone
// unstable and must be re-centered instead of emitting garbage.
constexpr double kStateGuardLimit = 20.0;

#if defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
// Two independent channels share instructions, never filter/quantizer state.
// Keep double precision and the original operation order; ordered comparisons
// reject NaNs as well as infinities and out-of-range integrators.
void quantizePair(const double* left, const double* right, int samples, int hold,
    double* leftState, double* rightState, uint8_t* leftOutput, uint8_t* rightOutput,
    bool msb, uint64_t& resets) {
  __m128d s[5], k[5];
  for (int i = 0; i < 5; ++i) {
    s[i] = _mm_set_pd(rightState[i], leftState[i]);
    k[i] = _mm_set1_pd(kFeedback[i]);
  }
  const __m128d zero = _mm_setzero_pd(), one = _mm_set1_pd(1.0);
  const __m128d sign = _mm_set1_pd(-0.0), limit = _mm_set1_pd(kStateGuardLimit);
  const __m128d headroom = _mm_set1_pd(PcmToDsdModulator::kInputHeadroomScale);
  size_t written = 0;
  uint8_t l = 0, r = 0;
  int bits = 0;
  for (int i = 0; i < samples; ++i) {
    const __m128d u = _mm_max_pd(_mm_sub_pd(zero, headroom),
        _mm_min_pd(headroom, _mm_set_pd(right[i], left[i])));
    for (int h = 0; h < hold; ++h) {
      const __m128d positive = _mm_cmpge_pd(s[4], zero);
      const int mask = _mm_movemask_pd(positive);
      const __m128d feedback = _mm_or_pd(_mm_and_pd(positive, one),
          _mm_andnot_pd(positive, _mm_set1_pd(-1.0)));
      for (int j = 4; j > 0; --j)
        s[j] = _mm_sub_pd(_mm_add_pd(s[j], s[j - 1]), _mm_mul_pd(k[j], feedback));
      s[0] = _mm_sub_pd(_mm_add_pd(s[0], _mm_mul_pd(k[0], u)), _mm_mul_pd(k[0], feedback));
      __m128d valid = _mm_cmple_pd(_mm_andnot_pd(sign, s[0]), limit);
      for (int j = 1; j < 5; ++j)
        valid = _mm_and_pd(valid, _mm_cmple_pd(_mm_andnot_pd(sign, s[j]), limit));
      const int validMask = _mm_movemask_pd(valid);
      if (validMask != 3) {
        for (auto& state : s) state = _mm_and_pd(state, valid);
        resets += (validMask & 1 ? 0 : 1) + (validMask & 2 ? 0 : 1);
      }
      const int shift = msb ? 7 - bits : bits;
      l |= static_cast<uint8_t>((mask & 1) << shift);
      r |= static_cast<uint8_t>(((mask >> 1) & 1) << shift);
      if (++bits == 8) {
        leftOutput[written] = l; rightOutput[written++] = r;
        bits = 0; l = 0; r = 0;
      }
    }
  }
  for (int i = 0; i < 5; ++i) {
    double values[2]; _mm_storeu_pd(values, s[i]);
    leftState[i] = values[0]; rightState[i] = values[1];
  }
}
#endif

constexpr int kBaseRate441 = 44100;
constexpr int kBaseRate48 = 48000;

bool isPowerOfTwo(int value) {
  return value > 0 && (value & (value - 1)) == 0;
}

int log2OfPowerOfTwo(int value) {
  int result = 0;
  while (value > 1) {
    value >>= 1;
    ++result;
  }
  return result;
}

}  // namespace

AudioSampleFormat PcmToDsdModulator::outputSampleFormat() const {
  return config_.bitOrder == DsdBitOrder::MsbFirst ? AudioSampleFormat::DsdInt8Msb1
                                                   : AudioSampleFormat::DsdInt8Lsb1;
}

bool PcmToDsdModulator::configure(const PcmToDsdModulatorConfig& config, std::string* error) {
  configured_ = false;
  if (config.channelCount <= 0 || config.channelCount > kMaxChannels) {
    if (error) *error = "PCM to DSD modulator supports 1 to 8 channels";
    return false;
  }
  if (config.inputSampleRate <= 0) {
    if (error) *error = "PCM to DSD modulator requires a positive input sample rate";
    return false;
  }
  if (config.targetDsdRate != 64 && config.targetDsdRate != 128 && config.targetDsdRate != 256) {
    if (error) *error = "PCM to DSD modulator supports DSD64, DSD128 and DSD256";
    return false;
  }

  int baseRate = 0;
  if (config.inputSampleRate % kBaseRate441 == 0) {
    baseRate = kBaseRate441;
  } else if (config.inputSampleRate % kBaseRate48 == 0) {
    baseRate = kBaseRate48;
  } else {
    if (error) *error = "PCM to DSD modulator requires a 44.1 kHz or 48 kHz family sample rate";
    return false;
  }

  const int dsdSampleRate = baseRate * config.targetDsdRate;
  if (dsdSampleRate % config.inputSampleRate != 0) {
    if (error) *error = "Input sample rate exceeds the requested DSD rate";
    return false;
  }
  const int ratio = dsdSampleRate / config.inputSampleRate;
  if (!isPowerOfTwo(ratio) || ratio < 8) {
    if (error) *error = "Unsupported PCM to DSD oversampling ratio";
    return false;
  }

  const int ratioLog2 = log2OfPowerOfTwo(ratio);
  const int stageCount = ratioLog2 < kMaxHalfbandStages ? ratioLog2 : kMaxHalfbandStages;

  config_ = config;
  dsdSampleRate_ = dsdSampleRate;
  upsampleRatio_ = ratio;
  halfbandStageCount_ = stageCount;
  holdFactor_ = ratio >> stageCount;
  channels_.assign(static_cast<size_t>(config.channelCount), ChannelState{});
  instabilityResets_ = 0;
  configured_ = true;
  return true;
}

void PcmToDsdModulator::injectInstabilityForTest() {
  for (auto& channel : channels_) {
    for (auto& state : channel.integrators) state = kStateGuardLimit * 16.0;
  }
}

void PcmToDsdModulator::reset() {
  for (auto& channel : channels_) {
    channel.filterHistory.fill(0.0);
    channel.historyPositions.fill(0);
    channel.integrators.fill(0.0);
    channel.pendingByte = 0;
    channel.pendingBits = 0;
  }
  instabilityResets_ = 0;
}

size_t PcmToDsdModulator::process(
    const float* interleavedInput,
    size_t frames,
    uint8_t* const* channelOutputs,
    size_t channelCapacityBytes) {
  if (!configured_ || !interleavedInput || !channelOutputs) return 0;
  const size_t channelCount = static_cast<size_t>(config_.channelCount);
  const size_t outputBytes = outputBytesPerChannel(frames);
  if (outputBytes > channelCapacityBytes) return 0;
  for (size_t channel = 0; channel < channelCount; ++channel) {
    if (!channelOutputs[channel]) return 0;
  }
  if (frames == 0) return 0;

  // Ping-pong expansion buffers sized for the maximum halfband output
  // (1 << kMaxHalfbandStages samples per input frame).
  double bufferA[2][1 << kMaxHalfbandStages];
  double bufferB[1 << kMaxHalfbandStages];
  size_t written[kMaxChannels] = {};

  const bool msbFirst = config_.bitOrder == DsdBitOrder::MsbFirst;

  for (size_t frame = 0; frame < frames; ++frame) {
    for (size_t channel = 0; channel < channelCount; ++channel) {
      ChannelState& state = channels_[channel];
      int lanes = 1;
#if defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
      if (channel + 1 < channelCount) lanes = 2;
#endif
      for (int lane = 0; lane < lanes; ++lane) {
        auto& filterState = channels_[channel + static_cast<size_t>(lane)];
        double sample =
            static_cast<double>(interleavedInput[frame * channelCount + channel + lane]);
        if (!std::isfinite(sample)) sample = 0.0;
        sample *= kInputHeadroomScale;
        if (sample > kInputHeadroomScale) sample = kInputHeadroomScale;
        if (sample < -kInputHeadroomScale) sample = -kInputHeadroomScale;

        // Halfband cascade: expand one input sample into (1 << stageCount).
        double* current = bufferA[lane];
        double* next = bufferB;
        current[0] = sample;
        int sampleCount = 1;
        for (int stage = 0; stage < halfbandStageCount_; ++stage) {
          const HalfbandStageSpec& spec = kStages[stage];
          double* history = filterState.filterHistory.data() + spec.historyOffset;
          int& position = filterState.historyPositions[stage];
          switch (stage) {
            case 0: interpolate<32>(spec.taps, history, position, current, next, sampleCount); break;
            case 1: interpolate<16>(spec.taps, history, position, current, next, sampleCount); break;
            case 2: interpolate<8>(spec.taps, history, position, current, next, sampleCount); break;
            case 3: interpolate<6>(spec.taps, history, position, current, next, sampleCount); break;
          }
          double* swap = current;
          current = next;
          next = swap;
          sampleCount *= 2;
        }
        if (current != bufferA[lane])
          std::memcpy(bufferA[lane], current, static_cast<size_t>(sampleCount) * sizeof(double));
      }
      const int sampleCount = 1 << halfbandStageCount_;
#if defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
      if (lanes == 2) {
        quantizePair(bufferA[0], bufferA[1], sampleCount, holdFactor_,
            state.integrators.data(), channels_[channel + 1].integrators.data(),
            channelOutputs[channel] + written[channel], channelOutputs[channel + 1] + written[channel + 1],
            msbFirst, instabilityResets_);
        const size_t count = static_cast<size_t>(upsampleRatio_) / 8;
        written[channel] += count; written[channel + 1] += count;
        ++channel;
        continue;
      }
#endif
      const double* current = bufferA[0];

      // Sigma-delta at full DSD rate; zero-order hold for the residual ratio.
      double* integrators = state.integrators.data();
      uint8_t pendingByte = state.pendingByte;
      int pendingBits = state.pendingBits;
      uint8_t* output = channelOutputs[channel];
      size_t outIndex = written[channel];
      for (int i = 0; i < sampleCount; ++i) {
        double u = current[i];
        if (u > kInputHeadroomScale) u = kInputHeadroomScale;
        if (u < -kInputHeadroomScale) u = -kInputHeadroomScale;
        for (int hold = 0; hold < holdFactor_; ++hold) {
          const double feedback = integrators[4] >= 0.0 ? 1.0 : -1.0;
          const double s0 = integrators[0] + kFeedback[0] * u - kFeedback[0] * feedback;
          const double s1 = integrators[1] + integrators[0] - kFeedback[1] * feedback;
          const double s2 = integrators[2] + integrators[1] - kFeedback[2] * feedback;
          const double s3 = integrators[3] + integrators[2] - kFeedback[3] * feedback;
          const double s4 = integrators[4] + integrators[3] - kFeedback[4] * feedback;
          integrators[0] = s0;
          integrators[1] = s1;
          integrators[2] = s2;
          integrators[3] = s3;
          integrators[4] = s4;

          bool unstable = false;
          for (int stateIndex = 0; stateIndex < 5; ++stateIndex) {
            const double magnitude = integrators[stateIndex];
            if (!std::isfinite(magnitude) || magnitude > kStateGuardLimit ||
                magnitude < -kStateGuardLimit) {
              unstable = true;
              break;
            }
          }
          if (unstable) {
            for (int stateIndex = 0; stateIndex < 5; ++stateIndex) integrators[stateIndex] = 0.0;
            ++instabilityResets_;
          }

          const uint8_t bit = feedback > 0.0 ? 1 : 0;
          if (msbFirst) {
            pendingByte = static_cast<uint8_t>((pendingByte << 1) | bit);
          } else {
            pendingByte = static_cast<uint8_t>(pendingByte | (bit << pendingBits));
          }
          if (++pendingBits == 8) {
            output[outIndex++] = pendingByte;
            pendingByte = 0;
            pendingBits = 0;
          }
        }
      }
      state.pendingByte = pendingByte;
      state.pendingBits = pendingBits;
      written[channel] = outIndex;
    }
  }

  return written[0];
}

}  // namespace twilight::audio
