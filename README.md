# TechMap Live

TechMap Liveは、技術ディスカッションをリアルタイムに文字起こし・分析し、論点、決定、未解決質問、リスク、アクションを根拠発話付きのマインドマップへ整理する会議ワークスペースです。Microsoft Teams会議を無料MVPの本線とし、Zoom RTMSもoptional inputとして利用できます。

## Product boundary

本番runtimeはWindowsローカルcompanionとして動作します。無料MVPでは、利用者が明示選択したTeamsライブキャプションの現在一cardだけをmemory-only local OCRします。Zoomでは利用者が明示armしたRTMS transcript-only streamをoptional inputとして利用でき、signed webhookだけは専用loopback portへ利用者の一時HTTPS tunnelを必要とします。字幕を利用できない場合のlocal audio fallbackは明示操作だけで開始します。生音声、OCR画像、Zoom raw identityは保存せず、匿名化済み文字起こしと分析結果はGit working tree外へローカル保存できます。OpenAI API送信はIssue #3と#6のredaction、保持、`store: false`境界に従います。無料MVPの成立状況と未確認条件は[Teams字幕OCR MVP support specification](docs/specs/teams-mvp-support.md)を参照してください。

## Repository layout

- `app/`: 共通UI層と、Sites/Vinextによる合成データreview surface
- `native/windows-audio/`: Teams process treeだけを対象にするWindows音声helper
- `native/teams-captions/`: Teams字幕の選択矩形・memory OCR・話者aliasingを所有するWindows helper
- `native/transcription/`: pinned whisper.cppを使うmemory-only文字起こしworker
- `native/privacy/`: current-user ACL、DPAPI、Windows Credential Managerを所有するprivacy helper
- `app/domain/analysis/`: versioned analysis state/delta、strict schema、prompt contract
- `app/adapters/analysis/`: deterministic mockとprivacy-gated OpenAI analyzer
- `companion/`: browserとnative helperを接続するloopback-only host
- `scripts/`: 会議外で実行する検証付きmodel setup
- `docs/specs/`: 現在のproduct behavior
- `docs/policies/`: Issue、PR、データ、agent協働の運用規約
- `docs/adr/`: 永続的な技術判断
- `.github/`: Issue、PR、CI設定

## Local development

Node.js 22.18以降とpnpmを使用します。

```powershell
cd app
pnpm install
pnpm run dev --hostname 127.0.0.1 --port 3000
```

検証コマンドは[AGENTS.md](AGENTS.md)を参照してください。

## Windows MVPを試す

### 別PCでポータブル版を試す

`Windows portable package` workflowのartifact `TechMapLive-windows-x64`をダウンロードし、ZIPを「すべて展開」して`TechMapLive\TechMapLive.cmd`をダブルクリックします。Node.js、pnpm、Git、GitHub CLI、Visual Studio/CMake、管理者権限は不要です。固定Node.js、native helper、検証済みTesseract日本語・英語OCRを同梱し、初回起動時に改変検査を行います。会議data、API key、保存session、Whisper modelは同梱しません。詳しい導入、attestation検証、別PCでの確認項目は[Windowsポータブル配布仕様](docs/specs/windows-portable-distribution.md)を参照してください。

### sourceからbuildして試す

最初にVisual Studio Build Tools、Windows SDK、CMake、Node.js 22.18以降、pnpmを用意し、native helperとweb appを一括buildします。transcription helperの初回buildは固定commitのwhisper.cppを取得するためnetworkを使います。

Node.jsが未導入の場合は、公式winget packageを導入します。install完了後はPATHを反映するためPowerShellを閉じ、新しいPowerShellで`node --version`が22.18以降であることを確認してください。

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
node --version
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-mvp.ps1
```

次にmain branchの`Attested Tesseract runtime`成功runから7日保持のOCR artifactをGit管理対象外へ取得します。GitHub CLIへlogin済みであることが必要です。installerはZIPを展開する前に、GitHub/Sigstore provenanceをこのrepositoryのmain branch、専用workflow、GitHub-hosted runnerへ限定して検証します。

```powershell
gh run download <mainの成功run ID> --repo undo-not/tech-discussion-map `
  --name techmap-ocr-runtime-windows-x64 --dir data/local/ocr-artifact
powershell -ExecutionPolicy Bypass -File scripts/install-attested-tesseract.ps1 `
  -ArtifactZip data/local/ocr-artifact/techmap-ocr-runtime-windows-x64.zip
```

組織で別distributionを承認している場合は、実測SHA-256を指定するoffline setupも利用できます。scriptはdownloadせず、検証済みfileだけを`%LOCALAPPDATA%\TechMapLive\ocr\current`へcopyします。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-tesseract.ps1 `
  -DistributionDirectory C:\approved\tesseract-5.5.3 `
  -TesseractSha256 <64桁の実測hash> `
  -JapaneseSha256 <64桁の実測hash> `
  -EnglishSha256 <64桁の実測hash>
```

起動前診断と起動は次の一commandです。UIとcompanionは`127.0.0.1`だけで動作し、このterminalでCtrl+Cを押すとlauncherが所有する子processを終了します。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-mvp.ps1
```

まず「合成デモ」でtimeline→分析→mind mapを確認し、必要なら「Mermaidを保存」から利用者が選択したlocal pathへ`.mmd`を保存できます。実Teamsでは全参加者の同意と画面上の開始条件を確認し、「Teams字幕OCRを開始」から現在発話者のcaption cardだけをdragします。OCRが利用できない場合に限り、明示操作で音声fallbackへ切り替えます。Zoom RTMSを使う環境では`powershell -ExecutionPolicy Bypass -File scripts/setup-zoom-rtms.ps1`でGeneral App credentialをWindows Credential Managerへ登録し、利用者の一時HTTPS tunnelを`127.0.0.1:43118/zoom/webhook`だけへ向けます。armは15分・one-shotで、3000または43117を公開してはいけません。

詳しい起動境界は[Windows local MVP launch specification](docs/specs/local-runtime-launch.md)、OCRは[Teams caption source capability specification](docs/specs/teams-caption-source.md)、音声fallbackは[Windows Teams audio adapter](docs/specs/windows-audio-adapter.md)を参照してください。

Teams字幕入力の実装本線は選択矩形local OCRです。対象PCでUI Automation probeがtimeoutしたためUIAは既定経路にしていません。`native/teams-captions`の通常probeは表示文字、window title、PIDを読み出さず、Teams top-level windowからUI Automation rootを取得できるかだけをローカル表示します。OCRは全参加者同意と利用者のdrag選択後に、選択矩形だけをmemory処理します。

```powershell
cmake -S native/teams-captions -B native/teams-captions/build -A x64
cmake --build native/teams-captions/build --config Release
ctest --test-dir native/teams-captions/build -C Release --output-on-failure
native/teams-captions/build/Release/techmap-captions.exe probe
```

`probe-at-cursor`は本人のみの合成テスト会議または全参加者同意済みのテスト専用です。診断結果もGitHubへ貼り付けません。詳細は[Teams caption source capability specification](docs/specs/teams-caption-source.md)を参照してください。

詳しいTesseract setup引数と操作は[native caption helper README](native/teams-captions/README.md)を参照してください。

ローカル文字起こしは[local transcription specification](docs/specs/local-transcription.md)に従います。音声fallbackを使う場合は、会議前に`powershell -ExecutionPolicy Bypass -File scripts/setup-whisper-model.ps1`でchecksum検証済みmodelを導入します。実会議runtimeは`start-mvp.ps1`から起動してください。launch secretはURLやconsoleへ出さず、launcher、UI server、companionのmemoryだけで受け渡します。公開URLではマイク入力は無効で、合成デモだけが動作します。

会議dataの同意、暗号化保存、保持、削除、redaction、OpenAI保持条件は[privacy boundary](docs/specs/privacy-boundary.md)に従います。API keyは`powershell -ExecutionPolicy Bypass -File scripts/setup-openai-key.ps1`の非表示promptからWindows Credential Managerへ保存します。keyを`.env`、browser、command line、Issue、PR、logへ入れないでください。
