import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/signup', '/verify-email', '/forgot-password', '/reset-password'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Rotas públicas e proxy /api passam sem checar
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/invite/')
  ) {
    return NextResponse.next();
  }

  // Better Auth cookie: tenta os dois nomes possíveis
  const session =
    req.cookies.get('better-auth.session_token') ?? req.cookies.get('__Secure-better-auth.session_token');

  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
