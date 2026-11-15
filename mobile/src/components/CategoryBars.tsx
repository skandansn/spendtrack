import React from "react";
import { Pressable, Text, View } from "react-native";

import { C, T, radius, space } from "../theme";
import { money0 } from "../money";
import { Meter } from "../ui";

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
 * Spend by category, as ranked rows with a meter under each name.
 *
 * One series, so one colour for every bar. Colouring each bar by its own size
 * would double-encode the length the bar already shows, and burn the only free
 * channel on information that is right there.
 *
 * Every bar carries its value directly, which is also what keeps this readable
 * without the hover tooltip a phone cannot offer.
 */
export function CategoryBars({ rows, selected, onSelect }: Props) {
  if (!rows.length) {
    return <Text style={[T.label, { color: C.muted, textAlign: "center", paddingVertical: space(6) }]}>No spend in this period.</Text>;
  }
  const max = rows[0]!.amount;

  return (
    <View>
      {rows.map((row, i) => {
        const active = selected === row.category;
        return (
          <Pressable
            key={row.category}
            onPress={() => onSelect?.(active ? null : row.category)}
            style={({ pressed }) => ({
              flexDirection: "row", alignItems: "center", gap: space(3), paddingVertical: space(2),
              borderRadius: radius.row, opacity: pressed ? 0.6 : 1,
            })}
            accessibilityRole="button"
            accessibilityLabel={`${row.category}, ${money0(row.amount)}`}
          >
            <Text style={[T.rank, { color: C.muted, width: 22 }]}>{i + 1}</Text>
            <View style={{ flex: 1, gap: space(1.5) }}>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text style={[T.bodyStrong, { color: C.text, flex: 1 }]} numberOfLines={1}>{row.category}</Text>
                <Text style={[T.rank, { color: C.text }]}>{money0(row.amount)}</Text>
              </View>
              <Meter fraction={Math.max(row.amount / max, 0.015)}
                color={active || !selected ? C.accent : C.accentDim} />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
