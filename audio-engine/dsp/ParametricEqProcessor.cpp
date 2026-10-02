#include "ParametricEqProcessor.h"
#include "ParametricEqProcessorUtils.h"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <utility>

namespace twilight::audio {
namespace {

constexpr double kGainEpsilonDb = 0.0001;

double dbToLinear(double db) {
  return std::pow(10.0, db / 20.0);
}

double clampFrequency(double frequency, int sampleRate) {
  const double nyquist = std::max(1.0, static_cast<double>(sampleRate) * 0.5);
  return std::clamp(frequency, 10.0, nyquist * 0.98);
}

double clampQ(double q) {
  return std::clamp(q, 0.1, 20.0);
}

bool isSupportedFilter(DspFilterType type) {
  return type == DspFilterType::Peak || type == DspFilterType::LowShelf || type == DspFilterType::HighShelf ||
         type == DspFilterType::LowPass || type == DspFilterType::HighPass || type == DspFilterType::BandPass ||
         type == DspFilterType::AllPass || type == DspFilterType::Notch;
}

bool filterNeedsProcessing(const DspEqBand& band, EqMode mode) {
  if (!band.enabled) return false;
  const DspFilterType type = mode == EqMode::Graphic ? DspFilterType::Peak : band.type;
  if (!isSupportedFilter(type)) return false;
  if (type == DspFilterType::LowPass || type == DspFilterType::HighPass ||
      type == DspFilterType::BandPass || type == DspFilterType::AllPass || type == DspFilterType::Notch) return true;
  return std::abs(band.gainDb) > kGainEpsilonDb;
}

ParametricEqProcessor::Biquad normalize(
    double b0,
    double b1,
    double b2,
    double a0,
    double a1,
    double a2) {
  if (std::abs(a0) < 1.0e-12) return {};
  return {b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
}

ParametricEqProcessor::Biquad makeBiquad(const DspEqBand& sourceBand, EqMode mode, int sampleRate) {
  DspEqBand band = sourceBand;
  if (mode == EqMode::Graphic) band.type = DspFilterType::Peak;

  const double frequency = clampFrequency(band.frequency, sampleRate);
  const double q = clampQ(band.q);
  const double w0 = 2.0 * std::numbers::pi * frequency / static_cast<double>(std::max(1, sampleRate));
  const double sinW0 = std::sin(w0);
  const double cosW0 = std::cos(w0);
  const double alpha = sinW0 / (2.0 * q);
  const double a = std::pow(10.0, band.gainDb / 40.0);

  switch (band.type) {
    case DspFilterType::Peak: {
      return normalize(1.0 + alpha * a, -2.0 * cosW0, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cosW0,
                       1.0 - alpha / a);
    }
    case DspFilterType::LowShelf: {
      const double sqrtA = std::sqrt(a);
      const double shelfAlpha = alpha;
      return normalize(
          a * ((a + 1.0) - (a - 1.0) * cosW0 + 2.0 * sqrtA * shelfAlpha),
          2.0 * a * ((a - 1.0) - (a + 1.0) * cosW0),
          a * ((a + 1.0) - (a - 1.0) * cosW0 - 2.0 * sqrtA * shelfAlpha),
          (a + 1.0) + (a - 1.0) * cosW0 + 2.0 * sqrtA * shelfAlpha,
          -2.0 * ((a - 1.0) + (a + 1.0) * cosW0),
          (a + 1.0) + (a - 1.0) * cosW0 - 2.0 * sqrtA * shelfAlpha);
    }
    case DspFilterType::HighShelf: {
      const double sqrtA = std::sqrt(a);
      const double shelfAlpha = alpha;
      return normalize(
          a * ((a + 1.0) + (a - 1.0) * cosW0 + 2.0 * sqrtA * shelfAlpha),
          -2.0 * a * ((a - 1.0) + (a + 1.0) * cosW0),
          a * ((a + 1.0) + (a - 1.0) * cosW0 - 2.0 * sqrtA * shelfAlpha),
          (a + 1.0) - (a - 1.0) * cosW0 + 2.0 * sqrtA * shelfAlpha,
          2.0 * ((a - 1.0) - (a + 1.0) * cosW0),
          (a + 1.0) - (a - 1.0) * cosW0 - 2.0 * sqrtA * shelfAlpha);
    }
    case DspFilterType::LowPass: {
      return normalize((1.0 - cosW0) * 0.5, 1.0 - cosW0, (1.0 - cosW0) * 0.5, 1.0 + alpha,
                       -2.0 * cosW0, 1.0 - alpha);
    }
    case DspFilterType::HighPass: {
      return normalize((1.0 + cosW0) * 0.5, -(1.0 + cosW0), (1.0 + cosW0) * 0.5, 1.0 + alpha,
                       -2.0 * cosW0, 1.0 - alpha);
    }
    case DspFilterType::BandPass: {
      return normalize(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cosW0, 1.0 - alpha);
    }
    case DspFilterType::AllPass: {
      return normalize(1.0 - alpha, -2.0 * cosW0, 1.0 + alpha, 1.0 + alpha, -2.0 * cosW0,
                       1.0 - alpha);
    }
    case DspFilterType::Notch: {
      return normalize(1.0, -2.0 * cosW0, 1.0, 1.0 + alpha, -2.0 * cosW0, 1.0 - alpha);
    }
    default:
      return {};
  }
}

}  // namespace

float ParametricEqProcessor::BiquadState::process(float input, const Biquad& coeffs) {
  const double out = coeffs.b0 * static_cast<double>(input) + z1;
  z1 = coeffs.b1 * static_cast<double>(input) - coeffs.a1 * out + z2;
  z2 = coeffs.b2 * static_cast<double>(input) - coeffs.a2 * out;
  if (!std::isfinite(out)) {
    reset();
    return 0.0f;
  }
  return static_cast<float>(std::clamp(out, -4.0, 4.0));
}

void ParametricEqProcessor::BiquadState::reset() {
  z1 = 0.0;
  z2 = 0.0;
}

void ParametricEqProcessor::configure(const DspConfig& config) {
  config_ = config;
  rebuildFilters();
}

void ParametricEqProcessor::prepare(const AudioFormat& format) {
  format_ = format;
  rebuildFilters();
}

void ParametricEqProcessor::setTrackContext(const DspTrackContext&) {
}

void ParametricEqProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples || frameCount == 0) return;

  const int channels = std::max(1, format_.channelCount);
  if (filters_.empty()) {
    eq::applyPreampOnly(samples, frameCount * static_cast<size_t>(channels), preampLinear_);
    return;
  }

  for (size_t frame = 0; frame < frameCount; ++frame) {
    for (int channel = 0; channel < channels; ++channel) {
      const size_t index = frame * static_cast<size_t>(channels) + static_cast<size_t>(channel);
      float value = static_cast<float>(std::clamp(static_cast<double>(samples[index]) * preampLinear_, -4.0, 4.0));
      for (auto& filter : filters_) {
        if ((filter.channelMask & (uint32_t{1} << std::min(channel, 31))) == 0) continue;
        value = filter.channelStates[static_cast<size_t>(channel)].process(value, filter.coeffs);
      }
      samples[index] = value;
    }
  }
}

bool ParametricEqProcessor::isActive() const {
  return active_;
}

void ParametricEqProcessor::reset() {
  for (auto& filter : filters_) {
    for (auto& state : filter.channelStates) {
      state.reset();
    }
  }
}

void ParametricEqProcessor::rebuildFilters() {
  filters_.clear();
  preampLinear_ = dbToLinear(config_.eqPreampDb);
  active_ = false;

  if (!config_.enabled || !config_.eqEnabled || format_.sampleRate <= 0 || format_.channelCount <= 0) return;

  active_ = std::abs(config_.eqPreampDb) > kGainEpsilonDb;
  for (const auto& band : config_.eqBands) {
    if (!filterNeedsProcessing(band, config_.eqMode)) continue;
    FilterBand filter;
    filter.coeffs = makeBiquad(band, config_.eqMode, format_.sampleRate);
    filter.channelStates.resize(static_cast<size_t>(std::max(1, format_.channelCount)));
    filter.channelMask = band.channelMask;
    filters_.push_back(std::move(filter));
  }

  active_ = active_ || !filters_.empty();
}

}  // namespace twilight::audio
