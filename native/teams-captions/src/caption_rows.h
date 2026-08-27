#pragma once

#include "caption_speaker.h"

#include <algorithm>
#include <cstdint>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace techmap::captions {

struct CaptionRowEvent final {
    enum class Type { Observation, Disappeared } type;
    std::string rowId;
    std::uint64_t revision;
    std::uint64_t observedAtMs;
    std::string speaker;
    std::string speakerAlias;
    std::string text;
    int confidence;
};

struct CaptionFrameResult final {
    std::vector<CaptionRowEvent> events;
    bool lowConfidence;
};

class CaptionRowTracker final {
public:
    explicit CaptionRowTracker(std::string rowPrefix = "ocr-") : rowPrefix_(std::move(rowPrefix)) {}
    CaptionFrameResult Apply(const std::vector<SafeCaptionLine>& lines, std::uint64_t observedAtMs) {
        CaptionFrameResult result{{}, false};
        std::unordered_set<std::string> seen;
        for (const auto& line : lines) {
            seen.insert(line.lineKey);
            if (line.confidence < MinimumConfidence) {
                result.lowConfidence = true;
                continue;
            }
            auto existing = std::find_if(rows_.begin(), rows_.end(), [&](const Row& row) { return row.lineKey == line.lineKey; });
            if (existing == rows_.end()) {
                rows_.push_back({line.lineKey, rowPrefix_ + std::to_string(nextId_++), 0, line.speaker, line.speakerAlias, line.text, 1, false, {}, {}, {}});
                continue;
            }
            const bool same = existing->speaker == line.speaker && existing->speakerAlias == line.speakerAlias && existing->candidateText == line.text;
            if (!same) {
                existing->speaker = line.speaker;
                existing->speakerAlias = line.speakerAlias;
                existing->candidateText = line.text;
                existing->stableSamples = 1;
                continue;
            }
            if (existing->stableSamples < 2) existing->stableSamples += 1;
            if (existing->stableSamples < 2) continue;
            if (existing->emitted && existing->emittedText == existing->candidateText && existing->emittedSpeaker == existing->speaker && existing->emittedAlias == existing->speakerAlias) continue;
            existing->revision += 1;
            existing->emitted = true;
            existing->emittedText = existing->candidateText;
            existing->emittedSpeaker = existing->speaker;
            existing->emittedAlias = existing->speakerAlias;
            result.events.push_back({
                CaptionRowEvent::Type::Observation, existing->rowId, existing->revision, observedAtMs,
                existing->speaker, existing->speakerAlias, existing->candidateText, line.confidence,
            });
        }

        auto row = rows_.begin();
        while (row != rows_.end()) {
            if (seen.contains(row->lineKey)) {
                ++row;
                continue;
            }
            if (row->emitted) {
                result.events.push_back({CaptionRowEvent::Type::Disappeared, row->rowId, row->revision, observedAtMs, {}, {}, {}, 0});
            }
            row = rows_.erase(row);
        }
        return result;
    }

    void Clear() noexcept {
        for (auto& row : rows_) {
            SecureClear(row.lineKey);
            SecureClear(row.speakerAlias);
            SecureClear(row.candidateText);
            SecureClear(row.emittedAlias);
            SecureClear(row.emittedText);
        }
        rows_.clear();
        SecureClear(rowPrefix_);
    }

    ~CaptionRowTracker() { Clear(); }

    static constexpr int MinimumConfidence = 85;

private:
    struct Row final {
        std::string lineKey;
        std::string rowId;
        std::uint64_t revision;
        std::string speaker;
        std::string speakerAlias;
        std::string candidateText;
        int stableSamples;
        bool emitted;
        std::string emittedText;
        std::string emittedSpeaker;
        std::string emittedAlias;
    };
    std::vector<Row> rows_;
    std::string rowPrefix_;
    std::uint64_t nextId_ = 1;

    static void SecureClear(std::string& value) noexcept {
        std::fill(value.begin(), value.end(), '\0');
        value.clear();
    }
};

} // namespace techmap::captions
