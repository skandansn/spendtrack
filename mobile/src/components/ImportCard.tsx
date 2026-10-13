import React, { useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { callImportLaptop, ImportResult } from "../firebase";
import { Theme, radius, space, useTheme } from "../theme";
import { cardStyle } from "./CategoryBars";

/**
 * Bring the laptop's database into the cloud.
 *
 * Web only, and deliberately so: it reads a file you choose, which a browser can
 * do with no extra permissions, and the import runs once. Re-linking the banks
 * instead would cost Plaid Items that never come back.
 */
export function ImportCard() {
  const theme = useTheme();
  const s = sheet(theme);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (Platform.OS !== "web") {
    return (
      <View style={cardStyle(theme)}>
        <Text style={s.title}>Bring your data across</Text>
        <Text style={s.body}>
          Open spendtrack in a browser on your laptop to import your existing accounts and
          transactions. It only needs doing once.
        </Text>
      </View>
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
    <View style={cardStyle(theme)}>
      <Text style={s.title}>Bring your data across</Text>
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
          <Text style={s.body}>
            then pick the file it writes. Your banks come across already linked, with every
            split, cashback and category you set - no re-linking, so no Plaid Items spent.
          </Text>
          <Pressable style={s.button} onPress={pick} disabled={busy}>
            {busy ? <ActivityIndicator color={theme.plane} />
                  : <Text style={s.buttonText}>Choose export file</Text>}
          </Pressable>
          {busy ? <Text style={s.note}>Writing a couple of thousand documents - under a minute.</Text> : null}
          {error ? <Text style={s.error}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}

const sheet = (theme: Theme) => StyleSheet.create({
  title: { color: theme.text, fontSize: 17, fontWeight: "600", marginBottom: space(2) },
  body: { color: theme.textSecondary, fontSize: 14, lineHeight: 20 },
  code: {
    color: theme.text, fontFamily: Platform.select({ web: "ui-monospace, monospace", default: "monospace" }),
    backgroundColor: theme.plane, borderRadius: radius.small, padding: space(3),
    marginVertical: space(3), fontSize: 13,
  },
  button: {
    backgroundColor: theme.text, borderRadius: radius.pill, paddingVertical: space(3.5),
    alignItems: "center", marginTop: space(4),
  },
  buttonText: { color: theme.plane, fontWeight: "700" },
  note: { color: theme.muted, fontSize: 12, marginTop: space(2), textAlign: "center" },
  done: { color: theme.good, fontSize: 14, lineHeight: 20 },
  error: { color: theme.critical, marginTop: space(3) },
});
