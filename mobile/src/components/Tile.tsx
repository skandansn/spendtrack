import React from "react";
import { Text, View } from "react-native";

import { C, T, radius, space } from "../theme";

interface Props {
  label: string;
  value: string;
  foot?: string;
  tone?: "good" | "bad";
}

/** A single figure, two to a row. */
export function Tile({ label, value, foot, tone }: Props) {
  return (
    <View style={{
      flexGrow: 1, flexBasis: "46%", backgroundColor: C.surface, borderRadius: radius.tile,
      padding: space(3.5), gap: space(1),
    }}>
      <Text style={[T.small, { color: C.muted }]}>{label}</Text>
      <Text style={[T.stat, { color: C.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {value}
      </Text>
      {foot ? (
        <Text style={[T.smallStrong, { color: tone === "good" ? C.accent : tone === "bad" ? C.down : C.muted }]}
          numberOfLines={2}>
          {foot}
        </Text>
      ) : null}
    </View>
  );
}
