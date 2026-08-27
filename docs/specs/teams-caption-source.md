# Teams caption source capability specification

## Probe modes

`techmap-captions probe`はTeams processとvisible top-level windowを数え、各top-level windowからUI Automation rootを取得できるかだけをcontent-freeに確認する。次の情報だけをJSONで返す。

- fixed contract version and state;
- process/window/UIA root counts;
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

OCR observationは`confidence >= 85`または`stableSamples >= 2`のどちらかを満たす場合だけ発話を生成する。`Windows.Media.Ocr`の公開結果にはconfidenceがないため、採用する場合は後者を使う。

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

UIA/OCRは`awaiting-consent`から利用者の同意確認を経て`selecting-target`へ進んだ場合だけactiveになれる。UIAからOCRへの切替はcaption missing後の利用者操作を必要とする。音声＋Whisperへの切替はこのstate machine外のMVP入力mode選択で別途明示する。

## OCR boundary reserved by this spike

OCR adapterはまだ有効化しない。実装時は次を満たす。

- 利用者が選んだphysical pixel矩形をDPI-aware座標で固定し、Teams window client boundsとの共通部分だけを取得する。
- Teams windowが最小化、遮蔽、移動、DPI変更、対象外processになった場合はcaptureせずdegradedへ遷移する。
- bitmap、OCR intermediate、raw speaker display nameをfile、clipboard、log、networkへ出さない。
- 日本語language packのavailabilityを開始前に検出し、自動downloadしない。
- confidence／連続安定性不足、speaker/text分割不能、複数行の対応不明を推測で埋めない。

## Automated evidence

- 合成caption observationsでrewrite、duplicate、out-of-order、settle、row disappearance、corrected final、anonymous speakerを検証する。
- raw display nameがalias boundaryを通過できないことをschema testで検証する。
- CIはWindows helperをbuildし、content-free `contract` commandだけを実行する。CIでTeamsやscreen contentへアクセスしない。
