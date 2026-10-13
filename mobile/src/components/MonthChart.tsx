import React, { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { MonthTotals } from "../data";
import { money0, monthName } from "../money";
import { space, useTheme } from "../theme";

const TOP = 7;
const HEIGHT = 170;

/**
 * Spend by month, stacked by category.
 *
 * The seven biggest categories over the whole window get the seven palette
 * slots, in rank order, and keep them - colour follows the category, not where
 * it falls in any one month, so a bar never repaints when another month changes.
 * Everything else shares the eighth slot as "Other", rather than an invented
 * ninth hue no one could tell apart.
 *
 * A phone has no hover, so tapping a segment pins its figure under the chart.
 */
export function MonthChart({ months, totals }: { months: string[]; totals: Map<string, MonthTotals> }) {
  const t = useTheme();
  const [picked, setPicked] = useState<{ month: string; category: string; amount: number } | null>(null);
  const ordered = useMemo(() => [...months].reverse(), [months]);   // oldest on the left

  const { stack, max } = useMemo(() => {
    const overall = new Map<string, number>();
    for (const m of months) {
      for (const [c, v] of Object.entries(totals.get(m)?.byCategory ?? {})) {
        if (v > 0) overall.set(c, (overall.get(c) ?? 0) + v);
      }
    }
    const ranked = [...overall.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const top = ranked.slice(0, TOP);
    const order = [...top, ...(ranked.length > TOP ? ["Other"] : [])];
    // "Other" can be a real category in the top seven too; it keeps one slot
    const unique = [...new Set(order)];

    let max = 0;
    for (const m of months) {
      const sum = Object.values(totals.get(m)?.byCategory ?? {}).reduce((a, v) => a + Math.max(v, 0), 0);
      max = Math.max(max, sum);
    }
    return { stack: unique, max: niceCeil(max) };
  }, [months, totals]);

  const colour = (category: string) =>
    t.series[Math.min(stack.indexOf(category), t.series.length - 1)] ?? t.series[t.series.length - 1]!;

  const segments = (month: string) => {
    const byCategory = totals.get(month)?.byCategory ?? {};
    const folded = new Map<string, number>();
    for (const [c, v] of Object.entries(byCategory)) {
      if (v <= 0) continue;
      const key = stack.slice(0, TOP).includes(c) ? c : "Other";
      folded.set(key, (folded.get(key) ?? 0) + v);
    }
    // largest at the base, so the bottom segment is the stable one between months
    return stack.filter((c) => folded.has(c)).map((c) => ({ category: c, amount: folded.get(c)! }));
  };

  if (!max) return <Text style={{ color: t.muted, textAlign: "center", padding: space(6) }}>No spend yet.</Text>;

  return (
    <View>
      <View style={{ flexDirection: "row" }}>
        <View style={{ width: 46, height: HEIGHT, justifyContent: "space-between" }}>
          {[1, 0.75, 0.5, 0.25, 0].map((f) => (
            <Text key={f} style={{ color: t.muted, fontSize: 10, textAlign: "right", paddingRight: space(1.5),
              fontVariant: ["tabular-nums"] }}>{money0(max * f)}</Text>
          ))}
        </View>
        <View style={{ flex: 1, height: HEIGHT }}>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <View key={f} style={{ position: "absolute", left: 0, right: 0, top: f * (HEIGHT - 1),
              borderTopWidth: 1, borderTopColor: t.grid }} />
          ))}
          <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-end", gap: space(1.5) }}>
            {ordered.map((month) => (
              <View key={month} style={{ flex: 1, height: "100%", justifyContent: "flex-end", gap: 2 }}>
                {segments(month).reverse().map((s, i, all) => (
                  <Pressable key={s.category} onPress={() => setPicked({ month, ...s })}
                    hitSlop={{ left: 4, right: 4 }}
                    style={{
                      height: `${(s.amount / max) * 100}%`, minHeight: 2,
                      backgroundColor: colour(s.category),
                      borderTopLeftRadius: i === 0 ? 4 : 1, borderTopRightRadius: i === 0 ? 4 : 1,
                      borderBottomLeftRadius: i === all.length - 1 ? 0 : 1,
                      borderBottomRightRadius: i === all.length - 1 ? 0 : 1,
                      opacity: picked && (picked.month !== month || picked.category !== s.category) ? 0.45 : 1,
                    }} />
                ))}
              </View>
            ))}
          </View>
        </View>
      </View>
      <View style={{ flexDirection: "row", marginLeft: 46, marginTop: space(1.5), gap: space(1.5) }}>
        {ordered.map((m) => (
          <Text key={m} style={{ flex: 1, color: t.muted, fontSize: 10, textAlign: "center" }}>
            {monthName(m)}
          </Text>
        ))}
      </View>

      <Text style={{ color: picked ? t.text : t.muted, fontSize: 13, marginTop: space(3), minHeight: 18 }}>
        {picked
          ? `${picked.category} in ${monthName(picked.month, true)}: ${money0(picked.amount)}`
          : "Tap a segment for its figure."}
      </Text>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(3), marginTop: space(2) }}>
        {stack.map((c) => (
          <View key={c} style={{ flexDirection: "row", alignItems: "center", gap: space(1.5) }}>
            <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: colour(c) }} />
            <Text style={{ color: t.textSecondary, fontSize: 12 }}>{c}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil((v / mag) * 2) / 2 * mag;
}
