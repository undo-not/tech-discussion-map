# Teams caption local adapter

Issue #17のWindows専用read-only capability probeです。Teamsのvisible top-level windowからUI Automation rootを取得できるか確認しますが、`probe`はsubtreeを走査せず、要素名、表示文字、window title、PIDを読み出し・表示しません。UIA callはstdoutを持たない使い捨てworker processで実行され、providerが応答しなくても親processが5秒で終了させます。

```powershell
cmake -S native/teams-captions -B native/teams-captions/build -A x64
cmake --build native/teams-captions/build --config Release
ctest --test-dir native/teams-captions/build -C Release --output-on-failure
native/teams-captions/build/Release/techmap-captions.exe probe
```

本人だけの合成テスト会議で字幕行にマウスポインタを置き、参加者同意を確認した場合に限って次を実行できます。

```powershell
native/teams-captions/build/Release/techmap-captions.exe probe-at-cursor --consent-confirmed
```

このコマンドは選択位置が`ms-teams.exe`のUI要素であることを検証し、文字列の有無と上限内かどうかだけを返します。文字列そのもの、正確な長さ、hash、PID、window titleは出力せず、取得したBSTRを解放前に消去します。画面画像は取得しません。実会議での実行結果やローカル診断JSONをGitHubへ記録しないでください。

このprobeはTeams UIの正式なAPI互換性を保証しません。対象PCではUIA rootがtimeoutしたため、MVP入力は利用者選択矩形のlocal OCRを使います。

## Tesseract setup

既定経路は、main branchの`Attested Tesseract runtime` workflowが公式署名tagのsourceから作る7日保持のartifactです。GitHub CLIでmainの成功runを指定して取得し、attestation検証付きinstallerへ渡します。ZIPと展開先は`data/local/`などGit管理対象外だけを使用してください。

```powershell
gh run download <mainの成功run ID> --repo undo-not/tech-discussion-map `
  --name techmap-ocr-runtime-windows-x64 --dir data/local/ocr-artifact
powershell -ExecutionPolicy Bypass -File scripts/install-attested-tesseract.ps1 `
  -ArtifactZip data/local/ocr-artifact/techmap-ocr-runtime-windows-x64.zip
native/teams-captions/build/Release/techmap-captions.exe ocr-status
```

installerはZIPを展開する前に、GitHub/Sigstore provenanceをこのrepositoryのmain branch、専用workflow、GitHub-hosted runnerへ限定して検証します。固定source commit、vcpkg baseline、model commit/hash、file allowlistも検証し、最後にoffline `setup-tesseract.ps1`を呼びます。networkを使うのは会議外のattestation検証だけで、OCR runtimeはnetworkへアクセスしません。

組織で別のTesseract 5.5.3 Windows distributionが承認されている場合は、次の3ファイルのSHA-256を手元で確認し、従来のoffline setupを使用できます。

- `tesseract.exe`
- `tessdata\jpn.traineddata`
- `tessdata\eng.traineddata`

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-tesseract.ps1 `
  -DistributionDirectory C:\approved\tesseract-5.5.3 `
  -TesseractSha256 <64桁の実測hash> `
  -JapaneseSha256 <64桁の実測hash> `
  -EnglishSha256 <64桁の実測hash>
native/teams-captions/build/Release/techmap-captions.exe ocr-status
```

offline setup scriptはnetworkへアクセスせず、hash検証後にversion commandを実行し、検証済みdistributionを`%LOCALAPPDATA%\TechMapLive\ocr\current`へcopyします。どちらの経路も既存installの置換は`-Replace`を明示した場合だけ行い、旧directoryは`previous-*`として残します。

## OCR usage

1. `node companion/local-transcription-host.mjs`とlocal UIを起動する。
2. Teamsライブキャプションを表示し、Teamsをforegroundにする。
3. UIで全参加者同意を確認し、`Teams字幕OCRを開始`を押す。
4. 60秒以内にnative overlayで字幕本文と発話者だけを含む矩形をdragする。
5. Teamsの最小化、遮蔽、移動、DPI変更、低confidenceでdegradedになった場合は、状態を直して新しく開始する。
6. 一時停止はcapture processとbufferを破棄する。再開時は矩形を再選択する。

`ocr-capture`は、親がlocal Node companion、stdin/stdoutがpipe、command lineとstdinの一回限り証明が一致する場合だけ動作するため、通常のterminalから直接captureできません。選択矩形のbitmap、TSV、raw表示名はfile、clipboard、log、networkへ出さず、alias済みcaption eventだけをloopback companionへ渡します。一時停止・停止時は未配信eventとparser bufferも破棄します。実会議dataや診断出力をIssue、PR、Git、CI artifactへ置かないでください。
