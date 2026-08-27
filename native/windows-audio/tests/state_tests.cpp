#include "capture_state.h"

#include <cstdlib>
#include <iostream>

using techmap::audio::CaptureState;
using techmap::audio::CaptureStateTracker;

namespace {

void Require(bool condition, const char* message) {
    if (!condition) {
        std::cerr << message << '\n';
        std::exit(1);
    }
}

} // namespace

int main() {
    CaptureStateTracker tracker;
    Require(tracker.state() == CaptureState::Stopped, "initial state must be stopped");
    Require(tracker.Start(1'000), "explicit start must activate capture");
    Require(tracker.state() == CaptureState::Active, "capture must be active after start");

    Require(!tracker.ObserveSignal(false, 15'999), "silence warning must not fire before 15 seconds");
    Require(tracker.ObserveSignal(false, 16'000), "silence warning must fire at 15 seconds");
    Require(tracker.state() == CaptureState::RemoteAudioUndetected, "silence must produce the warning state");

    Require(tracker.ObserveSignal(true, 16'100), "real signal must clear only the silence warning");
    Require(tracker.state() == CaptureState::Active, "signal must restore active from silence warning");

    Require(tracker.Degrade(), "process or device failure must degrade capture");
    Require(tracker.state() == CaptureState::DegradedMicrophoneOnly, "failure must enter microphone-only state");
    Require(!tracker.Start(17'000), "degraded capture must not auto-reconnect");
    Require(tracker.Stop(), "an explicit stop must reset degraded capture");
    Require(tracker.Start(18'000), "a new explicit start may reconnect");

    Require(tracker.Stop(), "active capture must stop");
    Require(tracker.state() == CaptureState::Stopped, "final state must be stopped");
    return 0;
}
