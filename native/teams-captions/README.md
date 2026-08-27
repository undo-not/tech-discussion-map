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

このrepositoryとCI artifactはTesseract、DLL、traineddataを含みません。組織で承認されたTesseract 5.5.3 Windows distributionを別途用意し、次の3ファイルのSHA-256を手元で確認してください。

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

setup scriptはnetworkへアクセスせず、hash検証後にversion commandを実行し、検証済みdistributionを`%LOCALAPPDATA%\TechMapLive\ocr\current`へcopyします。既存installの置換は`-Replace`を明示した場合だけ行い、旧directoryは`previous-*`として残します。

## OCR usage

1. `node companion/local-transcription-host.mjs`とlocal UIを起動する。
2. Teamsライブキャプションを表示し、Teamsをforegroundにする。
3. UIで全参加者同意を確認し、`Teams字幕OCRを開始`を押す。
4. native overlayで字幕本文と発話者だけを含む矩形をdragする。
5. Teamsの最小化、遮蔽、移動、DPI変更、低confidenceでdegradedになった場合は、状態を直して新しく開始する。
6. 一時停止はcapture processとbufferを破棄する。再開時は矩形を再選択する。

`ocr-capture`はcompanionがanonymous stdout pipeを接続した場合だけ動作するため、terminalから直接captureできません。選択矩形のbitmap、TSV、raw表示名はfile、clipboard、log、networkへ出さず、alias済みcaption eventだけをloopback companionへ渡します。実会議dataや診断出力をIssue、PR、Git、CI artifactへ置かないでください。
