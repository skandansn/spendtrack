import React, { useState } from "react";
import { Text, View } from "react-native";

import {
  CATEGORIES, Insights, MonthTotals, PAYOUTS, ReviewItem, Txn, markCashbackReceived, markSettled,
  setBudget, setCategory,
} from "../data";
import { daysUntil, money, money0, moneyExact, shortDate } from "../money";
import { space, useTheme } from "../theme";
import { Avatar, Button, Card, Chips, Divided, Field, Pill, Row, Sheet, textStyles } from "../ui";

/** What the review and P2P panels hand to the category picker. */
type Pick = { title: string; txn: Txn; scopes: ("merchant" | "one")[] };

export function CategoryPicker({ pick, onDone }: { pick: Pick | null; onDone: () => void }) {
  const t = useTheme();
  const [scope, setScope] = useState<"merchant" | "one">("merchant");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!pick) return null;
  const scopes = pick.scopes;
  const active = scopes.includes(scope) ? scope : scopes[0]!;

  const choose = async (category: string) => {
    setBusy(true); setError(null);
    try {
      await setCategory(pick.txn, category, active);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible onClose={onDone} title={pick.title}
      subtitle={active === "merchant"
        ? "Applies to every transaction from this merchant, now and later."
        : "Applies to this one transaction only."}>
      {scopes.length > 1 ? (
        <View style={{ marginBottom: space(4) }}>
          <Chips options={scopes} value={active} onChange={setScope}
            labels={{ merchant: "Every one from them", one: "Just this one" }} />
        </View>
      ) : null}
      <Chips options={CATEGORIES} value={pick.txn.category as (typeof CATEGORIES)[number]}
        onChange={(c) => { if (!busy) void choose(c); }} />
      {busy ? <Text style={{ color: t.muted, marginTop: space(3) }}>Saving…</Text> : null}
      {error ? <Text style={textStyles(t).error}>{error}</Text> : null}
    </Sheet>
  );
}

/** A review item as a transaction-shaped target for the picker. */
const reviewTarget = (r: ReviewItem): Txn => ({
  merchantKey: r.merchantKey, category: r.category, name: r.name, merchantName: r.merchantName,
} as Txn);

export function ReviewCard({ insights }: { insights: Insights | null }) {
  const t = useTheme();
  const s = textStyles(t);
  const [pick, setPick] = useState<Pick | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  // answered merchants vanish now; the server's list catches up on the next sync
  const rows = (insights?.review ?? []).filter((r) => !done.has(r.merchantKey));
  if (!rows.length) return null;

  return (
    <Card title="Needs review"
      note="No rule matched these and no model was confident. One answer covers every transaction from that merchant.">
      <Divided>
        {rows.slice(0, 8).map((r) => (
          <Row key={r.merchantKey}>
            <Avatar uri={r.logoUrl} label={r.merchantName || r.merchantKey} />
            <View style={{ flex: 1 }}>
              <Text style={s.primary} numberOfLines={1}>{r.merchantName || r.merchantKey}</Text>
              <Text style={s.muted}>{r.txns} txn · {money(r.amount)} · {r.categorySource === "plaid" ? `Plaid guessed ${r.category}` : "no guess"}</Text>
            </View>
            <Button small title="Sort" onPress={() => setPick({
              title: r.merchantName || r.merchantKey, txn: reviewTarget(r), scopes: ["merchant"],
            })} />
          </Row>
        ))}
      </Divided>
      <CategoryPicker pick={pick} onDone={() => {
        if (pick) setDone((d) => new Set(d).add(pick.txn.merchantKey));
        setPick(null);
      }} />
    </Card>
  );
}

export function P2PCard({ rows }: { rows: Txn[] }) {
  const t = useTheme();
  const s = textStyles(t);
  const [pick, setPick] = useState<Pick | null>(null);
  if (!rows.length) return null;
  return (
    <Card title="Zelle & Venmo to sort"
      note="Filed as transfers until you say otherwise. Paid a friend for dinner? Pick Restaurants and it counts as spend. Paid back for one? The same category nets it out. Moving your own money? Keep it a transfer.">
      <Divided>
        {rows.slice(0, 10).map((r) => (
          <Row key={r.txnId}>
            <View style={{ flex: 1 }}>
              <Text style={s.primary} numberOfLines={1}>{r.merchantName || r.name || r.merchantKey}</Text>
              <Text style={s.muted}>{shortDate(r.date)}</Text>
            </View>
            <Text style={[s.number, r.amount < 0 && { color: t.good }]}>{moneyExact(-r.amount)}</Text>
            <Button small title="Sort" onPress={() => setPick({
              title: `${moneyExact(Math.abs(r.amount))} ${r.amount < 0 ? "from" : "to"} ${r.merchantName || r.name}`,
              txn: r, scopes: ["one", "merchant"],
            })} />
          </Row>
        ))}
      </Divided>
      <CategoryPicker pick={pick} onDone={() => setPick(null)} />
    </Card>
  );
}

export function CashbackCard({ rows }: { rows: Txn[] }) {
  const t = useTheme();
  const s = textStyles(t);
  const [busy, setBusy] = useState<string | null>(null);
  if (!rows.length) return null;
  const total = rows.reduce((sum, r) => sum + r.cashback, 0);
  return (
    <Card title="Cashback owed"
      note={`${moneyExact(total)} marked but not paid out yet. Rakuten pays quarterly - tick each one when it lands.`}>
      <Divided>
        {rows.map((r) => {
          const payout = PAYOUTS[r.cashbackPayout ?? ""];
          return (
            <Row key={r.txnId}>
              <View style={{ flex: 1 }}>
                <Text style={s.primary} numberOfLines={1}>{r.merchantName || r.merchantKey}</Text>
                <Text style={s.muted}>{shortDate(r.date)} · {r.cashbackSource || "Rakuten"}</Text>
              </View>
              <View>
                <Text style={s.number}>{moneyExact(r.cashback)}</Text>
                <Text style={[s.muted, { textAlign: "right" }]}>
                  {payout ? (payout.points ? `${Math.round(r.cashback * 100).toLocaleString()} ${payout.label} pts` : payout.label) : ""}
                </Text>
              </View>
              <Button small title="Received" busy={busy === r.txnId} onPress={async () => {
                setBusy(r.txnId);
                try { await markCashbackReceived(r); } finally { setBusy(null); }
              }} />
            </Row>
          );
        })}
      </Divided>
    </Card>
  );
}

export function OwedCard({ rows }: { rows: Txn[] }) {
  const t = useTheme();
  const s = textStyles(t);
  const [busy, setBusy] = useState<string | null>(null);
  if (!rows.length) return null;
  const total = rows.reduce((sum, r) => sum + r.splitOwed, 0);
  return (
    <Card title="Owed to you" note={`${moneyExact(total)} you fronted and have not marked repaid.`}>
      <Divided>
        {rows.map((r) => (
          <Row key={r.txnId}>
            <View style={{ flex: 1 }}>
              <Text style={s.primary} numberOfLines={1}>{r.merchantName || r.merchantKey}</Text>
              <Text style={s.muted} numberOfLines={1}>
                {shortDate(r.date)}{r.splitNote ? ` · ${r.splitNote}` : ""}{r.splitSource === "rule" ? " · rule" : ""}
              </Text>
            </View>
            <View>
              <Text style={s.number}>{moneyExact(r.splitOwed)}</Text>
              <Text style={[s.muted, { textAlign: "right" }]}>of {moneyExact(r.amount)}</Text>
            </View>
            <Button small title="Repaid" busy={busy === r.txnId} onPress={async () => {
              setBusy(r.txnId);
              try { await markSettled(r); } finally { setBusy(null); }
            }} />
          </Row>
        ))}
      </Divided>
    </Card>
  );
}

export function RecurringCard({ insights }: { insights: Insights | null }) {
  const t = useTheme();
  const s = textStyles(t);
  const rows = insights?.recurring ?? [];
  return (
    <Card title="Recurring"
      note={rows.length
        ? `About ${money0(insights!.recurringMonthly)} a month across ${rows.length} charge${rows.length === 1 ? "" : "s"}.`
        : "Steady amount, steady schedule, charged recently. Nothing qualifies yet."}>
      {rows.length ? (
        <Divided>
          {rows.map((r) => {
            const due = daysUntil(r.nextDate);
            return (
              <Row key={r.merchantKey}>
                <Avatar uri={r.logoUrl} label={r.merchantName || r.merchantKey} />
                <View style={{ flex: 1 }}>
                  <Text style={s.primary} numberOfLines={1}>{r.merchantName || r.merchantKey}</Text>
                  <Text style={s.muted}>{r.category}</Text>
                </View>
                <Pill text={r.cadence} />
                <View>
                  <Text style={s.number}>{moneyExact(r.amount)}</Text>
                  <Text style={[s.muted, { textAlign: "right" }]}>
                    {due < 0 ? `due ${-due}d ago` : due === 0 ? "due today" : `next in ${due}d`}
                  </Text>
                </View>
              </Row>
            );
          })}
        </Divided>
      ) : null}
    </Card>
  );
}

/**
 * Budgets for this month. Every account, whatever filters are set. The tick on
 * each bar marks where spending evenly through the month would be today, so
 * "ahead of pace" is something you can see rather than calculate.
 */
export function BudgetsCard({ budgets, current, progress }: {
  budgets: Map<string, number>; current: MonthTotals | undefined; progress: number;
}) {
  const t = useTheme();
  const s = textStyles(t);
  const [editing, setEditing] = useState(false);
  const rows = [...budgets.entries()]
    .map(([category, monthly]) => ({ category, monthly, spent: current?.byCategory?.[category] ?? 0 }))
    .sort((a, b) => b.monthly - a.monthly);

  return (
    <Card title="Budgets this month"
      action={<Button small title="Edit" onPress={() => setEditing(true)} />}
      note={rows.length ? "The tick marks where even spending would be today." : undefined}>
      {!rows.length ? (
        <Text style={[s.muted, { textAlign: "center", paddingVertical: space(4) }]}>
          No budgets yet. Tap Edit to set a monthly limit per category.
        </Text>
      ) : rows.map((r) => {
        const share = r.monthly ? r.spent / r.monthly : 0;
        const over = r.spent > r.monthly;
        const ahead = !over && r.spent > r.monthly * progress;
        return (
          <View key={r.category} style={{ marginTop: space(3) }}>
            <Row>
              <Text style={[s.primary, { flex: 1 }]}>{r.category}</Text>
              <Text style={[s.secondary, over && { color: t.critical }]}>
                {money0(r.spent)} of {money0(r.monthly)}
              </Text>
            </Row>
            <View style={{ height: 8, borderRadius: 4, backgroundColor: t.grid, marginTop: space(1.5), overflow: "hidden" }}>
              <View style={{
                width: `${Math.min(share, 1) * 100}%`, height: "100%", borderRadius: 4,
                backgroundColor: over ? t.critical : ahead ? t.series[3] : t.series[0],
              }} />
              <View style={{ position: "absolute", left: `${progress * 100}%`, top: -2, bottom: -2, width: 2,
                backgroundColor: t.text, opacity: 0.6 }} />
            </View>
            <Text style={[s.muted, { marginTop: 2 }]}>
              {over ? `${money0(r.spent - r.monthly)} over` : `${money0(r.monthly - r.spent)} left${ahead ? " · ahead of pace" : ""}`}
            </Text>
          </View>
        );
      })}
      <BudgetEditor visible={editing} budgets={budgets} onClose={() => setEditing(false)} />
    </Card>
  );
}

function BudgetEditor({ visible, budgets, onClose }: {
  visible: boolean; budgets: Map<string, number>; onClose: () => void;
}) {
  const t = useTheme();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const spendable = CATEGORIES.filter((c) => c !== "Income" && c !== "Transfer");
  const value = (c: string) => draft[c] ?? (budgets.get(c)?.toString() ?? "");

  const save = async () => {
    setBusy(true);
    try {
      await Promise.all(Object.entries(draft).map(([c, v]) => {
        const n = parseFloat(v);
        return setBudget(c, Number.isFinite(n) && n > 0 ? n : null);
      }));
      setDraft({});
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Monthly budgets"
      subtitle="Leave a category empty for no budget.">
      {spendable.map((c) => (
        <Row key={c} style={{ marginBottom: space(1) }}>
          <Text style={{ color: t.text, flex: 1 }}>{c}</Text>
          <View style={{ width: 120 }}>
            <Field keyboardType="decimal-pad" placeholder="—" value={value(c)}
              onChangeText={(v) => setDraft((d) => ({ ...d, [c]: v.replace(/[^0-9.]/g, "") }))} />
          </View>
        </Row>
      ))}
      <Button kind="primary" title="Save" busy={busy} onPress={save} />
    </Sheet>
  );
}
