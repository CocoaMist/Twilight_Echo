#include "../dsp/ChannelRouter.h"
#include "../dsp/ChannelRouterDelayUtils.h"
#include "../core/AudioTypes.h"

#include <cassert>
#include <cmath>
#include <cstdlib>
#include <vector>

using namespace twilight::audio;

namespace {

constexpr float kTolerance = 1e-4f;

bool closeTo(float actual, float expected, float tolerance = kTolerance) {
  return std::abs(actual - expected) <= tolerance;
}

void require(bool condition) {
  if (!condition) std::abort();
}

void testSurroundDelayLineOverwritesRingSlot() {
  std::vector<float> delay = {0.0f, 0.0f};
  size_t cursor = 0;

  const float first = channel_router::pushDelaySample(delay, cursor, 0.5f);
  const float second = channel_router::pushDelaySample(delay, cursor, 0.25f);
  const float third = channel_router::pushDelaySample(delay, cursor, 0.0f);

  assert(closeTo(first, 0.0f));
  assert(closeTo(second, 0.0f));
  assert(closeTo(third, 0.5f));
  assert(cursor == 1);
  assert(closeTo(delay[0], 0.0f));
  assert(closeTo(delay[1], 0.25f));
}

/// 默认配置下的一阶低通系数 alpha
/// alpha = dt / (rc + dt), dt = 1/sr, rc = 1/(2*pi*fc)
float computeLfeAlpha(int sampleRate, float lowpassHz) {
  const float dt = 1.0f / static_cast<float>(sampleRate);
  const float rc = 1.0f / (2.0f * 3.14159265f * lowpassHz);
  return dt / (rc + dt);
}

/// 生成交错立体声样本：L 和 R 各 N 帧
std::vector<float> makeStereo(float l, float r, size_t frames) {
  std::vector<float> buf(frames * 2);
  for (size_t i = 0; i < frames; ++i) {
    buf[i * 2] = l;
    buf[i * 2 + 1] = r;
  }
  return buf;
}

// ──────────────────────────────────────────────
// 1. 5.1 上混基础：L/R 直通、Center 提取、Surround 增益
// ──────────────────────────────────────────────
void testUpmix51Basic() {
  ChannelRouter router;
  router.setSampleRate(48000);

  const float l = 0.5f;
  const float r = 0.5f;
  auto input = makeStereo(l, r, 1);
  std::vector<float> output(6, -999.0f);

  router.route(input.data(), output.data(), 1, 2, 6, ChannelRoutingMode::StereoTo51);

  // L/R 直通无衰减
  assert(closeTo(output[0], l));
  assert(closeTo(output[1], r));
  // Center = (L+R) * centerGain (默认 0.7071)
  assert(closeTo(output[2], (l + r) * 0.7071f));
  // RL = L * surroundGain, RR = R * surroundGain (默认 0.5)
  assert(closeTo(output[4], l * 0.5f));
  assert(closeTo(output[5], r * 0.5f));
}

// ──────────────────────────────────────────────
// 2. 7.1 上混基础：8 通道全有值，SL/SR 增益正确
// ──────────────────────────────────────────────
void testUpmix71Basic() {
  ChannelRouter router;
  router.setSampleRate(48000);

  const float l = 0.8f;
  const float r = -0.3f;
  auto input = makeStereo(l, r, 1);
  std::vector<float> output(8, -999.0f);

  router.route(input.data(), output.data(), 1, 2, 8, ChannelRoutingMode::StereoTo71);

  assert(closeTo(output[0], l));
  assert(closeTo(output[1], r));
  assert(closeTo(output[2], (l + r) * 0.7071f));
  // RL/RR
  assert(closeTo(output[4], l * 0.5f));
  assert(closeTo(output[5], r * 0.5f));
  // SL/SR (默认 sideGain = 0.3)
  assert(closeTo(output[6], l * 0.3f));
  assert(closeTo(output[7], r * 0.3f));
}

// ──────────────────────────────────────────────
// 3. LFE 低通：直流稳态趋近于 lfeInput
// ──────────────────────────────────────────────
void testLfeLowpassSteadyState() {
  ChannelRouter router;
  router.setSampleRate(48000);

  const float l = 1.0f;
  const float r = 1.0f;
  const size_t frames = 100000;  // 足够让一阶低通收敛
  auto input = makeStereo(l, r, frames);
  std::vector<float> output(frames * 6);

  router.route(input.data(), output.data(), frames, 2, 6, ChannelRoutingMode::StereoTo51);

  // 直流稳态：一阶低通增益为 1.0，LFE 应趋近于 (L+R)*lfeGain = 1.0
  const float lfeSteady = output[(frames - 1) * 6 + 3];
  const float lfeInput = (l + r) * 0.5f;  // lfeGain = 0.5
  assert(closeTo(lfeSteady, lfeInput, 0.01f));
}

// ──────────────────────────────────────────────
// 4. LFE 低通：高频被衰减
// ──────────────────────────────────────────────
void testLfeLowpassHighFrequencyAttenuation() {
  ChannelRouter router;
  router.setSampleRate(48000);

  const int sampleRate = 48000;
  const float freq = 5000.0f;  // 远高于 120Hz 截止
  const size_t frames = 4096;
  std::vector<float> input(frames * 2);
  for (size_t i = 0; i < frames; ++i) {
    const float s = static_cast<float>(std::sin(2.0 * 3.14159265 * freq * i / sampleRate));
    input[i * 2] = s;
    input[i * 2 + 1] = s;
  }
  std::vector<float> output(frames * 6);

  router.route(input.data(), output.data(), frames, 2, 6, ChannelRoutingMode::StereoTo51);

  // 测量 LFE 通道的峰值幅度
  float lfePeak = 0.0f;
  for (size_t i = 1000; i < frames; ++i) {  // 跳过暂态
    lfePeak = std::max(lfePeak, std::abs(output[i * 6 + 3]));
  }

  // lfeInput 峰值 = (1.0 + 1.0) * 0.5 = 1.0
  // 5000Hz 远超 120Hz 截止，低通应大幅衰减
  // 一阶低通在 5000Hz 的增益约 fc/freq = 120/5000 = 0.024
  assert(lfePeak < 0.1f);
}

// ──────────────────────────────────────────────
// 5. LFE 低通：首帧值正确（alpha * lfeInput）
// ──────────────────────────────────────────────
void testLfeFirstFrameValue() {
  ChannelRouter router;
  router.setSampleRate(48000);

  const float l = 0.5f;
  const float r = 0.5f;
  auto input = makeStereo(l, r, 1);
  std::vector<float> output(6);

  router.route(input.data(), output.data(), 1, 2, 6, ChannelRoutingMode::StereoTo51);

  const float alpha = computeLfeAlpha(48000, 120.0f);
  const float lfeInput = (l + r) * 0.5f;
  // 首帧：lfePrev_ 初始为 0，输出 = 0 + alpha * (lfeInput - 0) = alpha * lfeInput
  assert(closeTo(output[3], alpha * lfeInput, 1e-5f));
}

// ──────────────────────────────────────────────
// 6. 环绕延迟：delayMs > 0 时 RL/RR 滞后
// ──────────────────────────────────────────────
void testSurroundDelay() {
  ChannelRouter router;
  UpmixConfig config;
  config.surroundDelayMs = 10.0f;  // 10ms @ 48000Hz = 480 samples
  router.setSampleRate(48000);
  router.setUpmixConfig(config);

  // 延迟线大小应为 480
  const size_t expectedDelay = static_cast<size_t>(10.0f * 0.001f * 48000);
  assert(expectedDelay == 480);

  // 处理一帧 L=1.0, R=0.0
  auto input = makeStereo(1.0f, 0.0f, 1);
  std::vector<float> output(6);
  router.route(input.data(), output.data(), 1, 2, 6, ChannelRoutingMode::StereoTo51);

  // 首帧 RL/RR 应为 0（延迟线预填 0，输出的是延迟线头部）
  assert(closeTo(output[4], 0.0f));
  assert(closeTo(output[5], 0.0f));

  // 处理 479 帧静音，延迟线应该还没排空到实际信号
  auto silence = makeStereo(0.0f, 0.0f, 479);
  std::vector<float> silenceOutput(479 * 6);
  router.route(silence.data(), silenceOutput.data(), 479, 2, 6, ChannelRoutingMode::StereoTo51);

  // 第 480 帧（总第 480 帧，0-indexed = 479）应该输出最初写入的信号
  // 最初写入的是 RL = 1.0 * 0.5 = 0.5
  auto frame480 = makeStereo(0.0f, 0.0f, 1);
  std::vector<float> out480(6);
  router.route(frame480.data(), out480.data(), 1, 2, 6, ChannelRoutingMode::StereoTo51);

  // 第 480 帧输出应为最初推入的值
  assert(closeTo(out480[4], 0.5f));
}

// ──────────────────────────────────────────────
// 7. reset() 后滤波器状态归零
// ──────────────────────────────────────────────
void testResetClearsState() {
  ChannelRouter router;
  router.setSampleRate(48000);

  // 先处理一些样本建立滤波器状态
  auto input1 = makeStereo(1.0f, 1.0f, 1000);
  std::vector<float> output1(1000 * 6);
  router.route(input1.data(), output1.data(), 1000, 2, 6, ChannelRoutingMode::StereoTo51);

  // 此时 LFE 已有显著状态
  assert(std::abs(output1[999 * 6 + 3]) > 0.01f);

  // reset
  router.reset();

  // 再处理一帧，LFE 应回到首帧值（alpha * lfeInput）
  auto input2 = makeStereo(1.0f, 1.0f, 1);
  std::vector<float> output2(6);
  router.route(input2.data(), output2.data(), 1, 2, 6, ChannelRoutingMode::StereoTo51);

  const float alpha = computeLfeAlpha(48000, 120.0f);
  const float lfeInput = (1.0f + 1.0f) * 0.5f;
  assert(closeTo(output2[3], alpha * lfeInput, 1e-5f));
}

// ──────────────────────────────────────────────
// 8. 退化路径：sourceChannels < 2 时不崩溃
// ──────────────────────────────────────────────
void testPassthroughDegenerate() {
  ChannelRouter router;
  router.setSampleRate(48000);

  // 单声道输入，StereoTo51 模式 → 走 passthrough
  std::vector<float> input = {0.7f, 0.7f, 0.7f};  // 3 帧 mono
  std::vector<float> output(3 * 6, -999.0f);

  router.route(input.data(), output.data(), 3, 1, 6, ChannelRoutingMode::StereoTo51);

  // passthrough default 分支：dst < srcCh(1) 时 sample = srcFrame[dst]
  assert(closeTo(output[0], 0.7f));   // dst=0 < 1 → srcFrame[0]
  assert(closeTo(output[1], 0.0f));   // dst=1 >= 1 → 0
  assert(closeTo(output[5], 0.0f));   // dst=5 >= 1 → 0
}

// ──────────────────────────────────────────────
// 9. Auto 模式等通道直接拷贝
// ──────────────────────────────────────────────
void testAutoModeCopy() {
  ChannelRouter router;
  router.setSampleRate(48000);

  std::vector<float> input = {0.1f, 0.2f, 0.3f, 0.4f};  // 2 帧 stereo
  std::vector<float> output(4, -1.0f);

  router.route(input.data(), output.data(), 2, 2, 2, ChannelRoutingMode::Auto);

  assert(output == input);
}

// ──────────────────────────────────────────────
// 10. 自定义 UpmixConfig 增益生效
// ──────────────────────────────────────────────
void testCustomUpmixConfig() {
  ChannelRouter router;
  router.setSampleRate(48000);

  UpmixConfig config;
  config.centerGain = 1.0f;
  config.lfeGain = 0.25f;
  config.surroundGain = 0.75f;
  config.sideGain = 0.4f;
  router.setUpmixConfig(config);

  const float l = 0.5f;
  const float r = 0.5f;
  auto input = makeStereo(l, r, 1);
  std::vector<float> output(8);

  router.route(input.data(), output.data(), 1, 2, 8, ChannelRoutingMode::StereoTo71);

  assert(closeTo(output[2], (l + r) * 1.0f));     // custom centerGain
  assert(closeTo(output[4], l * 0.75f));           // custom surroundGain
  assert(closeTo(output[6], l * 0.4f));            // custom sideGain
}

// ──────────────────────────────────────────────
// 11. setSampleRate 重算延迟线大小
// ──────────────────────────────────────────────
void testSetSampleRateRecomputesDelay() {
  ChannelRouter router;
  UpmixConfig config;
  config.surroundDelayMs = 5.0f;  // 5ms
  router.setUpmixConfig(config);

  // 默认 48000 → 5ms = 240 samples
  router.setSampleRate(48000);
  auto input = makeStereo(1.0f, 0.0f, 1);
  std::vector<float> output(6);
  router.route(input.data(), output.data(), 1, 2, 6, ChannelRoutingMode::StereoTo51);

  // 首帧 RL 应为 0（延迟线长度 240，输出头部 0）
  assert(closeTo(output[4], 0.0f));

  // 切到 96000 → 5ms = 480 samples
  router.setSampleRate(96000);
  router.reset();
  router.route(input.data(), output.data(), 1, 2, 6, ChannelRoutingMode::StereoTo51);

  // 首帧 RL 仍应为 0（延迟线重算为 480，重新填 0）
  assert(closeTo(output[4], 0.0f));
}

// ──────────────────────────────────────────────
// 12. Mono → Stereo 路由
// ──────────────────────────────────────────────
void testMonoToStereoRouting() {
  ChannelRouter router;
  router.setSampleRate(48000);

  std::vector<float> input = {0.6f, 0.6f};  // 2 帧 mono
  std::vector<float> output(4, -1.0f);

  router.route(input.data(), output.data(), 2, 1, 2, ChannelRoutingMode::MonoToStereo);

  // MonoToStereo: dst < 2 时 sample = srcFrame[0]
  assert(closeTo(output[0], 0.6f));
  assert(closeTo(output[1], 0.6f));
  assert(closeTo(output[2], 0.6f));
  assert(closeTo(output[3], 0.6f));
}

void testMonoToStereoFastRoutePredicate() {
  require(channel_router::canFastRouteMonoToStereo(1, 2, ChannelRoutingMode::MonoToStereo));
  require(!channel_router::canFastRouteMonoToStereo(1, 6, ChannelRoutingMode::MonoToMultichannel));
  require(!channel_router::canFastRouteMonoToStereo(2, 2, ChannelRoutingMode::Stereo));
}

// ──────────────────────────────────────────────
// 13. 5.1 多帧连续处理：L/R 直通在多帧下正确
// ──────────────────────────────────────────────
void testUpmix51MultipleFrames() {
  ChannelRouter router;
  router.setSampleRate(48000);

  const size_t frames = 256;
  std::vector<float> input(frames * 2);
  for (size_t i = 0; i < frames; ++i) {
    input[i * 2] = static_cast<float>(i) / 100.0f;
    input[i * 2 + 1] = -static_cast<float>(i) / 100.0f;
  }
  std::vector<float> output(frames * 6);

  router.route(input.data(), output.data(), frames, 2, 6, ChannelRoutingMode::StereoTo51);

  // 抽查若干帧的 L/R 直通
  for (size_t i : {0, 1, 50, 127, 200, 255}) {
    assert(closeTo(output[i * 6], input[i * 2]));
    assert(closeTo(output[i * 6 + 1], input[i * 2 + 1]));
    // Center = (L+R) * 0.7071 = 0 (因为 R = -L)
    assert(closeTo(output[i * 6 + 2], 0.0f));
  }
}

// ──────────────────────────────────────────────
// 14. 零帧输入不崩溃
// ──────────────────────────────────────────────
void testZeroFramesNoCrash() {
  ChannelRouter router;
  router.setSampleRate(48000);

  std::vector<float> input;
  std::vector<float> output(6, -999.0f);

  router.route(input.data(), output.data(), 0, 2, 6, ChannelRoutingMode::StereoTo51);

  // 不崩溃即通过，output 未被修改
  assert(output[0] == -999.0f);
}

void testThreeDeckSourceLifetimes() {
  ChannelRouter first, second, uninterrupted;
  UpmixConfig config;
  config.surroundDelayMs = 20;
  for (auto* router : {&first, &second, &uninterrupted}) {
    router->setUpmixConfig(config);
    router->prepareForRealtime(48000, 1000);
  }
  const size_t frames = 512;
  std::vector<float> audio(frames * 2, 0.25f), silence(frames * 2, 0.0f);
  std::vector<float> actual(frames * 6), expected(frames * 6);
  first.beginSource(1);
  first.route(audio.data(), actual.data(), frames, 2, 6, ChannelRoutingMode::StereoTo51);
  second.beginSource(2);
  uninterrupted.beginSource(2);
  second.route(audio.data(), actual.data(), frames, 2, 6, ChannelRoutingMode::StereoTo51);
  uninterrupted.route(audio.data(), expected.data(), frames, 2, 6, ChannelRoutingMode::StereoTo51);
  // Decoder continuation after promotion must retain both the LFE and delay.
  second.beginSource(2);
  second.route(silence.data(), actual.data(), frames, 2, 6, ChannelRoutingMode::StereoTo51);
  uninterrupted.route(silence.data(), expected.data(), frames, 2, 6, ChannelRoutingMode::StereoTo51);
  assert(actual == expected);
  assert(actual[3] > 0); // a reset would erase the LFE tail
  // Reuse the old outgoing deck for track three. Even before all old delay
  // slots have been overwritten, silence must contain no track-one history.
  first.beginSource(3);
  for (unsigned block = 0; block < 4; ++block) {
    first.route(silence.data(), actual.data(), frames, 2, 6, ChannelRoutingMode::StereoTo51);
    for (const auto sample : actual) assert(sample == 0);
  }
}

}  // namespace

int main() {
  testSurroundDelayLineOverwritesRingSlot();
  testUpmix51Basic();
  testUpmix71Basic();
  testLfeLowpassSteadyState();
  testLfeLowpassHighFrequencyAttenuation();
  testLfeFirstFrameValue();
  testSurroundDelay();
  testResetClearsState();
  testPassthroughDegenerate();
  testAutoModeCopy();
  testCustomUpmixConfig();
  testSetSampleRateRecomputesDelay();
  testMonoToStereoRouting();
  testMonoToStereoFastRoutePredicate();
  testUpmix51MultipleFrames();
  testZeroFramesNoCrash();
  testThreeDeckSourceLifetimes();
  return 0;
}
