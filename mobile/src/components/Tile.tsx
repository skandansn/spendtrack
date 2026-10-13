import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Theme, radius, space, useTheme } from "../theme";

interface Props {
  label: string;
  value: string;
  foot?: string;
  tone?: "good" | "bad";
  hero?: boolean;
}

/** A single figure. The hero variant is for the one number a screen leads with. */
export function Tile({ label, value, foot, tone, hero }: Props) {
  const theme = useTheme();
  const styles = sheet(theme);
  return (
    <View style={[styles.tile, hero && styles.hero]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, hero && styles.heroValue]} numberOfLines={1}
            adjustsFontSizeToFit minimumFontScale={0.6}>
        {value}
      </Text>
      {foot ? (
        <Text style={[styles.foot,
          tone === "good" && { color: theme.good },
          tone === "bad" && { color: theme.critical }]}>
          {foot}
        </Text>
      ) : null}
    </View>
  );
}

const sheet = (theme: Theme) => StyleSheet.create({
  tile: {
    flexGrow: 1, flexBasis: "46%",
    backgroundColor: theme.surface,
    borderColor: theme.border, borderWidth: 1,
    borderRadius: radius.card,
    padding: space(4),
  },
  hero: { flexBasis: "100%" },
  label: { color: theme.textSecondary, fontSize: 13, fontWeight: "500", marginBottom: space(2) },
  value: { color: theme.text, fontSize: 28, fontWeight: "700", letterSpacing: -0.8 },
  heroValue: { fontSize: 44, letterSpacing: -1.6 },
  foot: { color: theme.muted, fontSize: 12, marginTop: space(1.5) },
});
