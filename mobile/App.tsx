import React, { useEffect, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StatusBar as Bars,
  StyleSheet, Text, TextInput, View,
} from "react-native";
import { loadAsync } from "expo-font";
import { StatusBar } from "expo-status-bar";
import {
  User, createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword,
} from "firebase/auth";

import { TxnFilter } from "./src/data";
import { auth } from "./src/firebase";
import { Accounts } from "./src/screens/Accounts";
import { Dashboard } from "./src/screens/Dashboard";
import { Transactions } from "./src/screens/Transactions";
import { C, F, T, radius, space } from "./src/theme";

type Tab = "dashboard" | "transactions" | "accounts";
const TABS: Record<Tab, string> = { dashboard: "Overview", transactions: "Transactions", accounts: "Accounts" };

// Android draws the app edge to edge, under the status bar and the gesture
// handle, so leave room for both. The gesture area is a fixed height on Pixels.
const TOP = Platform.OS === "android" ? Bars.currentHeight ?? 24 : 0;
const BOTTOM = Platform.OS === "android" ? 20 : 0;

// Native builds embed these through the expo-font config plugin; a browser has to fetch them.
if (Platform.OS === "web") {
  void loadAsync({
    [F.grotesk]: require("./assets/fonts/SpaceGrotesk-SemiBold.ttf"),
    [F.inter]: require("./assets/fonts/Inter-Regular.ttf"),
    [F.interSemi]: require("./assets/fonts/Inter-SemiBold.ttf"),
  });
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [filter, setFilter] = useState<TxnFilter>({});

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  if (user === undefined) {
    return (
      <View style={[s.center, { backgroundColor: C.ground }]}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }
  if (!user) return <SignIn />;

  return (
    <View style={{ flex: 1, backgroundColor: C.ground, paddingTop: TOP }}>
      <StatusBar style="light" />
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
            <View style={[s.tabPill, tab === t && s.tabPillOn]}>
              <Text style={[s.tabText, tab === t && s.tabTextOn]}>{TABS[t]}</Text>
            </View>
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
      style={[s.center, { backgroundColor: C.ground, padding: space(6) }]}
    >
      <Text style={s.brand}>spendtrack</Text>
      <Text style={s.sub}>Sign in to see your accounts.</Text>
      <TextInput style={s.input} placeholder="Email" placeholderTextColor={C.faint} selectionColor={C.accent}
                 autoCapitalize="none" keyboardType="email-address" autoComplete="email"
                 value={email} onChangeText={setEmail} />
      <TextInput style={s.input} placeholder="Password" placeholderTextColor={C.faint} selectionColor={C.accent}
                 secureTextEntry autoComplete="password" returnKeyType="go"
                 onSubmitEditing={() => go(false)}
                 value={password} onChangeText={setPassword} />
      <Pressable style={s.primary} disabled={busy} onPress={() => go(false)}>
        {busy ? <ActivityIndicator color={C.ground} />
              : <Text style={s.primaryText}>Sign in</Text>}
      </Pressable>
      <Pressable disabled={busy} onPress={() => go(true)} style={{ padding: space(3) }}>
        <Text style={s.link}>First time? Create the account</Text>
      </Pressable>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabs: { flexDirection: "row", borderTopWidth: 1, borderTopColor: C.raised, backgroundColor: C.ground },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", height: 64 },
  tabPill: { height: 32, paddingHorizontal: space(4), borderRadius: radius.pill, justifyContent: "center" },
  tabPillOn: { backgroundColor: C.accentBg },
  tabText: { ...T.labelStrong, color: C.muted },
  tabTextOn: { color: C.accent },
  brand: { ...T.title, color: C.text },
  sub: { ...T.label, color: C.muted, marginTop: space(1), marginBottom: space(6) },
  input: {
    ...T.body, width: "100%", maxWidth: 360, color: C.text, backgroundColor: C.raised,
    borderRadius: radius.pill, paddingHorizontal: space(4.5), height: 48, marginBottom: space(2.5),
  },
  primary: {
    width: "100%", maxWidth: 360, backgroundColor: C.accent, borderRadius: radius.pill,
    height: 48, alignItems: "center", justifyContent: "center", marginTop: space(2),
  },
  primaryText: { ...T.bodyStrong, color: C.ground },
  link: { ...T.label, color: C.muted },
  error: { ...T.label, color: C.down, marginTop: space(2), textTransform: "capitalize" },
});
