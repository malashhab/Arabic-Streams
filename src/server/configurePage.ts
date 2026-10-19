import type { CatalogDef } from "../catalogs/definitions.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Logo shown on the settings page and in the manifest (simple SVG, no external assets). */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs><rect width="256" height="256" rx="56" fill="url(#g)"/><text x="128" y="172" font-size="150" font-family="Arial,Tahoma,sans-serif" font-weight="700" text-anchor="middle" fill="#fff">ع</text><path d="M72 206h112" stroke="#fde68a" stroke-width="10" stroke-linecap="round"/></svg>`;

/** Settings page: bilingual, dark, mobile friendly. It posts to /api/config, which returns the personal (encrypted) install URL. */
export function configurePage(catalogs: CatalogDef[]): string {
  const group = (title: string, items: CatalogDef[]) =>
    items.length === 0
      ? ""
      : `<div class="grp"><h4>${esc(title)}</h4>${items
          .map((c) => `<label class="chk"><input type="checkbox" name="cat" value="${esc(c.id)}" checked><span>${esc(c.name)}</span></label>`)
          .join("")}</div>`;
  const catHtml = [
    group("Series · مسلسلات", catalogs.filter((c) => c.type === "series")),
    group("Movies · أفلام", catalogs.filter((c) => c.type === "movie")),
  ].join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arabic Movies &amp; Series - Settings</title>
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<style>
  :root{color-scheme:dark;--bg:#0b1220;--card:#121b2e;--line:#22304a;--txt:#e6edf7;--mut:#8fa1bd;--acc:#14b8a6;--acc2:#0f766e;--warn:#f59e0b;--bad:#f87171;--ok:#34d399}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 50% -200px,#12325a55,transparent),var(--bg);color:var(--txt);font:16px/1.55 system-ui,"Segoe UI",Tahoma,sans-serif}
  .wrap{max-width:720px;margin:0 auto;padding:24px 16px 80px}
  header{display:flex;gap:16px;align-items:center;margin-bottom:8px}
  header img{width:64px;height:64px;border-radius:16px}
  h1{margin:0;font-size:1.6rem} .sub{color:var(--mut);margin:2px 0 0}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:16px 0}
  .card h2{margin:0 0 4px;font-size:1.05rem} .card p.hint{margin:0 0 12px;color:var(--mut);font-size:.9rem}
  label.f{display:block;margin:10px 0 4px;font-size:.9rem;color:var(--mut)}
  .in{display:flex;gap:8px}
  input[type=text],input[type=url],input[type=password],select{width:100%;padding:11px 12px;background:#0d1627;color:var(--txt);border:1px solid var(--line);border-radius:10px;font-size:1rem}
  input:focus,select:focus{outline:2px solid var(--acc);border-color:transparent}
  button{font:inherit;cursor:pointer;border-radius:10px;border:1px solid var(--line);background:#16233b;color:var(--txt);padding:10px 14px}
  button:hover{border-color:var(--acc)}
  button.primary{background:linear-gradient(135deg,var(--acc),var(--acc2));border:0;font-weight:600;padding:13px 18px}
  .eye{flex:0 0 auto}
  .test{margin-top:8px;display:flex;gap:10px;align-items:center;font-size:.9rem}
  .res.ok{color:var(--ok)} .res.bad{color:var(--bad)}
  .chk{display:flex;gap:10px;align-items:flex-start;margin:6px 0;cursor:pointer}
  .chk input{margin-top:5px;accent-color:var(--acc)}
  .grp h4{margin:14px 0 4px;color:var(--mut);font-weight:600;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
  .note{border-left:3px solid var(--warn);background:#2a210d;padding:10px 12px;border-radius:6px;color:#f3d9a0;font-size:.9rem;margin:10px 0}
  .info{border-left:3px solid var(--acc);background:#0c2530;padding:10px 12px;border-radius:6px;color:#bfe9e4;font-size:.9rem;margin:10px 0}
  #out{display:none} #out code{display:block;word-break:break-all;background:#0d1627;border:1px solid var(--line);padding:10px;border-radius:8px;margin:8px 0;font-size:.85rem}
  #err{color:var(--bad);margin:10px 0 0}
  .actions{display:flex;gap:10px;flex-wrap:wrap}
  footer{color:var(--mut);font-size:.8rem;margin-top:28px}
  a{color:var(--acc)}
  [dir=rtl]{unicode-bidi:plaintext}
</style></head><body><div class="wrap">
<header><img src="/logo.svg" alt=""><div><h1>Arabic Movies &amp; Series <span dir="rtl">· أفلام ومسلسلات عربية</span></h1><p class="sub">Catalogs, Arabic search and debrid streams for Stremio &amp; Nuvio</p></div></header>

<form id="f" autocomplete="off">
<section class="card">
  <h2>1 · Where streams come from <span dir="rtl">· مصادر التشغيل</span></h2>
  <p class="hint">Catalogs and info work with no setup. To <b>play</b> something you need a debrid account <i>and</i> a release index.</p>
  <label class="f">Debrid service · خدمة الديبريد</label>
  <select name="debrid"><option value="none">None / لا شيء</option><option value="torbox">TorBox (recommended — confirms what is cached)</option><option value="realdebrid">Real-Debrid (cache cannot be checked)</option></select>
  <label class="f">Debrid API key · مفتاح الخدمة</label>
  <div class="in"><input type="password" name="debridKey" autocomplete="off" spellcheck="false"><button type="button" class="eye" data-eye="debridKey" title="Show / hide">👁</button></div>
  <div class="test"><button type="button" data-test="debrid">Test key</button><span class="res" id="r-debrid"></span></div>
  <label class="chk"><input type="checkbox" name="hidePacks" checked><span>Hide season packs that are not cached (they would download the whole season, 30-50 GB) · إخفاء الحزم الكاملة غير المخزّنة</span></label>
  <label class="chk"><input type="checkbox" name="showUncached" checked><span>Also list releases that are not confirmed cached · أظهر غير المخزّن مؤقتاً</span></label>

  <label class="chk"><input type="checkbox" name="allowPrivateUpload"><span>Also upload NOT-cached private-tracker torrents to my debrid (not recommended: it gives the debrid service your tracker key, usually stalls, and trackers often forbid it) · رفع غير المخزّن</span></label>

  <label class="f" style="margin-top:18px">Torznab URL (Prowlarr / Jackett, optional) · رابط الفهرس</label>
  <input type="url" name="torznabUrl" placeholder="https://your-server/api/v1/indexer/all/results/torznab" spellcheck="false">
  <label class="f">Torznab API key · مفتاح الفهرس</label>
  <div class="in"><input type="password" name="torznabKey" autocomplete="off" spellcheck="false"><button type="button" class="eye" data-eye="torznabKey" title="Show / hide">👁</button></div>
  <div class="test"><button type="button" data-test="torznab">Test index</button><span class="res" id="r-torznab"></span></div>
  <div class="info">Arabic releases are mostly on trackers that need an account. Add the trackers <b>you</b> have access to in your own Prowlarr/Jackett and paste its Torznab link here. This addon never logs in to sites for you.</div>
  <label class="chk"><input type="checkbox" name="torrentio"><span>Also search Torrentio (public addon, sends only the IMDb id) · تورنتيو</span></label>
  <label class="chk"><input type="checkbox" name="comet"><span>Also search Comet (public addon, sends only the IMDb id) · كوميت</span></label>
  <label class="chk"><input type="checkbox" name="internetArchive" checked><span>Include Internet Archive public files (no debrid needed) · أرشيف الإنترنت</span></label>
</section>

<section class="card">
  <h2>2 · Metadata <span dir="rtl">· البيانات</span></h2>
  <p class="hint">The server already has a TMDB key. Add your own only if you want to use yours.</p>
  <label class="f">TMDB API key or Read Access Token (optional)</label>
  <div class="in"><input type="password" name="tmdbReadToken" autocomplete="off" spellcheck="false"><button type="button" class="eye" data-eye="tmdbReadToken" title="Show / hide">👁</button></div>
  <label class="chk"><input type="checkbox" name="arabicOnly" checked><span>Arabic productions only in search · نتائج عربية فقط</span></label>
</section>

<section class="card">
  <h2>3 · Catalogs <span dir="rtl">· الكتالوجات</span></h2>
  <div class="row"><button type="button" id="all">Select all</button><button type="button" id="none">Select none</button></div>
  ${catHtml}
</section>

<div class="actions"><button type="submit" class="primary">Create install link · إنشاء رابط التثبيت</button></div>
<p id="err"></p>
</form>

<section class="card" id="out">
  <h2>Your install link <span dir="rtl">· رابطك</span></h2>
  <div class="actions"><button type="button" class="primary" id="stremio">Open in Stremio</button><button type="button" id="copy">Copy link</button></div>
  <code id="https"></code>
  <p class="hint">Nuvio and other Stremio-compatible apps: choose “add addon” and paste the link. Keep it private — it contains your encrypted settings.</p>
</section>
<footer>This addon does not host or distribute media. Posters and metadata: TMDB. Playback only through sources and accounts you configure.</footer>
</div>
<script>
const $ = (s, r = document) => r.querySelector(s);
const f = $("#f");
const val = (n) => f.elements[n].value.trim() || undefined;
document.querySelectorAll("[data-eye]").forEach((b) => b.addEventListener("click", () => { const i = f.elements[b.dataset.eye]; i.type = i.type === "password" ? "text" : "password"; }));
$("#all").onclick = () => f.querySelectorAll("input[name=cat]").forEach((c) => (c.checked = true));
$("#none").onclick = () => f.querySelectorAll("input[name=cat]").forEach((c) => (c.checked = false));

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || "Request failed (" + r.status + ")");
  return j;
}
document.querySelectorAll("[data-test]").forEach((b) => b.addEventListener("click", async () => {
  const kind = b.dataset.test, out = $("#r-" + kind);
  out.className = "res"; out.textContent = "Testing…";
  try {
    const body = kind === "debrid" ? { kind: val("debrid"), key: val("debridKey") }  : { kind: "torznab", url: val("torznabUrl"), key: val("torznabKey") };
    const j = await post("/api/test", body);
    out.className = "res ok"; out.textContent = "✓ " + j.message;
  } catch (e) { out.className = "res bad"; out.textContent = "✗ " + e.message; }
}));

f.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#err"); err.textContent = "";
  const cats = [...f.querySelectorAll("input[name=cat]:checked")].map((c) => c.value);
  if (cats.length === 0) { err.textContent = "Select at least one catalog."; return; }
  const body = { debrid: val("debrid"), debridKey: val("debridKey"), showUncached: f.elements.showUncached.checked, hidePacks: f.elements.hidePacks.checked,
    torznabUrl: val("torznabUrl"), torznabKey: val("torznabKey"), allowPrivateUpload: f.elements.allowPrivateUpload.checked, internetArchive: f.elements.internetArchive.checked, torrentio: f.elements.torrentio.checked, comet: f.elements.comet.checked,
    tmdbReadToken: val("tmdbReadToken"), arabicOnly: f.elements.arabicOnly.checked, catalogs: cats };
  try {
    const j = await post("/api/config", body);
    $("#stremio").onclick = () => (location.href = j.stremioUrl);
    $("#copy").onclick = async () => { try { await navigator.clipboard.writeText(j.manifestUrl); $("#copy").textContent = "Copied ✓"; } catch { prompt("Copy this link", j.manifestUrl); } };
    $("#https").textContent = j.manifestUrl;
    $("#out").style.display = "block"; $("#out").scrollIntoView({ behavior: "smooth" });
  } catch (x) { err.textContent = x.message; }
});
</script></body></html>`;
}
