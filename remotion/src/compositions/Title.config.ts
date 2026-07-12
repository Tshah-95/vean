import { z } from "zod";
import { theme } from "../lib/theme";

export const titleSchema = z.object({
  title: z.string(),
  /** Small kicker line above the title (rendered uppercase, letter-spaced). */
  kicker: z.string(),
  /** Accent color for the kicker (hex). */
  accent: z.string(),
});

export type TitleProps = z.infer<typeof titleSchema>;

export const titleDefaults: TitleProps = {
  title: "vean",
  kicker: "the agent-native title card",
  accent: theme.accent,
};
