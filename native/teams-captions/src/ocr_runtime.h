#pragma once

#include "caption_geometry.h"

#include <cstdint>
#include <string>

namespace techmap::captions {

int RunOcrStatus();
int RunOcrCapture(std::string sessionProof);
int RunCaptureFrameWorker(std::uintptr_t windowValue, PixelRect selection, std::uint32_t selectionDpi);

} // namespace techmap::captions
