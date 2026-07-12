// The shell's layout model. Two things live here:
//   1. The DRAWER TAB REGISTRY — the primary navigation (icon-only tabs atop the
//      left drawer). Each tab maps to a panel component in Drawer.tsx.
//   2. The LAYOUT CONFIG — panel sizes / collapsed state. Hardcoded today; this is
//      the exact shape it needs to become user-editable + persisted to
//      `.vean/vean.db` when we enable relocatable/resizable panels. Panels already
//      render at `config.<panel>.size`, so a resize handle writes back here — no
//      restructure. See DESIGN-UI.md §"Configurable panels (later)".
import {
  GitBranch,
  Image,
  Layers,
  type LucideIcon,
  MessageSquare,
  TriangleAlert,
} from "lucide-react";

/** A primary drawer tab (shown as an icon in the drawer header). */
export type DrawerTabId = "media" | "checks" | "branch" | "jobs" | "chat";
/** What the drawer body is showing — a tab, or the utility "settings" view (opened
 *  from the top-bar gear, not a visible tab). */
export type DrawerView = DrawerTabId | "settings";

export interface DrawerTab {
  id: DrawerTabId;
  title: string;
  icon: LucideIcon;
}

export const DRAWER_TABS: DrawerTab[] = [
  { id: "media", title: "Media", icon: Image },
  { id: "checks", title: "Checks", icon: TriangleAlert },
  { id: "branch", title: "Branch", icon: GitBranch },
  { id: "jobs", title: "Jobs", icon: Layers },
  { id: "chat", title: "Chat", icon: MessageSquare },
];

export interface PanelConfig {
  /** Width in px for side panels. */
  size: number;
  collapsed: boolean;
}

export interface LayoutConfig {
  drawer: PanelConfig;
  right: PanelConfig;
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  drawer: { size: 264, collapsed: false },
  right: { size: 236, collapsed: false },
};
