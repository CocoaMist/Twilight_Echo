#include "ParametricEqProcessor.h"

#include <cassert>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <numbers>
#include <vector>

using namespace twilight::audio;

int main() {
  const DspFilterType types[] = {DspFilterType::Peak, DspFilterType::LowShelf,
    DspFilterType::HighShelf, DspFilterType::LowPass, DspFilterType::HighPass,
    DspFilterType::BandPass, DspFilterType::AllPass, DspFilterType::Notch};
  const char* names[] = {"peak", "lowShelf", "highShelf", "lowPass", "highPass",
    "bandPass", "allPass", "notch"};
  std::cout << std::setprecision(12);
  for (int sampleRate : {44100, 48000, 96000}) {
    AudioFormat format;
    format.sampleRate = sampleRate;
    format.channelCount = 2;
    for (int typeIndex = 0; typeIndex < 8; ++typeIndex) {
      for (double q : {0.1, 0.7071067811865476, 2.0, 20.0}) {
        for (double frequency : {100.0, 1000.0, 6000.0}) {
          DspConfig config;
          config.enabled = true;
          config.eqEnabled = true;
          config.eqMode = EqMode::Parametric;
          DspEqBand band;
          band.type = types[typeIndex];
          band.gainDb = typeIndex < 3 ? 9.0 : 0.0;
          band.q = q;
          band.channelMask = 1;
          config.eqBands = {band};
          ParametricEqProcessor processor;
          processor.prepare(format);
          processor.configure(config);
          assert(processor.isActive());
          std::vector<float> input(sampleRate * 2);
          for (int frame = 0; frame < sampleRate; ++frame) {
            const float value = 0.001f * std::sin(2.0 * std::numbers::pi * frequency * frame / sampleRate);
            input[frame * 2] = input[frame * 2 + 1] = value;
          }
          auto output = input;
          processor.process(output.data(), sampleRate);
          double inputPower = 0.0;
          double outputPower = 0.0;
          double correlation = 0.0;
          for (int frame = sampleRate / 2; frame < sampleRate; ++frame) {
            const double original = input[frame * 2];
            const double filtered = output[frame * 2];
            assert(std::isfinite(filtered));
            assert(output[frame * 2 + 1] == input[frame * 2 + 1]);
            inputPower += original * original;
            outputPower += filtered * filtered;
            correlation += original * filtered;
          }
          if (band.type == DspFilterType::AllPass && frequency == 1000.0)
            assert(correlation / inputPower < -0.999);
          const double db = 10.0 * std::log10(std::max(outputPower / inputPower, 1e-24));
          std::cout << names[typeIndex] << ' ' << sampleRate << ' ' << band.gainDb << ' '
                    << q << ' ' << frequency << ' ' << db << '\n';
          config.eqBands[0].enabled = false;
          processor.configure(config);
          assert(!processor.isActive());
          output = input;
          processor.process(output.data(), sampleRate);
          assert(output == input);
          config.eqBands[0].enabled = true;
          config.eqBands[0].gainDb = 0.0;
          config.eqMode = EqMode::Graphic;
          processor.configure(config);
          assert(!processor.isActive());
        }
      }
    }
  }
}
