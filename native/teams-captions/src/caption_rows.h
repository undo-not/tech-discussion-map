#pragma once

#include "caption_speaker.h"

#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
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
        if (std::any_of(lines.begin(), lines.end(), [](const SafeCaptionLine& line) { return line.confidence < MinimumConfidence; })) {
            result.lowConfidence = true;
            return result;
        }
        std::unordered_set<std::string> claimedRows;
        for (const auto& line : lines) {
            auto existing = std::find_if(rows_.begin(), rows_.end(), [&](const Row& row) {
                return !claimedRows.contains(row.rowId) && row.speaker == line.speaker && row.speakerAlias == line.speakerAlias && row.candidateText == line.text;
            });
            if (existing == rows_.end()) {
                existing = std::find_if(rows_.begin(), rows_.end(), [&](const Row& row) {
                    return !claimedRows.contains(row.rowId) && row.lineKey == line.lineKey && row.speaker == line.speaker &&
                        row.speakerAlias == line.speakerAlias && IsLikelyRewrite(row.candidateText, line.text);
                });
            }
            if (existing == rows_.end()) {
                rows_.push_back({line.lineKey, rowPrefix_ + std::to_string(nextId_++), 0, line.speaker, line.speakerAlias, line.text, 1, false, {}, {}, {}});
                claimedRows.insert(rows_.back().rowId);
                continue;
            }
            claimedRows.insert(existing->rowId);
            existing->lineKey = line.lineKey;
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
            if (claimedRows.contains(row->rowId)) {
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
            SecureClear(row.emittedSpeaker);
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

    static bool IsLikelyRewrite(std::string_view previous, std::string_view next) noexcept {
        const std::size_t shorter = std::min(previous.size(), next.size());
        std::size_t common = 0;
        while (common < shorter && previous[common] == next[common]) common += 1;
        return common >= 8 && common * 2 >= shorter;
    }
};

} // namespace techmap::captions
