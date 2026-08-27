#include "protocol.h"

#include <array>
#include <cassert>
#include <cmath>
#include <cstdint>

int main() {
    using namespace techmap::transcription;
    const auto encoded = EncodeHeader("TMI1", static_cast<std::uint8_t>(InputType::Audio), 6);
    Header decoded{};
    assert(DecodeHeader(encoded, "TMI1", MaximumAudioBytes, decoded));
    assert(decoded.type == static_cast<std::uint8_t>(InputType::Audio));
    assert(decoded.payloadSize == 6);

    auto invalid = encoded;
    invalid[0] = 'X';
    assert(!DecodeHeader(invalid, "TMI1", MaximumAudioBytes, decoded));
    invalid = encoded;
    invalid[6] = 1;
    assert(!DecodeHeader(invalid, "TMI1", MaximumAudioBytes, decoded));

    const std::array<std::int16_t, 4> silence{0, 0, 0, 0};
    assert(RootMeanSquare(silence.data(), silence.size()) == 0.0F);
    const std::array<std::int16_t, 2> signal{16'384, -16'384};
    assert(std::fabs(RootMeanSquare(signal.data(), signal.size()) - 0.5F) < 0.0001F);
    return 0;
}
