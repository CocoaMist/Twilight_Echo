// Development oracle only. Headers are supplied from the locked external public
// reference checkout; this target is never linked into the player or staged.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include "signalsmith-stretch.h"
int main(int argc, char** argv) {
  if (argc != 8) return 2;
  unsigned rate = std::strtoul(argv[3], nullptr, 10), channels = std::strtoul(argv[4], nullptr, 10);
  size_t frames = std::strtoul(argv[5], nullptr, 10), start = std::strtoul(argv[7], nullptr, 10);
  double ratio = std::strtod(argv[6], nullptr);
  FILE* file = std::fopen(argv[1], "rb");
  if (!file || !channels || channels > 8 || !frames) return 1;
  std::fseek(file, 0, SEEK_END);
  long bytes = std::ftell(file);
  std::rewind(file);
  size_t count = bytes / (4 * channels), consumed = std::llround(frames * ratio);
  if (bytes < 0 || start + consumed > count) return 1;
  std::vector<float> interleaved(count * channels);
  if (std::fread(interleaved.data(), 4 * channels, count, file) != count) return 1;
  std::fclose(file);
  std::vector<std::vector<float>> input(channels, std::vector<float>(consumed)),
    output(channels, std::vector<float>(frames));
  for (size_t i = 0; i < consumed; i++)
    for (unsigned c = 0; c < channels; c++) input[c][i] = interleaved[(start + i) * channels + c];
  signalsmith::stretch::SignalsmithStretch<float> stretch;
  stretch.presetDefault(channels, rate);
  if (!stretch.exact(input, consumed, output, frames)) return 1;
  interleaved.resize(frames * channels);
  for (size_t i = 0; i < frames; i++)
    for (unsigned c = 0; c < channels; c++) interleaved[i * channels + c] = output[c][i];
  file = std::fopen(argv[2], "wb");
  if (!file || std::fwrite(interleaved.data(), 4 * channels, frames, file) != frames) return 1;
  return std::fclose(file) != 0;
}
