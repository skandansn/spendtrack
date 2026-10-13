/**
 * The dashboard's design tokens, carried over from the web stylesheet so the
 * phone and the browser look like one product rather than two.
 *
 * The categorical series is the validated eight-slot palette: fixed order,
 * never cycled, with separate steps chosen for the dark surface rather than an
 * automatic flip of the light ones.
 */

import { useColorScheme } from "react-native";

const light = {
  surface: "#fcfcfb",
  plane: "#f9f9f7",
  text: "#0b0b0b",
  textSecondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  border: "rgba(11, 11, 11, 0.10)",
  good: "#006300",
  critical: "#d03b3b",
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100",
           "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
};

const dark = {
  surface: "#1a1a19",
  plane: "#0d0d0d",
  text: "#ffffff",
  textSecondary: "#c3c2b7",
  muted: "#898781",
  grid: "#2c2c2a",
  border: "rgba(255, 255, 255, 0.10)",
  good: "#0ca30c",
  critical: "#e66767",
  series: ["#3987e5", "#d95926", "#199e70", "#c98500",
           "#d55181", "#008300", "#9085e9", "#e66767"],
};

export type Theme = typeof light;

export const useTheme = (): Theme => (useColorScheme() === "light" ? light : dark);

export const radius = { card: 20, pill: 999, small: 12 };
export const space = (n: number) => n * 4;

/**
 * Colour follows the category, never its current rank, so filtering a list
 * cannot repaint the survivors and teach you the wrong association. Past eight
 * everything shares the last slot rather than inventing a ninth hue that would
 * be indistinguishable under colour-blindness.
 */
export function categoryColor(theme: Theme, category: string, ranked: string[]): string {
  const index = ranked.indexOf(category);
  if (index < 0 || index >= theme.series.length) {
    return theme.series[theme.series.length - 1]!;
  }
  return theme.series[index]!;
}
