// The left icon-rail destinations. Each is a DESTINATION (fills the contextual
// content rail), NOT a mode (never swaps the monitor/timeline). "edit" is the
// focus/home that collapses the content rail; "settings" is pinned at the rail
// bottom and handled separately. See DESIGN-UI.md §"The shell".
import { Film, GitBranch, type LucideIcon, Image, Layers, TriangleAlert } from "lucide-react";

export type DestId = "edit" | "media" | "checks" | "branch" | "jobs" | "settings";

export interface Destination {
  id: Exclude<DestId, "settings">;
  label: string;
  icon: LucideIcon;
}

export const DESTINATIONS: Destination[] = [
  { id: "edit", label: "Edit", icon: Film },
  { id: "media", label: "Media", icon: Image },
  { id: "checks", label: "Checks", icon: TriangleAlert },
  { id: "branch", label: "Branch", icon: GitBranch },
  { id: "jobs", label: "Jobs", icon: Layers },
];
