#include "ChannelRouter.h"

#include "ChannelRouterDelayUtils.h"

#include <algorithm>
#include <cstring>
#include <cmath>

namespace twilight::audio {

ChannelRouter::ChannelRouter() {
  recomputeCoefficients();
}

void ChannelRouter::setUpmixConfig(const UpmixConfig& config) {
  config_ = config;
  recomputeCoefficients();
}

void ChannelRouter::setSampleRate(int sampleRate) {
  if (sampleRate <= 0) return;
  // No early-out on an unchanged rate: recomputing is a handful of float ops, and the
  // guard used to make setSampleRate(48000) -- the default -- a silent no-op.
  sampleRate_ = sampleRate;
  recomputeCoefficients();
}

void ChannelRouter::prepareForRealtime(int sampleRate, float maximumDelayMs) {
  if (sampleRate > 0) sampleRate_ = sampleRate;
  const float boundedDelayMs = std::max(0.0f, maximumDelayMs);
  realtimeDelayCapacity_ = static_cast<size_t>(
      boundedDelayMs * 0.001f * static_cast<float>(sampleRate_));
  surroundLeftDelay_.assign(realtimeDelayCapacity_, 0.0f);
  surroundRightDelay_.assign(realtimeDelayCapacity_, 0.0f);
  surroundLeftDelayGeneration_.assign(realtimeDelayCapacity_, 0);
  surroundRightDelayGeneration_.assign(realtimeDelayCapacity_, 0);
  realtimePrepared_ = true;
  sourceToken_ = 0;
  delayGeneration_ = 1;
  surroundDelaySamples_ = 0;
  surroundLeftDelayCursor_ = 0;
  surroundRightDelayCursor_ = 0;
  lfePrev_ = 0.0f;
  recomputeCoefficients();
}

void ChannelRouter::reset() {
  lfePrev_ = 0.0f;
  if (realtimePrepared_) {
    resetRealtimeDelayState();
    return;
  }
  channel_router::prepareDelayLine(surroundLeftDelay_, surroundDelaySamples_, surroundLeftDelayCursor_);
  channel_router::prepareDelayLine(surroundRightDelay_, surroundDelaySamples_, surroundRightDelayCursor_);
}

void ChannelRouter::beginSource(uint64_t token) {
  if (sourceToken_ == token) return;
  sourceToken_ = token;
  reset();
}

void ChannelRouter::recomputeCoefficients() {
  // 一阶低通：alpha = dt / (RC + dt), RC = 1 / (2π × fc)
  const float dt = 1.0f / static_cast<float>(sampleRate_);
  const float fc = std::max(1.0f, config_.lfeLowpassHz);
  const float rc = 1.0f / (2.0f * 3.14159265f * fc);
  lfeAlpha_ = dt / (rc + dt);

  // 环绕延迟线大小
  const size_t newDelay = static_cast<size_t>(
      std::max(0.0f, config_.surroundDelayMs) * 0.001f * static_cast<float>(sampleRate_));
  if (realtimePrepared_) {
    const size_t boundedDelay = std::min(newDelay, realtimeDelayCapacity_);
    if (surroundDelaySamples_ != boundedDelay) {
      surroundDelaySamples_ = boundedDelay;
      resetRealtimeDelayState();
    }
    return;
  }
  if (surroundDelaySamples_ != newDelay) {
    surroundDelaySamples_ = newDelay;
    channel_router::prepareDelayLine(surroundLeftDelay_, surroundDelaySamples_, surroundLeftDelayCursor_);
    channel_router::prepareDelayLine(surroundRightDelay_, surroundDelaySamples_, surroundRightDelayCursor_);
  }
}

void ChannelRouter::resetRealtimeDelayState() {
  surroundLeftDelayCursor_ = 0;
  surroundRightDelayCursor_ = 0;
  ++delayGeneration_;
  if (delayGeneration_ == 0) delayGeneration_ = 1;
}

float ChannelRouter::pushRealtimeDelaySample(
    std::vector<float>& delayLine,
    std::vector<uint32_t>& generations,
    size_t& cursor,
    float sample) {
  if (surroundDelaySamples_ == 0 || delayLine.empty() || generations.empty()) return sample;
  if (cursor >= surroundDelaySamples_) cursor = 0;
  const size_t index = cursor;
  const float delayed = generations[index] == delayGeneration_ ? delayLine[index] : 0.0f;
  delayLine[index] = sample;
  generations[index] = delayGeneration_;
  cursor = (index + 1) % surroundDelaySamples_;
  return delayed;
}

void ChannelRouter::route(const float* source, float* destination,
                          size_t frameCount,
                          int sourceChannels, int destinationChannels,
                          ChannelRoutingMode mode) {
  if (frameCount == 0 || sourceChannels <= 0 || destinationChannels <= 0) return;

  // 无需上混的路径：直接拷贝
  if (sourceChannels == destinationChannels && mode == ChannelRoutingMode::Auto) {
    if (source != destination) {
      std::memcpy(destination, source,
                  frameCount * static_cast<size_t>(sourceChannels) * sizeof(float));
    }
    return;
  }

  switch (mode) {
    case ChannelRoutingMode::StereoTo51:
      if (sourceChannels >= 2 && destinationChannels >= 6) {
        processUpmix51(source, destination, frameCount);
      } else {
        processPassthrough(source, destination, frameCount,
                           sourceChannels, destinationChannels, mode);
      }
      break;
    case ChannelRoutingMode::StereoTo71:
      if (sourceChannels >= 2 && destinationChannels >= 8) {
        processUpmix71(source, destination, frameCount);
      } else {
        processPassthrough(source, destination, frameCount,
                           sourceChannels, destinationChannels, mode);
      }
      break;
    default:
      processPassthrough(source, destination, frameCount,
                         sourceChannels, destinationChannels, mode);
      break;
  }
}

// ─── 5.1 上混 ───
// ITU-R BS.775 布局: [L, R, C, LFE, RL, RR]
void ChannelRouter::processUpmix51(const float* src, float* dst, size_t frames) {
  const float cg = config_.centerGain;
  const float lg = config_.lfeGain;
  const float sg = config_.surroundGain;

  for (size_t i = 0; i < frames; ++i) {
    const float l = src[i * 2 + 0];
    const float r = src[i * 2 + 1];
    float* out = dst + i * 6;

    out[0] = l;                          // L 直通
    out[1] = r;                          // R 直通
    out[2] = (l + r) * cg;               // Center = (L+R) × centerGain

    // LFE = (L+R) × lfeGain，经一阶低通
    const float lfeInput = (l + r) * lg;
    lfePrev_ = lfePrev_ + lfeAlpha_ * (lfeInput - lfePrev_);
    out[3] = lfePrev_;

    // 环绕（可选延迟）
    const float rl = l * sg;
    const float rr = r * sg;
    if (surroundDelaySamples_ > 0) {
      if (realtimePrepared_) {
        out[4] = pushRealtimeDelaySample(
            surroundLeftDelay_, surroundLeftDelayGeneration_, surroundLeftDelayCursor_, rl);
        out[5] = pushRealtimeDelaySample(
            surroundRightDelay_, surroundRightDelayGeneration_, surroundRightDelayCursor_, rr);
      } else {
        out[4] = channel_router::pushDelaySample(surroundLeftDelay_, surroundLeftDelayCursor_, rl);
        out[5] = channel_router::pushDelaySample(surroundRightDelay_, surroundRightDelayCursor_, rr);
      }
    } else {
      out[4] = rl;                       // RL = L × surroundGain
      out[5] = rr;                       // RR = R × surroundGain
    }
  }
}

// ─── 7.1 上混 ───
// 布局: [L, R, C, LFE, RL, RR, SL, SR]
void ChannelRouter::processUpmix71(const float* src, float* dst, size_t frames) {
  const float cg = config_.centerGain;
  const float lg = config_.lfeGain;
  const float sg = config_.surroundGain;
  const float sideG = config_.sideGain;

  for (size_t i = 0; i < frames; ++i) {
    const float l = src[i * 2 + 0];
    const float r = src[i * 2 + 1];
    float* out = dst + i * 8;

    out[0] = l;                          // L 直通
    out[1] = r;                          // R 直通
    out[2] = (l + r) * cg;               // Center

    // LFE 低通
    const float lfeInput = (l + r) * lg;
    lfePrev_ = lfePrev_ + lfeAlpha_ * (lfeInput - lfePrev_);
    out[3] = lfePrev_;

    // 后环绕
    out[4] = l * sg;                     // RL
    out[5] = r * sg;                     // RR
    // 侧环绕（更低增益，营造空间感）
    out[6] = l * sideG;                  // SL
    out[7] = r * sideG;                  // SR
  }
}

// ─── 退化路径：原有无状态逻辑（Mono/Stereo/Auto 等）───
void ChannelRouter::processPassthrough(const float* src, float* dst,
                                       size_t frames, int srcCh, int dstCh,
                                       ChannelRoutingMode mode) {
  if (channel_router::canFastRouteMonoToStereo(srcCh, dstCh, mode)) {
    channel_router::routeMonoToStereo(src, dst, frames);
    return;
  }

  for (size_t frame = 0; frame < frames; ++frame) {
    const float* srcFrame = src + frame * static_cast<size_t>(srcCh);
    float* dstFrame = dst + frame * static_cast<size_t>(dstCh);
    for (int dst = 0; dst < dstCh; ++dst) {
      float sample = 0.0f;
      switch (mode) {
        case ChannelRoutingMode::MonoToStereo:
        case ChannelRoutingMode::MonoToMultichannel:
          if (dst < 2 || mode == ChannelRoutingMode::MonoToMultichannel)
            sample = srcFrame[0];
          break;
        case ChannelRoutingMode::Stereo:
          if (dst < 2 && dst < srcCh) sample = srcFrame[dst];
          break;
        default:
          if (dst < srcCh) sample = srcFrame[dst];
          break;
      }
      dstFrame[dst] = sample;
    }
  }
}

}  // namespace twilight::audio
