import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface GallerySectionProps {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export function GallerySection({
  id,
  title,
  description,
  children,
  className,
}: GallerySectionProps) {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex scroll-mt-20 flex-col gap-4" id={id}>
      <div className="flex flex-col gap-1 border-b pb-3">
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className={cn("flex flex-col gap-4", className)}>{children}</div>
    </section>
  );
}

export function GalleryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
