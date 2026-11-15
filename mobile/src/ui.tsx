/**
 * The handful of building blocks every screen uses, in MusicStats' language:
 * borderless panels on a near-black ground, filled pills, one lime accent.
 */

import React, { ReactNode } from "react";
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle,
} from "react-native";

import { C, T, radius, space } from "./theme";

/** A panel. Tinted variants mark the one card on a screen that wants attention. */
export function Card({ title, note, action, children, style, tone }: {
  title?: string; note?: string; action?: ReactNode; children?: ReactNode; style?: ViewStyle;
  tone?: "accent" | "second";
}) {
  return (
    <View style={[{
      backgroundColor: tone === "accent" ? C.accentCard : tone === "second" ? C.secondCard : C.surface,
      borderRadius: radius.panel, padding: space(5),
    }, style]}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space(3) }}>
          <Text style={[T.section, { color: C.text, flex: 1 }]}>{title}</Text>
          {action}
        </View>
      ) : null}
      {note ? (
        <Text style={[T.label, { color: tone === "accent" ? C.accentInk : tone === "second" ? C.secondInk : C.muted,
          marginTop: space(1), marginBottom: space(3) }]}>{note}</Text>
      ) : title ? <View style={{ height: space(3) }} /> : null}
      {children}
    </View>
  );
}

export function Overline({ text, color = C.muted }: { text: string; color?: string }) {
  return <Text style={[T.overline, { color }]} numberOfLines={1}>{text}</Text>;
}

/** Overline above a Grotesk title, with room on the right for the screen's one action. */
export function ScreenHeader({ overline, title, trailing }: { overline: string; title: string; trailing?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", paddingTop: space(2) }}>
      <View style={{ flex: 1, gap: space(1) }}>
        <Overline text={overline} />
        <Text style={[T.title, { color: C.text }]}>{title}</Text>
      </View>
      {trailing}
    </View>
  );
}

export function Pill({ text, tone }: { text: string; tone?: "warn" | "good" | "second" }) {
  const [bg, fg] = tone === "warn" ? [C.downBg, C.down] : tone === "good" ? [C.accentBg, C.accent]
    : tone === "second" ? [C.secondBg, C.second] : [C.raised, C.muted];
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.pill, paddingHorizontal: space(2), paddingVertical: 3 }}>
      <Text style={[T.smallStrong, { color: fg }]} numberOfLines={1}>{text}</Text>
    </View>
  );
}

/** A percentage change, lime when it went the way you wanted and orange when it did not. */
export function ChangePill({ change, upIsGood = false }: { change: number; upIsGood?: boolean }) {
  const pct = Math.round(change * 100);
  const good = pct === 0 || (pct > 0) === upIsGood;
  return <Pill text={`${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`} tone={good ? "good" : "warn"} />;
}

/** A merchant's logo when Plaid has one, otherwise its initial on a raised tile. */
export function Avatar({ uri, label, size = 40 }: { uri?: string | null; label: string; size?: number }) {
  return (
    <View style={{
      width: size, height: size, borderRadius: radius.art, backgroundColor: C.raised, overflow: "hidden",
      alignItems: "center", justifyContent: "center",
    }}>
      <Text style={[T.rank, { color: C.muted }]}>{(label.trim()[0] ?? "?").toUpperCase()}</Text>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} /> : null}
    </View>
  );
}

export function Button({ title, onPress, kind = "secondary", busy, disabled, small }: {
  title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger" | "ghost";
  busy?: boolean; disabled?: boolean; small?: boolean;
}) {
  const bg = kind === "primary" ? C.accent : kind === "secondary" ? C.raised : kind === "danger" ? C.downBg : "transparent";
  const fg = kind === "primary" ? C.ground : kind === "danger" ? C.down : C.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy || disabled}
      style={({ pressed }) => ({
        backgroundColor: bg, borderRadius: radius.pill,
        height: small ? 34 : 44, paddingHorizontal: small ? space(3.5) : space(5),
        alignItems: "center", justifyContent: "center",
        opacity: pressed ? 0.7 : disabled ? 0.4 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={fg} />
        : <Text style={[small ? T.labelStrong : T.bodyStrong, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginBottom: space(3) }}>
      {label ? <Text style={[T.small, { color: C.muted, marginBottom: space(1.5) }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={C.faint}
        selectionColor={C.accent}
        style={[T.body, {
          color: C.text, backgroundColor: C.raised, borderRadius: radius.row,
          paddingHorizontal: space(3.5), paddingVertical: space(3),
        }, style]}
        {...rest}
      />
    </View>
  );
}

export function SearchField({ value, onChangeText }: { value: string; onChangeText: (v: string) => void }) {
  return (
    <TextInput value={value} onChangeText={onChangeText} placeholder="Search merchants"
      placeholderTextColor={C.muted} selectionColor={C.accent}
      autoCapitalize="none" autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing"
      style={[T.body, {
        color: C.text, backgroundColor: C.surface, borderRadius: radius.pill,
        height: 44, paddingHorizontal: space(4.5),
      }]} />
  );
}

/** A pill-shaped option: lime when on. */
export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      height: 36, paddingHorizontal: space(3.5), borderRadius: radius.pill, justifyContent: "center",
      backgroundColor: on ? C.accent : C.raised, opacity: pressed ? 0.7 : 1,
    })}>
      <Text style={[T.labelStrong, { color: on ? C.ground : C.text }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

/** A wrap of tappable options, one selected. */
export function Chips<K extends string>({ options, value, onChange, labels }: {
  options: readonly K[]; value: K | null; onChange: (v: K) => void; labels?: Partial<Record<K, string>>;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(1.5) }}>
      {options.map((o) => (
        <Chip key={o} label={labels?.[o] ?? o} on={o === value} onPress={() => onChange(o)} />
      ))}
    </View>
  );
}

/** A thin rounded progress bar. */
export function Meter({ fraction, color = C.accent, height = 4 }: { fraction: number; color?: string; height?: number }) {
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: C.raised, overflow: "hidden" }}>
      <View style={{ width: `${Math.min(Math.max(fraction, 0), 1) * 100}%`, height: "100%",
        borderRadius: height / 2, backgroundColor: color }} />
    </View>
  );
}

/** A bottom sheet. Tapping outside closes it, as everywhere else on Android. */
export function Sheet({ visible, onClose, title, subtitle, children }: {
  visible: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }} />
        </Pressable>
        <View style={{ flex: 1, justifyContent: "flex-end" }} pointerEvents="box-none">
          <View style={{
            backgroundColor: C.surface, borderTopLeftRadius: radius.panel, borderTopRightRadius: radius.panel,
            maxHeight: "88%", paddingBottom: space(6),
          }}>
            <View style={{ alignItems: "center", paddingTop: space(2.5) }}>
              <View style={{ width: 32, height: 4, borderRadius: 2, backgroundColor: C.faint }} />
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: space(6), paddingTop: space(4) }}
              keyboardShouldPersistTaps="handled">
              <Text style={[T.section, { color: C.text }]}>{title}</Text>
              {subtitle ? <Text style={[T.label, { color: C.muted, marginTop: space(1), marginBottom: space(4) }]}>{subtitle}</Text>
                : <View style={{ height: space(4) }} />}
              {children}
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export const Row = ({ children, style }: { children: ReactNode; style?: ViewStyle }) => (
  <View style={[{ flexDirection: "row", alignItems: "center", gap: space(3) }, style]}>{children}</View>
);

export function Divided({ children }: { children: ReactNode[] }) {
  return (
    <View>
      {children.map((child, i) => (
        <View key={i} style={{
          paddingVertical: space(3), borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: C.line,
        }}>{child}</View>
      ))}
    </View>
  );
}

export const S = StyleSheet.create({
  primary: { ...T.bodyStrong, color: C.text },
  secondary: { ...T.label, color: C.muted },
  muted: { ...T.small, color: C.muted },
  number: { ...T.rank, color: C.text, textAlign: "right" },
  error: { ...T.label, color: C.down, marginTop: space(2) },
});

/** Side and bottom padding every scrolling screen shares. */
export const screen = { paddingHorizontal: space(5), paddingTop: space(3), paddingBottom: space(7), gap: space(5) };
