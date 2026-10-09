#pragma once
#include <filesystem>
#include <span>
#include <string>
#include <cstdint>
namespace twilight::automix {
std::string sha256(std::span<const std::uint8_t> bytes);
std::string sha256File(const std::filesystem::path& path);
}
