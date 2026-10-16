"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Moon, Search, Sun } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { primaryNavItems, secondaryNavItems } from "./nav-items";

export function isCommandPaletteShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
) {
  return event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
}

export interface CommandPaletteProps {
  className?: string;
}

export function CommandPalette({ className }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isCommandPaletteShortcut(event)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const runCommand = useCallback((command: () => void) => {
    setOpen(false);
    command();
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        className={cn(
          "inline-flex h-9 w-full max-w-xs items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground shadow-elevation-1 transition-colors duration-fast ease-standard hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="flex-1 truncate text-left">Search or jump to</span>
        <kbd className="hidden rounded border bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground sm:inline-block">
          Ctrl K
        </kbd>
      </button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Jump to a page or run an action"
      >
        <CommandInput placeholder="Type a command or search" />
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          <CommandGroup heading="Go to">
            {[...primaryNavItems, ...secondaryNavItems].map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.href}
                  value={item.label}
                  onSelect={() => runCommand(() => router.push(item.href))}
                >
                  <Icon aria-hidden />
                  {item.label}
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Preferences">
            <CommandItem
              value="Toggle theme"
              onSelect={() =>
                runCommand(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))
              }
            >
              {resolvedTheme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
              Switch to {resolvedTheme === "dark" ? "light" : "dark"} theme
              <CommandShortcut>Theme</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
