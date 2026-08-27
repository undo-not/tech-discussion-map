#pragma once

#include <cstdint>
#include <string_view>

namespace techmap::audio {

enum class CaptureState {
    Stopped,
    Active,
    RemoteAudioUndetected,
    DegradedMicrophoneOnly,
};

constexpr std::string_view ToString(CaptureState state) noexcept {
    switch (state) {
    case CaptureState::Stopped:
        return "stopped";
    case CaptureState::Active:
        return "active";
    case CaptureState::RemoteAudioUndetected:
        return "remote-audio-undetected";
    case CaptureState::DegradedMicrophoneOnly:
        return "degraded-microphone-only";
    }
    return "stopped";
}

class CaptureStateTracker final {
public:
    static constexpr std::uint64_t SilenceWarningMilliseconds = 15'000;

    CaptureState state() const noexcept { return state_; }

    bool Start(std::uint64_t nowMilliseconds) noexcept {
        if (state_ != CaptureState::Stopped) {
            return false;
        }
        state_ = CaptureState::Active;
        lastSignalMilliseconds_ = nowMilliseconds;
        return true;
    }

    bool ObserveSignal(bool hasSignal, std::uint64_t nowMilliseconds) noexcept {
        if (state_ != CaptureState::Active && state_ != CaptureState::RemoteAudioUndetected) {
            return false;
        }

        if (hasSignal) {
            lastSignalMilliseconds_ = nowMilliseconds;
            if (state_ == CaptureState::RemoteAudioUndetected) {
                state_ = CaptureState::Active;
                return true;
            }
            return false;
        }

        if (state_ == CaptureState::Active && nowMilliseconds - lastSignalMilliseconds_ >= SilenceWarningMilliseconds) {
            state_ = CaptureState::RemoteAudioUndetected;
            return true;
        }
        return false;
    }

    bool Degrade() noexcept {
        if (state_ == CaptureState::DegradedMicrophoneOnly) {
            return false;
        }
        state_ = CaptureState::DegradedMicrophoneOnly;
        return true;
    }

    bool Stop() noexcept {
        if (state_ == CaptureState::Stopped) {
            return false;
        }
        state_ = CaptureState::Stopped;
        return true;
    }

private:
    CaptureState state_{CaptureState::Stopped};
    std::uint64_t lastSignalMilliseconds_{0};
};

} // namespace techmap::audio
