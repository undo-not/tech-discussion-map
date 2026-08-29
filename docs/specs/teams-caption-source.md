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

OCR observationは`confidence`と`stableSamples`のどちらか一方だけを必須とする。confidenceを提供するengineでは`confidence >= 85`、提供しないengineでは`stableSamples >= 2`の場合だけ発話を生成する。低品質の観測はassemblerから`low-confidence` signalを返すだけでsource stateを書き換えず、session ownerが明示的にdegradedへ遷移させる。一般contractでは回復時に`quality-recovered` transitionを先に適用し、観測だけでactiveへ戻さない。MVPのnative Tesseract sourceは低confidenceでworkerを終了するため、自動回復せず、利用者が再開して字幕矩形を再選択する。`Windows.Media.Ocr`の公開結果にはconfidenceがないため、採用する場合は後者を使う。

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

OCR adapterはWindowsローカルcompanionからだけ起動する。全参加者同意のcheckbox、[Teams MVP support checklist](teams-mvp-support.md)、開始buttonを経て、foregroundのTeams client areaに限定したoverlayで利用者が現在発話者の一caption cardだけをdragするまでpixelを取得しない。helperは親processが`node.exe`で、stdin/stdoutがpipeであり、companionがcommand lineとstdinへ渡す同一の一回限り証明を2秒以内に検証できた場合だけ起動する。証明64 byteを読み終えた正常なbroken-pipeは末尾byteなしとして受理し、それ以外のpipe errorと追加byteは拒否する。通常のterminal直接実行はcapture前に拒否する。

- physical pixel矩形はTeams client bounds内に完全包含し、最大2,560 × 720、BGRA 8 MiBとする。共通部分だけへの暗黙cropはしない。
- 各frameでvisible、foreground、非最小化、DPI不変、矩形の四隅・中央が同じ`ms-teams.exe` processに属することを確認する。外れた場合はpixelを取得せずdegradedへ遷移する。
- Teams window全体やscreen全体のbitmapは作らない。選択矩形寸法のmemory DCへ対象windowをclip描画する。provider hangは、継承handleをstdin/stdout/stderrだけに限定し、最小環境とJob Objectを持つ使い捨てframe workerを2秒で終了する。overlay選択も60秒で終了する。
- bitmapは最大8 MiB、Tesseract TSVは最大512 KiB、framed eventは最大64 KiB、cadenceは最大2 frame/秒とする。
- bitmap、OCR intermediate、raw speaker display nameをfile、clipboard、log、networkへ出さない。字幕行が`表示名: 発話`または`表示名：発話`として一つだけ明確に分離できた場合だけ、native adapter内でprefixをsession-only aliasへ変換する。speaker/body境界がない行や本文に二つ目のcolonがある行は表示名混入の可能性があるため、推測せず行全体をdropする。`Anonymous`／`Speaker`／`匿名`／`話者`の固定labelだけは`anonymous`へ正規化する。session内で999名を超えた場合は本文を保持したまま`unknown`とし、新しいraw名をtableへ保持しない。
- Teamsが話者名と本文を別OCR行に描画する場合は、現在のparserは発話をdropする。複数行を位置だけで推測結合すると別参加者名を本文として漏らす可能性があるため、実会議でcaption card geometryを確認しprivacy-safe contractを追加するまでsupport外とする。
- Tesseract 5.5.3、`jpn`、`eng`はsetup時とsession開始時にSHA-256検証する。PATH探索とruntime downloadをしない。
- Tesseractは`stdin`からmemory BMPを読み、`stdout`へTSVを返す。Job Object、process数1、512 MiB、5秒timeout、512 KiB stdout上限を適用する。
- Tesseract confidence 85以上かつ同じspeaker/textを2 frame連続観測した場合だけobservationを送る。confidence不足、speaker/text分割不能、複数行の対応不明を推測で埋めない。
- pauseとstopはcapture processを停止し、companionが未配信eventとparser bufferを破棄する。resumeはpaused sessionに一度だけ許可し、古い矩形を再利用せず、利用者が再選択する。

NativeからcompanionへはWindows CRTのbinary stdoutを使い、`TMO1` version 1、type 1のUTF-8 JSON frameだけを送る。frame workerのBMP stdoutもbinary modeとする。eventは`state`、alias済み`observation`、`row-disappeared`、`tick`に限定し、画像、座標、寸法、PID、window title、raw display name、TSVを含めない。companionとbrowser adapterはexact-key schemaを再検証する。proof stdinがworkerの早期終了で`EPIPE`になってもcompanion全体を終了させず、そのcaption sessionだけをfail closed停止する。

## Automated evidence

- 合成caption observationsでrewrite、duplicate、out-of-order、settle、row disappearance、corrected final、anonymous speakerを検証する。
- raw display nameがalias boundaryを通過できないことをschema testで検証する。
- CIはWindows helperをbuildし、content-free `contract` commandだけを実行する。CIでTeamsやscreen contentへアクセスしない。
