import type { CSSProperties } from "react";
import {
  Activity,
  ChevronRight,
  Download,
  GitBranch,
  Heart,
  Languages,
  Loader2,
  Lock,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Share2,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";

// Keep the kebab-case names from the original prototype so call sites don't churn.
const ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  "chevron-right": ChevronRight,
  download: Download,
  "git-branch": GitBranch,
  heart: Heart,
  languages: Languages,
  "loader-2": Loader2,
  lock: Lock,
  "more-horizontal": MoreHorizontal,
  "music-2": Music2,
  pause: Pause,
  play: Play,
  plus: Plus,
  "refresh-cw": RefreshCw,
  "share-2": Share2,
  "shield-check": ShieldCheck,
  "skip-back": SkipBack,
  "skip-forward": SkipForward,
  sparkles: Sparkles,
  zap: Zap,
};

export type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName | string;
  size?: number;
  style?: CSSProperties;
  className?: string;
}

export function Icon({ name, size = 16, style, className }: IconProps) {
  const Cmp = ICONS[name];
  if (!Cmp) return null;
  return <Cmp size={size} style={style} className={className} aria-hidden="true" />;
}
