import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { signOut } from "firebase/auth";

import { ImportCard } from "../components/ImportCard";
import { LinkBank } from "../components/LinkBank";
import { Account, useAccounts, useInstitutions } from "../data";
import { auth, callRepair } from "../firebase";
import { daysUntil, money0, moneyExact, shortDate } from "../money";
import { C, T, space } from "../theme";
import { Avatar, Button, Card, Divided, Pill, Row, S, ScreenHeader, screen } from "../ui";

export function Accounts() {
  const accounts = useAccounts();
  const institutions = useInstitutions();
  const [repairing, setRepairing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const byItem = new Map<string, Account[]>();
  for (const a of accounts) byItem.set(a.itemId, [...(byItem.get(a.itemId) ?? []), a]);

  const repair = async () => {
    setRepairing(true); setNote(null);
    try {
      const { data } = await callRepair();
      setNote(`Recounted ${data.transactions.toLocaleString()} transactions across ${data.months} months.`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setRepairing(false);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: C.ground }}
      contentContainerStyle={screen}>
      <ScreenHeader title="Accounts"
        overline={`${institutions.length} bank${institutions.length === 1 ? "" : "s"} · ${accounts.length} account${accounts.length === 1 ? "" : "s"}`} />

      {institutions.map((inst) => {
        const broken = inst.status === "login_required";
        return (
          <Card key={inst.itemId}>
            <Row style={{ marginBottom: space(2) }}>
              <Avatar uri={inst.logo ? `data:image/png;base64,${inst.logo}` : null} label={inst.name ?? "?"} />
              <Text style={[T.section, { color: C.text, flex: 1 }]} numberOfLines={1}>{inst.name ?? "Bank"}</Text>
              {broken ? <Pill text="sign-in needed" tone="warn" /> : null}
            </Row>
            <Divided>
              {(byItem.get(inst.itemId) ?? []).map((a) => <AccountRow key={a.accountId} a={a} />)}
            </Divided>
            {broken ? (
              <View style={{ marginTop: space(3) }}>
                <LinkBank itemId={inst.itemId} label={`Sign back in to ${inst.name ?? "the bank"}`} onLinked={() => {}} />
              </View>
            ) : null}
          </Card>
        );
      })}

      <Card title="Add a bank or card">
        <View style={{ marginTop: space(3) }}>
          <LinkBank onLinked={() => {}} />
        </View>
      </Card>

      {!accounts.length ? <ImportCard /> : null}

      <Card title="Housekeeping"
        note="Recount rebuilds every monthly total from the transactions themselves. Sync already does this every Sunday; use it if a figure ever looks off.">
        <Row>
          <Button title="Recount totals" busy={repairing} onPress={repair} />
          <View style={{ flex: 1 }} />
          <Button kind="danger" title="Sign out" onPress={() => void signOut(auth)} />
        </Row>
        {note ? <Text style={[S.secondary, { marginTop: space(3) }]}>{note}</Text> : null}
        <Text style={[S.muted, { marginTop: space(3) }]}>Signed in as {auth.currentUser?.email}</Text>
      </Card>
    </ScrollView>
  );
}

function AccountRow({ a }: { a: Account }) {
  const credit = a.type === "credit";
  const balance = credit ? a.currentBalance : a.availableBalance ?? a.currentBalance;
  const due = a.nextPaymentDueDate ? daysUntil(a.nextPaymentDueDate) : null;
  const details = [
    a.subtype,
    credit && a.creditLimit ? `${money0(a.creditLimit)} limit` : null,
    credit && a.aprPercentage ? `${a.aprPercentage}% APR` : null,
  ].filter(Boolean).join(" · ");

  return (
    <Row>
      <View style={{ flex: 1 }}>
        <Text style={S.primary} numberOfLines={1}>{a.name}{a.mask ? ` ·${a.mask}` : ""}</Text>
        {details ? <Text style={S.muted}>{details}</Text> : null}
        {credit && a.nextPaymentDueDate ? (
          <Text style={[S.muted, (a.isOverdue || (due != null && due <= 3)) && { color: C.down }]}>
            {a.isOverdue ? "Overdue" : `Due ${shortDate(a.nextPaymentDueDate)}${due != null && due >= 0 ? ` · in ${due}d` : ""}`}
          </Text>
        ) : null}
      </View>
      <View>
        <Text style={S.number}>{balance == null ? "—" : moneyExact(balance)}</Text>
        {credit && a.creditLimit && balance != null ? (
          <Text style={[S.muted, { textAlign: "right" }]}>{Math.round((balance / a.creditLimit) * 100)}% used</Text>
        ) : null}
      </View>
    </Row>
  );
}
