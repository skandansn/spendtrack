import React, { useState } from "react";
import { Platform, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { callCompleteHostedLink, callExchangeToken, callLinkToken } from "../firebase";
import { space, useTheme } from "../theme";
import { Button, textStyles } from "../ui";

/**
 * Connect a bank. Each one permanently uses one of the free Plaid Trial's ten
 * Items, and removing it does not give the slot back - so this says so before
 * starting rather than after.
 *
 * Two routes to the same place. The browser runs Plaid's Link script directly.
 * The phone uses Hosted Link in an Android Custom Tab: no native SDK to build
 * against, and a Custom Tab - unlike an in-app webview - is where OAuth banks
 * such as Chase can complete their sign-in.
 */
export function LinkBank({ itemId, label = "Link a bank or card", onLinked }: {
  itemId?: string; label?: string; onLinked: (institution: string | null) => void;
}) {
  const t = useTheme();
  const s = textStyles(t);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const reauth = Boolean(itemId);

  const viaHostedLink = async () => {
    const { data } = await callLinkToken({ itemId, hosted: true });
    if (!data.hostedLinkUrl) throw new Error("Plaid did not return a Hosted Link URL.");
    // returns when Plaid redirects to spendtrack://plaid-done, or the tab is closed
    await WebBrowser.openAuthSessionAsync(data.hostedLinkUrl, "spendtrack://plaid-done");
    if (reauth) return null;
    // Plaid records the session result moments after the redirect; give it a
    // couple of tries rather than failing on a race
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data: done } = await callCompleteHostedLink({ linkToken: data.linkToken });
      if (done.linked.length) return done.linked.map((l) => l.institution).join(", ");
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("Link closed without connecting a bank.");
  };

  const viaWebScript = async () => {
    const { data } = await callLinkToken({ itemId });
    await loadPlaidScript();
    return new Promise<string | null>((resolve, reject) => {
      const handler = (window as unknown as { Plaid: PlaidGlobal }).Plaid.create({
        token: data.linkToken,
        onSuccess: async (publicToken: string) => {
          if (reauth) { resolve(null); return; }
          try {
            const { data: linked } = await callExchangeToken({ publicToken });
            resolve(linked.institution);
          } catch (e) { reject(e); }
        },
        onExit: (err: { error_message?: string } | null) =>
          reject(new Error(err?.error_message || "Link closed without connecting a bank.")),
      });
      handler.open();
    });
  };

  const start = async () => {
    setBusy(true); setNote(null);
    try {
      const institution = Platform.OS === "web" ? await viaWebScript() : await viaHostedLink();
      setNote(reauth ? "Signed back in." : `Linked ${institution ?? "your bank"}. Its history arrives on the next sync.`);
      onLinked(institution);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Button kind={reauth ? "secondary" : "primary"} title={label} busy={busy} onPress={start} />
      {!reauth ? (
        <Text style={[s.muted, { marginTop: space(2), textAlign: "center" }]}>
          Uses one of your free Plaid Items for good. Re-signing-in to a linked bank does not.
        </Text>
      ) : null}
      {note ? <Text style={[s.secondary, { marginTop: space(2), textAlign: "center" }]}>{note}</Text> : null}
    </View>
  );
}

interface PlaidGlobal {
  create: (config: {
    token: string;
    onSuccess: (publicToken: string) => void;
    onExit: (err: { error_message?: string } | null) => void;
  }) => { open: () => void };
}

let scriptPromise: Promise<void> | null = null;
function loadPlaidScript(): Promise<void> {
  if ((window as unknown as { Plaid?: unknown }).Plaid) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    tag.onload = () => resolve();
    tag.onerror = () => { scriptPromise = null; reject(new Error("Could not load Plaid Link.")); };
    document.head.appendChild(tag);
  });
  return scriptPromise;
}
