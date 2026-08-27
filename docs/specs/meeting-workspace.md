# Meeting workspace specification

## Purpose

TechMap Liveは、会議を進行している最中に会話の構造を見える化し、参加者が「何を議論し、何を決め、何が未解決で、誰が何をするか」を共通認識として確認できるようにする。

## Workspace

会議ワークスペースは、少なくとも次を同時に表示する。

- 時刻順の逐次発話と入力状態。
- 中心テーマ、論点、主張、根拠、決定、質問、リスク、アクションの関係。
- 重要な変更を抽出したインサイト。
- 会議状態、分析状態、利用中の入力方式、データ保持の要点。

分析項目は根拠となる発話IDへ解決できなければならない。AI提案と人間が確定した内容を区別し、人間が確定した内容を自動分析が無断で上書きしてはならない。

## Input boundary

入力はadapterを介して取り込む。合成デモadapterは公開UI reviewに使用できる。実会議adapterはWindowsローカルruntimeで動作し、既定では利用者が明示選択したTeamsライブキャプション矩形だけをmemory-only local OCRする。表示された発話者名はnative境界でsession-only aliasへ置換する。OCRを利用できない場合だけ、利用者が診断と開始を別々に明示して、microphoneとTeams process限定application loopbackをlocal Whisperへ入力できる。capture、transcription、Teams、analysis、persistenceはUIとdomain modelから分離する。

画面または実音声の取得は利用者の明示操作と参加者同意を必要とする。OCR画像、TSV、raw表示名、生音声は永続化しない。字幕OCR失敗から音声captureへ自動切替してはならない。文字起こしと分析状態はGit working tree外へローカル保存できる。未保存sessionは会議終了時に削除し、保存sessionは利用者が保持期間と削除対象を確認できなければならない。OpenAI APIへは#3と#6の境界を通過したtextだけを送信できる。

実会議データを扱えるruntimeはpublic URLを持たず、local serverを使う場合はloopback interfaceだけへbindする。capture状態は`active`、`remote-audio-undetected`、`degraded-microphone-only`、`stopped`を区別して常時表示する。Teams process、audio stream、deviceの喪失時に正常動作を装ってはならない。

Microsoft Graph transcriptは会議終了後の照合にだけ使用でき、live mapの入力にはしない。Teams live captionsはDOMや画面全体を取得せず、利用者がTeams client内で選択した字幕矩形だけをOCRできる。選択範囲外、他app、chat、通知、参加者一覧へ拡張してはならない。Azure media botまたはHTTPS hosted meeting side panelを導入する場合は、local-only境界の変更と新しいADRを必要とする。

## Accessibility and resilience

主要な操作はキーボードで到達可能で、focusを視覚表示する。動きを減らすOS設定を尊重する。デモ入力の再生、一時停止、発話とマップの相互選択、mapの拡大縮小、根拠発話の確認を利用者が操作できる。
