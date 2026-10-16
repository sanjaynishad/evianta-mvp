"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { UserRound } from "lucide-react";
import { EviantaLogomark } from "@/components/brand/logomark";
import { useMotionSafe } from "@/hooks/use-motion-safe";
import { formatDateTime, toIsoDate, type DateInput } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ChatRole = "user" | "assistant";

export interface ChatBubbleProps {
  role: ChatRole;
  children: ReactNode;
  author?: string;
  timestamp?: DateInput;
  citations?: ReactNode;
  className?: string;
}

export function ChatBubble({
  role,
  children,
  author,
  timestamp,
  citations,
  className,
}: ChatBubbleProps) {
  const { fadeSlide } = useMotionSafe();
  const isUser = role === "user";
  const authorName = author ?? (isUser ? "You" : "Evianta");

  return (
    <motion.div
      data-slot="chat-bubble"
      data-role={role}
      variants={fadeSlide}
      initial="hidden"
      animate="visible"
      className={cn("flex w-full gap-3", isUser && "flex-row-reverse", className)}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          isUser && "bg-muted text-muted-foreground",
        )}
      >
        {isUser ? <UserRound className="size-4" /> : <EviantaLogomark className="size-7" />}
      </span>
      <div className={cn("flex min-w-0 max-w-[85%] flex-col gap-1", isUser && "items-end")}>
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{authorName}</span>
          {timestamp ? (
            <time dateTime={toIsoDate(timestamp)} className="figures">
              {formatDateTime(timestamp)}
            </time>
          ) : null}
        </div>
        <div
          className={cn(
            "rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
            isUser
              ? "rounded-tr-sm bg-primary-subtle text-foreground"
              : "rounded-tl-sm border bg-card text-card-foreground shadow-elevation-1",
          )}
        >
          {children}
        </div>
        {citations ? (
          <div className="flex flex-wrap gap-1.5" aria-label="Sources">
            {citations}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
