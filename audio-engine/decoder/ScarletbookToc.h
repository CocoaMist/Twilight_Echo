#pragma once

// Scarletbook (SACD specification) table-of-contents parsing for SACD ISO
// images. Layout follows the published Scarletbook structures as documented
// by the sacd-ripper project (GPL) — this is an independent implementation
// that reads the on-disc big-endian structures with strict bounds checking.
//
// Disc layout summary:
//   LSN 510                Master TOC ("SACDMTOC"), spec version, album/disc
//                          info and the 2CH / MC area TOC start LSNs + sizes.
//   LSN 511..518           Master text sectors ("SACDText"), one per locale.
//   area start LSN         Area TOC header ("TWOCHTOC" / "MULCHTOC"):
//                          sample-rate flag, frame format (DSD vs DST),
//                          channel count, track count.
//   following sectors      "SACDTTxt" (track titles / performers),
//                          "SACDTRL1" (track start/length LSN tables),
//                          "SACDTRL2" (track time-code start/duration tables).
//
// All input is treated as untrusted: every sector/offset read is bounds
// checked and malformed data yields `false` (caller falls back to heuristics)
// rather than crashing.

#include <cstddef>
#include <cstdint>
#include <fstream>
#include <string>
#include <vector>

namespace twilight::audio::sacd {

inline constexpr uint32_t kScarletbookSectorSize = 2048;
inline constexpr uint32_t kScarletbookMasterTocLsn = 510;
inline constexpr uint32_t kScarletbookMasterTocSectors = 10;
inline constexpr uint32_t kScarletbookFrameRate = 75;
inline constexpr uint32_t kScarletbookDsd64SampleRate = 2822400;
inline constexpr size_t kScarletbookMaxDstFrameBytes = 64 * 1024;
inline constexpr uint8_t kScarletbookPacketTypeAudio = 2;
inline constexpr uint8_t kScarletbookPacketTypeSupplementary = 3;
inline constexpr uint8_t kScarletbookPacketTypePadding = 7;
inline constexpr uint8_t kScarletbookFrameFormatDst = 0;

struct ScarletbookTrack {
  int trackNumber = 0;
  std::string title;
  std::string performer;
  uint32_t startLsn = 0;
  uint32_t lengthLsn = 0;
  double startSeconds = 0.0;
  double durationSeconds = 0.0;
};

struct ScarletbookArea {
  bool valid = false;
  bool multichannel = false;
  bool dst = false;
  int channelCount = 2;
  int sampleRate = static_cast<int>(kScarletbookDsd64SampleRate);
  uint32_t tocLsn = 0;
  std::vector<ScarletbookTrack> tracks;
};

struct ScarletbookAlbum {
  bool valid = false;
  std::string albumTitle;
  std::string albumArtist;
  std::string discTitle;
  std::string discArtist;
  std::string catalogNumber;
  int year = 0;
  int month = 0;
  int day = 0;
};

struct ScarletbookDisc {
  ScarletbookAlbum album;
  ScarletbookArea stereo;
  ScarletbookArea multichannel;

  bool hasArea() const {
    return stereo.valid || multichannel.valid;
  }
};

// Parses the Master TOC, master text and both area TOCs from an open SACD ISO
// image. Returns true when the Master TOC signature is present and at least
// one audio area yields a non-empty track list. Never throws; malformed input
// returns false.
bool parseScarletbookDisc(std::istream& file, uint64_t fileSize, ScarletbookDisc* out);

// One multiplexed packet inside a 2048-byte Scarletbook audio sector.
struct ScarletbookPacket {
  bool frameStart = false;
  uint8_t dataType = 0;   // audio_packet_data_type_t: 2 audio, 3 suppl, 7 pad
  uint16_t offset = 0;    // payload offset within the sector
  uint16_t length = 0;    // payload byte count
};

// Parses the audio-sector header (packet count, frame-info count, DST flag)
// and the packet table of one 2048-byte sector. Returns false on a malformed
// header or when a packet payload would run past the sector end. A sector
// with zero packets (e.g. all-zero padding) parses successfully with an empty
// packet list.
bool parseScarletbookAudioSector(const uint8_t* sector,
                                 size_t sectorSize,
                                 std::vector<ScarletbookPacket>* packets);

}  // namespace twilight::audio::sacd
