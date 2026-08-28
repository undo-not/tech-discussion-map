# Zoom RTMS transcript source specification

## Scope and prerequisites

Zoom Realtime Media Streams（RTMS）のmeeting transcriptだけを入力源として扱う。音声、映像、画面共有、chatは購読しない。利用にはZoom Developer Pack credits、user-managed General App、`meeting:read:meeting_transcript` scope、`meeting.rtms_started`／`meeting.rtms_interrupted`／`meeting.rtms_stopped` event subscription、会議側のrealtime content permissionが必要である。Meeting SDKをAI notetakerとして利用しない。

Zoomのsigned webhookには公開到達可能なHTTPS URLが必要なため、利用者が承認した一時tunnelを専用listener `127.0.0.1:43118/zoom/webhook`だけへ転送する。アプリはtunnel、Marketplace設定、DNS、firewall変更を自動作成しない。通常のbrowser APIは別listener `127.0.0.1:43117`に残し、公開tunnelへ向けてはならない。

公式protocolの根拠は[transcript WebSocket quickstart](https://developers.zoom.us/docs/rtms/meetings/quickstart-websockets/)、[media protocol](https://developers.zoom.us/docs/rtms/meetings/media/)、[failover](https://developers.zoom.us/docs/rtms/meetings/failover-reconnection/)、[RTMS webhook reference](https://developers.zoom.us/docs/api/rtms/events/)である。

## Credential boundary

Client ID、Client Secret、Webhook Secret Tokenは各PCのWindows Credential Managerへ保存する。setupはconsole echoを無効化し、`.env`、command line、browser、Node output、配布ZIP、Git working treeへ値を置かない。statusは3項目が揃っているかだけを返す。

Client handshakeはnative helperがframed stdinからboundedな`meeting_uuid`と`rtms_stream_id`だけを受け取り、Credential Manager内のClient IDを加えてHMAC-SHA256を返す。Webhook verificationはtimestamp、受信signature、raw bodyをnative helperへ渡し、helper内で期待値を計算してconstant-time比較し、booleanだけを返す。汎用Webhook HMAC機能は公開しない。`endpoint.url_validation`だけはboundedな`plainToken`に対する専用commandで`encryptedToken`を返す。

## Arming and connection state

1. 全参加者の同意recordが存在し、利用者が`Zoom RTMSを待機`を押した場合だけ1 sessionをarmする。
2. armは15分で失効し、最初の署名済み`meeting.rtms_started`に一度だけbindする。未arm時のstarted eventはIDを保持せず`not-armed`で応答する。
3. Webhook signatureはraw bodyに対する`v0:{timestamp}:{body}`を検証し、ローカル時計との差が5分を超えるrequestをrejectする。Zoomは標準replay windowを規定していないため、5分は本アプリのfail-closed policyである。
4. Signaling WebSocketではmessage type 1、media server response type 2を扱う。Transcript media WebSocketにはprotocol v1、sequence 0、`media_type: 8`だけをrequestし、成功後にsignaling socketへtype 7 ACKを返す。type 12 keepaliveにはtype 13で応答する。
5. signaling URLとhandshakeで返るtranscript URLの両方を接続直前に検査する。`wss:`、default/443 port、credentialなし、fragmentなし、bounded path、`zoom.us`またはそのdot-suffixだけを許可し、候補の一つでも外れればfail closedする。Zoomはproduction RTMS hostname一覧を保証していないため、実会議受入時に公式配信hostnameとの適合を確認し、例外を広いwildcardで回避しない。
6. `meeting.rtms_interrupted`はbound済みstreamだけに適用し、新しいserver URLが含まれる場合は同じ検査後に再接続する。自動再接続で復旧できない場合はdegradedを表示し、別会議へ自動bindしない。

## Transcript and identity boundary

type 17 packetはexact key、型、8,000文字、speaker上限、24時間のsession-relative時刻を検査する。Zoomのabsolute epoch millisecondsはcompanion内の最初の発話時刻から差し引き、browserや保存sessionへ渡さない。重複packetはbounded digest setで除外し、順序は既存utterance reducerが安定化する。

`user_id`と`user_name`はZoom WebSocketを所有するNode memoryを一時通過するが、packet処理中にだけ参照する。`user_id`はsession salt付きdigestをkeyとするmapで`speaker-1`から`speaker-999`へ変換し、raw ID、raw name、meeting UUID、stream ID、server URLをevent ring、browser、DPAPI session、logへ入れない。browser-facing eventはexact output schemaで再検証する。256 eventsを消費できない場合は古い会話を黙ってdropせず、bufferを消去してdegradedへfail closedする。stopはsocket、alias、dedup、未配信eventを消去する。

## Network and data lifecycle

Zoomへのruntime egressはnative Node WebSocketによるRTMS transcript socketだけである。Zoomからlocal listenerへのmetadata webhookは利用者の一時HTTPS tunnelを経由する。Tunnel公開中は署名検証前の専用portがInternetに到達可能となり、RTMS serverにはlocal public IPが見える。listenerは1 POST routeだけを持ち、CORSを返さず、browser bearer routesを共存させない。

Transcriptが既存OpenAI分析へ進む条件は他入力と同じで、外部分析gate、最小window、local redaction、`store:false`が必要である。ローカル保存も明示opt-in時だけDPAPI経路を使う。Zoom credential、raw webhook、raw RTMS packet、raw identityは保存対象ではない。

## Verification boundary

CIは合成credential runnerとFake WebSocketでsignature rejection、one-shot arm、2段URL allowlist、handshake sequence、transcript-only media type、keepalive、aliasing、epoch normalization、dedup、専用Webhook route、CORS不在、停止時消去を検証する。実Zoom会議の受入は全参加者同意済みの別PCで行い、hostname互換性、遅延、日本語精度、話者対応、interruption recoveryを確認する。会話本文、参加者名、meeting ID、credential、tunnel URLをIssue／PR evidenceへ貼らない。
