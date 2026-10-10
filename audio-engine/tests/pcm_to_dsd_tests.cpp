#include "../dsp/PcmToDsdModulator.h"

#include "../core/AudioPipelineDsdUtils.h"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

using namespace twilight::audio;

namespace {

constexpr double kTwoPi = 2.0 * 3.14159265358979323846;

[[noreturn]] void failTest(const char* message) {
  std::fprintf(stderr, "%s\n", message);
  std::abort();
}

std::vector<double> bitsFromMsbBytes(const std::vector<uint8_t>& bytes) {
  std::vector<double> bits;
  bits.reserve(bytes.size() * 8);
  for (uint8_t byte : bytes) {
    for (int bit = 7; bit >= 0; --bit) {
      bits.push_back((byte >> bit) & 1 ? 1.0 : -1.0);
    }
  }
  return bits;
}

// Three cascaded length-R boxcar filters followed by pick-every-R, i.e. a
// CIC^3 decimator. Enough stopband rejection to expose the in-band sine.
std::vector<double> decimateCic3(const std::vector<double>& bits, size_t R) {
  std::vector<double> stage(bits.size(), 0.0);
  std::vector<double> current(bits.begin(), bits.end());
  for (int pass = 0; pass < 2; ++pass) {
    std::vector<double> delay(R, 0.0);
    double sum = 0.0;
    for (size_t n = 0; n < current.size(); ++n) {
      sum += current[n] - delay[n % R];
      delay[n % R] = current[n];
      stage[n] = sum / static_cast<double>(R);
    }
    current = stage;
  }
  std::vector<double> output;
  output.reserve(bits.size() / R + 1);
  std::vector<double> delay(R, 0.0);
  double sum = 0.0;
  for (size_t n = 0; n < current.size(); ++n) {
    sum += current[n] - delay[n % R];
    delay[n % R] = current[n];
    if (n % R == R - 1) output.push_back(sum / static_cast<double>(R));
  }
  return output;
}

struct SineFit {
  double amplitude = 0.0;
  double snrDb = 0.0;
};

// Least-squares fit of A*sin + B*cos + C at the target frequency; SNR is the
// fitted sine power against the residual power.
SineFit fitSine(const std::vector<double>& x, double sampleRate, double frequency, size_t skip) {
  const size_t begin = skip;
  const size_t end = x.size() > skip ? x.size() - skip : 0;
  assert(end > begin + 64);

  double m[3][3] = {};
  double r[3] = {};
  for (size_t n = begin; n < end; ++n) {
    const double phase = kTwoPi * frequency * static_cast<double>(n) / sampleRate;
    const double basis[3] = {std::sin(phase), std::cos(phase), 1.0};
    for (int row = 0; row < 3; ++row) {
      for (int col = 0; col < 3; ++col) m[row][col] += basis[row] * basis[col];
      r[row] += x[n] * basis[row];
    }
  }
  for (int col = 0; col < 3; ++col) {
    int pivot = col;
    for (int row = col + 1; row < 3; ++row) {
      if (std::abs(m[row][col]) > std::abs(m[pivot][col])) pivot = row;
    }
    for (int k = 0; k < 3; ++k) std::swap(m[col][k], m[pivot][k]);
    std::swap(r[col], r[pivot]);
    for (int row = 0; row < 3; ++row) {
      if (row == col) continue;
      const double factor = m[row][col] / m[col][col];
      for (int k = col; k < 3; ++k) m[row][k] -= factor * m[col][k];
      r[row] -= factor * r[col];
    }
  }
  const double a = r[0] / m[0][0];
  const double b = r[1] / m[1][1];
  const double c = r[2] / m[2][2];

  double signalPower = 0.0;
  double noisePower = 0.0;
  for (size_t n = begin; n < end; ++n) {
    const double phase = kTwoPi * frequency * static_cast<double>(n) / sampleRate;
    const double fitted = a * std::sin(phase) + b * std::cos(phase) + c;
    signalPower += fitted * fitted;
    const double residual = x[n] - fitted;
    noisePower += residual * residual;
  }

  SineFit fit;
  fit.amplitude = std::hypot(a, b);
  fit.snrDb = 10.0 * std::log10(signalPower / noisePower);
  return fit;
}

double onesDensity(const std::vector<uint8_t>& bytes) {
  size_t ones = 0;
  for (uint8_t byte : bytes) {
    for (int bit = 0; bit < 8; ++bit) ones += (byte >> bit) & 1;
  }
  return static_cast<double>(ones) / (static_cast<double>(bytes.size()) * 8.0);
}

std::vector<uint8_t> runMono(
    PcmToDsdModulator& modulator,
    const std::vector<float>& input,
    size_t blockFrames) {
  std::vector<uint8_t> output(modulator.outputBytesPerChannel(input.size()));
  std::vector<uint8_t> block(modulator.outputBytesPerChannel(blockFrames));
  size_t outOffset = 0;
  size_t frame = 0;
  while (frame < input.size()) {
    const size_t frames = std::min(blockFrames, input.size() - frame);
    uint8_t* channelOutputs[1] = {block.data()};
    const size_t bytes = modulator.process(input.data() + frame, frames, channelOutputs, block.size());
    if (bytes != modulator.outputBytesPerChannel(frames)) {
      failTest("process wrote an unexpected byte count");
    }
    for (size_t i = 0; i < bytes; ++i) output[outOffset + i] = block[i];
    outOffset += bytes;
    frame += frames;
  }
  assert(outOffset == output.size());
  return output;
}

void testSineRecoveryAt44100ToDsd64() {
  PcmToDsdModulator modulator;
  PcmToDsdModulatorConfig config;
  config.inputSampleRate = 44100;
  config.channelCount = 1;
  config.targetDsdRate = 64;
  config.bitOrder = DsdBitOrder::MsbFirst;
  std::string error;
  if (!modulator.configure(config, &error)) failTest(error.c_str());
  assert(modulator.dsdSampleRate() == 2822400);
  assert(modulator.upsampleRatio() == 64);
  assert(modulator.outputSampleFormat() == AudioSampleFormat::DsdInt8Msb1);

  const size_t frames = 32768;
  std::vector<float> input(frames);
  for (size_t n = 0; n < frames; ++n) {
    input[n] = 0.5f * std::sin(kTwoPi * 1000.0 * static_cast<double>(n) / 44100.0);
  }

  const auto dsdBytes = runMono(modulator, input, 512);
  assert(modulator.instabilityResetCount() == 0);

  const auto bits = bitsFromMsbBytes(dsdBytes);
  const auto decimated = decimateCic3(bits, 64);
  const SineFit fit = fitSine(decimated, 44100.0, 1000.0, 512);

  // 0.5 FS input lands at 0.25 after the fixed -6 dB modulator headroom.
  if (fit.amplitude < 0.20 || fit.amplitude > 0.30) {
    std::fprintf(stderr, "recovered amplitude %.4f\n", fit.amplitude);
    failTest("PCM to DSD sine recovery amplitude out of range");
  }
  if (fit.snrDb < 60.0) {
    std::fprintf(stderr, "recovered SNR %.2f dB\n", fit.snrDb);
    failTest("PCM to DSD sine recovery SNR below 60 dB");
  }
  std::fprintf(stderr, "sine recovery: amplitude %.4f, SNR %.2f dB\n", fit.amplitude, fit.snrDb);
}

void testSilenceBitDensityIsBalanced() {
  PcmToDsdModulator modulator;
  PcmToDsdModulatorConfig config;
  config.inputSampleRate = 44100;
  config.channelCount = 2;
  config.targetDsdRate = 64;
  std::string error;
  if (!modulator.configure(config, &error)) failTest(error.c_str());

  const size_t frames = 16384;
  std::vector<float> input(frames * 2, 0.0f);
  std::vector<uint8_t> left(modulator.outputBytesPerChannel(frames));
  std::vector<uint8_t> right(modulator.outputBytesPerChannel(frames));
  uint8_t* channelOutputs[2] = {left.data(), right.data()};
  const size_t bytes = modulator.process(input.data(), frames, channelOutputs, left.size());
  assert(bytes == left.size());

  const double densityLeft = onesDensity(left);
  const double densityRight = onesDensity(right);
  if (std::abs(densityLeft - 0.5) > 0.01 || std::abs(densityRight - 0.5) > 0.01) {
    std::fprintf(stderr, "silence density L=%.4f R=%.4f\n", densityLeft, densityRight);
    failTest("digital silence must idle at ~50% bit density");
  }
}

void testInstabilityGuardRecovers() {
  PcmToDsdModulator modulator;
  PcmToDsdModulatorConfig config;
  config.inputSampleRate = 44100;
  config.channelCount = 1;
  config.targetDsdRate = 64;
  std::string error;
  if (!modulator.configure(config, &error)) failTest(error.c_str());

  // Garbage input: NaN, infinities and absurd magnitudes must be absorbed by
  // the input conditioning without tripping the loop.
  std::vector<float> garbage(4096);
  for (size_t n = 0; n < garbage.size(); ++n) {
    switch (n % 4) {
      case 0:
        garbage[n] = std::numeric_limits<float>::quiet_NaN();
        break;
      case 1:
        garbage[n] = std::numeric_limits<float>::infinity();
        break;
      case 2:
        garbage[n] = -1.0e30f;
        break;
      default:
        garbage[n] = 1.0e30f;
        break;
    }
  }
  const auto garbageBytes = runMono(modulator, garbage, 256);
  assert(garbageBytes.size() == modulator.outputBytesPerChannel(garbage.size()));

  // Force the loop state into an unstable region; the guard must reset the
  // integrators rather than emit unbounded state.
  modulator.injectInstabilityForTest();
  std::vector<float> silence(8192, 0.0f);
  const auto recoveryBytes = runMono(modulator, silence, 512);
  if (modulator.instabilityResetCount() == 0) {
    failTest("instability guard did not engage on forced overload");
  }

  // After recovery the tail must settle back to a balanced idle pattern.
  const size_t tailBytes = recoveryBytes.size() / 2;
  std::vector<uint8_t> tail(recoveryBytes.end() - static_cast<long long>(tailBytes), recoveryBytes.end());
  const double density = onesDensity(tail);
  if (std::abs(density - 0.5) > 0.02) {
    std::fprintf(stderr, "post-recovery density %.4f\n", density);
    failTest("modulator did not recover to balanced idle after overload");
  }
}

void testRateFamilyMapping() {
  struct Case {
    int inputRate;
    int dsdRate;
    int expectedDsdSampleRate;
    int expectedRatio;
  };
  const Case cases[] = {
      {44100, 64, 2822400, 64},
      {44100, 128, 5644800, 128},
      {44100, 256, 11289600, 256},
      {88200, 64, 2822400, 32},
      {176400, 128, 5644800, 32},
      {48000, 64, 3072000, 64},
      {96000, 128, 6144000, 64},
      {192000, 256, 12288000, 64},
      {352800, 64, 2822400, 8}};
  for (const Case& c : cases) {
    PcmToDsdModulator modulator;
    PcmToDsdModulatorConfig config;
    config.inputSampleRate = c.inputRate;
    config.channelCount = 2;
    config.targetDsdRate = c.dsdRate;
    std::string error;
    if (!modulator.configure(config, &error)) failTest(error.c_str());
    assert(modulator.dsdSampleRate() == c.expectedDsdSampleRate);
    assert(modulator.upsampleRatio() == c.expectedRatio);
  }

  // Rejections: off-family rates, unsupported multipliers, ratios below x8.
  const Case rejected[] = {
      {32000, 64, 0, 0},
      {44100, 512, 0, 0},
      {44100, 32, 0, 0},
      {705600, 64, 0, 0},
      {0, 64, 0, 0}};
  for (const Case& c : rejected) {
    PcmToDsdModulator modulator;
    PcmToDsdModulatorConfig config;
    config.inputSampleRate = c.inputRate;
    config.channelCount = 2;
    config.targetDsdRate = c.dsdRate;
    std::string error;
    assert(!modulator.configure(config, &error));
    assert(!error.empty());
    assert(!modulator.configured());
  }
}

void testBitOrderMatchesEngineConvention() {
  PcmToDsdModulatorConfig config;
  config.inputSampleRate = 44100;
  config.channelCount = 1;
  config.targetDsdRate = 64;

  config.bitOrder = DsdBitOrder::MsbFirst;
  PcmToDsdModulator msb;
  std::string error;
  if (!msb.configure(config, &error)) failTest(error.c_str());
  assert(msb.outputSampleFormat() == AudioSampleFormat::DsdInt8Msb1);

  config.bitOrder = DsdBitOrder::LsbFirst;
  PcmToDsdModulator lsb;
  if (!lsb.configure(config, &error)) failTest(error.c_str());
  assert(lsb.outputSampleFormat() == AudioSampleFormat::DsdInt8Lsb1);

  const size_t frames = 1024;
  std::vector<float> input(frames);
  for (size_t n = 0; n < frames; ++n) {
    input[n] = 0.4f * std::sin(kTwoPi * 3000.0 * static_cast<double>(n) / 44100.0);
  }

  const auto msbBytes = runMono(msb, input, 128);
  const auto lsbBytes = runMono(lsb, input, 128);
  assert(msbBytes.size() == lsbBytes.size());
  // Identical inputs and state: each byte must be the exact bit reversal of
  // its counterpart, matching the engine's render::reverseDsdBits convention.
  for (size_t i = 0; i < msbBytes.size(); ++i) {
    if (render::reverseDsdBits(msbBytes[i]) != lsbBytes[i]) {
      failTest("MSB-first and LSB-first outputs are not bit-reversed counterparts");
    }
  }
}

void testProcessRejectsBadArguments() {
  PcmToDsdModulator modulator;
  std::vector<float> input(64, 0.0f);
  std::vector<uint8_t> output(64);
  uint8_t* channelOutputs[1] = {output.data()};
  // Unconfigured modulator must refuse work.
  assert(modulator.process(input.data(), 8, channelOutputs, output.size()) == 0);

  PcmToDsdModulatorConfig config;
  config.inputSampleRate = 44100;
  config.channelCount = 1;
  config.targetDsdRate = 64;
  std::string error;
  if (!modulator.configure(config, &error)) failTest(error.c_str());

  assert(modulator.process(nullptr, 8, channelOutputs, output.size()) == 0);
  assert(modulator.process(input.data(), 8, nullptr, output.size()) == 0);
  // Capacity too small for 8 frames * 64 bits = 64 bytes.
  assert(modulator.process(input.data(), 8, channelOutputs, 32) == 0);
  uint8_t* nullChannel[1] = {nullptr};
  assert(modulator.process(input.data(), 8, nullChannel, output.size()) == 0);
  assert(modulator.process(input.data(), 0, channelOutputs, output.size()) == 0);
}

void testIndependentChannelsAndGeneratedPacking() {
  for (int rate : {44100, 48000, 192000}) for (int target : {64, 128, 256})
  for (int channels : {1, 2, 3, 8}) for (auto order : {DsdBitOrder::MsbFirst, DsdBitOrder::LsbFirst}) {
    PcmToDsdModulator multi;
    PcmToDsdModulatorConfig config{rate, channels, target, order};
    std::string error;
    if (!multi.configure(config, &error)) failTest(error.c_str());
    std::vector<PcmToDsdModulator> mono(channels);
    config.channelCount = 1;
    for (auto& modulator : mono) if (!modulator.configure(config, &error)) failTest(error.c_str());
    const size_t stride = multi.outputBytesPerChannel(256);
    std::vector<uint8_t> padded(stride * channels, 0xee);
    std::vector<uint8_t*> planes(channels);
    for (int c = 0; c < channels; ++c) planes[c] = padded.data() + stride * c;
    size_t position = 0;
    for (size_t frames : {size_t(17), size_t(3), size_t(64), size_t(1)}) {
      std::vector<float> input(frames * channels);
      for (size_t f = 0; f < frames; ++f) for (int c = 0; c < channels; ++c)
        input[f * channels + c] = static_cast<float>(.4 * std::sin((position + f) * .17 + c));
      const size_t written = multi.process(input.data(), frames, planes.data(), stride);
      for (int c = 0; c < channels; ++c) {
        std::vector<float> single(frames);
        for (size_t f = 0; f < frames; ++f) single[f] = input[f * channels + c];
        std::vector<uint8_t> expected(written);
        uint8_t* pointer = expected.data();
        assert(mono[c].process(single.data(), frames, &pointer, written) == written);
        if (!std::equal(expected.begin(), expected.end(), planes[c])) failTest("Paired quantizer changed channel bits");
      }
      for (auto format : {AudioSampleFormat::DsdInt8Msb1, AudioSampleFormat::DsdInt8Lsb1,
                          AudioSampleFormat::DsdInt8Ner8, AudioSampleFormat::Int24Interleaved,
                          AudioSampleFormat::Int24In32Interleaved}) {
        const bool native = isDsdSampleFormat(format);
        const size_t available = native ? written : written / 2;
        const size_t count = std::min<size_t>(available, 3); // partial callback, including odd marker phase
        const size_t sampleBytes = native ? 1 : dop::dopCarrierBytesPerSample(format);
        std::vector<uint8_t> packed(count * channels * sampleBytes + 8, 0xdd);
        assert(render::packGeneratedDsd(planes.data(), written, channels, order, format,
            packed.data(), packed.size() - 8, count, 1) == count);
        for (size_t f = 0; f < count; ++f) for (int c = 0; c < channels; ++c) {
          if (native) assert(packed[f * channels + c] == render::convertDsdByte(planes[c][f], order, format));
          else {
            uint8_t expected[4]{};
            dop::writeDopSample(expected, 0, sampleBytes, dop::normalizeDsdByte(planes[c][2 * f], order),
                dop::normalizeDsdByte(planes[c][2 * f + 1], order), dop::dopMarkerForFrame(1 + f));
            assert(std::equal(expected, expected + sampleBytes, packed.data() + (f * channels + c) * sampleBytes));
          }
        }
        assert(std::all_of(packed.end() - 8, packed.end(), [](uint8_t byte) { return byte == 0xdd; }));
      }
      position += frames;
    }
    // The SIMD and scalar guards both recover independently for odd layouts.
    multi.injectInstabilityForTest();
    std::vector<float> silence(channels);
    multi.process(silence.data(), 1, planes.data(), stride);
    assert(multi.instabilityResetCount() >= static_cast<uint64_t>(channels));
    multi.reset();
    assert(multi.instabilityResetCount() == 0);
  }
}

}  // namespace

int main() {
  testRateFamilyMapping();
  testProcessRejectsBadArguments();
  testIndependentChannelsAndGeneratedPacking();
  testSilenceBitDensityIsBalanced();
  testBitOrderMatchesEngineConvention();
  testInstabilityGuardRecovers();
  testSineRecoveryAt44100ToDsd64();
  return 0;
}
