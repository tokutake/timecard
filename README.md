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
| POST | `/api/register` | 新規登録（`{"email", "password"}`） |
| POST | `/api/login` | ログイン |
| POST | `/api/logout` | ログアウト |
| GET | `/api/me` | ログイン中の利用者 |
| GET | `/api/status` | 自分が出勤中かどうか |
| POST | `/api/clock-in` | 出勤 |
| POST | `/api/clock-out` | 退勤 |
| GET | `/api/records?month=YYYY-MM` | 指定月の記録一覧 |
| DELETE | `/api/records/:id` | 記録の削除 |

## 認証と利用者ごとの分離

メールアドレスとパスワードで、アプリ内に登録・ログインします。外部サービスの設定は不要です。

- パスワードは PBKDF2-SHA256（ランダムな salt、10 万回）でハッシュ化して保存します。
- ログイン成功時にランダムなセッショントークンを発行し、Cookie（HttpOnly、30 日）に保存します。DB にはトークンのハッシュだけを保存します。
- 5 回連続で失敗すると、そのアカウントは 15 分間ログインできなくなります。
- 記録（`records.user_id`）は利用者ごとに分かれ、打刻・一覧・削除はすべて本人の記録に限定されます。

パスワードは 8 文字以上 128 文字以下です。

## ローカル開発

```sh
npm install
npm run db:migrate:local
npm run dev        # http://localhost:8787（画面で登録してから利用）
```

## セットアップ（Cloudflare）

```sh
npx wrangler login
npx wrangler d1 create timecard
# 出力された database_id を wrangler.toml の REPLACE_WITH_YOUR_D1_DATABASE_ID に貼り付ける
npm run db:migrate:remote
npm run deploy
```

## 注意

- 誰でも登録できます。不特定多数に公開する場合は、登録の制限（招待制など）を別途検討してください。
- 登録時に「登録済み」と表示されるため、メールアドレスが登録済みかどうかは分かります。
