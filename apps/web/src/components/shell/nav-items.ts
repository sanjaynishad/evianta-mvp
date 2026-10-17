import { FilePlus2, FolderKanban, Palette, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const primaryNavItems: NavItem[] = [
  { href: "/", label: "Cases", icon: FolderKanban },
  { href: "/cases/new", label: "New case", icon: FilePlus2 },
];

export const secondaryNavItems: NavItem[] = [
  { href: "/design", label: "Design system", icon: Palette },
];

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}
