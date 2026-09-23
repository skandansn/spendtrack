"use strict";

const SERIES_SLOTS = 8;      // never cycled - the 8th slot is "Other"
const STACK_TOP_N = 7;
const PAGE = 100;

const $ = (id) => document.getElementById(id);
const money = (n) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
const money0 = (n) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const monthLabel = (m) => {
  const [y, mm] = m.split("-");
  return new Date(+y, +mm - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
};
const json = (method, body) => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

// Rakuten pays these in points, one per cent of cashback.
const PAYOUTS = {
  paypal: { label: "PayPal", points: false },
  amex_mr: { label: "Amex MR", points: true },
  bilt: { label: "Bilt", points: true },
};
const pts = (dollars) => Math.round(dollars * 100).toLocaleString();

// A logo when Plaid has one, the initial otherwise. The initial sits underneath
// the image, so a logo URL that 404s falls back without any script.
function avatar(src, label, cls = "") {
  const initial = (label || "?").trim().charAt(0).toUpperCase();
  return `<span class="avatar ${cls}" data-l="${initial}">${src
    ? `<img src="${src}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>`;
}

// For spend, up is the bad direction; for income, the good one. The arrow
// carries the direction too, so it never rests on color alone.
function delta(cur, prev, vs, upIsGood = false) {
  if (!prev) return "";
  const pct = (cur - prev) / Math.abs(prev) * 100;
  if (Math.abs(pct) < 0.5) return `<div class="foot">level with ${vs}</div>`;
  const up = pct > 0;
  return `<div class="foot ${up === upIsGood ? "good" : "bad"}">${up ? "&#9650;" : "&#9660;"}
    ${Math.abs(pct).toFixed(0)}% vs ${vs}</div>`;
}

const state = {
  months: 6, start: "", end: "", account: "", category: "", q: "", transfers: false,
  sort: "date", desc: true,
  offset: 0, total: 0, categories: [],
  // category -> series slot, assigned once from the overall ranking so a
  // filter change never repaints the survivors
  colorOf: new Map(),
};

let sawStale = false;
const api = async (path, opts) => {
  const res = await fetch(path, opts);
  if (res.headers.get("X-Spendtrack-Stale")) sawStale = true;
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

// A picked date range replaces the months preset everywhere it is sent.
const period = () => (state.start
  ? { start: state.start, ...(state.end ? { end: state.end } : {}) }
  : { months: state.months });

const shortDate = (iso) => new Date(iso + "T00:00").toLocaleDateString("en-US",
  { month: "short", day: "numeric", year: "numeric" });

const params = () => {
  const p = new URLSearchParams(period());
  if (state.account) p.set("account_id", state.account);
  if (state.category) p.set("category", state.category);
  if (state.q) p.set("q", state.q);
  if (state.transfers) p.set("include_transfers", "true");
  p.set("sort", state.sort);
  p.set("desc", state.desc);
  return p;
};

// --- tooltip ----------------------------------------------------------------

const tip = $("tooltip");
function showTip(evt, html) {
  tip.innerHTML = html;
  tip.classList.add("on");
  const pad = 14, r = tip.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
const hideTip = () => tip.classList.remove("on");

function bindTip(el, html) {
  el.addEventListener("mousemove", (e) => showTip(e, html));
  el.addEventListener("mouseleave", hideTip);
}

// --- stat tiles -------------------------------------------------------------

function renderTiles(s, owed) {
  // Name the active slice in the tile labels, so a filtered total is never
  // mistaken for the overall one.
  const slice = state.category ? `${state.category}` : "Spent";
  const span = s.window.custom
    ? `${shortDate(s.window.start)} – ${shortDate(s.window.end)}`
    : `last ${s.window.months} mo`;
  const before = s.window.custom ? "the same span before" : `the ${s.window.months} before`;
  const tiles = [
    {
      label: `${slice} this month`,
      value: money0(s.spend_this_month), n: s.spend_this_month,
      delta: delta(s.spend_this_month, s.spend_last_month_to_date, "last month so far"),
      spark: true,
    },
    {
      label: `${slice}, ${span}`,
      value: money0(s.spend_window), n: s.spend_window,
      delta: delta(s.spend_window, s.spend_prev_window, before),
      foot: `${s.txns.toLocaleString()} transactions`,
    },
  ];
  // Income and savings only mean something once a bank account brings the
  // paycheck in, and only for the whole picture - not a single category.
  // Both follow the period filter like the spend tile beside them.
  if (s.has_bank && !state.category) {
    const saved = s.income_window - s.spend_window;
    tiles.push(
      {
        label: `Income, ${span}`,
        value: money0(s.income_window), n: s.income_window,
        delta: delta(s.income_window, s.income_prev_window, before, true),
        foot: `${money0(s.income_this_month)} this month`,
      },
      {
        label: `Saved, ${span}`,
        value: money0(saved), n: saved,
        foot: s.income_window > 0
          ? `${(saved / s.income_window * 100).toFixed(0)}% of income` : "no income in this period",
        footClass: saved >= 0 ? "" : "bad",
      },
    );
  }
  tiles.push(
    { label: "Cash on hand", value: money0(s.cash), n: s.cash, footClass: "good" },
    {
      label: "Card balance owed",
      value: money0(Math.abs(s.card_debt)), n: Math.abs(s.card_debt),
      footClass: s.card_debt > 0 ? "bad" : "",
      foot: s.card_debt > 0 ? "outstanding" : "clear",
    },
  );
  if (owed.total > 0) {
    const inPoints = Object.entries(owed.points)
      .map(([p, n]) => `${n.toLocaleString()} ${PAYOUTS[p].label} pts`).join(" &middot; ");
    tiles.push({
      label: "Cashback owed",
      value: money0(owed.total), n: owed.total,
      foot: inPoints || `${owed.rows.length} purchase${owed.rows.length === 1 ? "" : "s"}`,
      link: "cashback-card",
    });
  }
  if (s.uncategorized > 0) {
    tiles.push({
      label: "Uncategorised",
      value: s.uncategorized.toLocaleString(), n: s.uncategorized, int: true,
      foot: "review them below",
      link: "review-card",
    });
  }
  tiles[0].hero = true;
  $("tiles").innerHTML = tiles.map((t) => `
    <div class="tile ${t.hero ? "hero" : ""} ${t.link ? "linked" : ""}" ${t.link ? `data-link="${t.link}"` : ""}>
      <div class="label">${t.label}</div>
      <div class="value" data-key="${t.label.split(",")[0]}" data-n="${t.n ?? ""}"
           data-int="${t.int ? 1 : ""}">${t.value}</div>
      ${t.delta || ""}
      ${t.foot ? `<div class="foot ${t.footClass || ""}">${t.foot}</div>` : ""}
      ${t.spark ? sparkline(s.trend) : ""}
    </div>`).join("");

  for (const el of $("tiles").querySelectorAll(".value[data-n]")) {
    if (el.dataset.n !== "") countUp(el, +el.dataset.n, el.dataset.int ? (n) => Math.round(n).toLocaleString() : money0);
  }
  if (!renderTiles.done) {
    renderTiles.done = true;
    $("tiles").classList.add("first");
    setTimeout(() => $("tiles").classList.remove("first"), 1200);
  }

  for (const bar of $("tiles").querySelectorAll(".spark i")) {
    const p = s.trend[+bar.dataset.i];
    const partial = +bar.dataset.i === s.trend.length - 1 ? " so far" : "";
    bindTip(bar, `<div class="t-name">${monthLabel(p.month)}${partial}</div>
      <div class="t-val">${money(p.spend)}</div>`);
  }
  for (const el of $("tiles").querySelectorAll("[data-link]")) {
    el.addEventListener("click", () => $(el.dataset.link).scrollIntoView({ behavior: "smooth" }));
  }

  $("last-sync").textContent = s.last_sync
    ? `last synced ${new Date(s.last_sync).toLocaleString()}`
    : "never synced";
}

// --- motion -----------------------------------------------------------------

const calm = matchMedia("(prefers-reduced-motion: reduce)");
const shown = new Map();   // tile key -> the number it last displayed

// Roll a tile's figure from what it showed before to its new value, so a
// filter change reads as the number moving rather than being replaced.
function countUp(el, to, fmt) {
  const key = el.dataset.key;
  const from = shown.has(key) ? shown.get(key) : 0;
  shown.set(key, to);
  if (calm.matches || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 750;
  const step = (now) => {
    const k = Math.min((now - t0) / dur, 1);
    const eased = 1 - (1 - k) ** 4;
    el.textContent = fmt(from + (to - from) * eased);
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Cards rise in the first time they scroll into view; ones already on screen
// at load go in order, side-by-side cards a beat apart.
function revealOnScroll() {
  const cards = document.querySelectorAll("main .card");
  if (calm.matches || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  cards.forEach((c) => {
    const twin = c.parentElement.classList.contains("row-flex") && c.previousElementSibling;
    if (twin) c.style.setProperty("--stagger", "90ms");
    c.classList.add("reveal");
    io.observe(c);
  });
}

// The top bar gains its hairline only once content scrolls under it.
function watchScroll() {
  const bar = $("topbar");
  const update = () => bar.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", update, { passive: true });
  update();
}

// Twelve months as mini columns rather than a line: the current month is only
// partly spent, and a line would dive at the end every month. Past months are
// de-emphasised, the current one carries the accent.
function sparkline(trend) {
  const max = Math.max(...trend.map((p) => p.spend), 1);
  return `<div class="spark">${trend.map((p, i) =>
    `<i data-i="${i}" class="${i === trend.length - 1 ? "now" : ""}"
        style="height:${Math.max(p.spend / max * 100, 3).toFixed(1)}%"></i>`).join("")}</div>`;
}

// --- cashback ---------------------------------------------------------------

const cbLabel = (t) => [
  t.cashback_source,
  t.cashback_pct != null ? `${+t.cashback_pct}%` : money(t.cashback),
  PAYOUTS[t.cashback_payout]?.label,
  t.cashback_received ? "received" : "pending",
].filter(Boolean).join(" &middot; ");

function renderCashback(owed) {
  $("cashback-card").hidden = !owed.rows.length;
  if (!owed.rows.length) return;
  $("cashback-note").textContent = "Marked on a purchase but not paid out yet. Rakuten pays "
    + "quarterly; tick each one off when it lands.";
  $("cashback").innerHTML = owed.rows.map((r) => {
    const p = PAYOUTS[r.cashback_payout];
    return `<tr>
      <td><div class="with-avatar">${avatar(r.logo_url, r.merchant)}
        <span class="merchant">${r.merchant}<span class="raw">${r.date} &middot; ${r.cashback_source || ""}</span></span></div></td>
      <td class="num">${money(r.cashback)}
        <div class="acct">${p.points ? `${pts(r.cashback)} ${p.label} pts` : p.label}</div></td>
      <td class="num"><button class="small" data-received="${r.txn_id}">Received</button></td>
    </tr>`;
  }).join("");
  for (const btn of $("cashback").querySelectorAll("[data-received]")) {
    const r = owed.rows.find((x) => x.txn_id === btn.dataset.received);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await api(`/api/transactions/${r.txn_id}/cashback`, json("PUT", {
        ...(r.cashback_pct != null ? { percent: r.cashback_pct } : { amount: r.cashback }),
        payout: r.cashback_payout, source: r.cashback_source, received: true,
      }));
      reload();
    });
  }
}

const cb = { txn: null };

function openCashback(t) {
  cb.txn = t;
  const has = t.cashback > 0;
  $("cb-what").textContent = `${t.merchant_name || t.merchant_key} · ${t.date} · ${money(t.amount)}`;
  $("cb-unit").value = has && t.cashback_pct == null ? "amount" : "percent";
  $("cb-value").value = has ? (t.cashback_pct ?? t.cashback) : "";
  $("cb-payout").value = t.cashback_payout || localStorage.getItem("cb-payout") || "amex_mr";
  $("cb-source").value = t.cashback_source || "Rakuten";
  $("cb-received").checked = !!t.cashback_received;
  $("cb-remove").hidden = !has;
  $("cb-error").textContent = "";
  previewCashback();
  $("cb-dialog").showModal();
  $("cb-value").focus();
}

function cashbackDollars() {
  const v = parseFloat($("cb-value").value);
  if (!(v > 0)) return 0;
  return $("cb-unit").value === "percent" ? Math.round(cb.txn.amount * v) / 100 : v;
}

function previewCashback() {
  const back = cashbackDollars();
  const p = PAYOUTS[$("cb-payout").value];
  $("cb-preview").innerHTML = back > 0
    ? `${money(back)} back${p.points ? ` &middot; ${pts(back)} ${p.label} points` : ""}
       &middot; counts as <strong>${money(Math.max(cb.txn.amount - back, 0))}</strong> of spend`
    : "";
}

function wireCashback() {
  for (const id of ["cb-value", "cb-unit", "cb-payout"]) {
    $(id).addEventListener("input", previewCashback);
  }
  $("cb-cancel").addEventListener("click", () => $("cb-dialog").close());
  $("cb-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const unit = $("cb-unit").value;
    try {
      await api(`/api/transactions/${cb.txn.txn_id}/cashback`, json("PUT", {
        [unit]: $("cb-value").value,
        payout: $("cb-payout").value,
        source: $("cb-source").value,
        received: $("cb-received").checked,
      }));
      // most purchases through one portal pay out the same way
      localStorage.setItem("cb-payout", $("cb-payout").value);
      $("cb-dialog").close();
      reload();
    } catch (err) {
      $("cb-error").textContent = err.message.replace(/^\d+ /, "");
    }
  });
  $("cb-remove").addEventListener("click", async () => {
    await api(`/api/transactions/${cb.txn.txn_id}/cashback`, { method: "DELETE" });
    $("cb-dialog").close();
    reload();
  });
}

// --- needs review -----------------------------------------------------------

function renderReview(rows) {
  const card = $("review-card");
  card.hidden = !rows.length;
  if (!rows.length) return;
  // Starts on a placeholder, not the current category: choosing the value a
  // select already shows fires no change event, so "Other" could never be
  // confirmed from the picker. Keep is the button for that.
  const opts = `<option value="" selected disabled>Choose...</option>`
    + state.categories.map((c) => `<option value="${c}">${c}</option>`).join("");
  $("review").innerHTML = rows.map((r) => {
    const label = r.merchant_name || r.merchant_key;
    const guess = r.category_source === "plaid"
      ? `<span class="pill">Plaid guess: ${r.category}</span>` : `<span class="pill">no guess</span>`;
    return `<div class="review-row" data-txn="${r.txn_id}" data-cat="${r.category}">
      ${avatar(r.logo_url, label)}
      <div class="who">
        <div class="merchant">${label}</div>
        <div class="acct">${r.txns} transaction${r.txns === 1 ? "" : "s"} &middot; ${money(r.amount)}
          &middot; last ${r.last_date}</div>
      </div>
      ${guess}
      <select class="cat-select">${opts}</select>
      <button class="small keep" title="${r.category} is right">Keep ${r.category}</button>
    </div>`;
  }).join("");

  for (const row of $("review").querySelectorAll(".review-row")) {
    const sel = row.querySelector("select");
    const save = async (category) => {
      row.classList.add("saving");
      try {
        await api(`/api/transactions/${row.dataset.txn}/category`, json("POST", { category }));
        row.classList.add("done");
        // let the row fade before everything re-renders around it
        setTimeout(reload, 220);
      } catch (e) {
        row.classList.remove("saving");
        $("txn-note").innerHTML = `<span class="err">${e.message}</span>`;
      }
    };
    sel.addEventListener("change", () => save(sel.value));
    row.querySelector(".keep")?.addEventListener("click", () => save(row.dataset.cat));
  }
}

// --- budgets: a meter per category ------------------------------------------

let editingBudgets = false;

function renderBudgets(b) {
  const box = $("budgets");
  $("edit-budgets").textContent = editingBudgets ? "Done" : "Edit";
  if (editingBudgets) {
    const have = new Map(b.rows.map((r) => [r.category, r.monthly]));
    const budgetable = state.categories.filter((c) => c !== "Income" && c !== "Transfer");
    box.innerHTML = `<div class="budget-edit">${budgetable.map((c) => `
      <label><span>${c}</span>
        <input type="number" min="0" step="10" inputmode="decimal" placeholder="none"
               data-cat="${c}" value="${have.get(c) ?? ""}"></label>`).join("")}</div>`;
    for (const input of box.querySelectorAll("input")) {
      input.addEventListener("change", async () => {
        input.classList.remove("err-input");
        try {
          await api(`/api/budgets/${encodeURIComponent(input.dataset.cat)}`,
                    json("PUT", { monthly: input.value }));
        } catch (e) {
          input.classList.add("err-input");
        }
      });
    }
    return;
  }
  if (!b.rows.length) {
    box.innerHTML = `<div class="empty">No budgets yet. Press Edit to set a monthly limit per category.</div>`;
    return;
  }
  box.innerHTML = b.rows.map((r) => {
    const used = r.spent / r.monthly;
    const level = used > 1 ? "over" : used >= 0.8 ? "near" : "";
    const status = used > 1
      ? `<span class="status over">&#9888; over by ${money0(r.spent - r.monthly)}</span>`
      : `<span class="status ${level}">${level ? "&#9888; " : ""}${money0(r.monthly - r.spent)} left</span>`;
    return `<div class="budget" data-cat="${r.category}">
      <div class="budget-top">
        <span class="name">${r.category}</span>
        <span class="amt">${money0(r.spent)} <span class="acct">of ${money0(r.monthly)}</span></span>
      </div>
      <div class="meter ${level}">
        <div class="fill" style="width:${Math.min(used * 100, 100).toFixed(1)}%"></div>
        <div class="pace" style="left:${(b.month_progress * 100).toFixed(1)}%"></div>
      </div>
      ${status}
    </div>`;
  }).join("");

  for (const el of box.querySelectorAll(".budget")) {
    const r = b.rows.find((x) => x.category === el.dataset.cat);
    const pace = r.monthly * b.month_progress;
    bindTip(el.querySelector(".meter"), `<div class="t-name">${r.category}</div>
      <div class="t-val">${money(r.spent)} of ${money(r.monthly)} (${(r.spent / r.monthly * 100).toFixed(0)}%)</div>
      <div class="t-sub">Even spending would be ${money0(pace)} by today</div>`);
  }
}

// --- recurring --------------------------------------------------------------

function renderRecurring(rec) {
  const tbody = $("recurring");
  if (!rec.rows.length) {
    tbody.innerHTML = `<tr><td class="empty">Nothing charges you on a steady schedule yet.</td></tr>`;
    $("recurring-note").textContent = "Steady amount, steady schedule, charged recently.";
    return;
  }
  $("recurring-note").textContent =
    `About ${money0(rec.monthly_total)} a month across ${rec.rows.length} charge${rec.rows.length === 1 ? "" : "s"}.`;
  const today = new Date(new Date().toDateString());
  tbody.innerHTML = rec.rows.map((r) => {
    const days = Math.round((new Date(r.next_date + "T00:00") - today) / 864e5);
    const when = days < 0 ? `due ${-days}d ago` : days === 0 ? "today" : `in ${days}d`;
    const label = r.merchant_name || r.merchant_key;
    return `<tr>
      <td><div class="with-avatar">${avatar(r.logo_url, label)}
        <span class="merchant">${label}<span class="raw">${r.category}</span></span></div></td>
      <td><span class="pill">${r.cadence}</span></td>
      <td class="num">${money(r.amount)}<div class="acct">next ${when}</div></td>
    </tr>`;
  }).join("");
}

// --- spend by category: one series, one color -------------------------------

function renderByCategory(rows) {
  const box = $("by-category");
  if (!rows.length) { box.innerHTML = `<div class="empty">No spend in this window.</div>`; return; }
  const max = Math.max(...rows.map((r) => r.amount));
  box.innerHTML = rows.map((r) => `
    <div class="bar-row ${state.category === r.category ? "active" : ""}" data-cat="${r.category}">
      <div class="name" title="${r.category}">${r.category}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(r.amount / max * 100).toFixed(2)}%"></div></div>
      <div class="val">${money0(r.amount)}</div>
    </div>`).join("");

  for (const el of box.querySelectorAll(".bar-row")) {
    const r = rows.find((x) => x.category === el.dataset.cat);
    bindTip(el, `<div class="t-name">${r.category}</div>
      <div class="t-val">${money(r.amount)}</div>
      <div class="t-sub">${r.txns} transaction${r.txns === 1 ? "" : "s"}
      &middot; ${money(r.amount / r.txns)} avg</div>`);
    el.addEventListener("click", () => {
      state.category = state.category === r.category ? "" : r.category;
      $("category").value = state.category;
      hideTip();
      reload();
    });
  }
}

// --- spend by month: stacked columns ----------------------------------------

function niceCeil(v) {
  if (v <= 0) return 100;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag * 2) / 2 * mag;
}

function assignColors(categoriesByTotal) {
  // Slots follow the overall ranking, so a category keeps its hue when a filter
  // changes the series count. "Other" is both a real category and the name of
  // the fold bucket; if it already earned a slot it keeps it rather than being
  // reassigned, which is what produced two "Other" entries in the legend.
  state.colorOf.clear();
  let slot = 1;
  for (const c of categoriesByTotal.slice(0, STACK_TOP_N)) {
    state.colorOf.set(c, `var(--series-${slot++})`);
  }
  if (!state.colorOf.has("Other")) {
    state.colorOf.set("Other", `var(--series-${SERIES_SLOTS})`);
  }
}
// null for a category with no slot of its own - the caller shows a neutral mark
// rather than borrowing another series' hue.
const colorFor = (cat) => state.colorOf.get(cat) || null;

function renderByMonth(rows) {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const plot = $("by-month");
  if (!months.length) {
    plot.innerHTML = `<div class="empty" style="margin:auto">No spend in this window.</div>`;
    $("x-axis").innerHTML = ""; $("y-axis").innerHTML = ""; $("legend").innerHTML = "";
    return;
  }

  const totalByCat = new Map();
  for (const r of rows) totalByCat.set(r.category, (totalByCat.get(r.category) || 0) + r.amount);
  const ranked = [...totalByCat.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  assignColors(ranked);
  const top = new Set(ranked.slice(0, STACK_TOP_N));

  // month -> category (folded) -> amount
  const byMonth = new Map(months.map((m) => [m, new Map()]));
  for (const r of rows) {
    const cat = top.has(r.category) ? r.category : "Other";
    const m = byMonth.get(r.month);
    m.set(cat, (m.get(cat) || 0) + r.amount);
  }

  const totals = months.map((m) => [...byMonth.get(m).values()].reduce((a, b) => a + b, 0));
  const top_ = niceCeil(Math.max(...totals));
  const stackOrder = ranked.slice(0, STACK_TOP_N);
  if (totalByCat.size > STACK_TOP_N && !stackOrder.includes("Other")) stackOrder.push("Other");

  plot.innerHTML = months.map((m) => {
    const cats = byMonth.get(m);
    // largest at the bottom of the stack, so the baseline segment is stable
    const segs = stackOrder.filter((c) => cats.has(c)).reverse().map((c) => {
      const amt = cats.get(c);
      return `<div class="seg" data-m="${m}" data-c="${c}" data-a="${amt}"
        style="height:${(amt / top_ * 100).toFixed(3)}%;background:${colorFor(c)}"></div>`;
    }).join("");
    return `<div class="col" style="height:100%">${segs}</div>`;
  }).join("");

  const label = (m) => {
    const [y, mm] = m.split("-");
    return new Date(+y, +mm - 1, 1).toLocaleDateString("en-US", { month: "short" })
      + (mm === "01" || m === months[0] ? ` '${y.slice(2)}` : "");
  };
  $("x-axis").innerHTML = months.map((m) => `<span>${label(m)}</span>`).join("");

  const TICKS = 4;
  $("y-axis").innerHTML = Array.from({ length: TICKS + 1 }, (_, i) =>
    `<span>${money0(top_ * (TICKS - i) / TICKS)}</span>`).join("");
  $("gridlines").innerHTML = Array.from({ length: TICKS + 1 }, () => "<div></div>").join("");

  for (const seg of plot.querySelectorAll(".seg")) {
    const { m, c, a } = seg.dataset;
    const monthTotal = totals[months.indexOf(m)];
    bindTip(seg, `<div class="t-name">${c}</div>
      <div class="t-val">${money(+a)}</div>
      <div class="t-sub">${label(m)} &middot; ${(+a / monthTotal * 100).toFixed(0)}% of ${money0(monthTotal)}</div>`);
    seg.addEventListener("click", () => {
      state.category = state.category === c ? "" : c;
      $("category").value = state.category;
      hideTip();
      reload();
    });
  }

  $("legend").innerHTML = stackOrder.map((c) =>
    `<span class="item"><span class="swatch" style="background:${colorFor(c)}"></span>${c}</span>`
  ).join("");
}

// --- accounts ---------------------------------------------------------------

function renderAccounts(rows) {
  const tbody = $("accounts");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="empty">No accounts linked yet. Run <code>spendtrack link</code>.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((a) => {
    const credit = a.type === "credit";
    const due = a.next_payment_due_date
      ? `<span class="pill ${a.is_overdue ? "warn" : ""}">due ${a.next_payment_due_date}</span>` : "";
    const apr = a.apr_percentage != null ? `<span class="pill">${a.apr_percentage}% APR</span>` : "";
    const stale = a.item_status === "login_required"
      ? `<span class="pill warn">re-link needed</span>` : "";
    const util = credit && a.credit_limit
      ? `<span class="pill">${(a.current_balance / a.credit_limit * 100).toFixed(0)}% used</span>` : "";
    const logo = avatar(a.has_logo ? `/api/items/${a.item_id}/logo` : null,
                        a.institution_name, "bank");
    // the brand color only tints the fallback initial; a real logo brings its own
    const brand = a.has_logo || !a.institution_color ? "" : ` style="--brand:${a.institution_color}"`;
    return `<tr>
      <td><div class="with-avatar"${brand}>${logo}<div>
          <strong>${a.name || a.official_name || "account"}</strong>
          ${a.mask ? `<span class="acct"> ....${a.mask}</span>` : ""}
          <div class="acct">${a.institution_name || ""} &middot; ${a.subtype || a.type || ""}</div>
        </div></div></td>
      <td>${[due, apr, util, stale].filter(Boolean).join(" ")}</td>
      <td class="num">${a.current_balance == null ? "-" : money(a.current_balance)}
          <div class="acct">${credit ? "owed" : "available"}</div></td>
    </tr>`;
  }).join("");
}

// --- transactions -----------------------------------------------------------

// With cashback the charge is struck through beside what it really cost, so the
// statement figure is never hidden.
function amountCell(t) {
  if (t.amount <= 0) return `<td class="num credit">${money(-t.amount)}</td>`;
  if (!(t.cashback > 0)) {
    return `<td class="num">${money(-t.amount)}
      <button class="cb-link" data-cb="${t.txn_id}">+ cashback</button></td>`;
  }
  return `<td class="num"><s class="was">${money(-t.amount)}</s> ${money(-(t.amount - t.cashback))}
    <button class="cb-link set ${t.cashback_received ? "" : "pending"}" data-cb="${t.txn_id}">${cbLabel(t)}</button></td>`;
}

function renderTransactions(rows, append) {
  const tbody = $("transactions");
  if (!append) tbody.innerHTML = "";
  if (!rows.length && !append) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">Nothing matches these filters.</td></tr>`;
    return;
  }
  // Starts on a placeholder, not the current category: choosing the value a
  // select already shows fires no change event, so "Other" could never be
  // confirmed from the picker. Keep is the button for that.
  const opts = `<option value="" selected disabled>Choose...</option>`
    + state.categories.map((c) => `<option value="${c}">${c}</option>`).join("");
  tbody.insertAdjacentHTML("beforeend", rows.map((t) => {
    const label = t.merchant_name || t.merchant_key;
    const showRaw = t.name && t.name !== label;
    return `<tr>
      <td class="date">${t.date}${t.pending ? ' <span class="pill">pending</span>' : ""}</td>
      <td><div class="with-avatar">${avatar(t.logo_url, label)}
        <span class="merchant">${label}${showRaw ? `<span class="raw">${t.name}</span>` : ""}</span></div></td>
      <td class="acct">${t.account_name || ""}${t.mask ? ` ....${t.mask}` : ""}</td>
      <td><div class="cat-cell">
        <span class="dot" style="background:${colorFor(t.category) || "var(--baseline)"}"></span>
        <select class="cat-select" data-txn="${t.txn_id}">${opts}</select>
        <span class="src">${{ override: "yours", manual: "this one" }[t.category_source] || t.category_source || ""}</span>
      </div></td>
      ${amountCell(t)}
    </tr>`;
  }).join(""));

  for (const btn of tbody.querySelectorAll("button[data-cb]:not([data-bound])")) {
    const row = rows.find((r) => r.txn_id === btn.dataset.cb);
    btn.dataset.bound = "1";
    if (row) btn.addEventListener("click", () => openCashback(row));
  }

  for (const sel of tbody.querySelectorAll("select[data-txn]:not([data-bound])")) {
    const row = rows.find((r) => r.txn_id === sel.dataset.txn);
    if (row) sel.value = row.category;
    sel.dataset.bound = "1";
    // Nothing is saved until you say how far the change reaches: every
    // transaction from this merchant, or just this one.
    sel.addEventListener("change", () => {
      const cell = sel.closest(".cat-cell");
      cell.querySelector(".scope")?.remove();
      cell.insertAdjacentHTML("beforeend", `<span class="scope">
        <button class="small" data-scope="merchant" title="${row.merchant_key}">All from merchant</button>
        <button class="small" data-scope="one">Just this one</button>
        <button class="small ghost" data-scope="" title="Cancel">&times;</button></span>`);
      for (const btn of cell.querySelectorAll(".scope button")) {
        btn.addEventListener("click", () => {
          const scope = btn.dataset.scope;
          cell.querySelector(".scope").remove();
          if (scope) saveCategory(sel, sel.value, scope);
          else sel.value = row.category;
        });
      }
    });
  }
}

async function saveCategory(sel, category, scope) {
  sel.disabled = true;
  try {
    const res = await api(`/api/transactions/${sel.dataset.txn}/category`,
                          json("POST", { category, scope }));
    $("txn-note").textContent = scope === "one"
      ? `Set this one transaction from ${res.merchant_key} to "${res.category}".`
      : `Applied "${res.category}" to ${res.updated} transaction${res.updated === 1 ? "" : "s"} from ${res.merchant_key}.`;
    await reload();
  } catch (e) {
    $("txn-note").innerHTML = `<span class="err">${e.message}</span>`;
    sel.disabled = false;
  }
}

// --- Zelle / Venmo ----------------------------------------------------------

function renderP2P(rows) {
  $("p2p-card").hidden = !rows.length;
  if (!rows.length) return;
  const opts = `<option value="" selected disabled>Sort as...</option>`
    + state.categories.filter((c) => c !== "Transfer")
      .map((c) => `<option value="${c}">${c}</option>`).join("");
  $("p2p").innerHTML = rows.map((r) => {
    const sent = r.amount > 0;
    return `<tr data-txn="${r.txn_id}">
      <td class="date">${r.date}</td>
      <td><span class="merchant">${r.merchant_key}<span class="raw">${r.name || ""}</span></span></td>
      <td><span class="pill">${sent ? "sent" : "received"}</span></td>
      <td class="num ${sent ? "" : "credit"}">${money(-r.amount)}</td>
      <td class="p2p-actions"><select class="cat-select">${opts}</select>
        <button class="small" data-keep title="It's my own money moving">Transfer</button></td>
    </tr>`;
  }).join("");
  for (const tr of $("p2p").querySelectorAll("tr")) {
    const set = async (category) => {
      tr.classList.add("saving");
      try {
        await api(`/api/transactions/${tr.dataset.txn}/category`,
                  json("POST", { category, scope: "one" }));
        reload();
      } catch (e) {
        tr.classList.remove("saving");
        $("txn-note").innerHTML = `<span class="err">${e.message}</span>`;
      }
    };
    tr.querySelector("select").addEventListener("change", (e) => set(e.target.value));
    tr.querySelector("[data-keep]").addEventListener("click", () => set("Transfer"));
  }
}

// --- orchestration ----------------------------------------------------------

async function reload() {
  state.offset = 0;
  sawStale = false;
  const busy = setTimeout(() => $("main").classList.add("busy"), 150);
  const p = params();
  // Every panel honours the filter bar, so the numbers on screen always
  // describe the same slice. The by-category chart is the one exception: it
  // skips the category filter because it is the control you pick it with.
  const scope = new URLSearchParams(period());
  if (state.account) scope.set("account_id", state.account);
  if (state.q) scope.set("q", state.q);
  const picker = new URLSearchParams(scope);
  if (state.category) scope.set("category", state.category);
  try {
    const [summary, byCat, byMonth, accts, txns, review, budgets, recurring, owed, p2p] = await Promise.all([
      api(`/api/summary?${scope}`),
      api(`/api/spend/by-category?${picker}`),
      api(`/api/spend/by-month?${scope}`),
      api(`/api/accounts`),
      api(`/api/transactions?${p}&limit=${PAGE}&offset=0`),
      api(`/api/review`),
      api(`/api/budgets`),
      api(`/api/recurring`),
      api(`/api/cashback/pending`),
      api(`/api/p2p?${new URLSearchParams(period())}`),
    ]);
    renderTiles(summary, owed);
    renderCashback(owed);
    renderP2P(p2p);
    renderByMonth(byMonth);   // assigns colours; must run before anything using colorFor
    renderByCategory(byCat);
    renderReview(review);
    renderBudgets(budgets);
    renderRecurring(recurring);
    renderAccounts(accts);
    state.total = txns.total;
    renderTransactions(txns.rows, false);
    state.offset = txns.rows.length;
    updateCount();
    markStale(sawStale);
  } catch (e) {
    $("txn-note").innerHTML = `<span class="err">${e.message}</span>`;
  } finally {
    clearTimeout(busy);
    $("main").classList.remove("busy");
  }
}

function updateCount() {
  $("txn-count").textContent = `showing ${Math.min(state.offset, state.total)} of ${state.total}`;
  $("more").disabled = state.offset >= state.total;
}

async function loadMore() {
  const txns = await api(`/api/transactions?${params()}&limit=${PAGE}&offset=${state.offset}`);
  renderTransactions(txns.rows, true);
  state.offset += txns.rows.length;
  updateCount();
}

function markSort() {
  $("sort-m").value = state.sort;
  $("sort-dir").innerHTML = state.desc ? "&darr;" : "&uarr;";
  for (const th of document.querySelectorAll("th.sortable")) {
    const on = th.dataset.sort === state.sort;
    th.classList.toggle("on", on);
    th.classList.toggle("desc", on && state.desc);
    th.classList.toggle("asc", on && !state.desc);
  }
}

function applyRange() {
  const from = $("from").value, to = $("to").value;
  $("to").min = from;
  if (!from || (to && to < from)) return;   // half-picked: wait for a valid pair
  state.start = from;
  state.end = to;
  reload();
}

let searchTimer;
function wire() {
  $("months").addEventListener("change", (e) => {
    const custom = e.target.value === "custom";
    $("custom-range").hidden = !custom;
    if (custom) {
      // open on the range the preset was showing, so switching changes nothing yet
      const today = new Date();
      const from = new Date(today.getFullYear(), today.getMonth() - state.months + 1, 1);
      $("from").value = state.start || from.toLocaleDateString("en-CA");
      $("to").value = state.end || today.toLocaleDateString("en-CA");
      applyRange();
    } else {
      state.months = +e.target.value;
      state.start = state.end = "";
      reload();
    }
  });
  for (const id of ["from", "to"]) $(id).addEventListener("change", applyRange);
  $("account").addEventListener("change", (e) => { state.account = e.target.value; reload(); });
  $("category").addEventListener("change", (e) => { state.category = e.target.value; reload(); });
  $("transfers").addEventListener("change", (e) => { state.transfers = e.target.checked; reload(); });
  $("q").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); reload(); }, 250);
  });
  $("more").addEventListener("click", loadMore);
  $("edit-budgets").addEventListener("click", async () => {
    editingBudgets = !editingBudgets;
    // leaving edit mode is when the typed limits should show up as meters
    renderBudgets(await api("/api/budgets"));
  });

  for (const th of document.querySelectorAll("th.sortable")) {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      // same column toggles direction; a new column starts on its natural end -
      // newest dates and biggest amounts first, but names A-Z
      if (state.sort === key) state.desc = !state.desc;
      else { state.sort = key; state.desc = key === "date" || key === "amount"; }
      markSort();
      reload();
    });
  }

  // The same sorts, reachable on a phone where the column headers are hidden.
  $("sort-m").addEventListener("change", (e) => {
    state.sort = e.target.value;
    state.desc = state.sort === "date" || state.sort === "amount";
    markSort();
    reload();
  });
  $("sort-dir").addEventListener("click", () => {
    state.desc = !state.desc;
    markSort();
    reload();
  });

  markSort();

  $("theme").addEventListener("click", () => {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    localStorage.setItem("theme", dark ? "light" : "dark");
  });

  $("link").addEventListener("click", async () => {
    const btn = $("link");
    if (typeof Plaid === "undefined") {
      $("txn-note").innerHTML = `<span class="err">Plaid Link did not load - check your network.</span>`;
      return;
    }
    btn.disabled = true; btn.textContent = "Opening...";
    const restore = () => { btn.disabled = false; btn.textContent = "+ Link account"; };
    try {
      const { link_token } = await api("/api/link/token");
      Plaid.create({
        token: link_token,
        onSuccess: async (public_token) => {
          $("txn-note").textContent = "Linking, then pulling transactions...";
          try {
            await api("/api/link/exchange", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ public_token }),
            });
            // a fresh Item has no transactions for a few seconds; sync anyway so
            // accounts and balances appear at once, then let the user re-sync
            await api("/api/sync", { method: "POST" });
            $("txn-note").textContent =
              "Linked. If transactions are missing, press Sync now in a moment.";
            await refreshAccountFilter();
            await reload();
          } catch (e) {
            $("txn-note").innerHTML = `<span class="err">${e.message}</span>`;
          } finally { restore(); }
        },
        onExit: (err) => {
          $("txn-note").textContent = err
            ? `Link exited: ${[err.error_code, err.error_message].filter(Boolean).join(": ")}`
            : "";
          restore();
        },
      }).open();
    } catch (e) {
      $("txn-note").innerHTML = `<span class="err">${e.message}</span>`;
      restore();
    }
  });

  $("sync").addEventListener("click", async () => {
    const btn = $("sync");
    btn.disabled = true; btn.textContent = "Syncing...";
    try {
      const res = await api("/api/sync", { method: "POST" });
      const errs = res.results.filter((r) => r.error);
      $("txn-note").innerHTML = errs.length
        ? `<span class="err">${errs.map((e) => `${e.institution}: ${e.error}`).join("; ")}</span>`
        : res.results.map((r) => `${r.institution}: +${r.added} new, ${r.modified} updated`).join(" &middot; ")
          || "Nothing linked yet.";
      await reload();
    } catch (e) {
      $("txn-note").innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false; btn.textContent = "Sync now";
    }
  });
}

async function refreshAccountFilter() {
  const sel = $("account");
  const accts = await api("/api/accounts");
  sel.innerHTML = `<option value="">All accounts</option>` + accts.map((a) =>
    `<option value="${a.account_id}">${a.name}${a.mask ? ` ....${a.mask}` : ""}</option>`).join("");
  sel.value = state.account;
  if (sel.value !== state.account) state.account = "";   // account went away
}

// Registered from the page rather than served at the root: the scope only needs
// to cover what the app actually fetches.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    // no service worker means no offline shell; the app still works online
  });
}

// The service worker marks replayed-from-cache responses. Say so plainly rather
// than presenting yesterday's balance as today's.
function markStale(isStale) {
  const el = $("stale");
  el.hidden = !isStale;
  el.className = isStale ? "stale-banner" : "";
  if (isStale) {
    el.textContent = "Showing the last data this phone received - spendtrack is "
      + "not reachable right now. Wake the laptop and pull to refresh.";
  }
}

(async function init() {
  registerServiceWorker();
  const saved = localStorage.getItem("theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  wire();
  wireCashback();
  watchScroll();
  revealOnScroll();
  try {
    state.categories = await api("/api/categories");
    $("category").insertAdjacentHTML("beforeend",
      state.categories.map((c) => `<option value="${c}">${c}</option>`).join(""));
    await refreshAccountFilter();
  } catch (e) { /* reload() surfaces the error */ }
  await reload();
})();
