const PUBLIC_SHELL_ROUTE = /^(?:\/$|\/(?:pricing|contact|about|careers|privacy|terms|refund-policy|acceptable-use-policy|data-deletion-status|pinterest-app|welcome|login|signup)\/?$)/;

export type PublicThemeTarget = "app" | "admin" | null;

/** The root layout may only initialize theme state for surfaces it owns. */
export function publicThemeTarget(pathname: string): PublicThemeTarget {
  if (pathname.startsWith("/app") || PUBLIC_SHELL_ROUTE.test(pathname)) return "app";
  if (pathname.startsWith("/admin")) return "admin";
  return null;
}

// Kept as a plain IIFE because it runs before React hydrates. Keep its route
// predicate in sync with publicThemeTarget; the runtime test executes it in a
// VM so malformed syntax and accidental route expansion cannot be hidden by a
// source-only assertion.
export const PUBLIC_THEME_INIT_SCRIPT = `(function(){try{
  var p=location.pathname;
  var isPublic=/^(?:\\/$|\\/(?:pricing|contact|about|careers|privacy|terms|refund-policy|acceptable-use-policy|data-deletion-status|pinterest-app|welcome|login|signup)\\/?$)/.test(p);
  if(p.startsWith('/app')||isPublic){
    var t=localStorage.getItem('vp:appearance_theme:v1');
    var r=t==='light'?'light':t==='system'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):'dark';
    document.documentElement.setAttribute('data-theme',r);
  }else if(p.startsWith('/admin')){
    var at=localStorage.getItem('vibepin-admin-theme');
    document.documentElement.setAttribute('data-admin-theme',at==='dark'?'dark':'light');
  }
}catch(e){}})();`;
