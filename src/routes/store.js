import { Errors } from '../core/errors.js';
import { requireAuth } from './middleware.js';

const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

function cookie(ctx, name) {
  for (const part of String(ctx.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Accounts the checkout page may act for: the purchase-flow token if the game sent one, else recent store users from this address. */
function checkoutAccounts(ctx) {
  const { auth, vbucksStore } = ctx.services;
  const out = [];
  for (const name of ['EPIC_BEARER_TOKEN', 'EPIC_BEARER_TOKEN_GD', 'EPIC_BEARER_TOKEN_STAGE', 'EPIC_BEARER_TOKEN_CI']) {
    const s = auth.tryVerify(cookie(ctx, name));
    if (s?.account) out.push({ id: s.account.id, displayName: s.account.displayName, viaToken: true });
  }
  for (const a of vbucksStore.candidates(cleanIp(ctx.ip))) if (!out.some((o) => o.id === a.id)) out.push(a);
  return out;
}

/**
 * V-Bucks store: catalog-service offer lookups for the STORE tab, the price engine, and the
 * checkout page the in-game purchase browser opens (see services/vbucksStore.js).
 */
export function registerStoreRoutes(router) {
  const bulk = (ctx) => {
    const ids = [...ctx.queryAll('id'), ...ctx.queryAll('offerId'), ...(Array.isArray(ctx.body?.ids) ? ctx.body.ids : []), ...(Array.isArray(ctx.body?.offerIds) ? ctx.body.offerIds : [])].filter((x) => typeof x === 'string');
    if (ctx.auth?.accountId) ctx.services.vbucksStore.noteVisitor(cleanIp(ctx.ip), ctx.auth.accountId);
    ctx.json(ctx.services.vbucksStore.bulkOffers(ids));
  };
  router.get('/catalog/api/shared/bulk/offers', requireAuth, bulk);
  router.post('/catalog/api/shared/bulk/offers', requireAuth, bulk);
  router.post('/catalog/api/shared/namespace/:namespace/bulk/offers', requireAuth, bulk);

  // No sales or discounts: the client falls back to the catalog price ("offers will not have any
  // sales/discounts applied"), which keeps the purchase on the paid path that opens the checkout page.
  router.post('/priceengine/api/shared/offers/price', requireAuth, (ctx) => {
    if (ctx.auth?.accountId) ctx.services.vbucksStore.noteVisitor(cleanIp(ctx.ip), ctx.auth.accountId);
    throw Errors.notFound('price engine rules (none are configured)');
  });

  router.get('/gallium/purchase', (ctx) => {
    ctx.header('Cache-Control', 'no-store');
    ctx.send(CHECKOUT_HTML, 'text/html; charset=utf-8');
  });

  router.get('/gallium/purchase/api/session', (ctx) => {
    const { vbucksStore, config } = ctx.services;
    const offers = String(ctx.query.offers || '').split(',').filter(Boolean);
    const pack = offers.map((o) => vbucksStore.pack(o)).find(Boolean);
    ctx.services.log.child('vbucks-store').info(`Checkout opened from ${cleanIp(ctx.ip)} for offers=${offers.join(',') || '(none)'}`);
    ctx.json({
      enabled: config.store.fakeVbucksPurchases !== false,
      pack: pack ? { id: pack.epicOfferId, title: pack.title, vbucks: pack.vbucks, bonus: pack.bonus, price: `$${(pack.cents / 100).toFixed(2)}` } : null,
      accounts: checkoutAccounts(ctx).map(({ id, displayName }) => ({ id, displayName })),
    });
  });

  router.post('/gallium/purchase/api/complete', (ctx) => {
    const { offerId, accountId } = ctx.body || {};
    if (typeof offerId !== 'string' || typeof accountId !== 'string') throw Errors.validation('offerId and accountId are required');
    if (!checkoutAccounts(ctx).some((a) => a.id === accountId)) throw Errors.missingPermission(`gallium:store:${accountId}`, 'PURCHASE');
    ctx.json(ctx.services.vbucksStore.complete({ accountId, offerId }));
  });
}

const CHECKOUT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checkout</title>
<style>
  :root { --bg1:#0b1640; --bg2:#1d3a8a; --card:#ffffff; --ink:#0f1a3a; --muted:#5a6788; --gold:#ffd400; --line:#dde3f0; --green:#13a06b; }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; }
  body { font-family: "Segoe UI", Roboto, Arial, sans-serif; color: var(--ink);
         background: radial-gradient(1200px 700px at 20% 10%, var(--bg2), var(--bg1)); display:flex; align-items:center; justify-content:center; }
  .sheet { width: min(760px, 94vw); background: var(--card); border-radius: 6px; box-shadow: 0 30px 80px rgba(0,0,0,.45); overflow:hidden; }
  header { background: #0f1a3a; color: #fff; padding: 18px 28px; display:flex; align-items:center; justify-content:space-between; }
  header h1 { margin:0; font-size: 22px; letter-spacing: .08em; text-transform: uppercase; font-weight: 800; }
  header .secure { font-size: 12px; opacity: .7; letter-spacing: .06em; text-transform: uppercase; }
  main { display:grid; grid-template-columns: 220px 1fr; gap: 28px; padding: 28px; }
  .coin { width: 200px; height: 200px; border-radius: 50%; display:flex; align-items:center; justify-content:center;
          background: radial-gradient(circle at 24% 20%, rgba(255,255,255,.85) 0 7%, rgba(255,255,255,0) 14%), radial-gradient(circle at 50% 45%, #8ab8ff 0 50%, #4c84ea 51% 74%, #1e4fc2 75%);
          box-shadow: inset 0 -8px 0 rgba(0,0,0,.15), 0 10px 25px rgba(30,79,194,.35); }
  .coin span { font-size: 96px; font-weight: 900; color: #fff; text-shadow: 0 4px 0 #1e4fc2; font-family: Impact, "Arial Black", sans-serif; }
  h2 { margin: 6px 0 2px; font-size: 30px; font-family: Impact, "Arial Black", sans-serif; letter-spacing: .02em; text-transform: uppercase; }
  .bonus { color: var(--green); font-weight: 700; min-height: 20px; }
  .rows { margin: 18px 0; border-top: 1px solid var(--line); }
  .row { display:flex; justify-content:space-between; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 15px; }
  .row .k { color: var(--muted); }
  .strike { text-decoration: line-through; color: var(--muted); margin-right: 8px; }
  .free { background: var(--green); color:#fff; font-weight:800; padding: 2px 8px; border-radius: 3px; font-size: 13px; letter-spacing:.06em; }
  select { font-size: 15px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 3px; }
  .buttons { display:flex; gap: 12px; margin-top: 18px; }
  button { font-size: 18px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; border: 0; border-radius: 4px; padding: 14px 22px; cursor: pointer; }
  .buy { background: var(--gold); color: #1a1a1a; flex: 1; box-shadow: 0 4px 0 #c9a700; }
  .buy:disabled { opacity: .5; cursor: default; }
  .cancel { background: #e7ebf5; color: var(--ink); }
  .note { font-size: 12px; color: var(--muted); margin-top: 14px; }
  .status { margin-top: 12px; font-weight: 700; min-height: 22px; }
  .status.err { color: #c62828; } .status.ok { color: var(--green); }
  .done { text-align:center; padding: 40px 28px 46px; }
  .done h2 { font-size: 38px; } .done p { color: var(--muted); }
  @media (max-width: 620px) { main { grid-template-columns: 1fr; justify-items:center; text-align:center; } }
</style>
</head>
<body>
<div class="sheet">
  <header><h1>Checkout</h1><div class="secure">Gallium &middot; no payment required</div></header>
  <div id="content"><main><div class="coin"><span>V</span></div><div><h2>Loading&hellip;</h2></div></main></div>
</div>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var offers = params.get('offers') || '';
  var content = document.getElementById('content');
  var state = { pack: null, accounts: [] };

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }

  // The game exposes UPurchaseFlowJSBridge on window.ue (UE lower-cases bound method names).
  function bridge() {
    var ue = window.ue;
    if (!ue) return null;
    for (var k in ue) { if (ue[k] && typeof ue[k].receipt === 'function') return ue[k]; }
    return null;
  }
  function report(receipt) {
    var b = bridge();
    if (!b) return false;
    try { b.receipt(receipt); } catch (e) {}
    setTimeout(function () { try { b.requestclose(''); } catch (e) {} }, 1500);
    return true;
  }

  function render() {
    var p = state.pack;
    if (!p) { content.innerHTML = '<div class="done"><h2>Unknown offer</h2><p>This pack is not sold by Gallium.</p><div class="buttons" style="justify-content:center"><button class="cancel" id="cancel">Close</button></div></div>'; bindCancel(); return; }
    var options = state.accounts.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.displayName) + '</option>'; }).join('');
    content.innerHTML =
      '<main><div class="coin"><span>V</span></div><div>' +
      '<h2>' + esc(fmt(p.vbucks)) + ' V-Bucks</h2>' +
      '<div class="bonus">' + (p.bonus ? 'Includes ' + esc(fmt(p.bonus)) + ' bonus V-Bucks' : '') + '</div>' +
      '<div class="rows">' +
      '<div class="row"><span class="k">Account</span><span>' + (state.accounts.length ? '<select id="acct">' + options + '</select>' : '<b style="color:#c62828">Not signed in</b>') + '</span></div>' +
      '<div class="row"><span class="k">Price</span><span><span class="strike">' + esc(p.price) + '</span><span class="free">FREE</span></span></div>' +
      '<div class="row"><span class="k">Total</span><b>$0.00</b></div>' +
      '</div>' +
      '<div class="buttons"><button class="cancel" id="cancel">Cancel</button><button class="buy" id="buy"' + (state.accounts.length ? '' : ' disabled') + '>Place order</button></div>' +
      '<div class="status" id="status"></div>' +
      '<div class="note">This is a local Gallium store. No money is charged; the V-Bucks are added to your account straight away.</div>' +
      '</div></main>';
    bindCancel();
    document.getElementById('buy').onclick = buy;
  }

  function bindCancel() {
    document.getElementById('cancel').onclick = function () {
      if (!report({ offers: [], transactionState: 'Canceled', transactionId: '' })) history.back();
    };
  }

  function buy() {
    var btn = document.getElementById('buy');
    var status = document.getElementById('status');
    var acct = document.getElementById('acct');
    btn.disabled = true;
    status.className = 'status';
    status.textContent = 'Processing\\u2026';
    fetch('/gallium/purchase/api/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offerId: state.pack.id, accountId: acct && acct.value }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.errorMessage || 'Purchase failed');
        var inGame = report(res.j.receipt);
        content.innerHTML = '<div class="done"><div class="coin" style="margin:0 auto 18px;width:150px;height:150px"><span style="font-size:72px">V</span></div>' +
          '<h2>Thanks for your purchase!</h2><p>' + esc(fmt(res.j.pack.vbucks)) + ' V-Bucks were added. Balance: <b>' + esc(fmt(res.j.balance)) + '</b></p>' +
          '<p>' + (inGame ? 'Returning to Fortnite\\u2026' : 'You can close this window and return to Fortnite.') + '</p></div>';
      })
      .catch(function (e) { btn.disabled = false; status.className = 'status err'; status.textContent = e.message; });
  }

  fetch('/gallium/purchase/api/session?offers=' + encodeURIComponent(offers), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (s) { state.pack = s.pack; state.accounts = s.accounts || []; render(); })
    .catch(function () { content.innerHTML = '<div class="done"><h2>Store unavailable</h2><p>Could not reach Gallium.</p></div>'; });
})();
</script>
</body>
</html>`;
