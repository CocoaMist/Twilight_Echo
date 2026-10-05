#include "dsp/WsolaResampler.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>

namespace twilight::audio {
namespace {

constexpr double kMinRate = 0.5;
constexpr double kMaxRate = 2.0;
constexpr double kWindowMs = 32.0;
constexpr double kSearchMs = 12.0;

float hann(int i, int n) {
  if (n <= 1) return 1.0f;
  return 0.5f *
         (1.0f - std::cos(
                     2.0f * 3.14159265358979323846f * static_cast<float>(i) /
                     static_cast<float>(n)));
}

}  // namespace

void WsolaResampler::prepare(int channelCount, int sampleRate, size_t maxOutFrames) {
  channels_ = std::max(1, channelCount);
  sampleRate_ = std::max(1, sampleRate);
  windowFrames_ = std::max(64, static_cast<int>(std::lround(sampleRate_ * kWindowMs / 1000.0)));
  if (windowFrames_ % 2 != 0) ++windowFrames_;
  analysisHop_ = std::max(1, windowFrames_ / 2);
  searchRadius_ = std::max(8, static_cast<int>(std::lround(sampleRate_ * kSearchMs / 1000.0)));

  window_.assign(static_cast<size_t>(windowFrames_), 0.0f);
  for (int i = 0; i < windowFrames_; ++i) window_[static_cast<size_t>(i)] = hann(i, windowFrames_);

  grainA_.assign(static_cast<size_t>(windowFrames_ * channels_), 0.0f);
  grainB_.assign(static_cast<size_t>(analysisHop_ * channels_), 0.0f);
  olaTail_.assign(static_cast<size_t>(analysisHop_ * channels_), 0.0f);

  const size_t need =
      static_cast<size_t>(windowFrames_ * 4 + searchRadius_ * 2) +
      std::max<size_t>(maxOutFrames * 2, 2048);
  inputCapacity_ = need;
  input_.assign(inputCapacity_ * static_cast<size_t>(channels_), 0.0f);
  pullScratch_.assign(std::max<size_t>(512, maxOutFrames) * static_cast<size_t>(channels_), 0.0f);
  overlapReference_.assign(static_cast<size_t>(analysisHop_ * channels_), 0.0f);
  reset();
}

void WsolaResampler::setRate(double rate) noexcept {
  if (!std::isfinite(rate)) return;
  rate_ = std::clamp(rate, kMinRate, kMaxRate);
}

void WsolaResampler::reset() noexcept {
  inputRead_ = 0;
  inputWrite_ = 0;
  inputCount_ = 0;
  olaTailFrames_ = 0;
  referenceReady_ = false;
  readyRead_ = readyFrames_ = 0;
  sourceCursor_ = 0.0;
  if (!olaTail_.empty()) std::fill(olaTail_.begin(), olaTail_.end(), 0.0f);
}

const float* WsolaResampler::inputFrame(size_t index) const noexcept {
  const size_t abs = (inputRead_ + index) % inputCapacity_;
  return input_.data() + abs * static_cast<size_t>(channels_);
}

void WsolaResampler::pushInput(const float* src, size_t frames) {
  if (frames == 0 || inputCapacity_ == 0) return;
  const size_t ch = static_cast<size_t>(channels_);
  for (size_t i = 0; i < frames; ++i) {
    if (inputCount_ >= inputCapacity_) {
      inputRead_ = (inputRead_ + 1) % inputCapacity_;
      --inputCount_;
      if (sourceCursor_ >= 1.0) sourceCursor_ -= 1.0;
      else sourceCursor_ = 0.0;
    }
    const size_t writeIndex = inputWrite_ % inputCapacity_;
    std::memcpy(input_.data() + writeIndex * ch, src + i * ch, ch * sizeof(float));
    inputWrite_ = (inputWrite_ + 1) % inputCapacity_;
    ++inputCount_;
  }
}

void WsolaResampler::popInput(size_t frames) {
  if (frames == 0) return;
  const size_t consume = std::min(frames, inputCount_);
  inputRead_ = (inputRead_ + consume) % inputCapacity_;
  inputCount_ -= consume;
}

int WsolaResampler::findBestOffset(size_t center, int radius, int length) const noexcept {
  if (!referenceReady_ || length <= 4 || inputCount_ < static_cast<size_t>(windowFrames_) ||
      center + static_cast<size_t>(windowFrames_) > inputCount_) return 0;
  const int lo = -std::min(radius, static_cast<int>(center));
  const int hi = std::min(radius, static_cast<int>(inputCount_ - center - windowFrames_));
  if (hi <= lo) return lo;
  // Bounded multi-resolution correlation. Keep channels separate: a mono sum
  // would cancel anti-phase stereo and misalign multichannel material.
  const int coarseStep = std::max(1, (hi - lo + 95) / 96);
  const int stride = std::max(1, (length + 191) / 192);
  double referenceEnergy = 0.0;
  for (int i = 0; i < length; i += stride) {
    for (int c = 0; c < channels_; ++c) {
      const double a = overlapReference_[static_cast<size_t>(i * channels_ + c)];
      referenceEnergy += a * a;
    }
  }
  if (referenceEnergy < 1.0e-12) return 0;
  const auto score = [&](int offset) {
    double corr = 0.0, energy = 0.0;
    const size_t start = static_cast<size_t>(static_cast<int>(center) + offset);
    for (int i = 0; i < length; i += stride) {
      const float* b = inputFrame(start + static_cast<size_t>(i));
      const float* a = overlapReference_.data() + static_cast<size_t>(i * channels_);
      for (int c = 0; c < channels_; ++c) {
        corr += static_cast<double>(a[c]) * b[c];
        energy += static_cast<double>(b[c]) * b[c];
      }
    }
    return energy < 1.0e-12 ? -2.0 : corr / std::sqrt(referenceEnergy * energy);
  };
  struct Candidate { int offset = 0; double score = -2.0; };
  std::array<Candidate, 4> best{};
  const auto consider = [&](int offset) {
    const double value = score(offset);
    for (size_t i = 0; i < best.size(); ++i) {
      if (best[i].score > -2.0 && best[i].offset == offset) return;
      if (value > best[i].score + 1.0e-10 ||
          (std::abs(value - best[i].score) <= 1.0e-10 && std::abs(offset) < std::abs(best[i].offset))) {
        for (size_t j = best.size() - 1; j > i; --j) best[j] = best[j - 1];
        best[i] = {offset, value};
        return;
      }
    }
  };
  consider(0);
  consider(hi);
  for (int offset = lo; offset <= hi; offset += coarseStep) consider(offset);
  const auto coarse = best;
  const int middleStep = std::max(1, coarseStep / 4);
  for (const auto& candidate : coarse) {
    for (int offset = std::max(lo, candidate.offset - coarseStep);
         offset <= std::min(hi, candidate.offset + coarseStep); offset += middleStep) consider(offset);
  }
  const auto middle = best;
  for (size_t i = 0; i < 2; ++i) {
    for (int offset = std::max(lo, middle[i].offset - middleStep);
         offset <= std::min(hi, middle[i].offset + middleStep); ++offset) consider(offset);
  }
  return best[0].offset;
}

void WsolaResampler::synthesizeGrain(float* grain, int grainLen, size_t inputOffset) const noexcept {
  const int ch = channels_;
  for (int i = 0; i < grainLen; ++i) {
    const float w = window_[static_cast<size_t>(i)];
    const size_t frame = inputOffset + static_cast<size_t>(i);
    const float* src = frame < inputCount_ ? inputFrame(frame) : nullptr;
    float* dst = grain + static_cast<size_t>(i * ch);
    for (int c = 0; c < ch; ++c) dst[c] = src ? src[c] * w : 0.0f;
  }
}

void WsolaResampler::advanceRead(double sourceFrames) noexcept {
  sourceCursor_ += sourceFrames;
  const size_t whole = static_cast<size_t>(sourceCursor_);
  if (whole == 0) return;
  // Retain history for negative-offset candidates without changing the source clock.
  const size_t history = static_cast<size_t>(searchRadius_);
  const size_t consume = std::min(whole > history ? whole - history : 0, inputCount_);
  popInput(consume);
  sourceCursor_ -= static_cast<double>(consume);
}

size_t WsolaResampler::processFn(
    float* output,
    size_t outFrames,
    size_t (*pullSource)(void* ctx, float* dst, size_t maxFrames),
    void* pullCtx) {
  return process(output, outFrames, [&](float* dst, size_t maxFrames) -> size_t {
    if (!pullSource) return 0;
    return pullSource(pullCtx, dst, maxFrames);
  });
}

}  // namespace twilight::audio
