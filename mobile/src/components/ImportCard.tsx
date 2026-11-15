import React, { useState } from "react";
import { Platform, StyleSheet, Text } from "react-native";

import { callImportLaptop, ImportResult } from "../firebase";
import { C, T, radius, space } from "../theme";
import { Button, Card } from "../ui";

/**
 * Bring the laptop's database into the cloud.
 *
 * Web only, and deliberately so: it reads a file you choose, which a browser can
 * do with no extra permissions, and the import runs once. Re-linking the banks
 * instead would cost Plaid Items that never come back.
 */
export function ImportCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (Platform.OS !== "web") {
    return (
      <Card title="Bring your data across">
        <Text style={s.body}>
          Open spendtrack in a browser on your laptop to import your existing accounts and
          transactions. It only needs doing once.
        </Text>
      </Card>
    );
  }

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setBusy(true);
      setError(null);
      try {
        const payload = JSON.parse(await file.text());
        const { data } = await callImportLaptop(payload);
        setResult(data);
      } catch (e) {
        setError((e as Error).message || String(e));
      } finally {
        setBusy(false);
      }
    };
    input.click();
  };

  return (
    <Card title="Bring your data across">
      {result ? (
        <Text style={s.done}>
          Imported {result.transactions.toLocaleString()} transactions across {result.months} months,
          {" "}{result.accounts} accounts at {result.institutions} institutions.
          {"\n\n"}Delete the export file now - it contains your bank access tokens.
        </Text>
      ) : (
        <>
          <Text style={s.body}>
            On your laptop, in the spendtrack folder, run:
          </Text>
          <Text style={s.code}>python -m spendtrack.cli export</Text>
          <Text style={[s.body, { marginBottom: space(4) }]}>
            then pick the file it writes. Your banks come across already linked, with every
            split, cashback and category you set - no re-linking, so no Plaid Items spent.
          </Text>
          <Button kind="primary" title="Choose export file" busy={busy} onPress={pick} />
          {busy ? <Text style={s.note}>Writing a couple of thousand documents - under a minute.</Text> : null}
          {error ? <Text style={s.error}>{error}</Text> : null}
        </>
      )}
    </Card>
  );
}

const s = StyleSheet.create({
  body: { ...T.label, color: C.muted },
  code: {
    ...T.label, color: C.text, fontFamily: Platform.select({ web: "ui-monospace, monospace", default: "monospace" }),
    backgroundColor: C.raised, borderRadius: radius.row, padding: space(3), marginVertical: space(3),
  },
  note: { ...T.small, color: C.muted, marginTop: space(2), textAlign: "center" },
  done: { ...T.label, color: C.accent },
  error: { ...T.label, color: C.down, marginTop: space(3) },
});
