import {
  ClipboardList,
  FolderKanban,
  MessageSquarePlus,
  Palette,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const primaryNavItems: NavItem[] = [
  { href: "/", label: "New chat", icon: MessageSquarePlus },
  { href: "/cases/new", label: "Guided setup", icon: ClipboardList },
  { href: "/cases", label: "Cases", icon: FolderKanban },
];

export const secondaryNavItems: NavItem[] = [
  { href: "/design", label: "Design system", icon: Palette },
];

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/" || pathname.startsWith("/chat/");
  }

  // Guided setup lives under /cases but is its own entry.
  if (href === "/cases" && (pathname === "/cases/new" || pathname.startsWith("/cases/new/"))) {
    return false;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}
