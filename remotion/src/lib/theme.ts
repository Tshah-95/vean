// Plain-hex tokens for the demo compositions. NO @/brand coupling — vean is a
// standalone OSS project, so colors are literal hex strings here, and every
// composition takes its real colors from props (these are only the defaults).
export const theme = {
  /** Dark bar behind the lower-third text. */
  bar: "#11131aee",
  /** Accent stripe on the left edge of the bar. */
  accent: "#c7ae7a",
  /** Title text color. */
  title: "#ffffff",
  /** Subtitle text color. */
  subtitle: "#c7c9d1",
} as const;

/** A system font stack — no network font fetch, so headless renders need no
 *  font download (load-bearing for a fast, offline `remotion render`). */
export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
