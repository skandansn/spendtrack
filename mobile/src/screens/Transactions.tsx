import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";

import { TxnSheet } from "../components/TxnSheet";
import {
  CATEGORIES, SORTS, Sort, Txn, TxnFilter, recentMonths, searchWords, useAccounts, useTransactions,
} from "../data";
import { moneyExact, monthName, shortDate } from "../money";
import { C, space } from "../theme";
import { Avatar, Chip, Chips, Pill, S, ScreenHeader, SearchField, Sheet } from "../ui";

const ALL = "all";
const SORT_LABELS: Record<Sort, string> = {
  newest: "Newest", oldest: "Oldest", largest: "Largest", smallest: "Smallest", merchant: "Merchant A-Z",
};

export function Transactions({ filter, onFilter }: {
  filter: TxnFilter; onFilter: (f: TxnFilter) => void;
}) {
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
    <View style={{ gap: space(4), marginBottom: space(3) }}>
      <ScreenHeader overline={filter.month ? monthName(filter.month, true) : "Every month"} title="Transactions" />
      <SearchField value={text} onChangeText={setText} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(1.5) }}>
        <Chip label={filter.month ? monthName(filter.month, true) : "Any month"} on={!!filter.month}
          onPress={() => setPicking("month")} />
        <Chip label={filter.category ?? "Any category"} on={!!filter.category}
          onPress={() => setPicking("category")} />
        <Chip label={filter.accountId ? accountName.get(filter.accountId) ?? "Account" : "Any account"}
          on={!!filter.accountId} onPress={() => setPicking("account")} />
        {!filter.category ? (
          <Chip label="Transfers" on={!!filter.includeTransfers}
            onPress={() => set({ includeTransfers: !filter.includeTransfers })} />
        ) : null}
        <Chip label={SORT_LABELS[filter.sort ?? "newest"]} on={(filter.sort ?? "newest") !== "newest"}
          onPress={() => setPicking("sort")} />
        {filter.month || filter.category || filter.accountId || filter.q ? (
          <Chip label="Clear" on={false} onPress={() => onFilter({})} />
        ) : null}
      </View>
      {filter.q && rows.length >= 500 ? (
        <Text style={S.muted}>Showing the newest 500 matches - add a word to narrow it.</Text>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.ground }}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.txnId}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingHorizontal: space(5), paddingTop: space(3), paddingBottom: space(7) }}
        onEndReachedThreshold={0.5}
        onEndReached={more}
        refreshing={false}
        onRefresh={reload}
        renderItem={({ item }) => (
          <TxnRow txn={item} account={accountName.get(item.accountId)} onPress={() => setOpen(item)} />
        )}
        ListEmptyComponent={loading ? null
          : <Text style={[error ? S.error : S.muted, { textAlign: "center", paddingVertical: space(10) }]}>
              {error ?? "Nothing matches."}
            </Text>}
        ListFooterComponent={loading
          ? <ActivityIndicator style={{ marginVertical: space(6) }} color={C.muted} />
          : done && rows.length ? <Text style={[S.muted, { textAlign: "center", marginTop: space(4) }]}>That's everything.</Text> : null}
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

const TxnRow = React.memo(function TxnRow({ txn, account, onPress }: {
  txn: Txn; account?: string; onPress: () => void;
}) {
  const label = txn.merchantName || txn.name || txn.merchantKey;
  const credit = txn.amount < 0;
  const adjusted = txn.cashback > 0 || txn.splitOwed > 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      flexDirection: "row", alignItems: "center", gap: space(3), paddingVertical: space(2.5),
      opacity: pressed ? 0.6 : 1,
    })}>
      <Avatar uri={txn.logoUrl} label={label} />
      <View style={{ flex: 1 }}>
        <Text style={S.primary} numberOfLines={1}>{label}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space(1.5), marginTop: 3 }}>
          <Text style={S.muted} numberOfLines={1}>
            {shortDate(txn.date)} · {txn.category}{account ? ` · ${account}` : ""}
          </Text>
          {txn.pending ? <Pill text="pending" /> : null}
          {txn.duplicateOf ? <Pill text="via PayPal · counted there" /> : null}
          {txn.splitOwed > 0 ? <Pill text={txn.splitSettled ? "split · repaid" : "split"} tone={txn.splitSettled ? "good" : undefined} /> : null}
          {txn.cashback > 0 ? <Pill text={txn.cashbackReceived ? "cashback · in" : "cashback"} tone="good" /> : null}
          {txn.categorySource === "uncategorized" ? <Pill text="review" tone="warn" /> : null}
        </View>
      </View>
      <View>
        <Text style={[S.number, credit && { color: C.accent }]}>{moneyExact(-txn.amount)}</Text>
        {adjusted ? <Text style={[S.muted, { textAlign: "right" }]}>yours {moneyExact(txn.net)}</Text> : null}
      </View>
    </Pressable>
  );
});
