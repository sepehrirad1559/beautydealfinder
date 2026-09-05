import React from 'react';

// Minimal path-based router with no external dependency. Navigation is
// plain <a href> full-page loads rather than client-side pushState
// transitions — for a catalog site where most traffic arrives via a
// search-engine or social link straight to one specific page anyway, this
// trades a bit of perceived SPA snappiness for something much simpler and
// harder to break, and full loads are also the safest option for crawlers
// that don't handle client-side route changes perfectly.

export function Link({ to, children, ...props }) {
  return React.createElement('a', { href: to, ...props }, children);
}

function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (part !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// Set once per page load by renderRoute(), read by useParams(). There's no
// client-side navigation to invalidate this mid-session, so a plain module
// variable (rather than React context) is enough.
let currentParams = {};
export function useParams() {
  return currentParams;
}

export function renderRoute(routes) {
  const pathname = window.location.pathname;
  for (const { path, Component } of routes) {
    const params = matchRoute(path, pathname);
    if (params) {
      currentParams = params;
      return React.createElement(Component);
    }
  }
  currentParams = {};
  return null;
}
