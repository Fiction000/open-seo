# seo.katot.dev のコード専用デプロイ

## 起動条件

`Fiction000/open-seo` の main push に対する既存 `CI` が成功すると、`Selfhost production` が起動する。`ci` と `docker-build` の成功を対象 SHA で再確認し、selfhost 用テスト、ビルド、オフライン dry-run が通ってから deploy job に進む。

PR イベントでは資格情報なしの checks だけを実行する。`workflow_dispatch` は main だけで利用でき、同じ SHA の成功済み push CI が必要。checkout は SHA に固定し、更新操作ごとに現在の `origin/main` と照合する。

JST の `[06:10, 07:25)` と `[16:30, 17:30)` は更新しない。開始時刻を含み、終了時刻を含まない。最初の判定が禁止時間なら deploy job を skip する。直前判定で禁止時間に入った場合も upload と本番確認を skip する。helper 実行中に禁止時間へ入ると、次の更新前にエラーで止まる。

deploy job は `open-seo-selfhost-production` concurrency group で直列化し、実行中の job をキャンセルしない。GitHub の concurrency は待機 run 全件の保存や FIFO を保証しない。禁止時間外に main から手動実行できる。古い SHA は拒否する。

## 更新する範囲

対象は既存の `open-seo-selfhost-audit` と `open-seo-selfhost` のコードと static assets。Alchemy は CI で実行しない。state-store の認証値、暗号化パスワード、`.env.selfhost` の複製は不要。

各 Worker の Deployment API から100%稼働中の version を取得し、未反映の新しい version がないことを確認する。その version の全 bindings を、名前と `type: inherit`、`version_id` だけで引き継ぐ。`ASSETS` は新しいビルドへ差し替え、既存 selfhost の `runWorkerFirst` 設定を再利用する。

`DATAFORSEO_API_KEY`、`BETTER_AUTH_SECRET`、`OPENROUTER_API_KEY` などの secret、`TEAM_DOMAIN`、`POLICY_AUD`、`MCP_GATEWAY_*` などの vars と、D1/KV/R2/DO/Workflow/service/browser bindings を既存 version から引き継ぐ。値は config やログへ書かない。AUTH_MODE は `cloudflare_access` を要求し、クライアントも同じ mode で build する。任意の integration を新たに有効にする操作は含めない。

Wrangler `4.151.0` の `versions upload` で2つの version を先に作り、Deployment API で audit、app の順に100%へ切り替える。各切替後に Deployment API を読戻す。app の placement は既存 selfhost の `smart`、compatibility date/flags と limits は source version の値を使う。

### domain / Access / routes に触らない根拠

生成する Wrangler config は元の `wrangler.jsonc` を読み込まず、`routes`、custom domain、Access、cron、D1 migration、DO migration、Workflow provisioning の宣言を持たない。`wrangler deploy` や `triggers deploy` も使わない。

Wrangler の upload 経路は、assets upload session と Worker version upload を扱う。固定した `4.151.0` の `versionsUpload` は `POST /workers/scripts/.../versions?bindings_inherit=strict` を使用し、route/domain/Access の同期は行わない。`unsafe.bindings` から生成される実 multipart で、全 inherit binding の `version_id` が残ることを `offline-plan.mjs` が検査する。

helper 自身の API wrapper は、対象2 Workerの deployments/versions の GET と deployments の POST だけを許可する。この allowlist は Wrangler 内部の全 HTTP を監視するものではないため、Wrangler の固定版の実装検査と、domain/routes/Access 書込み権限のない専用 token を組み合わせる。

## D1 とインフラ変更

**D1 migration は CI では実行しない。** DO migration と Workflow の作成・変更も行わない。`drizzle/sqlite`、`deploy/alchemy`、`wrangler.jsonc`、`wrangler.audit.jsonc` の fingerprint が baseline と異なる場合は、更新前に止まる。

baseline はコード変更の検出用であり、本番 DB が同じ schema であることの証明にはならない。初回利用前には、本番への必要な migration と既存 bindings の整合を別途確認する。以後の schema / infrastructure 変更も、たつひこさんの OK を得た手動反映後に baseline 更新をレビューする。hash を合わせるだけでガードを解除しない。

新たな DO/Workflow export や binding が必要な変更は、この経路だけでは反映できない。Cloudflare の upload validation が失敗した場合も、token 権限を自動で拡張しない。

## 必要な repository secrets

この実装作業では作成・登録していない。初回利用前に、たつひこさんの OK と専用資格情報の準備が必要。

| 名前                              | 用途                                                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`            | 上記2 Workerの version/assets upload と deployment/readback。対象 Worker に絞る。zone/route/domain/Access 書込み、D1 data、token 管理権限を付けない。readwiser 専用 token は流用しない。 |
| `CLOUDFLARE_ACCOUNT_ID`           | 対象 Cloudflare account の選択。                                                                                                                                                         |
| `CLOUDFLARE_ACCESS_CLIENT_ID`     | 本番 root の GET に使う open-seo 専用 Access service token の ID。                                                                                                                       |
| `CLOUDFLARE_ACCESS_CLIENT_SECRET` | 同 service token の secret。Service Auth policy の接続先は seo.katot.dev の Access app だけとする。                                                                                      |

Worker の実際の名前は `open-seo-selfhost` と `open-seo-selfhost-audit`。token の対象を upstream の `open-seo` / `open-seo-audit` と取り違えない。4つの secret が揃わない場合は更新を始めない。

Access token を用いた root GET がアプリの認証条件も満たすかは、資格情報準備後に read-only で確認する。Service Auth の設定だけで root の200を保証した扱いにしない。owner 用 Allow policy は維持する。

## 本番確認と失敗時

反映後に `https://seo.katot.dev/` を Access service token のヘッダー付きで GET する。redirect は追わず、HTTP 200 だけを成功とする。ログイン画面への302、403、5xx、通信エラーは失敗。レスポンス本文と資格情報はログに出さない。

2 Worker の切替は非 atomic。audit 成功後の app 失敗や、反映後の本番確認失敗に対する自動 rollback は実装しない。upload だけ成功して止まると pending version が残り、次回は自動で先へ進まない。状態を読取り、たつひこさんへ報告して、手動解決の OK を待つ。

CI は Alchemy state を更新しない。後日 Alchemy で手動反映する場合は、最新コードと本番状態に対する plan を確認し、CI の変更を意図せず上書きしないようにする。

## ローカル検証

```bash
node --test scripts/selfhost-ci/*.test.mjs
pnpm build:report-widgets
AUTH_MODE=cloudflare_access VITE_SHOW_DEVTOOLS=false pnpm vite build --mode selfhost
pnpm exec tsc --noEmit
node scripts/selfhost-ci/offline-plan.mjs
```

Node `24.12.0` と lockfile の Wrangler `4.151.0` を使用する。offline-plan は合成 metadata と実ビルドを使うローカル検査で、本番 state の観測、token の権限確認、実 deploy の成功を証明しない。資格情報が揃った後の `deploy-runtime.mjs --plan` は remote state の読取りとローカル dry-run を行い、反映はしない。

既存 `scripts/selfhost-deploy-preflight.mjs` には TEAM_DOMAIN/POLICY_AUD を設定すれば Access を provision しないという説明があるが、現在の `alchemy.selfhost.ts` は selfhost Access Application/Policy を明示的に管理する。CI はその説明に依存せず、Alchemy 経路を避けている。
