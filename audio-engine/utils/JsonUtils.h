#pragma once

#include <cctype>
#include <charconv>
#include <cstdlib>
#include <optional>
#include <string>
#include <vector>

namespace twilight::audio::json_utils {

// Shortest decimal that round-trips the exact source-frame timeline.
inline std::string number(double value) {
  char buffer[32];
  const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value);
  return result.ec == std::errc{} ? std::string(buffer, result.ptr) : "0";
}

inline std::string escape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char ch : value) {
    switch (ch) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

inline void skipWhitespace(const std::string& json, size_t* pos) {
  while (*pos < json.size() && std::isspace(static_cast<unsigned char>(json[*pos]))) ++(*pos);
}

inline std::optional<std::string> parseStringToken(const std::string& json, size_t quotePos, size_t* endPos) {
  if (quotePos >= json.size() || json[quotePos] != '"') return std::nullopt;
  std::string value;
  bool escaped = false;
  for (size_t i = quotePos + 1; i < json.size(); ++i) {
    const char ch = json[i];
    if (escaped) {
      switch (ch) {
        case 'n':
          value += '\n';
          break;
        case 'r':
          value += '\r';
          break;
        case 't':
          value += '\t';
          break;
        case 'b':
          value += '\b';
          break;
        case 'f':
          value += '\f';
          break;
        default:
          value += ch;
          break;
      }
      escaped = false;
      continue;
    }
    if (ch == '\\') {
      escaped = true;
      continue;
    }
    if (ch == '"') {
      if (endPos) *endPos = i + 1;
      return value;
    }
    value += ch;
  }
  return std::nullopt;
}

inline std::optional<size_t> matchingContainerEnd(const std::string& json, size_t start) {
  if (start >= json.size()) return std::nullopt;
  const char open = json[start];
  const char close = open == '{' ? '}' : open == '[' ? ']' : '\0';
  if (close == '\0') return std::nullopt;

  bool inString = false;
  bool escaped = false;
  int depth = 0;
  for (size_t i = start; i < json.size(); ++i) {
    const char ch = json[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == '"') {
        inString = false;
      }
      continue;
    }

    if (ch == '"') {
      inString = true;
    } else if (ch == open) {
      ++depth;
    } else if (ch == close) {
      --depth;
      if (depth == 0) return i + 1;
    }
  }
  return std::nullopt;
}

inline std::optional<size_t> topLevelFieldValueStart(const std::string& json, const std::string& key) {
  size_t pos = 0;
  skipWhitespace(json, &pos);
  if (pos >= json.size() || json[pos] != '{') return std::nullopt;
  ++pos;

  while (pos < json.size()) {
    skipWhitespace(json, &pos);
    if (pos >= json.size() || json[pos] == '}') return std::nullopt;
    if (json[pos] != '"') {
      ++pos;
      continue;
    }

    size_t keyEnd = pos;
    const std::optional<std::string> parsedKey = parseStringToken(json, pos, &keyEnd);
    if (!parsedKey.has_value()) return std::nullopt;
    pos = keyEnd;
    skipWhitespace(json, &pos);
    if (pos >= json.size() || json[pos] != ':') return std::nullopt;
    ++pos;
    skipWhitespace(json, &pos);

    if (*parsedKey == key) return pos;

    if (pos < json.size() && (json[pos] == '{' || json[pos] == '[')) {
      const std::optional<size_t> end = matchingContainerEnd(json, pos);
      if (!end.has_value()) return std::nullopt;
      pos = *end;
    } else if (pos < json.size() && json[pos] == '"') {
      size_t stringEnd = pos;
      if (!parseStringToken(json, pos, &stringEnd).has_value()) return std::nullopt;
      pos = stringEnd;
    } else {
      while (pos < json.size() && json[pos] != ',' && json[pos] != '}') ++pos;
    }

    skipWhitespace(json, &pos);
    if (pos < json.size() && json[pos] == ',') ++pos;
  }
  return std::nullopt;
}

inline std::optional<std::string> fieldString(const std::string& json, const std::string& key) {
  const std::optional<size_t> start = topLevelFieldValueStart(json, key);
  if (!start.has_value()) return std::nullopt;
  size_t end = *start;
  return parseStringToken(json, *start, &end);
}

inline std::optional<double> fieldNumber(const std::string& json, const std::string& key) {
  const std::optional<size_t> start = topLevelFieldValueStart(json, key);
  if (!start.has_value()) return std::nullopt;
  char* end = nullptr;
  const double value = std::strtod(json.c_str() + *start, &end);
  if (end == json.c_str() + *start) return std::nullopt;
  return value;
}

inline std::optional<bool> fieldBool(const std::string& json, const std::string& key) {
  const std::optional<size_t> start = topLevelFieldValueStart(json, key);
  if (!start.has_value()) return std::nullopt;
  if (json.compare(*start, 4, "true") == 0) return true;
  if (json.compare(*start, 5, "false") == 0) return false;
  return std::nullopt;
}

inline std::string fieldContainer(const std::string& json, const std::string& key, char open) {
  const std::optional<size_t> start = topLevelFieldValueStart(json, key);
  if (!start.has_value() || *start >= json.size() || json[*start] != open) return {};
  const std::optional<size_t> end = matchingContainerEnd(json, *start);
  if (!end.has_value()) return {};
  return json.substr(*start, *end - *start);
}

inline std::string fieldArray(const std::string& json, const std::string& key) {
  return fieldContainer(json, key, '[');
}

inline std::string fieldObject(const std::string& json, const std::string& key) {
  return fieldContainer(json, key, '{');
}

inline std::vector<std::string> splitTopLevelObjects(const std::string& json) {
  std::vector<std::string> objects;
  bool inString = false;
  bool escaped = false;
  int depth = 0;
  size_t objectStart = std::string::npos;

  for (size_t i = 0; i < json.size(); ++i) {
    const char ch = json[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == '"') {
        inString = false;
      }
      continue;
    }

    if (ch == '"') {
      inString = true;
    } else if (ch == '{') {
      if (depth == 0) objectStart = i;
      ++depth;
    } else if (ch == '}') {
      --depth;
      if (depth == 0 && objectStart != std::string::npos) {
        objects.push_back(json.substr(objectStart, i - objectStart + 1));
        objectStart = std::string::npos;
      }
    }
  }

  return objects;
}

}  // namespace twilight::audio::json_utils
