#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace twilight::audio {

/**
 * RT-oriented WSOLA (Waveform Similarity Overlap-Add) rate changer.
 * Preserves pitch while stretching/compressing time for rates in [0.5, 2.0].
 * Not an IAudioProcessor (variable input/output frame counts).
 *
 * Render-thread only: no locks, no allocations after prepare().
 * `process` is a template so the puller can be an inlined lambda (no type erasure).
 */
class WsolaResampler {
 public:
  void prepare(int channelCount, int sampleRate, size_t maxOutFrames);
  void setRate(double rate) noexcept;
  void reset() noexcept;

  /**
   * Emit `outFrames` interleaved samples into `output`.
   * `pull(dst, maxFrames)` writes up to maxFrames interleaved frames and returns
   * the number written (0 = underrun/EOS).
   */
  template <typename PullFn>
  size_t process(float* output, size_t outFrames, PullFn&& pull);

  /** C-style wrapper for tests / FFI. */
  size_t processFn(
      float* output,
      size_t outFrames,
      size_t (*pullSource)(void* ctx, float* dst, size_t maxFrames),
      void* pullCtx);

  double rate() const noexcept { return rate_; }
  bool prepared() const noexcept { return channels_ > 0 && sampleRate_ > 0; }

 private:
  template <typename PullFn>
  void ensureInput(size_t neededFrames, PullFn&& pull);
  void pushInput(const float* src, size_t frames);
  void popInput(size_t frames);
  const float* inputFrame(size_t index) const noexcept;
  int findBestOffset(size_t searchCenter, int searchRadius, int templateLen) const noexcept;
  void synthesizeGrain(float* grain, int grainLen, size_t inputOffset) const noexcept;
  void advanceRead(double sourceFrames) noexcept;

  template <typename PullFn>
  size_t processImpl(float* output, size_t outFrames, PullFn&& pull);

  int channels_ = 0;
  int sampleRate_ = 0;
  double rate_ = 1.0;

  std::vector<float> input_;
  size_t inputCapacity_ = 0;
  size_t inputRead_ = 0;
  size_t inputWrite_ = 0;
  size_t inputCount_ = 0;

  int windowFrames_ = 0;
  int analysisHop_ = 0;
  int searchRadius_ = 0;
  std::vector<float> window_;
  std::vector<float> grainA_;
  std::vector<float> grainB_;  // One completed output hop, drained across callbacks.
  std::vector<float> olaTail_;
  int olaTailFrames_ = 0;
  std::vector<float> overlapReference_;
  bool referenceReady_ = false;
  size_t readyRead_ = 0;
  size_t readyFrames_ = 0;
  double sourceCursor_ = 0.0;
  std::vector<float> pullScratch_;
};

template <typename PullFn>
size_t WsolaResampler::process(float* output, size_t outFrames, PullFn&& pull) {
  return processImpl(output, outFrames, static_cast<PullFn&&>(pull));
}

template <typename PullFn>
void WsolaResampler::ensureInput(size_t neededFrames, PullFn&& pull) {
  while (inputCount_ < neededFrames) {
    if (pullScratch_.empty()) break;
    const size_t freeFrames = inputCapacity_ > inputCount_ ? inputCapacity_ - inputCount_ : 0;
    if (freeFrames == 0) break;
    const size_t pullCap = pullScratch_.size() / static_cast<size_t>(channels_);
    const size_t want = freeFrames < pullCap ? (freeFrames < 512 ? freeFrames : 512) : (pullCap < 512 ? pullCap : 512);
    const size_t got = pull(pullScratch_.data(), want);
    if (got == 0) break;
    pushInput(pullScratch_.data(), got);
  }
}

template <typename PullFn>
size_t WsolaResampler::processImpl(float* output, size_t outFrames, PullFn&& pull) {
  if (!output || outFrames == 0 || !prepared()) return 0;

  if (rate_ > 0.999999 && rate_ < 1.000001) {
    size_t filled = 0;
    while (filled < outFrames) {
      ensureInput(outFrames - filled, pull);
      if (inputCount_ == 0) break;
      const size_t take = outFrames - filled < inputCount_ ? outFrames - filled : inputCount_;
      const size_t ch = static_cast<size_t>(channels_);
      for (size_t i = 0; i < take; ++i) {
        const float* src = inputFrame(i);
        float* dst = output + (filled + i) * ch;
        for (size_t c = 0; c < ch; ++c) dst[c] = src[c];
      }
      popInput(take);
      filled += take;
    }
    if (filled < outFrames) {
      const size_t ch = static_cast<size_t>(channels_);
      for (size_t i = filled * ch; i < outFrames * ch; ++i) output[i] = 0.0f;
    }
    return filled;
  }

  const int ch = channels_;
  const int grainLen = windowFrames_;
  const int hopOut = analysisHop_;
  const double hopIn = static_cast<double>(hopOut) * rate_;
  size_t filled = 0;
  while (filled < outFrames) {
    if (readyFrames_ > 0) {
      const size_t take = std::min(readyFrames_, outFrames - filled);
      std::copy_n(grainB_.data() + readyRead_ * ch, take * ch, output + filled * ch);
      readyRead_ += take;
      readyFrames_ -= take;
      filled += take;
      continue;
    }
    size_t natural = static_cast<size_t>(sourceCursor_);
    ensureInput(natural + static_cast<size_t>(grainLen + searchRadius_), pull);
    // A gapless stream promotion can reset the resampler from inside pull().
    natural = static_cast<size_t>(sourceCursor_);
    if (inputCount_ <= natural) {
      if (olaTailFrames_ == 0) break;
      // Drain the final overlap once, including sources shorter than one window.
      std::copy_n(olaTail_.data(), static_cast<size_t>(olaTailFrames_ * ch), grainB_.data());
      readyRead_ = 0;
      readyFrames_ = static_cast<size_t>(olaTailFrames_);
      olaTailFrames_ = 0;
      referenceReady_ = false;
      popInput(inputCount_);
      sourceCursor_ = 0.0;
      continue;
    }
    const int offset = findBestOffset(natural, searchRadius_, hopOut);
    const size_t grainStart = static_cast<size_t>(static_cast<int>(natural) + offset);
    synthesizeGrain(grainA_.data(), grainLen, grainStart);
    for (int i = 0; i < hopOut; ++i) {
      const size_t referenceFrame = grainStart + static_cast<size_t>(hopOut + i);
      const float* reference = referenceFrame < inputCount_ ? inputFrame(referenceFrame) : nullptr;
      for (int c = 0; c < ch; ++c) {
        const size_t slot = static_cast<size_t>(i * ch + c);
        grainB_[slot] = grainA_[slot] + (olaTailFrames_ > 0 ? olaTail_[slot] : 0.0f);
        olaTail_[slot] = grainA_[slot + static_cast<size_t>(hopOut * ch)];
        overlapReference_[slot] = reference ? reference[c] : 0.0f;
      }
    }
    olaTailFrames_ = hopOut;
    referenceReady_ = true;
    readyRead_ = 0;
    readyFrames_ = static_cast<size_t>(hopOut);
    advanceRead(hopIn);
  }
  return filled;
}

}  // namespace twilight::audio
