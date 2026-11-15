/**
 * Design tokens, shared with MusicStats so the two apps read as one family:
 * borderless raised panels, lime for the thing that matters, orange for what
 * went the wrong way, Space Grotesk for figures and Inter for words. Dark only,
 * as there, but on pure black so an OLED screen leaves the ground unlit.
 *
 * Each weight is its own font file: Android ignores fontWeight on a custom
 * family, so the weight is chosen by family name and fontWeight is never set.
 */

import { TextStyle } from "react-native";

export const C = {
  ground: "#000000",
  surface: "#15151A",
  raised: "#1E1E25",
  line: "#2A2A33",
  text: "#F5F5F7",
  muted: "#A3A3AF",
  faint: "#4A4A55",
  accent: "#C8F169",
  accentDim: "#55702B",
  accentBg: "#26301A",
  accentCard: "#1F2A12",
  accentInk: "#D9E8B8",
  second: "#A99BFF",
  secondBg: "#241F3A",
  secondCard: "#1C1930",
  secondInk: "#D6D0FA",
  down: "#FF9466",
  downBg: "#33261F",
  /**
   * The validated eight-slot categorical palette, dark steps: fixed order,
   * never cycled. Single-series charts use the accent instead.
   */
  series: ["#3987e5", "#d95926", "#199e70", "#c98500",
           "#d55181", "#008300", "#9085e9", "#e66767"],
};

export const F = {
  grotesk: "SpaceGrotesk-SemiBold",
  inter: "Inter-Regular",
  interSemi: "Inter-SemiBold",
};

const tnum: TextStyle["fontVariant"] = ["tabular-nums"];

export const T = {
  display: { fontFamily: F.grotesk, fontSize: 60, lineHeight: 62, letterSpacing: -1.8, fontVariant: tnum },
  title: { fontFamily: F.grotesk, fontSize: 32, lineHeight: 36, letterSpacing: -0.6 },
  stat: { fontFamily: F.grotesk, fontSize: 24, lineHeight: 28, fontVariant: tnum },
  section: { fontFamily: F.grotesk, fontSize: 19, lineHeight: 24 },
  rank: { fontFamily: F.grotesk, fontSize: 15, lineHeight: 20, fontVariant: tnum },
  body: { fontFamily: F.inter, fontSize: 15, lineHeight: 21 },
  bodyStrong: { fontFamily: F.interSemi, fontSize: 15, lineHeight: 21 },
  label: { fontFamily: F.inter, fontSize: 13, lineHeight: 18 },
  labelStrong: { fontFamily: F.interSemi, fontSize: 13, lineHeight: 18 },
  small: { fontFamily: F.inter, fontSize: 12, lineHeight: 16, fontVariant: tnum },
  smallStrong: { fontFamily: F.interSemi, fontSize: 12, lineHeight: 16, fontVariant: tnum },
  overline: { fontFamily: F.interSemi, fontSize: 11, lineHeight: 14, letterSpacing: 0.9, textTransform: "uppercase" },
} satisfies Record<string, TextStyle>;

export const radius = { panel: 24, tile: 20, row: 14, art: 10, pill: 999 };
export const space = (n: number) => n * 4;
