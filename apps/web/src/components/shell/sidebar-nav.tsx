"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { EviantaLogomark } from "@/components/brand/logomark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isNavItemActive, primaryNavItems, secondaryNavItems, type NavItem } from "./nav-items";

interface NavLinkProps {
  item: NavItem;
  pathname: string;
  expanded: boolean;
  onNavigate?: () => void;
}

function NavLink({ item, pathname, expanded, onNavigate }: NavLinkProps) {
  const active = isNavItemActive(pathname, item.href);
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium text-sidebar-foreground transition-colors duration-fast ease-standard hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-sidebar-accent text-primary hover:text-primary",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary opacity-0 transition-opacity duration-fast",
          active && "opacity-100",
        )}
      />
      <Icon aria-hidden className="size-[18px] shrink-0" strokeWidth={2} />
      <span className={cn("truncate", !expanded && "sr-only lg:not-sr-only")}>{item.label}</span>
    </Link>
  );

  if (expanded) {
    return link;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="lg:hidden">
        {item.label}
      </TooltipContent>
    </Tooltip>
  );
}

export interface SidebarNavProps {
  expanded?: boolean;
  onNavigate?: () => void;
  className?: string;
}

export function SidebarNav({ expanded = false, onNavigate, className }: SidebarNavProps) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={cn("flex h-full flex-col gap-1 p-2", className)}>
      <Link
        href="/"
        onClick={onNavigate}
        className="mb-3 flex h-10 items-center gap-2.5 rounded-md px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <EviantaLogomark className="size-7" title="Evianta home" />
        <span
          className={cn(
            "text-base font-semibold tracking-tight text-foreground",
            !expanded && "sr-only lg:not-sr-only",
          )}
        >
          Evianta
        </span>
      </Link>
      <div className="flex flex-col gap-0.5">
        {primaryNavItems.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            pathname={pathname}
            expanded={expanded}
            onNavigate={onNavigate}
          />
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-0.5 border-t border-sidebar-border pt-2">
        {secondaryNavItems.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            pathname={pathname}
            expanded={expanded}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </nav>
  );
}
