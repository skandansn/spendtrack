import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";

import {
  CATEGORIES, PAYOUTS, Txn, clearCashback, clearSplit, round2, setCashback, setCategory, setSplit,
} from "../data";
import { moneyExact, shortDate } from "../money";
import { space, useTheme } from "../theme";
import { Button, Chips, Field, Row, Sheet, textStyles } from "../ui";

type Mode = "category" | "split" | "cashback";

/**
 * Everything you can do to one transaction: recategorise it, split it, mark
 * cashback on it. One sheet with three tabs rather than three dialogs, so the
 * transaction stays in view while you choose.
 */
export function TxnSheet({ txn, onClose, onChanged }: {
  txn: Txn | null; onClose: () => void; onChanged: () => void;
}) {
  const t = useTheme();
  const s = textStyles(t);
  const [mode, setMode] = useState<Mode>("category");
  useEffect(() => { setMode("category"); }, [txn?.txnId]);
  if (!txn) return null;

  const label = txn.merchantName || txn.name || txn.merchantKey;
  const credit = txn.amount <= 0;
  const modes: Mode[] = credit ? ["category"] : ["category", "split", "cashback"];

  return (
    <Sheet visible onClose={onClose} title={label}
      subtitle={`${shortDate(txn.date)} · ${moneyExact(Math.abs(txn.amount))}${credit ? " credit" : ""}${txn.pending ? " · pending" : ""}`}>
      {modes.length > 1 ? (
        <View style={{ marginBottom: space(4) }}>
          <Chips options={modes} value={mode} onChange={setMode}
            labels={{ category: "Category", split: "Split", cashback: "Cashback" }} />
        </View>
      ) : null}
      {mode === "category" ? <CategoryTab txn={txn} done={() => { onChanged(); onClose(); }} /> : null}
      {mode === "split" ? <SplitTab txn={txn} done={() => { onChanged(); onClose(); }} /> : null}
      {mode === "cashback" ? <CashbackTab txn={txn} done={() => { onChanged(); onClose(); }} /> : null}
      {credit ? <Text style={[s.muted, { marginTop: space(4) }]}>Credits can be recategorised, but splits and cashback apply to purchases.</Text> : null}
    </Sheet>
  );
}

function CategoryTab({ txn, done }: { txn: Txn; done: () => void }) {
  const t = useTheme();
  const [scope, setScope] = useState<"merchant" | "one">(txn.p2p ? "one" : "merchant");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View>
      <View style={{ marginBottom: space(3) }}>
        <Chips options={["merchant", "one"] as const} value={scope} onChange={setScope}
          labels={{ merchant: "Every one from them", one: "Just this one" }} />
      </View>
      <Text style={[textStyles(t).muted, { marginBottom: space(3) }]}>
        {scope === "merchant"
          ? "Past and future transactions from this merchant follow your answer."
          : "Only this transaction changes."}
      </Text>
      <Chips options={CATEGORIES} value={txn.category as (typeof CATEGORIES)[number]} onChange={async (c) => {
        if (busy) return;
        setBusy(true); setError(null);
        try { await setCategory(txn, c, scope); done(); }
        catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
      }} />
      {busy ? <Text style={{ color: t.muted, marginTop: space(3) }}>Saving…</Text> : null}
      {error ? <Text style={textStyles(t).error}>{error}</Text> : null}
    </View>
  );
}

/**
 * Three ways to say it: split between N people (you included, so N = 1 is you
 * alone and cannot mean "all theirs"), a dollar figure owed to you, or none of
 * it was yours. That last mode is its own option precisely because no number of
 * people expresses it.
 */
function SplitTab({ txn, done }: { txn: Txn; done: () => void }) {
  const t = useTheme();
  const s = textStyles(t);
  const has = txn.splitOwed > 0;
  const whole = has && Math.abs(txn.splitOwed - txn.amount) < 0.005;
  const ways = has && !whole ? txn.amount / (txn.amount - txn.splitOwed) : 2;
  const even = has && !whole && Math.abs(ways - Math.round(ways)) < 0.01 && Math.round(ways) <= 10;

  const [mode, setMode] = useState<"ways" | "amount" | "all">(whole ? "all" : !has || even ? "ways" : "amount");
  const [value, setValue] = useState(!has || whole ? "2" : even ? String(Math.round(ways)) : txn.splitOwed.toFixed(2));
  const [note, setNote] = useState(txn.splitNote ?? "");
  const [everyCharge, setEveryCharge] = useState(txn.splitSource === "rule");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = parseFloat(value);
  const owed = mode === "all" ? txn.amount
    : mode === "amount" ? Math.min(Number.isFinite(n) ? n : 0, txn.amount)
    : n >= 1 ? round2(txn.amount * (1 - 1 / n)) : 0;
  const mine = Math.max(txn.amount - owed, 0);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const myShare = mode === "all" ? 0 : mode === "ways" ? 1 / n : undefined;
      await setSplit(txn, { myShare, owed: mode === "amount" ? owed : undefined, note, everyCharge });
      done();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <View>
      <View style={{ marginBottom: space(3) }}>
        <Chips options={["ways", "amount", "all"] as const} value={mode} onChange={setMode}
          labels={{ ways: "Split evenly", amount: "They owe me $", all: "None of it is mine" }} />
      </View>
      {mode !== "all" ? (
        <Field label={mode === "ways" ? "Between how many people, you included" : "They owe me"}
          keyboardType="decimal-pad" value={value} onChangeText={(v) => setValue(v.replace(/[^0-9.]/g, ""))} />
      ) : null}
      <Field label="With" placeholder="flatmate, Priya, the group…" value={note} onChangeText={setNote} />
      <View style={{ marginBottom: space(3) }}>
        <Chips options={["once", "always"] as const} value={everyCharge ? "always" : "once"}
          onChange={(v) => setEveryCharge(v === "always")}
          labels={{ once: "Just this charge", always: "Every charge from them" }} />
      </View>
      <Text style={[s.secondary, { marginBottom: space(4) }]}>
        {owed > 0
          ? mine < 0.005 ? `${moneyExact(owed)} owed to you · none of it counts as your spend`
            : `${moneyExact(owed)} owed to you · counts as ${moneyExact(mine)} of your spend`
          : "Enter how it splits."}
      </Text>
      <Row>
        {has ? <Button kind="danger" title="Remove" onPress={async () => {
          setBusy(true);
          try { await clearSplit(txn, txn.splitSource === "rule"); done(); } finally { setBusy(false); }
        }} /> : null}
        <View style={{ flex: 1 }} />
        <Button kind="primary" title="Save" busy={busy} disabled={!(owed > 0) && mode !== "all"} onPress={save} />
      </Row>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
}

function CashbackTab({ txn, done }: { txn: Txn; done: () => void }) {
  const t = useTheme();
  const s = textStyles(t);
  const has = txn.cashback > 0;
  const [unit, setUnit] = useState<"percent" | "amount">(has && txn.cashbackPct == null ? "amount" : "percent");
  const [value, setValue] = useState(has ? String(txn.cashbackPct ?? txn.cashback) : "");
  const [payout, setPayout] = useState(txn.cashbackPayout ?? "amex_mr");
  const [source, setSource] = useState(txn.cashbackSource ?? "Rakuten");
  const [received, setReceived] = useState(txn.cashbackReceived);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = parseFloat(value);
  const back = !(n > 0) ? 0 : unit === "percent" ? round2(txn.amount * n / 100) : n;
  const p = PAYOUTS[payout];

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await setCashback(txn, { ...(unit === "percent" ? { percent: n } : { amount: n }), payout, source, received });
      done();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <View>
      <View style={{ marginBottom: space(3) }}>
        <Chips options={["percent", "amount"] as const} value={unit} onChange={setUnit}
          labels={{ percent: "Percent back", amount: "Dollars back" }} />
      </View>
      <Field label={unit === "percent" ? "Percent" : "Dollars"} keyboardType="decimal-pad" value={value}
        onChangeText={(v) => setValue(v.replace(/[^0-9.]/g, ""))} />
      <Text style={[s.secondary, { marginBottom: space(2) }]}>Paid out as</Text>
      <View style={{ marginBottom: space(3) }}>
        <Chips options={Object.keys(PAYOUTS)} value={payout} onChange={setPayout}
          labels={Object.fromEntries(Object.entries(PAYOUTS).map(([k, v]) => [k, v.label]))} />
      </View>
      <Field label="From" value={source} onChangeText={setSource} />
      <View style={{ marginBottom: space(3) }}>
        <Chips options={["pending", "received"] as const} value={received ? "received" : "pending"}
          onChange={(v) => setReceived(v === "received")}
          labels={{ pending: "Not paid out yet", received: "Already received" }} />
      </View>
      <Text style={[s.secondary, { marginBottom: space(4) }]}>
        {back > 0
          ? `${moneyExact(back)} back${p?.points ? ` · ${Math.round(back * 100).toLocaleString()} ${p.label} points` : ""} · counts as ${moneyExact(Math.max(txn.amount - back, 0))} of spend`
          : "Enter how much comes back."}
      </Text>
      <Row>
        {has ? <Button kind="danger" title="Remove" onPress={async () => {
          setBusy(true);
          try { await clearCashback(txn); done(); } finally { setBusy(false); }
        }} /> : null}
        <View style={{ flex: 1 }} />
        <Button kind="primary" title="Save" busy={busy} disabled={!(back > 0)} onPress={save} />
      </Row>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
}
