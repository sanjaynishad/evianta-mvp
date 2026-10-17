"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const measurementId = "G-Z4PMQFXB3L";
const publicPaths = new Set(["/", "/cases/new", "/design"]);

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

function track(..._values: unknown[]) {
  window.dataLayer ??= [];
  // eslint-disable-next-line prefer-rest-params -- Google tag consumes Arguments objects.
  window.dataLayer.push(arguments);
}

export function Analytics() {
  const pathname = usePathname();
  const isPublicPage = publicPaths.has(pathname);
  const initialized = useRef(false);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!isPublicPage) {
      lastPath.current = null;
      return;
    }

    if (!initialized.current || lastPath.current === pathname) {
      return;
    }

    track("event", "page_view", {
      page_location: `${window.location.origin}${pathname}`,
      page_referrer: "",
      page_title: "Evianta",
    });
    lastPath.current = pathname;
  }, [isPublicPage, pathname]);

  if (!isPublicPage) {
    return null;
  }

  return (
    <Script
      src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
      strategy="afterInteractive"
      onReady={() => {
        if (!initialized.current) {
          // Override URL defaults even for automatic events after private navigation.
          const defaults = {
            page_location: window.location.origin,
            page_referrer: "",
            page_title: "Evianta",
          };
          track("set", defaults);
          track("js", new Date());
          track("config", measurementId, { ...defaults, send_page_view: false });
          initialized.current = true;
        }

        if (lastPath.current !== pathname) {
          track("event", "page_view", {
            page_location: `${window.location.origin}${pathname}`,
            page_referrer: "",
            page_title: "Evianta",
          });
          lastPath.current = pathname;
        }
      }}
    />
  );
}
