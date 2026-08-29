# Teams字幕OCR MVP support specification

## Verdict

無料ライセンスだけで成立するproduct architectureは、Windows上のサインイン済みTeams desktop clientで、利用者自身に表示された同一言語のlive captionsを、明示選択した現在発話者のcaption cardだけlocal OCRする方式である。Teams Freeにもlive captionsはあり、group meetingは最大100人・60分である。通常captionにTeams PremiumやMicrosoft 365 Copilotは要求しない。翻訳captionはMVP対象外であり、PremiumまたはCopilot条件に依存する。

ただし、実装が存在することとMVP成立確認は別である。2026-08-30時点では、content-free probeと合成fixtureは合格しているが、実Teamsの日本語caption cardにおける話者名・本文の配置、改行、OCR confidence、書き換えをこのruntimeで確認できていない。したがってMVP成立判定は**未確定**であり、Issue #40は実会議acceptanceが完了するまでcloseしない。

## Supported baseline

次をすべて満たすsessionだけをMVP support候補とする。

- Windows 10 22H2 build 19045以上、またはcurrent Windows 11でportable packageを使用する。
- 利用者はTeams desktop clientへサインインし、通常meetingへ参加する。browser、mobile、PSTN電話参加は対象外である。
- 利用者自身の画面で日本語live captionsが有効で、現在の一発話者名と本文を確認できる。
- meetingにE2EEまたはPrevent screen capturesが適用されておらず、組織規約がlocal OCRを禁止していない。
- Teams側のcaption表示とは別に、全参加者がTechMap Liveによる文字起こし・分析へ同意している。
- 取得対象は利用者がdragした一つのcurrent caption cardだけで、Teams window全体や過去発話一覧を含めない。
- 生画像、OCR intermediate、raw display nameはmemoryから出さない。alias済み文字だけを下流へ渡す。

## Host, participant, license matrix

| Organizer / participant condition | Teams側の成立条件 | TechMap Live MVP status |
| --- | --- | --- |
| Teams Free organizer、同じPCのサインイン済みdesktop participant | built-in live captionsあり。group meetingは100人・60分まで | **本線候補。実機acceptance待ち** |
| Microsoft 365 / Teams business organizer、同一tenantのサインイン済みdesktop participant | attendee自身がlive captionsを有効化できること。admin policyで無効化されていないこと | **本線候補。実機acceptance待ち** |
| 信頼済みexternal access user | meeting参加と本人のcaption表示が許可されること | **未確認。手動acceptance完了までsupport外** |
| organizer tenantのMicrosoft Entra B2B guest | guest access、meeting、caption関連policyが許可されること | **未確認。手動acceptance完了までsupport外** |
| 匿名・未検証participant | organizerがanonymous joinを許可しても、caption表示と安全なspeaker alias境界を保証できない | **support外** |
| Teams web、mobile、PSTN電話 | native helperが`ms-teams.exe`の選択矩形を要求する | **support外** |
| translated captions | Teams PremiumまたはMicrosoft 365 Copilotの条件に依存 | **non-goal** |
| E2EE meeting / call | live captions自体が利用不能になる構成がある | **support外** |
| Prevent screen captures有効meeting | captureがblack frameまたは制限対象になる | **support外。迂回禁止** |

外部参加者はTeams上でguest、trusted external、anonymousのいずれかとして扱われ、設定不一致によりサインインしていてもanonymousになる場合がある。アプリは表示名から参加形態を推測せず、利用者の事前確認と実会議acceptanceを要求する。

## Acceptance boundary

自動testで合格とできる範囲は次に限定する。

- portable manifest、Windows build、pinned Tesseract version/hash、loopback port、helper schema。
- content-free Teams probe。出力は固定stateと`contentInspected:false`、`contentEmitted:false`、`contentPersisted:false`だけで、meeting content、window title、PIDを含めない。
- 合成captionによるalias、duplicate、rewrite、row disappearance、low-confidence、停止・再選択。
- 合成デモからworkspace表示、利用者が選択したlocal pathへのMermaid export。
- consent、support checklist、capture開始を別操作にし、未確認ならfail closedすること。

次は自動testで代替せず、実会議で確認する。

1. Teams Freeまたはbusinessの本人だけのmeetingで、日本語captionを表示する。
2. 現在発話者のcaption cardだけを選択し、話者名と本文が別行・折り返し・逐次書き換えの場合も、raw display nameを漏らさずalias済み発話になることを確認する。
3. caption消失、Teams最小化、選択範囲変更、停止・再選択を確認する。
4. external access userとEntra guestは別account・別tenantで確認する。
5. anonymous/browserは別検証Issueで扱い、合格するまでsupportへ昇格しない。

OCR parserは現在、`表示名: 本文`または`表示名：本文`が一つのOCR行で明確に分離できる場合だけ受理する。Teamsが話者名と本文を別OCR行に描画する実機結果が得られた場合、対応付けを推測で追加せず、選択cardのgeometryを含むprivacy-safe parser contractを先に設計する。この確認が終わるまで、MVPが実Teamsで動作すると表現してはならない。

## Official references

- [Live captions in Microsoft Teams Free](https://support.microsoft.com/en-US/teams/free/meetings/live-captions-in-microsoft-teams-free)
- [Create a meeting in Microsoft Teams Free](https://support.microsoft.com/en-us/teams/free/meetings/create-a-meeting-in-microsoft-teams-free)
- [Use live captions in Microsoft Teams meetings](https://support.microsoft.com/en-US/teams/meetings/use-live-captions-in-microsoft-teams-meetings)
- [Hide your identity in meeting captions and transcripts](https://support.microsoft.com/en-US/teams/meetings-events/hide-your-identity-in-meeting-captions-and-transcripts-in-microsoft-teams)
- [Plan for meetings with external participants](https://learn.microsoft.com/en-us/microsoftteams/plan-meetings-external-participants)
- [Teams settings and policies reference](https://learn.microsoft.com/en-us/MicrosoftTeams/settings-policies-reference)
- [End-to-end encryption for Microsoft Teams](https://learn.microsoft.com/en-us/MicrosoftTeams/teams-end-to-end-encryption)
- [Meeting options in Microsoft Teams](https://support.microsoft.com/en-gb/office/meeting-options-in-microsoft-teams-53261366-dbd5-45f9-aae9-a70e6354f88e)
