# Teams caption source capability specification

## Probe modes

`techmap-captions probe`はTeams processとvisible top-level windowの存在をworker内で確認し、各top-level windowからUI Automation rootを取得できるかだけをcontent-freeに確認する。次の情報だけをJSONで返す。

- fixed contract version and state;
- fixed state (`candidate-found`、`teams-not-found`、`teams-window-not-found`、`uia-unavailable`、`probe-timeout`、`probe-failed`、`helper-launch-failed`のいずれか);
- `contentInspected: false`, `contentEmitted: false`, `contentPersisted: false`.

window title、PID、Automation `Name`、`Value`、`TextPattern`、座標、文字列hashは返さず、UIA subtreeを走査しない。`candidate-found`は字幕取得成功ではなく、TeamsのUIA root候補が見つかったことだけを意味する。すべてのUIA callはstdoutを持たない使い捨てworker process内で実行し、親processが5秒で強制終了して固定の`probe-timeout` metadataだけを返す。companionはこれを`degraded-caption-missing`として扱う。

`probe-at-cursor --consent-confirmed`は利用者が現在指している1要素だけを調べる。対象process imageが`ms-teams.exe`でない場合は失敗する。文字列はworker memory内で有無と上限内かを確認して消去し、親processへはexit codeのbit flagだけを返す。内容、正確な長さ、hashをstdout/stderr/fileへ出さない。workerが応答しない場合も5秒で終了する。これは本人のみの合成テスト会議または全参加者が同意したテストでのみ実行する。

## Caption event contract

UIA/OCR adapterはraw participant display nameを渡さず、session-only alias後の`SafeCaptionObservation`だけをdomainへ渡す。

- `rowId`: 1 session内でappearanceごとに一意なopaque ID。UI virtualizationで同じelementが別行へ再利用された場合は新しいIDにする。
- `revision`: 同じ行のrewriteごとに単調増加する整数。
- `source`: `teams-uia`または`teams-ocr`。
- `speaker`: `self`、`displayed-alias`、`anonymous`、`unknown`。
- `speakerAlias`: `displayed-alias`の場合だけ`speaker-1`から`speaker-999`。
- `observedAtMs`: session開始からの単調時刻。
- `text`: 1文字以上8,000文字以下。
- `confidence`: confidenceを提供するOCR engineだけ0から100の整数。85以上を受け入れる。
- `stableSamples`: confidenceを提供しないOCR engineだけ、同一speaker/textを連続観測した回数。2回以上を受け入れる。

OCR observationは`confidence`と`stableSamples`のどちらか一方だけを必須とする。confidenceを提供するengineでは`confidence >= 85`、提供しないengineでは`stableSamples >= 2`の場合だけ発話を生成する。低品質の観測はassemblerから`low-confidence` signalを返すだけでsource stateを書き換えず、session ownerが明示的にdegradedへ遷移させる。回復時も`quality-recovered` transitionを先に適用し、観測だけでactiveへ戻さない。`Windows.Media.Ocr`の公開結果にはconfidenceがないため、採用する場合は後者を使う。

最初の観測とrewriteはpartialを生成する。1,200 ms更新がない、または行消失を観測したときfinalを生成する。確定後により高いrevisionが届いた場合はcorrected finalとして明示的に生成し、既存のtranscript contractが分析訂正eventとして保持する。同一以下のrevisionは無視する。

## Session states

- `idle`
- `awaiting-consent`
- `selecting-target`
- `active-uia`
- `active-ocr`
- `degraded-caption-missing`
- `degraded-low-confidence`
- `stopped`

UIA/OCRは`awaiting-consent`から利用者の同意確認を経て`selecting-target`へ進んだ場合だけactiveになれる。assemblerは選択済みactive sourceと一致する観測だけを受け入れ、観測自体によるactivation、source切替、degradedからの自動復帰を許可しない。UIAからOCRへの切替はcaption missing後の利用者操作を必要とする。音声＋Whisperへの切替はこのstate machine外のMVP入力mode選択で別途明示する。

## Local OCR runtime

OCR adapterはWindowsローカルcompanionからだけ起動する。全参加者同意のcheckboxと開始buttonを経て、foregroundのTeams client areaに限定したoverlayで利用者が字幕矩形をdragするまでpixelを取得しない。helper stdoutがanonymous pipeでない直接CLI実行もcapture前に拒否する。

- physical pixel矩形はTeams client bounds内に完全包含し、最大2,560 × 720、BGRA 8 MiBとする。共通部分だけへの暗黙cropはしない。
- 各frameでvisible、foreground、非最小化、DPI不変、矩形の四隅・中央が同じ`ms-teams.exe` processに属することを確認する。外れた場合はpixelを取得せずdegradedへ遷移する。
- Teams window全体やscreen全体のbitmapは作らない。選択矩形寸法のmemory DCへ対象windowをclip描画する。provider hangは使い捨てframe workerを2秒で終了する。
- bitmapは最大8 MiB、Tesseract TSVは最大512 KiB、framed eventは最大64 KiB、cadenceは最大2 frame/秒とする。
- bitmap、OCR intermediate、raw speaker display nameをfile、clipboard、log、networkへ出さない。字幕行が`表示名: 発話`または`表示名：発話`の形で得られた場合も、native adapter内でprefixを分離してsession-only aliasへ変換し、`text`へ表示名を残さない。
- Tesseract 5.5.3、`jpn`、`eng`はsetup時とsession開始時にSHA-256検証する。PATH探索とruntime downloadをしない。
- Tesseractは`stdin`からmemory BMPを読み、`stdout`へTSVを返す。Job Object、process数1、512 MiB、5秒timeout、512 KiB stdout上限を適用する。
- Tesseract confidence 85以上かつ同じspeaker/textを2 frame連続観測した場合だけobservationを送る。confidence不足、speaker/text分割不能、複数行の対応不明を推測で埋めない。
- pauseはcapture processを停止してbufferを破棄する。resumeでは古い矩形を再利用せず、利用者が再選択する。

Nativeからcompanionへは`TMO1` version 1、type 1のUTF-8 JSON frameだけを送る。eventは`state`、alias済み`observation`、`row-disappeared`、`tick`に限定し、画像、座標、寸法、PID、window title、raw display name、TSVを含めない。companionとbrowser adapterはexact-key schemaを再検証する。

## Automated evidence

- 合成caption observationsでrewrite、duplicate、out-of-order、settle、row disappearance、corrected final、anonymous speakerを検証する。
- raw display nameがalias boundaryを通過できないことをschema testで検証する。
- CIはWindows helperをbuildし、content-free `contract` commandだけを実行する。CIでTeamsやscreen contentへアクセスしない。
