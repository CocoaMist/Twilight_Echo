#include "ReplayGainProcessor.h"
#include "ReplayGainProcessorUtils.h"

#include <cmath>

namespace twilight::audio {
namespace {

constexpr double kGainEpsilonDb = 0.0001;
constexpr double kDefaultLoudnormTargetLufs = -23.0;
constexpr double kDefaultLoudnormTruePeakCeilingDb = -1.0;

double dbToLinear(double db) {
  return std::pow(10.0, db / 20.0);
}

}  // namespace

void ReplayGainProcessor::configure(const DspConfig& config) {
  config_ = config;
  updateGain({});
}

void ReplayGainProcessor::prepare(const AudioFormat& format) {
  format_ = format;
}

void ReplayGainProcessor::setTrackContext(const DspTrackContext& context) {
  updateGain(context.stream.replayGain);
}

void ReplayGainProcessor::process(float* samples, size_t frameCount) {
  if (!active_ || !samples || frameCount == 0) return;

  const size_t sampleCount = frameCount * static_cast<size_t>(std::max(1, format_.channelCount));
  replaygain::applyReplayGain(samples, sampleCount, gainLinear_, config_.replayGainClip);
}

void ReplayGainProcessor::processDouble(double* samples, size_t frameCount) {
  if (!active_ || !samples || frameCount == 0) return;

  const size_t sampleCount = frameCount * static_cast<size_t>(std::max(1, format_.channelCount));
  for (size_t i = 0; i < sampleCount; ++i) {
    double scaled = samples[i] * gainLinear_;
    if (config_.replayGainClip) {
      scaled = std::clamp(scaled, -1.0, 1.0);
    }
    samples[i] = scaled;
  }
}

void ReplayGainProcessor::reset() {
}

bool ReplayGainProcessor::isActive() const {
  return active_;
}

double ReplayGainProcessor::currentGainDb() const {
  return active_ ? gainDb_ : 0.0;
}

void ReplayGainProcessor::updateGain(const ReplayGainInfo& info) {
  if (!config_.enabled || config_.replayGainMode == ReplayGainMode::Off) {
    gainDb_ = 0.0;
    gainLinear_ = 1.0;
    active_ = false;
    return;
  }

  if (config_.replayGainMode == ReplayGainMode::Loudnorm) {
    const double targetLufs =
        std::isfinite(config_.loudnormTargetLufs) ? config_.loudnormTargetLufs : kDefaultLoudnormTargetLufs;
    const double truePeakCeilingDb = std::isfinite(config_.loudnormTruePeakCeilingDb)
                                         ? config_.loudnormTruePeakCeilingDb
                                         : kDefaultLoudnormTruePeakCeilingDb;

    double gainDb = config_.replayGainFallbackDb + config_.replayGainPreampDb;
    if (info.measuredIntegratedLufs && std::isfinite(*info.measuredIntegratedLufs)) {
      gainDb = (targetLufs - *info.measuredIntegratedLufs) + config_.replayGainPreampDb;
      if (info.measuredTruePeakDb && std::isfinite(*info.measuredTruePeakDb)) {
        const double projectedTruePeak = *info.measuredTruePeakDb + gainDb;
        if (projectedTruePeak > truePeakCeilingDb) {
          gainDb -= (projectedTruePeak - truePeakCeilingDb);
        }
      }
    }

    gainDb_ = gainDb;
    gainLinear_ = dbToLinear(gainDb_);
    // Loudnorm stays active while enabled so perfect reporting stays honest even at ~0 dB.
    active_ = true;
    return;
  }

  std::optional<double> selected;
  if (config_.replayGainMode == ReplayGainMode::Track) {
    selected = info.trackGainDb ? info.trackGainDb : info.r128TrackGainDb;
  } else if (config_.replayGainMode == ReplayGainMode::Album) {
    selected = info.albumGainDb ? info.albumGainDb : info.r128AlbumGainDb;
  }

  gainDb_ = selected.value_or(config_.replayGainFallbackDb) + config_.replayGainPreampDb;
  gainLinear_ = dbToLinear(gainDb_);
  active_ = std::abs(gainDb_) > kGainEpsilonDb;
}

}  // namespace twilight::audio
