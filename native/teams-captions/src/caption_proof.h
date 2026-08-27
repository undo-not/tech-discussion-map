#pragma once

#include <cstdint>

namespace techmap::captions {

constexpr bool ProofPipeHasNoTrailingBytes(bool peekSucceeded, std::uint32_t availableBytes, bool brokenPipe) noexcept {
    return (peekSucceeded && availableBytes == 0) || (!peekSucceeded && brokenPipe);
}

} // namespace techmap::captions
