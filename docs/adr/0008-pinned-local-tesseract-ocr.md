# ADR-0008: Teams字幕OCRにhash固定したlocal Tesseractを使う

- Status: Proposed（Issue #19の合成E2Eと対象PC capability確認後にAcceptedへ変更）
- Source: Issue #19
- Extends: ADR-0007

## Context

対象PCではTeams UI Automation rootのcontent-free probeが5秒timeoutとなり、UIAをMVP既定にできない。Teamsライブキャプションは表示上の文字と発話者を持つため、利用者が選択した字幕矩形だけをローカルOCRする経路を検証する。

Windows.Media.Ocrはdesktop appでpackage identityを必要とし、公開resultにword confidenceを持たない。Tesseract 5はimageをstdin、TSVをstdoutで扱い、word confidenceを返せる。MVPはMSIX化を前提にせず、Tesseract 5.5.3と`jpn`／`eng` traineddataを利用者が指定したSHA-256でsetup時に固定する。

Tesseract projectはsource releaseを提供するが、このrepositoryはWindows binary、DLL、traineddataを配布しない。利用者は組織で承認されたdistributionを用意し、実測hashをsetup scriptへ明示する。runtime downloadとPATH探索は行わない。

## Decision

- `%LOCALAPPDATA%\TechMapLive\ocr\current`の固定配置だけを使う。
- setupはTesseract version、executable、`jpn.traineddata`、`eng.traineddata`を検証し、hash manifestをローカルに作る。hash値をrepositoryへ創作・固定しない。
- runtimeは毎session開始前にmanifestと3ファイルのSHA-256を再検証する。
- Tesseractは選択矩形だけを持つmemory BMPをstdinで受け、TSVをstdoutへ返す。file output、clipboard、debug output、networkを使わない。
- 子processは継承handleをstdin/stdout/NUL stderrに限定し、Job Object、process数1、memory上限、5秒timeoutを適用する。
- TSVのstrict parse、speaker prefix分離、session-only alias化、2回連続安定性判定はnative process内で完了する。raw表示名とTSVをcompanionへ渡さない。
- OCR画像とTSV bufferは使用後にzero化し、永続化対象にしない。

## Capture boundary

利用者が全参加者同意を確認してUIから開始し、foregroundの`ms-teams.exe` client area上で字幕矩形をdragした場合だけcaptureする。overlayはcapture対象外属性を付け、選択完了前にpixelを取得しない。

各frameでTeamsのvisible、foreground、非最小化、DPI不変、client area完全内包、四隅と中央のprocess ownershipを再検証する。Teams window全体のbitmapは作らず、選択矩形と同じ寸法のmemory DCへ`PrintWindow`をclipして描画する。`PrintWindow`は別の同一helper workerで実行し、2秒で応答しなければworkerを終了する。

検証失敗、黒／一様frame、OCR timeout、malformed TSV、confidence不足では発話を生成せずdegradedへ遷移する。screen DCや他application pixelへのfallbackはしない。

## Consequences

- Teams側の字幕認識と発話者表示を再利用でき、音声再認識より端末負荷を抑えられる可能性がある。
- Teamsの非公開UI描画挙動とTesseract品質に依存するため、対象PCで`PrintWindow`が黒frameになる場合は使用できない。
- pauseはnative capture processを終了し、resume時に矩形を再選択する。旧bitmapや座標を保持しない。
- process-scoped音声＋local Whisperは明示fallbackとして残す。

## Official references

- https://github.com/tesseract-ocr/tesseract/releases/tag/5.5.3
- https://github.com/tesseract-ocr/tesseract/blob/main/doc/tesseract.1.asc
- https://github.com/tesseract-ocr/tessdoc/blob/main/Command-Line-Usage.md
- https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr

