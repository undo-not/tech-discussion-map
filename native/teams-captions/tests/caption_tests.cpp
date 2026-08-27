#include "caption_geometry.h"
#include "caption_rows.h"
#include "caption_speaker.h"
#include "caption_tsv.h"

#include <cstdlib>
#include <iostream>
#include <string>

using namespace techmap::captions;

namespace {

void Require(bool condition, const char* message) {
    if (!condition) {
        std::cerr << message << '\n';
        std::exit(1);
    }
}

std::string Header() {
    return "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";
}

} // namespace

int main() {
    const WindowSnapshot valid{{100, 100, 2'000, 900}, 144, true, true, false, true};
    Require(ValidateSelection(valid, {120, 200, 1'900, 700}, 144) == SelectionDecision::Allowed, "valid selection rejected");
    Require(ValidateSelection(valid, {99, 200, 1'900, 700}, 144) == SelectionDecision::SelectionOutsideClient, "outside selection accepted");
    Require(ValidateSelection(valid, {120, 200, 120, 700}, 144) == SelectionDecision::SelectionInvalid, "empty selection accepted");
    auto background = valid;
    background.foreground = false;
    Require(ValidateSelection(background, {120, 200, 1'900, 700}, 144) == SelectionDecision::TeamsNotForeground, "background window accepted");
    auto foreign = valid;
    foreign.pointsOwnedByTeams = false;
    Require(ValidateSelection(foreign, {120, 200, 1'900, 700}, 144) == SelectionDecision::SelectionOwnedByAnotherProcess, "foreign points accepted");
    Require(ValidateSelection(valid, {120, 200, 1'900, 700}, 96) == SelectionDecision::DpiChanged, "DPI change accepted");

    const std::string tsv = Header() +
        "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t96\tAlice:\n"
        "5\t1\t1\t1\t1\t2\t11\t0\t10\t10\t90\tsynthetic\n"
        "5\t1\t1\t1\t1\t3\t22\t0\t10\t10\t87\tdesign\n";
    const auto parsed = ParseTesseractTsv(tsv);
    Require(parsed.size() == 1, "TSV line not reconstructed");
    Require(parsed[0].confidence == 91, "TSV confidence not averaged deterministically");
    Require(ParseTesseractTsv("bad header\n").empty(), "bad header accepted");
    Require(ParseTesseractTsv(Header() + "5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t-1\tunsafe\n").empty(), "negative confidence accepted");

    SpeakerAliasTable aliases;
    const auto safe = aliases.Anonymize(parsed[0]);
    Require(safe && safe->speaker == "displayed-alias" && safe->speakerAlias == "speaker-1", "display name not anonymized");
    Require(safe->text == "synthetic design" && safe->text.find("Alice") == std::string::npos, "display name leaked into text");
    const auto same = aliases.Anonymize({"2", "Alice: another", 95});
    Require(same && same->speakerAlias == "speaker-1", "alias not stable");
    Require(!aliases.Anonymize({"3", "possible raw name without boundary", 95}), "ambiguous line crossed identity boundary");
    Require(!aliases.Anonymize({"3b", "Caption: Alice: secret", 95}), "second identity boundary crossed into caption text");
    const auto anonymous = aliases.Anonymize({"4", "匿名：合成発話", 95});
    Require(anonymous && anonymous->speaker == "anonymous" && anonymous->speakerAlias.empty(), "anonymous speaker not normalized");
    aliases.Clear();
    Require(aliases.Size() == 0, "alias table not cleared");

    CaptionRowTracker tracker;
    const std::vector<SafeCaptionLine> frame{{"line-1", "displayed-alias", "speaker-1", "synthetic design", 91}};
    Require(tracker.Apply(frame, 100).events.empty(), "unstable first sample emitted");
    const auto stable = tracker.Apply(frame, 600);
    Require(stable.events.size() == 1 && stable.events[0].rowId == "ocr-1" && stable.events[0].revision == 1, "stable observation not emitted");
    Require(tracker.Apply(frame, 1'100).events.empty(), "duplicate stable observation emitted");
    const std::vector<SafeCaptionLine> rewrite{{"line-1", "displayed-alias", "speaker-1", "synthetic revised", 93}};
    Require(tracker.Apply(rewrite, 1'600).events.empty(), "unstable rewrite emitted");
    const auto revised = tracker.Apply(rewrite, 2'100);
    Require(revised.events.size() == 1 && revised.events[0].revision == 2, "stable rewrite not versioned");
    const auto disappeared = tracker.Apply({}, 2'600);
    Require(disappeared.events.size() == 1 && disappeared.events[0].type == CaptionRowEvent::Type::Disappeared, "row disappearance not emitted");
    const std::vector<SafeCaptionLine> weak{{"line-2", "unknown", {}, "synthetic weak", 84}};
    Require(tracker.Apply(weak, 3'100).lowConfidence, "low confidence not signaled");

    CaptionRowTracker scrolling("ocr-scroll-");
    const std::vector<SafeCaptionLine> beforeScroll{
        {"line-1", "displayed-alias", "speaker-1", "first utterance", 95},
        {"line-2", "displayed-alias", "speaker-2", "second utterance", 95},
    };
    scrolling.Apply(beforeScroll, 100);
    const auto initialRows = scrolling.Apply(beforeScroll, 600);
    Require(initialRows.events.size() == 2, "initial scrolling rows not emitted");
    const std::vector<SafeCaptionLine> afterScroll{
        {"line-1", "displayed-alias", "speaker-2", "second utterance", 95},
        {"line-2", "displayed-alias", "speaker-1", "third unrelated utterance", 95},
    };
    const auto scrollStarted = scrolling.Apply(afterScroll, 1'100);
    Require(scrollStarted.events.size() == 1 && scrollStarted.events[0].type == CaptionRowEvent::Type::Disappeared &&
        scrollStarted.events[0].rowId == "ocr-scroll-1", "scrolled-out row was rewritten instead of finalized");
    const auto scrollSettled = scrolling.Apply(afterScroll, 1'600);
    Require(scrollSettled.events.size() == 1 && scrollSettled.events[0].rowId == "ocr-scroll-3", "new scrolled row reused an old identity");
    return 0;
}
