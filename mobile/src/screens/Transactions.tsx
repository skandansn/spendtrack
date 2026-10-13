import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from "react-native";

import { TxnSheet } from "../components/TxnSheet";
import {
  CATEGORIES, SORTS, Sort, Txn, TxnFilter, recentMonths, searchWords, useAccounts, useTransactions,
} from "../data";
import { moneyExact, monthName, shortDate } from "../money";
import { radius, space, useTheme } from "../theme";
import { Avatar, Chips, Pill, Sheet, textStyles } from "../ui";

const ALL = "all";
const SORT_LABELS: Record<Sort, string> = {
  newest: "Newest", oldest: "Oldest", largest: "Largest", smallest: "Smallest", merchant: "Merchant A-Z",
};

export function Transactions({ filter, onFilter }: {
  filter: TxnFilter; onFilter: (f: TxnFilter) => void;
}) {
  const t = useTheme();
  const s = textStyles(t);
  const accounts = useAccounts();
  const { rows, loading, done, error, more, reload } = useTransactions(filter);
  const [open, setOpen] = useState<Txn | null>(null);
  const [picking, setPicking] = useState<"month" | "category" | "account" | "sort" | null>(null);
  const [text, setText] = useState(filter.q ?? "");
  useEffect(() => { setText(filter.q ?? ""); }, [filter.q]);
  // wait for a pause in typing, so each keystroke is not a query
  useEffect(() => {
    const words = searchWords(text).join(" ");
    if (words === searchWords(filter.q).join(" ")) return;
    const timer = setTimeout(() => onFilter({ ...filter, q: words || null }), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const months = useMemo(() => recentMonths(24), []);
  const accountName = new Map(accounts.map((a) => [a.accountId, `${a.name ?? "Account"}${a.mask ? ` ·${a.mask}` : ""}`]));

  const set = (patch: Partial<TxnFilter>) => { onFilter({ ...filter, ...patch }); setPicking(null); };

  const header = (
    <View style={{ gap: space(3), marginBottom: space(3) }}>
      <TextInput value={text} onChangeText={setText} placeholder="Search merchants" placeholderTextColor={t.muted}
        autoCapitalize="none" autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing"
        style={{
          color: t.text, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
          borderRadius: radius.pill, paddingHorizontal: space(4), paddingVertical: space(2.5), fontSize: 15,
        }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
        <FilterChip label={filter.month ? monthName(filter.month, true) : "Any month"} on={!!filter.month}
          onPress={() => setPicking("month")} />
        <FilterChip label={filter.category ?? "Any category"} on={!!filter.category}
          onPress={() => setPicking("category")} />
        <FilterChip label={filter.accountId ? accountName.get(filter.accountId) ?? "Account" : "Any account"}
          on={!!filter.accountId} onPress={() => setPicking("account")} />
        {!filter.category ? (
          <FilterChip label="Transfers" on={!!filter.includeTransfers}
            onPress={() => set({ includeTransfers: !filter.includeTransfers })} />
        ) : null}
        <FilterChip label={SORT_LABELS[filter.sort ?? "newest"]} on={(filter.sort ?? "newest") !== "newest"}
          onPress={() => setPicking("sort")} />
      </View>
      {filter.q && rows.length >= 500 ? (
        <Text style={s.muted}>Showing the newest 500 matches - add a word to narrow it.</Text>
      ) : null}
      {filter.month || filter.category || filter.accountId || filter.q ? (
        <Pressable onPress={() => onFilter({})}>
          <Text style={s.muted}>Clear filters</Text>
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.plane }}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.txnId}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: space(4), paddingBottom: space(16) }}
        onEndReachedThreshold={0.5}
        onEndReached={more}
        refreshing={false}
        onRefresh={reload}
        renderItem={({ item }) => (
          <TxnRow txn={item} account={accountName.get(item.accountId)} onPress={() => setOpen(item)} />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: t.grid }} />}
        ListEmptyComponent={loading ? null
          : <Text style={[error ? s.error : s.muted, { textAlign: "center", paddingVertical: space(10) }]}>
              {error ?? "Nothing matches."}
            </Text>}
        ListFooterComponent={loading
          ? <ActivityIndicator style={{ marginVertical: space(6) }} color={t.muted} />
          : done && rows.length ? <Text style={[s.muted, { textAlign: "center", marginTop: space(4) }]}>That's everything.</Text> : null}
      />

      <TxnSheet txn={open} onClose={() => setOpen(null)} onChanged={reload} />

      <Sheet visible={picking === "month"} onClose={() => setPicking(null)} title="Month">
        <Chips options={[ALL, ...months]} value={filter.month ?? ALL}
          labels={Object.fromEntries([[ALL, "Any month"], ...months.map((m) => [m, monthName(m, true)])])}
          onChange={(m) => set({ month: m === ALL ? null : m })} />
      </Sheet>
      <Sheet visible={picking === "category"} onClose={() => setPicking(null)} title="Category">
        <Chips options={[ALL, ...CATEGORIES]} value={filter.category ?? ALL} labels={{ [ALL]: "Any category" }}
          onChange={(c) => set({ category: c === ALL ? null : c })} />
      </Sheet>
      <Sheet visible={picking === "account"} onClose={() => setPicking(null)} title="Account">
        <Chips options={[ALL, ...accounts.map((a) => a.accountId)]} value={filter.accountId ?? ALL}
          labels={Object.fromEntries([[ALL, "Any account"], ...accountName])}
          onChange={(a) => set({ accountId: a === ALL ? null : a })} />
      </Sheet>
      <Sheet visible={picking === "sort"} onClose={() => setPicking(null)} title="Sort by">
        <Chips options={Object.keys(SORTS) as Sort[]} value={filter.sort ?? "newest"} labels={SORT_LABELS}
          onChange={(sort) => set({ sort })} />
      </Sheet>
    </View>
  );
}

function FilterChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={{
      paddingHorizontal: space(3.5), paddingVertical: space(2), borderRadius: 999, borderWidth: 1,
      borderColor: on ? t.text : t.border, backgroundColor: on ? t.text : "transparent",
    }}>
      <Text style={{ color: on ? t.plane : t.textSecondary, fontSize: 13, fontWeight: on ? "600" : "400" }}>
        {label}
      </Text>
    </Pressable>
  );
}

const TxnRow = React.memo(function TxnRow({ txn, account, onPress }: {
  txn: Txn; account?: string; onPress: () => void;
}) {
  const t = useTheme();
  const s = textStyles(t);
  const label = txn.merchantName || txn.name || txn.merchantKey;
  const credit = txn.amount < 0;
  const adjusted = txn.cashback > 0 || txn.splitOwed > 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      flexDirection: "row", alignItems: "center", gap: space(3), paddingVertical: space(3),
      opacity: pressed ? 0.6 : 1,
    })}>
      <Avatar uri={txn.logoUrl} label={label} />
      <View style={{ flex: 1 }}>
        <Text style={s.primary} numberOfLines={1}>{label}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space(1.5), marginTop: 2 }}>
          <Text style={s.muted} numberOfLines={1}>
            {shortDate(txn.date)} · {txn.category}{account ? ` · ${account}` : ""}
          </Text>
          {txn.pending ? <Pill text="pending" /> : null}
          {txn.splitOwed > 0 ? <Pill text={txn.splitSettled ? "split · repaid" : "split"} tone={txn.splitSettled ? "good" : undefined} /> : null}
          {txn.cashback > 0 ? <Pill text={txn.cashbackReceived ? "cashback · in" : "cashback"} tone="good" /> : null}
          {txn.categorySource === "uncategorized" ? <Pill text="review" tone="warn" /> : null}
        </View>
      </View>
      <View>
        <Text style={[s.number, credit && { color: t.good }]}>{moneyExact(-txn.amount)}</Text>
        {adjusted ? <Text style={[s.muted, { textAlign: "right" }]}>yours {moneyExact(txn.net)}</Text> : null}
      </View>
    </Pressable>
  );
});
