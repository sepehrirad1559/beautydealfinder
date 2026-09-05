import { useEffect } from 'react';

const SITE = 'https://www.beautypricematch.com';

function setMetaTag(attr, key, content) {
  if (!content) return;
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setCanonical(path) {
  let el = document.head.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', 'canonical');
    document.head.appendChild(el);
  }
  el.setAttribute('href', `${SITE}${path}`);
}

function setRobots(content) {
  setMetaTag('name', 'robots', content || 'index,follow');
}

function setJsonLd(id, data) {
  let el = document.getElementById(id);
  if (!data) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(data);
}

// Sets <title>, meta description, canonical, robots directive, and one
// JSON-LD block per page. Every route calls this on mount/update instead
// of hand-editing the DOM directly, so there's a single place that knows
// how to clean up (e.g. remove the JSON-LD block) when the route changes.
// This is a client-side-rendered approach — Googlebot does execute JS and
// will pick these up, but a build-time prerender/SSR pass (see the SEO
// strategy doc, Part 11) would make indexing faster and more reliable as
// the catalog grows; this is the practical version buildable today
// without migrating off Vite/CSR.
export function useSeo({ title, description, path, robots, jsonLd }) {
  useEffect(() => {
    if (title) document.title = title;
    setMetaTag('name', 'description', description);
    setMetaTag('property', 'og:title', title);
    setMetaTag('property', 'og:description', description);
    if (path) {
      setCanonical(path);
      setMetaTag('property', 'og:url', `${SITE}${path}`);
    }
    setRobots(robots);
    setJsonLd('page-jsonld', jsonLd);
    return () => setJsonLd('page-jsonld', null);
  }, [title, description, path, robots, jsonLd]);
}

export { SITE };
