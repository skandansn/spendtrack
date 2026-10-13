import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Theme, radius, space, useTheme } from "../theme";
import { money0 } from "../money";

export interface Row {
  category: string;
  amount: number;
}

interface Props {
  rows: Row[];
  selected?: string | null;
  onSelect?: (category: string | null) => void;
}

/**
 * Spend by category.
 *
 * One series, so one colour for every bar. Colouring each bar by its own size
 * would double-encode the length the bar already shows, and burn the only free
 * channel on information that is right there.
 *
 * Every bar carries its value directly, which is also what keeps this readable
 * without the hover tooltip a phone cannot offer.
 */
export function CategoryBars({ rows, selected, onSelect }: Props) {
  const theme = useTheme();
  const styles = sheet(theme);
  const max = Math.max(...rows.map((r) => r.amount), 1);

  if (!rows.length) {
    return <Text style={styles.empty}>No spend in this period.</Text>;
  }

  return (
    <View>
      {rows.map((row) => {
        const active = selected === row.category;
        return (
          <Pressable
            key={row.category}
            onPress={() => onSelect?.(active ? null : row.category)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`${row.category}, ${money0(row.amount)}`}
          >
            <Text style={styles.name} numberOfLines={1}>{row.category}</Text>
            <View style={styles.track}>
              <View style={[styles.fill, {
                width: `${Math.max((row.amount / max) * 100, 1.5)}%`,
                backgroundColor: theme.series[0],
                opacity: active || !selected ? 1 : 0.4,
              }]} />
            </View>
            <Text style={styles.value}>{money0(row.amount)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const sheet = (theme: Theme) => StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space(2), paddingVertical: space(1.5) },
  pressed: { opacity: 0.6 },
  name: { width: 88, textAlign: "right", color: theme.textSecondary, fontSize: 13 },
  track: { flex: 1, height: 18, justifyContent: "center" },
  // rounded only at the data end, so the bar stays anchored to its baseline
  fill: { height: "100%", borderTopRightRadius: 4, borderBottomRightRadius: 4, minWidth: 3 },
  value: { width: 72, textAlign: "right", color: theme.text, fontSize: 13,
           fontVariant: ["tabular-nums"] },
  empty: { color: theme.muted, textAlign: "center", paddingVertical: space(6) },
});

export const cardStyle = (theme: Theme) => ({
  backgroundColor: theme.surface,
  borderColor: theme.border,
  borderWidth: 1,
  borderRadius: radius.card,
  padding: space(5),
});
