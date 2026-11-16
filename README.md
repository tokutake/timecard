# timecard

Cloudflare Workers + D1 で動く勤怠記録システム。出勤・退勤のボタンを押すと記録され、月ごとの一覧と合計実働時間を確認できます。時刻は日本時間（Asia/Tokyo）で表示されます。

## 構成

- `src/index.js` — Worker（API とページ配信）
- `src/page.js` — フロントエンド（単一HTML）
- `migrations/0001_init.sql` — D1 のスキーマ
- `wrangler.toml` — Worker と D1 の設定

## API

| Method | Path | 内容 |
|---|---|---|
| GET | `/api/me` | ログイン中の利用者 |
| GET | `/api/status` | 自分が出勤中かどうか |
| POST | `/api/clock-in` | 出勤 |
| POST | `/api/clock-out` | 退勤 |
| GET | `/api/records?month=YYYY-MM` | 指定月の記録一覧 |
| DELETE | `/api/records/:id` | 記録の削除 |

## 認証と利用者ごとの分離

ログインは Cloudflare Access が行い、Worker はその JWT を検証してメールアドレスを取り出します。

- 利用者は `users` テーブルに、初回アクセス時に自動登録されます（メールアドレスで一意）。
- 記録（`records.user_id`）は利用者ごとに分かれ、打刻・一覧・削除はすべて本人の記録に限定されます。
- Worker は `Cf-Access-Jwt-Assertion` の署名・発行元（iss）・対象（aud）・有効期限を検証します。Access を通らずに Worker を直接叩かれても、署名が無ければ拒否されます。
- 既存の記録（マイグレーション 0002 より前のもの）は `user_id` が空のため、どの利用者からも見えません。

`CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` は `wrangler.toml` の `[vars]` に書きます。Cloudflare の Zero Trust で Access アプリを作成し、その AUD と Team ドメインを設定してください。許可するメールアドレスは Access のポリシーで管理します。

## ローカル開発

```sh
npm install
npm run db:migrate:local
cp .dev.vars.example .dev.vars   # DEV_USER_EMAIL を自分のメールアドレスに書き換える（git 管理外）
npm run dev        # http://localhost:8787

`DEV_USER_EMAIL` は localhost / 127.0.0.1 でのみ使われます。本番では設定しないでください。
```

## セットアップ（Cloudflare）

```sh
npx wrangler login
npx wrangler d1 create timecard
# 出力された database_id を wrangler.toml の REPLACE_WITH_YOUR_D1_DATABASE_ID に貼り付ける
# wrangler.toml の CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD を設定してから
npm run db:migrate:remote
npm run deploy
```

## 注意

- 誰がログインできるかは Cloudflare Access のポリシーで決まります。Worker 側では制限していません。
- Access の設定を忘れると、`CF_ACCESS_TEAM_DOMAIN` が未設定のため API はすべて 500 を返します（閉じた状態で失敗します）。
