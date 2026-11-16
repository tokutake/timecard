export const PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>勤怠記録</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#6b7280; --line:#e5e7eb;
          --in:#2563eb; --out:#dc2626; --radius:12px; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --card:#181b22; --text:#e6e8ec; --muted:#9aa3b2; --line:#2a2f3a; }
  }
  [hidden] { display: none !important; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  .header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 8px 0 16px; }
  h1 { font-size: 20px; margin: 0; }
  .me { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
          padding: 20px; margin-bottom: 16px; }
  .clock { font-size: 36px; font-variant-numeric: tabular-nums; text-align: center; margin: 0; }
  .status { text-align: center; color: var(--muted); margin: 6px 0 18px; min-height: 1.4em; }
  .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  button { font: inherit; font-size: 18px; font-weight: 600; color: #fff; border: 0;
           border-radius: var(--radius); padding: 16px; cursor: pointer; }
  button:disabled { opacity: .35; cursor: not-allowed; }
  #btn-in { background: var(--in); }
  #btn-out { background: var(--out); }
  .btn-sub { display: inline-block; text-decoration: none; white-space: nowrap; color: var(--muted);
             font-size: 14px; font-weight: 500; padding: 6px 10px; border: 1px solid var(--line);
             border-radius: 8px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  input[type=month] { font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--line);
                      background: var(--card); color: var(--text); }
  .total { font-size: 18px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
  th, td { text-align: left; padding: 10px 6px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .del { background: none; color: var(--out); font-size: 13px; padding: 4px 8px; border: 1px solid var(--line);
         border-radius: 8px; font-weight: 500; }
  .empty { color: var(--muted); text-align: center; padding: 16px 0; }
  .err { color: var(--out); text-align: center; min-height: 1.2em; margin-top: 10px; font-size: 14px; }
</style>
</head>
<body>
<main>
  <div class="header">
    <h1>勤怠記録</h1>
    <div class="row">
      <span class="me" id="me"></span>
      <a class="btn-sub" href="/cdn-cgi/access/logout">ログアウト</a>
    </div>
  </div>

  <section class="card">
    <p class="clock" id="clock">--:--:--</p>
    <p class="status" id="status">読み込み中…</p>
    <div class="buttons">
      <button id="btn-in" disabled>出勤</button>
      <button id="btn-out" disabled>退勤</button>
    </div>
    <div class="err" id="err"></div>
  </section>

  <section class="card">
    <div class="row">
      <input type="month" id="month">
      <div class="total">合計 <span id="total">0:00</span></div>
    </div>
    <table>
      <thead><tr><th>日付</th><th>出勤</th><th>退勤</th><th class="num">実働</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty" hidden>記録がありません</div>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const TZ = 'Asia/Tokyo';
const fmtTime = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, month: '2-digit', day: '2-digit', weekday: 'short' });
const fmtClock = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function nowJstMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  return y + '-' + m;
}

function hm(ms) {
  const mins = Math.floor(ms / 60000);
  return Math.floor(mins / 60) + ':' + String(mins % 60).padStart(2, '0');
}

function showErr(msg) { $('err').textContent = msg || ''; }

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('エラー (' + res.status + ')'));
  return body;
}

async function loadMe() {
  const me = await api('/api/me');
  $('me').textContent = me.email;
}

async function loadStatus() {
  const status = await api('/api/status');
  $('btn-in').disabled = status.working;
  $('btn-out').disabled = !status.working;
  $('status').textContent = status.working
    ? '出勤中（' + fmtTime.format(new Date(status.since)) + ' 〜）'
    : '未出勤';
}

async function loadRecords() {
  const month = $('month').value;
  const { records } = await api('/api/records?month=' + encodeURIComponent(month));
  const tbody = $('rows');
  tbody.innerHTML = '';
  let total = 0;
  for (const r of records) {
    const inMs = new Date(r.clock_in);
    const outMs = r.clock_out ? new Date(r.clock_out) : null;
    const dur = outMs ? outMs - inMs : null;
    if (dur) total += dur;
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + fmtDate.format(inMs) + '</td>' +
      '<td>' + fmtTime.format(inMs) + '</td>' +
      '<td>' + (outMs ? fmtTime.format(outMs) : '<span style="color:var(--muted)">勤務中</span>') + '</td>' +
      '<td class="num">' + (dur !== null ? hm(dur) : '-') + '</td>' +
      '<td class="num"><button class="del" data-id="' + r.id + '">削除</button></td>';
    tbody.appendChild(tr);
  }
  $('total').textContent = hm(total);
  $('empty').hidden = records.length > 0;
}

async function clock(kind) {
  showErr('');
  $('btn-in').disabled = $('btn-out').disabled = true;
  try {
    await api('/api/' + kind, { method: 'POST' });
  } catch (e) {
    showErr(e.message);
  }
  await refresh();
}

async function refresh() {
  try {
    await loadMe();
    await loadStatus();
    await loadRecords();
  } catch (e) {
    showErr(e.message);
  }
}

$('btn-in').addEventListener('click', () => clock('clock-in'));
$('btn-out').addEventListener('click', () => clock('clock-out'));
$('month').addEventListener('change', () => loadRecords().catch(e => showErr(e.message)));
$('rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button.del');
  if (!btn) return;
  if (!confirm('この記録を削除しますか？')) return;
  try {
    await api('/api/records/' + btn.dataset.id, { method: 'DELETE' });
    await loadRecords();
  } catch (err) {
    showErr(err.message);
  }
});

$('month').value = nowJstMonth();
setInterval(() => { $('clock').textContent = fmtClock.format(new Date()); }, 1000);
$('clock').textContent = fmtClock.format(new Date());
refresh();
</script>
</body>
</html>`;
