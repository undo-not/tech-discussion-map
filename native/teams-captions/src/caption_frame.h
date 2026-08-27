#pragma once

#include <array>
#include <cstdint>

namespace techmap::captions {

constexpr std::array<unsigned char, 12> CaptionFrameHeader(std::uint8_t type, std::uint32_t payloadBytes) noexcept {
    return {{
        'T', 'M', 'O', '1', 1, type, 0, 0,
        static_cast<unsigned char>(payloadBytes & 0xff),
        static_cast<unsigned char>((payloadBytes >> 8) & 0xff),
        static_cast<unsigned char>((payloadBytes >> 16) & 0xff),
        static_cast<unsigned char>((payloadBytes >> 24) & 0xff),
    }};
}

} // namespace techmap::captions
