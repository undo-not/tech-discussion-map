# Windows local MVP launch specification

## Outcome

利用者はWindows terminalの一つのcommandでTechMap Liveを起動し、OCR-firstの会議ワークスペースを試せる。UIとcompanionは`127.0.0.1`だけへbindし、launcherが所有する子processだけを終了時にcleanupする。

## Preflight

`scripts/preflight-mvp.ps1`はcaptureを開始せず、次を確認する。

- Node.js 22.18以降、web dependencies、caption helper、privacy helper。
- `%LOCALAPPDATA%\TechMapLive\ocr\current`にあるTesseract 5.5.3 manifestと実fileのSHA-256一致。
- loopback port 3000と43117が利用可能であること。
- Teams音声helper、transcriber、Whisper modelは明示fallbackのoptional readinessとして別表示する。

preflightはTeams、microphone、screen、OpenAIへアクセスしない。`-ContractOnly`はPowerShell syntaxとlauncher fileだけを検証し、CIでnative runtimeや実dataを要求しない。

## Startup and shutdown

`scripts/start-mvp.ps1`は検証済みproduction buildを起動し、cryptographic random launch secretをmemoryに生成する。companionへはenvironment経由で渡し、companion entrypointが直ちにenvironmentから削除する。UI serverへはroute readinessを再試行して確認後、browserを開く前にloopback-only HTTP bodyで一度だけprovisionし、UI server memoryだけに保持する。secretをprocess command line、URL、browser history、file、console、logへ書かない。launcherはsecretを含まないplain loopback URLを既定browserで開く。browserはsame-origin・exact JSON POSTでUI serverのmemoryからsecretを取得し、companion bootstrapにだけ使用する。endpointは未provisionのpublic runtimeで404となり、二度目のprovisionを拒否する。

launcherはforegroundに残り、Ctrl+Cまたはいずれかの子process終了時に、自分が開始したUI／companion process treeだけを停止する。stdout／stderrはterminalへ表示できるが、fileへredirectせず、meeting content、OCR画像、TSV、生音声、credential、launch secretを出力してはならない。

## Input order

1. 合成デモは同意やcaptureなしで利用できる。
2. 実会議は全参加者同意を確認し、Teams字幕OCRを明示開始して矩形を選択する。
3. OCRを利用できない場合だけTeams音声を明示診断し、成功後に別buttonでfallbackを開始する。
4. OCR失敗、caption missing、低confidenceを理由に音声fallbackを自動開始しない。

実Teams、microphone、OpenAIのtrialは自動testに含めず、利用者が同意境界と送信previewを確認して手動実行する。
