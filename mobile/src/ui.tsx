/**
 * The handful of building blocks every screen uses, carrying the web
 * dashboard's look: soft cards, pill controls, one accent.
 */

import React, { ReactNode } from "react";
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle,
} from "react-native";

import { Theme, radius, space, useTheme } from "./theme";

export function Card({ title, note, action, children, style }: {
  title?: string; note?: string; action?: ReactNode; children?: ReactNode; style?: ViewStyle;
}) {
  const t = useTheme();
  return (
    <View style={[{
      backgroundColor: t.surface, borderColor: t.border, borderWidth: 1,
      borderRadius: radius.card, padding: space(5),
    }, style]}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: t.text, fontSize: 17, fontWeight: "600", letterSpacing: -0.3, flex: 1 }}>
            {title}
          </Text>
          {action}
        </View>
      ) : null}
      {note ? <Text style={{ color: t.muted, fontSize: 13, marginTop: space(1), marginBottom: space(3) }}>{note}</Text> : null}
      {children}
    </View>
  );
}

export function Pill({ text, tone }: { text: string; tone?: "warn" | "good" }) {
  const t = useTheme();
  const color = tone === "warn" ? t.critical : tone === "good" ? t.good : t.textSecondary;
  return (
    <View style={{
      borderWidth: 1, borderColor: tone ? color : t.border, borderRadius: radius.pill,
      paddingHorizontal: space(2), paddingVertical: 1,
    }}>
      <Text style={{ color, fontSize: 11 }}>{text}</Text>
    </View>
  );
}

/** A merchant's logo when Plaid has one, otherwise its initial on a tint. */
export function Avatar({ uri, label, size = 32 }: { uri?: string | null; label: string; size?: number }) {
  const t = useTheme();
  if (uri) {
    return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2,
      backgroundColor: t.grid }} />;
  }
  return (
    <View style={{
      width: size, height: size, borderRadius: size / 2, backgroundColor: t.grid,
      alignItems: "center", justifyContent: "center",
    }}>
      <Text style={{ color: t.textSecondary, fontWeight: "700", fontSize: size * 0.42 }}>
        {(label.trim()[0] ?? "?").toUpperCase()}
      </Text>
    </View>
  );
}

export function Button({ title, onPress, kind = "secondary", busy, disabled, small }: {
  title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger" | "ghost";
  busy?: boolean; disabled?: boolean; small?: boolean;
}) {
  const t = useTheme();
  const filled = kind === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={busy || disabled}
      style={({ pressed }) => ({
        backgroundColor: filled ? t.text : "transparent",
        borderColor: kind === "ghost" ? "transparent" : filled ? t.text : t.border,
        borderWidth: 1, borderRadius: radius.pill,
        paddingHorizontal: small ? space(3) : space(4.5),
        paddingVertical: small ? space(1.5) : space(3),
        alignItems: "center", justifyContent: "center",
        opacity: pressed || disabled ? 0.6 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={filled ? t.plane : t.muted} />
        : <Text style={{
            color: filled ? t.plane : kind === "danger" ? t.critical : t.text,
            fontWeight: filled ? "700" : "500", fontSize: small ? 12 : 14,
          }}>{title}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const t = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginBottom: space(3) }}>
      {label ? <Text style={{ color: t.textSecondary, fontSize: 12, marginBottom: space(1.5) }}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={t.muted}
        style={[{
          color: t.text, backgroundColor: t.plane, borderWidth: 1, borderColor: t.border,
          borderRadius: radius.small, paddingHorizontal: space(3.5), paddingVertical: space(3),
          fontSize: 15,
        }, style]}
        {...rest}
      />
    </View>
  );
}

/** A wrap of tappable options, one selected. */
export function Chips<T extends string>({ options, value, onChange, labels }: {
  options: readonly T[]; value: T | null; onChange: (v: T) => void; labels?: Partial<Record<T, string>>;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space(2) }}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable key={o} onPress={() => onChange(o)} style={{
            paddingHorizontal: space(3.5), paddingVertical: space(2), borderRadius: radius.pill,
            borderWidth: 1, borderColor: on ? t.text : t.border, backgroundColor: on ? t.text : "transparent",
          }}>
            <Text style={{ color: on ? t.plane : t.textSecondary, fontSize: 13, fontWeight: on ? "600" : "400" }}>
              {labels?.[o] ?? o}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A bottom sheet. Tapping outside closes it, as everywhere else on Android. */
export function Sheet({ visible, onClose, title, subtitle, children }: {
  visible: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode;
}) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)" }} />
        </Pressable>
        <View style={{ flex: 1, justifyContent: "flex-end" }} pointerEvents="box-none">
          <View style={{
            backgroundColor: t.surface, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card,
            maxHeight: "88%", paddingBottom: space(6),
          }}>
            <View style={{ alignItems: "center", paddingTop: space(2.5) }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.grid }} />
            </View>
            <ScrollView contentContainerStyle={{ padding: space(5) }} keyboardShouldPersistTaps="handled">
              <Text style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>{title}</Text>
              {subtitle ? <Text style={{ color: t.muted, fontSize: 13, marginTop: space(1), marginBottom: space(4) }}>{subtitle}</Text> : <View style={{ height: space(3) }} />}
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
  const t = useTheme();
  return (
    <View>
      {children.map((child, i) => (
        <View key={i} style={{
          paddingVertical: space(3), borderTopWidth: i ? 1 : 0, borderTopColor: t.grid,
        }}>{child}</View>
      ))}
    </View>
  );
}

export const textStyles = (t: Theme) => StyleSheet.create({
  primary: { color: t.text, fontSize: 15, fontWeight: "500" },
  secondary: { color: t.textSecondary, fontSize: 13 },
  muted: { color: t.muted, fontSize: 12 },
  number: { color: t.text, fontSize: 15, fontVariant: ["tabular-nums"], textAlign: "right" },
  error: { color: t.critical, fontSize: 13, marginTop: space(2) },
});
