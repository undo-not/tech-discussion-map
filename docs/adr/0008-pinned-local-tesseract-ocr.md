# ADR-0008: Teams字幕OCRにhash固定したlocal Tesseractを使う

- Status: Accepted（Issue #16、#25、2026-08-28。実Teams字幕品質は対象PCで継続評価）
- Source: Issue #19
- Extends: ADR-0007

## Context

対象PCではTeams UI Automation rootのcontent-free probeが5秒timeoutとなり、UIAをMVP既定にできない。Teamsライブキャプションは表示上の文字と発話者を持つため、利用者が選択した字幕矩形だけをローカルOCRする経路を検証する。

Windows.Media.Ocrはdesktop appでpackage identityを必要とし、公開resultにword confidenceを持たない。Tesseract 5はimageをstdin、TSVをstdoutで扱い、word confidenceを返せる。MVPはMSIX化を前提にせず、Tesseract 5.5.3と`jpn`／`eng` traineddataを利用者が指定したSHA-256でsetup時に固定する。

Tesseract projectの5.5.3 annotated tagはGitHubで署名検証済みで、commit `db0ec62f81b0737fbbe184d8fea40af5738f8eef`を参照する。一方、同releaseのWindows installerはGitHub公開SHA-256と一致しても、2026年のtimestampに対して2023年失効のcode-signing certificateを持ち、対象PCのAuthenticode検証が失敗した。このinstallerを信頼rootにせず、署名済みtagのsource archive SHA-512、Microsoft vcpkg baseline、`tessdata_fast` commitとmodel SHA-256を固定したGitHub-hosted Windows buildを採用する。

repositoryのtracked contentにはWindows binary、DLL、traineddataを含めない。main branchの専用workflowは7日保持のephemeral ZIPだけを生成し、GitHub/SigstoreのSLSA build provenance attestationを付ける。local installerはrepository、workflow path、`refs/heads/main`、GitHub-hosted runnerを検証してからZIPを展開し、既存のoffline setupへ実測hashを渡す。attestation取得は会議外のsetup時だけnetworkを使い、OCR runtimeはdownload、PATH探索、network accessを行わない。組織が別distributionを承認している場合は従来のoffline setupを使用できる。

## Decision

- `%LOCALAPPDATA%\TechMapLive\ocr\current`の固定配置だけを使う。
- official 5.5.3 tag object、source commit/archive hash、vcpkg baseline/static triplet、`tessdata_fast` commit/model hashをbuild scriptとartifact manifestで固定する。
- local installはartifact attestationを`undo-not/tech-discussion-map/.github/workflows/tesseract-runtime.yml`、main ref、GitHub-hosted runnerへ限定して検証する。ZIPのpath、entry数、展開size、file allowlistも展開前に検証する。
- setupはTesseract version、executable、`jpn.traineddata`、`eng.traineddata`を検証し、hash manifestをローカルに作る。hash値をrepositoryへ創作・固定しない。
- runtimeは毎session開始前にmanifestと3ファイルのSHA-256を再検証する。
- Tesseractは選択矩形だけを持つmemory BMPをstdinで受け、TSVをstdoutへ返す。TSV modeは外部config fileではなく固定した`tessedit_create_tsv=1`を使い、file output、clipboard、debug output、networkを使わない。
- 子processは継承handleをstdin/stdout/NUL stderrに限定し、Job Object、process数1、memory上限、5秒timeoutを適用する。
- TSVのstrict parse、speaker prefix分離、session-only alias化、2回連続安定性判定はnative process内で完了する。speaker/bodyを明確に分離できない行は表示名混入を避けるためdropし、raw表示名とTSVをcompanionへ渡さない。
- OCR画像とTSV bufferは使用後にzero化し、永続化対象にしない。

## Capture boundary

利用者が全参加者同意を確認してUIから開始し、foregroundの`ms-teams.exe` client area上で字幕矩形をdragした場合だけcaptureする。overlayはcapture対象外属性を付け、選択完了前にpixelを取得しない。

各frameでTeamsのvisible、foreground、非最小化、DPI不変、client area完全内包、四隅と中央のprocess ownershipを再検証する。Teams window全体のbitmapは作らず、選択矩形と同じ寸法のmemory DCへ`PrintWindow`をclipして描画する。`PrintWindow`は別の同一helper workerで実行し、2秒で応答しなければworkerを終了する。

検証失敗、黒／一様frame、OCR timeout、malformed TSV、confidence不足では発話を生成せずdegradedへ遷移する。screen DCや他application pixelへのfallbackはしない。

## Consequences

- Teams側の字幕認識と発話者表示を再利用でき、音声再認識より端末負荷を抑えられる可能性がある。
- attested runtime buildはmain更新時と手動実行時にnetworkとGitHub-hosted Windows runnerを使う。artifactは7日で失効するため、local install後のruntime hash manifestを継続利用し、再導入時は新しいmain artifactを検証する。
- Teamsの非公開UI描画挙動とTesseract品質に依存するため、対象PCで`PrintWindow`が黒frameになる場合は使用できない。
- pauseはnative capture processを終了し、resume時に矩形を再選択する。旧bitmapや座標を保持しない。
- process-scoped音声＋local Whisperは明示fallbackとして残す。

## Official references

- https://github.com/tesseract-ocr/tesseract/releases/tag/5.5.3
- https://github.com/tesseract-ocr/tesseract/blob/main/doc/tesseract.1.asc
- https://github.com/tesseract-ocr/tessdoc/blob/main/Command-Line-Usage.md
- https://docs.github.com/en/actions/concepts/security/artifact-attestations
- https://github.com/microsoft/vcpkg
- https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr
