/**
 * Firebase client.
 *
 * These values are not secrets - they identify the project and ship in every
 * web and mobile Firebase app by design. What protects the data is the security
 * rules plus signing in: without an authenticated uid the rules deny everything,
 * and the Plaid access tokens live in a collection no client may read at all.
 */

import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { initializeApp } from "firebase/app";
import * as FirebaseAuth from "firebase/auth";
import { getFirestore, initializeFirestore } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";

const app = initializeApp({
  apiKey: "AIzaSyAFbWIhAg1x0ai0-9GjNO1pm-uPckdlyvU",
  authDomain: "spendtrack-50307.firebaseapp.com",
  projectId: "spendtrack-50307",
  storageBucket: "spendtrack-50307.firebasestorage.app",
  messagingSenderId: "417110564062",
  appId: "1:417110564062:web:bff9328ca0c0aa8d61364f",
});

/**
 * On a phone, sign-in must be persisted explicitly. The default in-memory store
 * forgets you every time Android stops the app, which it does constantly.
 * getReactNativePersistence only exists in Firebase's React Native build, so it
 * is absent from the web type definitions and looked up at runtime.
 */
export const auth = Platform.OS === "web"
  ? FirebaseAuth.getAuth(app)
  : FirebaseAuth.initializeAuth(app, {
      persistence: (FirebaseAuth as unknown as {
        getReactNativePersistence: (s: typeof AsyncStorage) => FirebaseAuth.Persistence;
      }).getReactNativePersistence(AsyncStorage),
    });

/**
 * Long polling on native. Firestore's default streaming transport can stall
 * silently behind Android's networking stack and some VPNs - NordVPN among the
 * ones you run - leaving listeners waiting forever with no error. Auto-detect
 * falls back to long polling only when streaming fails, so it costs nothing
 * when streaming works.
 */
export const db = Platform.OS === "web"
  ? getFirestore(app)
  : initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

const functions = getFunctions(app);

export interface SyncOutcome {
  institution: string;
  added: number;
  modified: number;
  removed: number;
  error?: string;
}

export interface ImportResult {
  institutions: number;
  accounts: number;
  transactions: number;
  months: number;
  writes: number;
  skipped: number;
}

/** The things that need the Plaid secret, so they live server side. */
export const callSync = httpsCallable<void, { results: SyncOutcome[] }>(functions, "sync");
export const callLinkToken = httpsCallable<
  { itemId?: string; hosted?: boolean },
  { linkToken: string; hostedLinkUrl: string | null }
>(functions, "linkToken");
export const callExchangeToken = httpsCallable<
  { publicToken: string }, { itemId: string; institution: string | null }
>(functions, "exchangeToken");
export const callCompleteHostedLink = httpsCallable<
  { linkToken: string }, { linked: { itemId: string; institution: string | null }[] }
>(functions, "completeHostedLink");
export const callRepair = httpsCallable<void, { transactions: number; months: number }>(
  functions, "repair");
export const callImportLaptop = httpsCallable<unknown, ImportResult>(functions, "importLaptop");
