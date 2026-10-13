import React, { useEffect, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StatusBar as Bars,
  StyleSheet, Text, TextInput, View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  User, createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword,
} from "firebase/auth";

import { TxnFilter } from "./src/data";
import { auth } from "./src/firebase";
import { Accounts } from "./src/screens/Accounts";
import { Dashboard } from "./src/screens/Dashboard";
import { Transactions } from "./src/screens/Transactions";
import { Theme, radius, space, useTheme } from "./src/theme";

type Tab = "dashboard" | "transactions" | "accounts";
const TABS: Record<Tab, string> = { dashboard: "Overview", transactions: "Transactions", accounts: "Accounts" };

// Android draws the app edge to edge, under the status bar and the gesture
// handle, so leave room for both. The gesture area is a fixed height on Pixels.
const TOP = Platform.OS === "android" ? Bars.currentHeight ?? 24 : 0;
const BOTTOM = Platform.OS === "android" ? 20 : 0;

export default function App() {
  const theme = useTheme();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [filter, setFilter] = useState<TxnFilter>({});

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  if (user === undefined) {
    return (
      <View style={[styles(theme).center, { backgroundColor: theme.plane }]}>
        <ActivityIndicator color={theme.muted} />
      </View>
    );
  }
  if (!user) return <SignIn />;

  const s = styles(theme);
  return (
    <View style={{ flex: 1, backgroundColor: theme.plane, paddingTop: TOP }}>
      <StatusBar style={theme.text === "#ffffff" ? "light" : "dark"} />
      <View style={{ flex: 1 }}>
        {/* Overview stays mounted so its live listeners are not torn down and re-read on every tab switch */}
        <View style={{ flex: 1, display: tab === "dashboard" ? "flex" : "none" }}>
          <Dashboard onOpen={(f) => { setFilter(f); setTab("transactions"); }} />
        </View>
        {tab === "transactions" ? <Transactions filter={filter} onFilter={setFilter} /> : null}
        {tab === "accounts" ? <Accounts /> : null}
      </View>
      <View style={[s.tabs, { paddingBottom: BOTTOM }]}>
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={s.tab}>
            <Text style={[s.tabText, tab === t && s.tabTextOn]}>{TABS[t]}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/**
 * Email and password rather than Google sign-in: it works identically on web
 * and native with no native module, no SHA fingerprints and no OAuth client per
 * platform. For a one-person app that trade is easy.
 */
function SignIn() {
  const theme = useTheme();
  const s = styles(theme);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async (create: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await (create ? createUserWithEmailAndPassword : signInWithEmailAndPassword)(
        auth, email.trim(), password);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setError(code.replace("auth/", "").replace(/-/g, " ") || "Could not sign in");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[s.center, { backgroundColor: theme.plane, padding: space(6) }]}
    >
      <Text style={s.brand}>spendtrack</Text>
      <Text style={s.sub}>Sign in to see your accounts.</Text>
      <TextInput style={s.input} placeholder="Email" placeholderTextColor={theme.muted}
                 autoCapitalize="none" keyboardType="email-address" autoComplete="email"
                 value={email} onChangeText={setEmail} />
      <TextInput style={s.input} placeholder="Password" placeholderTextColor={theme.muted}
                 secureTextEntry autoComplete="password" returnKeyType="go"
                 onSubmitEditing={() => go(false)}
                 value={password} onChangeText={setPassword} />
      <Pressable style={s.primary} disabled={busy} onPress={() => go(false)}>
        {busy ? <ActivityIndicator color={theme.plane} />
              : <Text style={s.primaryText}>Sign in</Text>}
      </Pressable>
      <Pressable disabled={busy} onPress={() => go(true)} style={{ padding: space(3) }}>
        <Text style={s.link}>First time? Create the account</Text>
      </Pressable>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </KeyboardAvoidingView>
  );
}

const styles = (theme: Theme) => StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabs: {
    flexDirection: "row", borderTopWidth: 1, borderTopColor: theme.grid,
    backgroundColor: theme.surface,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: space(3.5) },
  tabText: { color: theme.muted, fontSize: 13, fontWeight: "500" },
  tabTextOn: { color: theme.text, fontWeight: "700" },
  brand: { color: theme.text, fontSize: 28, fontWeight: "700", letterSpacing: -0.8 },
  sub: { color: theme.muted, marginTop: space(1), marginBottom: space(6) },
  input: {
    width: "100%", maxWidth: 360, color: theme.text, backgroundColor: theme.surface,
    borderWidth: 1, borderColor: theme.border, borderRadius: radius.pill,
    paddingHorizontal: space(4), paddingVertical: space(3), marginBottom: space(2.5),
  },
  primary: {
    width: "100%", maxWidth: 360, backgroundColor: theme.text, borderRadius: radius.pill,
    paddingVertical: space(3.5), alignItems: "center", marginTop: space(2),
  },
  primaryText: { color: theme.plane, fontWeight: "700" },
  link: { color: theme.textSecondary, fontSize: 13 },
  error: { color: theme.critical, marginTop: space(2), textTransform: "capitalize" },
});
