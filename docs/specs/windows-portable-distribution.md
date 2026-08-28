# Windowsポータブル配布

## 利用者向け手順

対象は64-bit Windows 10/11です。`TechMapLive-windows-x64.zip`をローカルディスクへ保存し、右クリックの「すべて展開」で展開してから、展開先の`TechMapLive\TechMapLive.cmd`をダブルクリックします。Windows PowerShell 5.1の長いpath制限を避けるため、`C:\TechMapLive-Test`のような短い展開先を使い、ZIP内から直接起動しないでください。管理者権限、Node.js、pnpm、Git、GitHub CLI、Visual Studio、CMakeは不要です。

本パッケージは未署名のため、インターネットから取得したfileとしてWindowsの警告やSmartScreenが表示される場合があります。main artifactのattestationとSHA-256を検証した場合だけ、Windowsの「詳細情報」から実行してください。組織ポリシーが未署名アプリまたはPowerShellを禁止しているPCでは回避せず、管理者へ配布許可またはcode signingを依頼してください。`-ExecutionPolicy Bypass`はGroup Policyを上書きしません。

初回起動は同梱ファイルをSHA-256で検査し、固定されたTesseract 5.5.3と日本語・英語モデルを`%LOCALAPPDATA%\TechMapLive\ocr\current`へコピーします。既存のOCR directoryがある場合は自動置換しません。既存内容が壊れている場合はfail closedし、利用者が退避または削除してから再実行する必要があります。起動後はブラウザーで`http://127.0.0.1:3000/`を開きます。終了は起動したconsoleでCtrl+Cを押します。

OpenAI分析を使う場合だけ、各PCで次を実行し、非表示promptへAPI keyを入力します。keyはWindows Credential Managerへ保存され、配布ZIP、command line、browser、GitHubには入りません。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-openai-key.ps1
```

現時点のポータブルZIPはOCR-firstテスト用であり、local Whisper modelを含みません。したがって音声fallbackはmodelを別途明示導入するまで`UNAVAILABLE (optional)`と表示されます。Teams字幕OCRは全参加者の同意後、「Teams字幕OCRを開始」で字幕本文と発話者だけを含む矩形を選択してください。画像と生音声は保存しません。

## 配布物の信頼確認

GitHub Actionsの`Windows portable package`成功runから、14日保持の`TechMapLive-windows-x64` artifactをダウンロードします。main branchで生成されたZIPはGitHub artifact attestationを持ち、GitHub CLIを導入済みの検証用PCでは次でsource repository、workflow、main branchへの結び付きを確認できます。これは配布物を起動するPCの必須条件ではありません。

```powershell
gh attestation verify TechMapLive-windows-x64.zip `
  --repo undo-not/tech-discussion-map `
  --signer-workflow undo-not/tech-discussion-map/.github/workflows/portable-windows.yml `
  --source-ref refs/heads/main
```

同梱manifestは各実行資源のsizeとSHA-256を起動前に検査し、欠損、変更、manifest外の追加fileがあれば起動しません。manifest自体を含むZIP全体の真正性は上記attestationで確認します。

## 配布境界

CIはsourceと固定downloadからallowlistで新規directoryを組み立てます。配布対象は、Vinext standalone production server、companionに必要なdomain/adapter source、4つのnative helper、固定OCR runtime、固定Node.js runtime、起動script、licenseと文書だけです。repositoryの`data/local`、`.env*`、`.wrangler`、log、DB、音声、文字起こし、会議・session・capture名のdata fileは拒否します。build output、ZIP、manifestはGit管理対象外です。

runtimeのUIとcompanionは`127.0.0.1`だけでlistenします。OCR開始、音声fallback、OpenAI API送信には既存仕様の明示操作と同意gateが引き続き適用されます。通常起動時のnetworkは、利用者が設定・許可したOpenAI API通信を除き不要です。

実Teams字幕の認識精度とTeams build差異はCIでは検証できません。別PCでは合成デモ、字幕矩形選択、発話者alias、停止、再起動の順に受入確認し、診断結果や会話本文をIssue/PRへ貼らないでください。
