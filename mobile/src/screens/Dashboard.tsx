import React, { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";

import { CategoryBars, Row as BarRow } from "../components/CategoryBars";
import { ImportCard } from "../components/ImportCard";
import { MonthChart } from "../components/MonthChart";
import {
  BudgetsCard, CashbackCard, OwedCard, P2PCard, RecurringCard, ReviewCard,
} from "../components/Panels";
import { Tile } from "../components/Tile";
import {
  CATEGORIES, MonthTotals, TxnFilter, recentMonths, searchWords, thisMonth, useAccounts, useBudgets,
  useCashbackPending, useInsights, useLastSync, useP2P, useSearchTotals, useSplitOwed, useTotals,
} from "../data";
import { callSync, SyncOutcome } from "../firebase";
import { money0, monthName, monthProgress } from "../money";
import { C, T, radius, space } from "../theme";
import { Card, ChangePill, Chip, Chips, S, ScreenHeader, SearchField, Sheet, screen } from "../ui";

const PERIODS = ["1", "3", "6", "12", "24"] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_LABELS: Record<Period, string> = { "1": "This month", "3": "3 mo", "6": "6 mo", "12": "12 mo", "24": "24 mo" };
const ALL = "all";

interface Scope { accountId: string | null; category: string | null; q: string | null }

/**
 * One month's figures narrowed to an account and/or a category. Per-account
 * figures are stored alongside the month's, so this costs no reads. A category
 * has no stored count of its own, so the count is dropped (NaN) rather than
 * shown wrong.
 */
function narrow(m: MonthTotals, { accountId, category }: Scope): MonthTotals {
  const part = accountId ? m.byAccount?.[accountId] : m;
  if (!part) return { month: m.month, total: 0, income: 0, byCategory: {}, txnCount: 0 };
  if (!category) return { month: m.month, ...part };
  const value = part.byCategory?.[category] ?? 0;
  return {
    month: m.month,
    total: category === "Income" ? 0 : value,
    income: category === "Income" ? part.income : 0,
    byCategory: value ? { [category]: value } : {},
    txnCount: NaN,
  };
}

export function Dashboard({ onOpen }: { onOpen: (filter: TxnFilter) => void }) {
  const [period, setPeriod] = useState<Period>("6");
  const count = Number(period);
  // Subscribe to every month any period or its comparison window can touch:
  // switching period then costs no reads.
  const all = useMemo(() => recentMonths(48), []);
  const { totals: stored, loading } = useTotals(all);
  const [scope, setScope] = useState<Scope>({ accountId: null, category: null, q: null });
  const [picking, setPicking] = useState<"account" | "category" | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    const q = searchWords(text).join(" ") || null;
    if (q === scope.q) return;
    const timer = setTimeout(() => setScope((sc) => ({ ...sc, q })), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const searched = useSearchTotals(scope.q, all.slice(0, Number(period) * 2));
  const totals = useMemo(() => {
    const base = scope.q ? searched ?? new Map<string, MonthTotals>() : stored;
    if (!scope.accountId && !scope.category) return base;
    return new Map([...base].map(([m, v]) => [m, narrow(v, scope)]));
  }, [stored, searched, scope]);
  const accounts = useAccounts();
  const insights = useInsights();
  const budgets = useBudgets();
  const cashback = useCashbackPending();
  const owed = useSplitOwed();
  const p2p = useP2P();
  const lastSync = useLastSync();
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const months = all.slice(0, count);
  const before = all.slice(count, count * 2);
  const sum = (ms: string[], f: (m: MonthTotals) => number) =>
    ms.reduce((acc, m) => acc + (totals.get(m) ? f(totals.get(m)!) : 0), 0);

  const spend = sum(months, (m) => m.total || 0);
  const income = sum(months, (m) => m.income || 0);
  const count_ = sum(months, (m) => m.txnCount || 0);
  const spendBefore = sum(before, (m) => m.total || 0);

  const current = totals.get(thisMonth());
  const progress = monthProgress(thisMonth());
  // Part of this month against the same share of last month - comparing a part
  // month to a whole one makes every month look like a drop.
  const lastMonthSoFar = (totals.get(all[1]!)?.total || 0) * progress;
  const delta = lastMonthSoFar ? ((current?.total || 0) - lastMonthSoFar) / lastMonthSoFar : null;

  const categories: BarRow[] = useMemo(() => {
    const merged = new Map<string, number>();
    for (const m of months) {
      for (const [c, v] of Object.entries(totals.get(m)?.byCategory ?? {})) {
        merged.set(c, (merged.get(c) ?? 0) + v);
      }
    }
    return [...merged].filter(([, v]) => v > 0).map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [months, totals]);

  const inScope = accounts.filter((a) => !scope.accountId || a.accountId === scope.accountId);
  const cash = inScope.filter((a) => a.type === "depository")
    .reduce((acc, a) => acc + (a.availableBalance ?? a.currentBalance ?? 0), 0);
  const cardDebt = inScope.filter((a) => a.type === "credit")
    .reduce((acc, a) => acc + (a.currentBalance ?? 0), 0);
  const cashbackOwed = cashback.reduce((acc, r) => acc + r.cashback, 0);

  const accountLabel = (id: string) => {
    const a = accounts.find((x) => x.accountId === id);
    return a ? `${a.name ?? "Account"}${a.mask ? ` ·${a.mask}` : ""}` : "Account";
  };
  const scoped = (extra: TxnFilter): TxnFilter =>
    ({ accountId: scope.accountId, category: scope.category, q: scope.q, ...extra });

  const sync = async () => {
    setSyncing(true); setNote(null); setFailed(false);
    try {
      const { data } = await callSync();
      const failures = data.results.filter((r: SyncOutcome) => r.error);
      setFailed(failures.length > 0);
      setNote(failures.length
        ? failures.map((r) => `${r.institution}: ${r.error}`).join("\n")
        : data.results.map((r) => `${r.institution} +${r.added}`).join("   ") || "Nothing linked yet.");
    } catch (e) {
      setFailed(true);
      setNote((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: C.ground }} contentContainerStyle={screen}
      refreshControl={<RefreshControl refreshing={syncing} onRefresh={sync} tintColor={C.accent}
        colors={[C.ground]} progressBackgroundColor={C.accent} />}>

      <ScreenHeader overline={new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}
        title="Overview" trailing={<SyncPill syncing={syncing} failed={failed} at={lastSync} onPress={sync} />} />
      {note ? <Text style={S.muted}>{note}</Text> : null}

      {!loading && accounts.length === 0 ? <ImportCard /> : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space(1.5) }}>
        {PERIODS.map((p) => <Chip key={p} label={PERIOD_LABELS[p]} on={p === period} onPress={() => setPeriod(p)} />)}
      </ScrollView>

      <View style={{ gap: space(2.5) }}>
        <SearchField value={text} onChangeText={setText} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(1.5) }}>
          <Chip label={scope.accountId ? accountLabel(scope.accountId) : "All accounts"} on={!!scope.accountId}
            onPress={() => setPicking("account")} />
          <Chip label={scope.category ?? "All categories"} on={!!scope.category}
            onPress={() => setPicking("category")} />
          {scope.accountId || scope.category || scope.q ? (
            <Chip label="Clear" on={false}
              onPress={() => { setScope({ accountId: null, category: null, q: null }); setText(""); }} />
          ) : null}
        </View>
      </View>

      <Hero spent={current?.total ?? 0} delta={delta} months={all.slice(0, 6).reverse()} totals={totals} />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2.5) }}>
        {count > 1 ? (
          <Tile label={`Spent, last ${count} mo`} value={money0(spend)}
            foot={[
              spendBefore ? `${signedPct((spend - spendBefore) / spendBefore)} vs the ${count} before` : null,
              Number.isNaN(count_) ? null : `${count_} txns`,
            ].filter(Boolean).join(" · ") || undefined}
            tone={spendBefore && spend > spendBefore ? "bad" : undefined} />
        ) : null}
        <Tile label={`Income, ${count === 1 ? "this month" : `${count} mo`}`} value={money0(income)} />
        {income > 0 ? (
          <Tile label="Saved" value={money0(income - spend)}
            foot={`${Math.round(((income - spend) / income) * 100)}% of income`}
            tone={income - spend >= 0 ? "good" : "bad"} />
        ) : null}
        <Tile label="Cash on hand" value={money0(cash)} />
        <Tile label="Card balance" value={money0(Math.abs(cardDebt))}
          foot={cardDebt > 0 ? "outstanding" : "clear"} tone={cardDebt > 0 ? "bad" : "good"} />
        {cashbackOwed > 0 ? (
          <Tile label="Cashback owed" value={money0(cashbackOwed)}
            foot={`${cashback.length} purchase${cashback.length === 1 ? "" : "s"}`} />
        ) : null}
      </View>

      <CashbackCard rows={cashback} />
      <OwedCard rows={owed} />
      <P2PCard rows={p2p} />
      <ReviewCard insights={insights} />

      <Card title="Spend by category" note="Tap one to see its transactions.">
        <CategoryBars rows={categories}
          onSelect={(c) => c && onOpen(scoped({ category: c, month: count === 1 ? thisMonth() : null }))} />
      </Card>

      <Card title="Spend by month" note="Top seven categories; everything else grouped as Other.">
        <MonthChart months={all.slice(0, Math.max(count, 6))} totals={totals} />
      </Card>

      {/* budgets are for the whole month across every account, whatever the filters */}
      <BudgetsCard budgets={budgets} current={stored.get(thisMonth())} progress={progress} />
      <RecurringCard insights={insights} />

      <Sheet visible={picking === "account"} onClose={() => setPicking(null)} title="Account">
        <Chips options={[ALL, ...accounts.map((a) => a.accountId)]} value={scope.accountId ?? ALL}
          labels={Object.fromEntries([[ALL, "All accounts"], ...accounts.map((a) => [a.accountId, accountLabel(a.accountId)])])}
          onChange={(a) => { setScope((sc) => ({ ...sc, accountId: a === ALL ? null : a })); setPicking(null); }} />
      </Sheet>
      <Sheet visible={picking === "category"} onClose={() => setPicking(null)} title="Category">
        <Chips options={[ALL, ...CATEGORIES]} value={scope.category ?? ALL} labels={{ [ALL]: "All categories" }}
          onChange={(c) => { setScope((sc) => ({ ...sc, category: c === ALL ? null : c })); setPicking(null); }} />
      </Sheet>
    </ScrollView>
  );
}

const signedPct = (change: number) =>
  `${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(Math.round(change * 100))}%`;

/**
 * The one number the screen leads with, and the last six months under it so
 * this month's figure has something to be read against.
 */
function Hero({ spent, delta, months, totals }: {
  spent: number; delta: number | null; months: string[]; totals: Map<string, MonthTotals>;
}) {
  const values = months.map((m) => Math.max(totals.get(m)?.total || 0, 0));
  const max = Math.max(...values, 1);
  return (
    <Card>
      <Text style={[T.label, { color: C.muted }]}>Spent in {monthName(thisMonth(), true)}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(3), marginTop: space(3) }}>
        <Text style={[T.display, { color: C.text, flexShrink: 1 }]} numberOfLines={1}
          adjustsFontSizeToFit minimumFontScale={0.5}>{money0(spent)}</Text>
        {delta != null ? <ChangePill change={delta} /> : null}
      </View>
      <Text style={[T.label, { color: C.muted, marginTop: space(3) }]}>
        {delta != null ? `vs ${monthName(months[months.length - 2]!, true)} at this point in the month` : "Nothing to compare against yet"}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space(1.5), height: 96, marginTop: space(4) }}
        accessibilityLabel={`Spend over the last ${months.length} months`}>
        {values.map((v, i) => (
          <View key={months[i]} style={{
            flex: 1, height: `${Math.max(v / max, 0.03) * 100}%`, borderRadius: 3,
            backgroundColor: i === values.length - 1 ? C.accent : C.accentDim,
          }} />
        ))}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: space(2) }}>
        <Text style={[T.small, { color: C.muted }]}>{monthName(months[0]!, true)}</Text>
        <Text style={[T.small, { color: C.muted }]}>This month</Text>
      </View>
    </Card>
  );
}

function SyncPill({ syncing, failed, at, onPress }: {
  syncing: boolean; failed: boolean; at: Date | null; onPress: () => void;
}) {
  const [text, dot] = syncing ? ["Syncing…", C.second]
    : failed ? ["Sync failed · retry", C.down]
    : [at ? `Synced ${ago(at)}` : "Not synced", C.accent];
  return (
    <Pressable onPress={onPress} disabled={syncing} accessibilityLabel="Sync now" style={({ pressed }) => ({
      flexDirection: "row", alignItems: "center", gap: space(1.5), height: 36, paddingHorizontal: space(3),
      borderRadius: radius.pill, backgroundColor: C.surface, opacity: pressed ? 0.7 : 1,
    })}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }} />
      <Text style={[T.small, { color: C.muted }]}>{text}</Text>
    </Pressable>
  );
}

function ago(at: Date): string {
  const mins = Math.floor((Date.now() - at.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`;
  return `${Math.floor(mins / (24 * 60))} d ago`;
}
