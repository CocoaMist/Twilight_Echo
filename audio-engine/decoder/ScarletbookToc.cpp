#include "ScarletbookToc.h"

#include <algorithm>
#include <cstring>

// Scarletbook TOC parsing. See ScarletbookToc.h for the disc-layout summary.
// All multi-byte on-disc integers are big-endian. Every read is bounds checked
// against the sector size and the image size; malformed data degrades to
// "not parsed" instead of crashing (the demuxer then falls back to heuristics).

namespace twilight::audio::sacd {
namespace {

constexpr uint32_t kMaxAreaTocSectors = 96;   // MAX_AREA_TOC_SIZE_LSN per spec
constexpr uint32_t kMaxTrackCount = 255;
constexpr size_t kMaxTextLength = 255;
constexpr size_t kMaxTrackTextEntries = 16;

uint16_t readBe16(const uint8_t* data) {
  return static_cast<uint16_t>((static_cast<uint16_t>(data[0]) << 8) | data[1]);
}

uint32_t readBe32(const uint8_t* data) {
  return (static_cast<uint32_t>(data[0]) << 24) | (static_cast<uint32_t>(data[1]) << 16) |
         (static_cast<uint32_t>(data[2]) << 8) | static_cast<uint32_t>(data[3]);
}

bool readSector(std::istream& file, uint64_t fileSize, uint32_t lsn, uint8_t* out) {
  const uint64_t offset = static_cast<uint64_t>(lsn) * kScarletbookSectorSize;
  if (offset + kScarletbookSectorSize > fileSize) return false;
  file.clear();
  file.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
  if (!file) return false;
  file.read(reinterpret_cast<char*>(out), static_cast<std::streamsize>(kScarletbookSectorSize));
  return static_cast<size_t>(file.gcount()) == kScarletbookSectorSize;
}

// Copies a NUL-terminated string starting at `offset` inside a sector.
// Conservative about encodings: control bytes (< 0x20) become spaces, ASCII
// and high bytes (UTF-8 or legacy 8-bit codepages) are copied through
// unchanged. Never reads past the sector end.
std::string copySectorText(const uint8_t* sector, size_t sectorSize, size_t offset) {
  std::string out;
  for (size_t index = offset; index < sectorSize && out.size() < kMaxTextLength; ++index) {
    const uint8_t ch = sector[index];
    if (ch == 0) break;
    out.push_back(ch < 0x20 ? ' ' : static_cast<char>(ch));
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  size_t start = 0;
  while (start < out.size() && out[start] == ' ') ++start;
  return out.substr(start);
}

// Fixed-width, space/NUL padded field (catalog numbers).
std::string copyFixedText(const uint8_t* data, size_t size) {
  std::string out;
  for (size_t index = 0; index < size; ++index) {
    const uint8_t ch = data[index];
    if (ch == 0) break;
    out.push_back(ch < 0x20 ? ' ' : static_cast<char>(ch));
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

double timecodeSeconds(const uint8_t* data) {
  const uint32_t frames = static_cast<uint32_t>(data[0]) * 60u * kScarletbookFrameRate +
                          static_cast<uint32_t>(data[1]) * kScarletbookFrameRate +
                          static_cast<uint32_t>(data[2]);
  return static_cast<double>(frames) / static_cast<double>(kScarletbookFrameRate);
}

// Master text sector ("SACDText"): 16-bit big-endian positions, relative to
// the sector start, at fixed offsets after the 8-byte id + 8 reserved bytes.
void parseMasterText(const uint8_t* sector, ScarletbookAlbum* album) {
  if (std::memcmp(sector, "SACDText", 8) != 0) return;
  const auto textAt = [&](size_t positionOffset) -> std::string {
    const uint16_t position = readBe16(sector + positionOffset);
    if (position == 0 || position >= kScarletbookSectorSize) return {};
    return copySectorText(sector, kScarletbookSectorSize, position);
  };
  album->albumTitle = textAt(16);   // album_title_position
  album->albumArtist = textAt(20);  // album_artist_position
  album->discTitle = textAt(32);    // disc_title_position
  album->discArtist = textAt(36);   // disc_artist_position
}

// "SACDTTxt": per-track 16-bit positions follow the 8-byte id. Each record is
// [amount:1][reserved:3] then `amount` entries of [type:1][0x20:1][cstring],
// separated by NUL runs. Track text types: 0x01 title, 0x02 performer.
void parseAreaTrackText(const uint8_t* sector, ScarletbookArea* area) {
  const size_t trackCount = area->tracks.size();
  if (8 + trackCount * 2 > kScarletbookSectorSize) return;
  for (size_t trackIndex = 0; trackIndex < trackCount; ++trackIndex) {
    const uint16_t position = readBe16(sector + 8 + trackIndex * 2);
    if (position == 0 || position + 4 >= kScarletbookSectorSize) continue;
    const uint8_t amount = sector[position];
    size_t cursor = static_cast<size_t>(position) + 4;
    for (size_t entry = 0; entry < amount && entry < kMaxTrackTextEntries; ++entry) {
      if (cursor + 2 >= kScarletbookSectorSize) break;
      const uint8_t type = sector[cursor];
      cursor += 2;  // type byte + separator (0x20)
      const std::string text = copySectorText(sector, kScarletbookSectorSize, cursor);
      if (!text.empty()) {
        if (type == 0x01 && area->tracks[trackIndex].title.empty()) {
          area->tracks[trackIndex].title = text;
        } else if (type == 0x02 && area->tracks[trackIndex].performer.empty()) {
          area->tracks[trackIndex].performer = text;
        }
      }
      // Advance past the string and the NUL run separating entries.
      while (cursor < kScarletbookSectorSize && sector[cursor] != 0) ++cursor;
      while (cursor < kScarletbookSectorSize && sector[cursor] == 0) ++cursor;
    }
  }
}

bool parseAreaToc(std::istream& file,
                  uint64_t fileSize,
                  uint32_t tocLsn,
                  uint32_t tocSizeSectors,
                  bool multichannelSlot,
                  ScarletbookArea* area) {
  area->valid = false;
  area->multichannel = multichannelSlot;
  area->tocLsn = tocLsn;
  area->tracks.clear();
  if (tocLsn == 0) return false;

  std::vector<uint8_t> sector(kScarletbookSectorSize);
  if (!readSector(file, fileSize, tocLsn, sector.data())) return false;
  if (std::memcmp(sector.data(), "TWOCHTOC", 8) != 0 &&
      std::memcmp(sector.data(), "MULCHTOC", 8) != 0) {
    return false;
  }

  const uint16_t declaredSize = readBe16(sector.data() + 10);
  if (tocSizeSectors == 0) tocSizeSectors = declaredSize;
  if (tocSizeSectors == 0 || tocSizeSectors > kMaxAreaTocSectors) {
    tocSizeSectors = kMaxAreaTocSectors;
  }

  // sample_frequency (byte 20): 0x04 = 64 * 44.1 kHz, the only rate the spec
  // allows physically; unknown flags conservatively keep DSD64.
  area->sampleRate = static_cast<int>(kScarletbookDsd64SampleRate);
  const uint8_t frameFormat = sector[21] & 0x0f;
  area->dst = frameFormat == kScarletbookFrameFormatDst;

  const uint8_t channelCount = sector[32];
  area->channelCount = (channelCount >= 1 && channelCount <= 6) ? channelCount
                                                                : (multichannelSlot ? 6 : 2);

  const uint8_t trackCount = sector[69];
  const uint32_t trackStartLsn = readBe32(sector.data() + 72);
  const uint32_t trackEndLsn = readBe32(sector.data() + 76);
  if (trackCount == 0 || trackCount > kMaxTrackCount) return false;

  area->tracks.resize(trackCount);
  for (uint32_t index = 0; index < trackCount; ++index) {
    area->tracks[index].trackNumber = static_cast<int>(index) + 1;
  }

  bool haveOffsets = false;
  bool haveText = false;
  std::vector<uint8_t> extra(kScarletbookSectorSize);
  uint32_t sectorIndex = 1;
  while (sectorIndex < tocSizeSectors) {
    if (!readSector(file, fileSize, tocLsn + sectorIndex, extra.data())) break;
    if (std::memcmp(extra.data(), "SACDTTxt", 8) == 0) {
      if (!haveText) {
        parseAreaTrackText(extra.data(), area);
        haveText = true;
      }
      sectorIndex += 1;
    } else if (std::memcmp(extra.data(), "SACDTRL1", 8) == 0) {
      // track_start_lsn[255] at +8, track_length_lsn[255] at +1028 (BE32).
      for (uint32_t index = 0; index < trackCount; ++index) {
        area->tracks[index].startLsn = readBe32(extra.data() + 8 + index * 4);
        area->tracks[index].lengthLsn = readBe32(extra.data() + 1028 + index * 4);
      }
      haveOffsets = true;
      sectorIndex += 1;
    } else if (std::memcmp(extra.data(), "SACDTRL2", 8) == 0) {
      // start[255] at +8, duration[255] at +1028; 4-byte m/s/f/flags entries.
      for (uint32_t index = 0; index < trackCount; ++index) {
        area->tracks[index].startSeconds = timecodeSeconds(extra.data() + 8 + index * 4);
        area->tracks[index].durationSeconds = timecodeSeconds(extra.data() + 1028 + index * 4);
      }
      sectorIndex += 1;
    } else if (std::memcmp(extra.data(), "SACD_IGL", 8) == 0) {
      sectorIndex += 2;
    } else if (std::memcmp(extra.data(), "SACD_ACC", 8) == 0) {
      sectorIndex += 32;
    } else {
      break;
    }
  }
  if (!haveOffsets) return false;

  // Drop tracks whose extents are missing or fall outside the image.
  const uint64_t totalSectors = fileSize / kScarletbookSectorSize;
  std::vector<ScarletbookTrack> validTracks;
  validTracks.reserve(area->tracks.size());
  for (auto& track : area->tracks) {
    if (track.startLsn == 0 || track.lengthLsn == 0) continue;
    if (static_cast<uint64_t>(track.startLsn) + track.lengthLsn > totalSectors) continue;
    if (trackStartLsn != 0 && trackEndLsn > trackStartLsn) {
      if (track.startLsn < trackStartLsn || track.startLsn >= trackEndLsn) continue;
    }
    validTracks.push_back(std::move(track));
  }
  area->tracks = std::move(validTracks);
  for (size_t index = 0; index < area->tracks.size(); ++index) {
    area->tracks[index].trackNumber = static_cast<int>(index) + 1;
  }

  area->valid = !area->tracks.empty();
  return area->valid;
}

}  // namespace

bool parseScarletbookDisc(std::istream& file, uint64_t fileSize, ScarletbookDisc* out) {
  if (!out) return false;
  *out = {};

  std::vector<uint8_t> sector(kScarletbookSectorSize);
  if (!readSector(file, fileSize, kScarletbookMasterTocLsn, sector.data())) return false;
  if (std::memcmp(sector.data(), "SACDMTOC", 8) != 0) return false;

  // Master TOC fixed offsets (packed big-endian layout):
  //   +8  version (major, minor)     +24 album_catalog_number[16]
  //   +64 area_1_toc_1_start         +68 area_1_toc_2_start
  //   +72 area_2_toc_1_start         +76 area_2_toc_2_start
  //   +84 area_1_toc_size            +86 area_2_toc_size
  //   +88 disc_catalog_number[16]    +120 year/month/day
  out->album.valid = true;
  out->album.catalogNumber = copyFixedText(sector.data() + 24, 16);
  if (out->album.catalogNumber.empty()) {
    out->album.catalogNumber = copyFixedText(sector.data() + 88, 16);
  }
  out->album.year = readBe16(sector.data() + 120);
  out->album.month = sector[122];
  out->album.day = sector[123];

  const uint32_t area1Toc1 = readBe32(sector.data() + 64);
  const uint32_t area1Toc2 = readBe32(sector.data() + 68);
  const uint32_t area2Toc1 = readBe32(sector.data() + 72);
  const uint32_t area2Toc2 = readBe32(sector.data() + 76);
  const uint16_t area1Size = readBe16(sector.data() + 84);
  const uint16_t area2Size = readBe16(sector.data() + 86);

  // Master text sectors immediately follow the master TOC sector, one per
  // locale. We conservatively use the first one only.
  std::vector<uint8_t> textSector(kScarletbookSectorSize);
  if (readSector(file, fileSize, kScarletbookMasterTocLsn + 1, textSector.data())) {
    parseMasterText(textSector.data(), &out->album);
  }

  const uint32_t stereoToc = area1Toc1 != 0 ? area1Toc1 : area1Toc2;
  const uint32_t multiToc = area2Toc1 != 0 ? area2Toc1 : area2Toc2;
  if (stereoToc != 0) {
    parseAreaToc(file, fileSize, stereoToc, area1Size, false, &out->stereo);
  }
  if (multiToc != 0) {
    parseAreaToc(file, fileSize, multiToc, area2Size, true, &out->multichannel);
  }
  return out->hasArea();
}

bool parseScarletbookAudioSector(const uint8_t* sector,
                                 size_t sectorSize,
                                 std::vector<ScarletbookPacket>* packets) {
  if (!sector || !packets || sectorSize == 0) return false;
  packets->clear();

  // Header byte (big-endian bit order on disc):
  //   bits 7-5 packet_info_count, bits 4-2 frame_info_count,
  //   bit 1 reserved, bit 0 dst_encoded.
  const uint8_t header = sector[0];
  const unsigned packetCount = (header >> 5) & 0x07;
  const unsigned frameInfoCount = (header >> 2) & 0x07;
  const bool dstEncoded = (header & 0x01) != 0;

  // Frame-info entries are 4 bytes on DST-encoded sectors, 3 bytes otherwise
  // (the trailing channel/sector-count byte only exists for DST frames).
  const size_t frameInfoSize = dstEncoded ? 4 : 3;
  size_t payloadOffset = 1 + packetCount * 2 + frameInfoCount * frameInfoSize;
  if (payloadOffset > sectorSize) return false;

  size_t tableOffset = 1;
  for (unsigned index = 0; index < packetCount; ++index) {
    // Packet info (2 bytes): bit 15 frame_start, bit 14 reserved,
    // bits 13-11 data_type, bits 10-0 packet_length.
    const uint8_t b0 = sector[tableOffset];
    const uint8_t b1 = sector[tableOffset + 1];
    ScarletbookPacket packet;
    packet.frameStart = (b0 & 0x80) != 0;
    packet.dataType = (b0 >> 3) & 0x07;
    packet.length = static_cast<uint16_t>(((b0 & 0x07) << 8) | b1);
    if (payloadOffset + packet.length > sectorSize) {
      packets->clear();
      return false;
    }
    packet.offset = static_cast<uint16_t>(payloadOffset);
    payloadOffset += packet.length;
    packets->push_back(packet);
    tableOffset += 2;
  }
  return true;
}

}  // namespace twilight::audio::sacd
