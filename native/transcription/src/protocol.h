#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace techmap::transcription {

constexpr std::size_t HeaderSize = 12;
constexpr std::uint32_t MaximumAudioBytes = 128 * 1024;
constexpr std::uint32_t MaximumOutputBytes = 64 * 1024;

enum class InputType : std::uint8_t { Audio = 1, Flush = 2 };
enum class OutputType : std::uint8_t { Utterance = 1 };

struct Header final {
    std::uint8_t type;
    std::uint32_t payloadSize;
};

inline bool DecodeHeader(
    const std::array<std::uint8_t, HeaderSize>& bytes,
    std::string_view magic,
    std::uint32_t maximumPayload,
    Header& output) noexcept {
    if (magic.size() != 4 || bytes[0] != magic[0] || bytes[1] != magic[1] || bytes[2] != magic[2] || bytes[3] != magic[3]) {
        return false;
    }
    if (bytes[4] != 1 || bytes[6] != 0 || bytes[7] != 0) return false;
    const std::uint32_t size = static_cast<std::uint32_t>(bytes[8]) |
        (static_cast<std::uint32_t>(bytes[9]) << 8) |
        (static_cast<std::uint32_t>(bytes[10]) << 16) |
        (static_cast<std::uint32_t>(bytes[11]) << 24);
    if (size > maximumPayload) return false;
    output = {bytes[5], size};
    return true;
}

inline std::array<std::uint8_t, HeaderSize> EncodeHeader(
    std::string_view magic,
    std::uint8_t type,
    std::uint32_t payloadSize) noexcept {
    return {
        static_cast<std::uint8_t>(magic[0]), static_cast<std::uint8_t>(magic[1]),
        static_cast<std::uint8_t>(magic[2]), static_cast<std::uint8_t>(magic[3]),
        1, type, 0, 0,
        static_cast<std::uint8_t>(payloadSize & 0xff),
        static_cast<std::uint8_t>((payloadSize >> 8) & 0xff),
        static_cast<std::uint8_t>((payloadSize >> 16) & 0xff),
        static_cast<std::uint8_t>((payloadSize >> 24) & 0xff),
    };
}

inline float RootMeanSquare(const std::int16_t* samples, std::size_t count) noexcept {
    if (count == 0) return 0.0F;
    double total = 0.0;
    for (std::size_t index = 0; index < count; ++index) {
        const double sample = static_cast<double>(samples[index]) / 32768.0;
        total += sample * sample;
    }
    return static_cast<float>(std::sqrt(total / static_cast<double>(count)));
}

} // namespace techmap::transcription
