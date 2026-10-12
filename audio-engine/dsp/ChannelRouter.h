#pragma once

#include "../core/AudioTypes.h"
#include <cstddef>
#include <cstdint>
#include <vector>

namespace twilight::audio {

/// 上混参数配置（5.1 / 7.1 声道扩展）
struct UpmixConfig {
  /// 中置增益（线性，1.0 = 原始电平）。默认 -3dB
  float centerGain = 0.7071f;
  /// LFE 增益。默认 -6dB
  float lfeGain = 0.5f;
  /// LFE 低通截止频率 (Hz)
  float lfeLowpassHz = 120.0f;
  /// 后环绕增益。默认 -6dB
  float surroundGain = 0.5f;
  /// 侧环绕增益（仅 7.1）。默认 -10dB
  float sideGain = 0.3f;
  /// 环绕延迟（毫秒），0 = 无延迟
  float surroundDelayMs = 0.0f;
};

/// 有状态的声道路由/上混处理器
///
/// 替代原来的无状态自由函数 routeChannels()。
/// 支持 LFE 低通滤波和环绕延迟线，实现真正的 5.1/7.1 上混。
class ChannelRouter {
 public:
  /// 计算默认采样率/截止频率下的滤波器系数，使对象一构造即可用。
  /// 缺了这一步，只调用 setSampleRate(48000)（正好等于默认值）的调用方会拿到
  /// lfeAlpha_ = 0 的惰性低通，LFE 恒为静音。
  ChannelRouter();

  /// 配置上混参数（可在播放中实时调整）
  void setUpmixConfig(const UpmixConfig& config);
  UpmixConfig upmixConfig() const { return config_; }

  /// 采样率变更时通知（重算滤波器系数和延迟线大小）
  void setSampleRate(int sampleRate);

  // Allocate the delay-line storage before an output callback starts. Once
  // prepared, runtime parameter changes only advance a generation counter and
  // never resize or clear a buffer on the audio thread.
  void prepareForRealtime(int sampleRate, float maximumDelayMs);

  /// 重置所有状态（切歌/切设备时调用）
  void reset();

  // Called by the render owner before routing a deck. Continuation decoders
  // keep the same token; a new source/seek clears history without allocation.
  void beginSource(uint64_t token);

  /// 路由/上混
  void route(const float* source, float* destination,
             size_t frameCount,
             int sourceChannels, int destinationChannels,
             ChannelRoutingMode mode);

 private:
  UpmixConfig config_;
  int sampleRate_ = 48000;

  // LFE 一阶低通滤波器状态
  float lfePrev_ = 0.0f;
  float lfeAlpha_ = 0.0f;

  // 环绕延迟线
  std::vector<float> surroundLeftDelay_;
  std::vector<float> surroundRightDelay_;
  std::vector<uint32_t> surroundLeftDelayGeneration_;
  std::vector<uint32_t> surroundRightDelayGeneration_;
  size_t surroundDelaySamples_ = 0;
  size_t surroundLeftDelayCursor_ = 0;
  size_t surroundRightDelayCursor_ = 0;
  size_t realtimeDelayCapacity_ = 0;
  uint32_t delayGeneration_ = 1;
  bool realtimePrepared_ = false;
  uint64_t sourceToken_ = 0;

  void recomputeCoefficients();
  void resetRealtimeDelayState();
  float pushRealtimeDelaySample(
      std::vector<float>& delayLine,
      std::vector<uint32_t>& generations,
      size_t& cursor,
      float sample);
  void processUpmix51(const float* src, float* dst, size_t frames);
  void processUpmix71(const float* src, float* dst, size_t frames);
  void processPassthrough(const float* src, float* dst, size_t frames,
                          int srcCh, int dstCh, ChannelRoutingMode mode);
};

}  // namespace twilight::audio
