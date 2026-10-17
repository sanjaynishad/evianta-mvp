import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const url = request.nextUrl.clone();
  const pathname = url.pathname.replace(/%40|%5b|%5d/gi, (value) => decodeURIComponent(value));

  if (pathname === url.pathname) {
    return NextResponse.next();
  }

  // Proxies can partially decode parallel-route chunk URLs, which Next cannot match.
  url.pathname = pathname;

  return NextResponse.rewrite(url);
}

export const config = {
  matcher: "/_next/static/chunks/:path*",
};
