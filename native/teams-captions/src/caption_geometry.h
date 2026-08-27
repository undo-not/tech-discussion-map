#pragma once

#include <cstdint>

namespace techmap::captions {

struct PixelRect final {
    std::int32_t left;
    std::int32_t top;
    std::int32_t right;
    std::int32_t bottom;
};

struct WindowSnapshot final {
    PixelRect client;
    std::uint32_t dpi;
    bool visible;
    bool foreground;
    bool minimized;
    bool pointsOwnedByTeams;
};

enum class SelectionDecision {
    Allowed,
    TeamsNotVisible,
    TeamsNotForeground,
    TeamsMinimized,
    DpiChanged,
    SelectionInvalid,
    SelectionOutsideClient,
    SelectionTooLarge,
    SelectionOwnedByAnotherProcess,
};

constexpr std::int32_t MaximumCaptionWidth = 2'560;
constexpr std::int32_t MaximumCaptionHeight = 720;
constexpr std::uint64_t MaximumCaptionPixelBytes = 8ULL * 1024ULL * 1024ULL;

constexpr std::int64_t Width(const PixelRect& value) noexcept {
    return static_cast<std::int64_t>(value.right) - value.left;
}

constexpr std::int64_t Height(const PixelRect& value) noexcept {
    return static_cast<std::int64_t>(value.bottom) - value.top;
}

constexpr SelectionDecision ValidateSelection(
    const WindowSnapshot& current,
    const PixelRect& selected,
    std::uint32_t selectionDpi) noexcept {
    if (!current.visible) return SelectionDecision::TeamsNotVisible;
    if (!current.foreground) return SelectionDecision::TeamsNotForeground;
    if (current.minimized) return SelectionDecision::TeamsMinimized;
    if (selectionDpi == 0 || current.dpi != selectionDpi) return SelectionDecision::DpiChanged;
    const std::int64_t width = Width(selected);
    const std::int64_t height = Height(selected);
    if (width <= 0 || height <= 0) return SelectionDecision::SelectionInvalid;
    if (selected.left < current.client.left || selected.top < current.client.top ||
        selected.right > current.client.right || selected.bottom > current.client.bottom) {
        return SelectionDecision::SelectionOutsideClient;
    }
    if (width > MaximumCaptionWidth || height > MaximumCaptionHeight ||
        static_cast<std::uint64_t>(width) * static_cast<std::uint64_t>(height) * 4ULL > MaximumCaptionPixelBytes) {
        return SelectionDecision::SelectionTooLarge;
    }
    if (!current.pointsOwnedByTeams) return SelectionDecision::SelectionOwnedByAnotherProcess;
    return SelectionDecision::Allowed;
}

} // namespace techmap::captions
