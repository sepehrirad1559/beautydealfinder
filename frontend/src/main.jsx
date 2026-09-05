import React from 'react';
import ReactDOM from 'react-dom/client';
import { renderRoute } from './router.js';
import App from './App.jsx';
import ProductPage from './pages/ProductPage.jsx';
import BrandPage from './pages/BrandPage.jsx';
import CategoryPage from './pages/CategoryPage.jsx';
import DealsPage from './pages/DealsPage.jsx';
import './App.css';

// Route map, matching the URL structure in the SEO strategy doc (Part 1):
//   /                          homepage
//   /p/:brandSlug/:slugId      product detail + price comparison
//   /brand/:brandSlug          brand hub
//   /category/:categorySlug    category hub
//   /deals                     deals hub
// There's deliberately no separate /compare/ or /vs/ route yet — with most
// products currently carrying a single retailer offer, those page types
// would fail their own indexability gate (see Part 3/4 of the strategy
// doc). /p/ already shows the full multi-retailer comparison table when
// more than one offer exists, so it doubles as the "compare" view; a
// dedicated /compare/ route is worth splitting out once enough products
// have 2+ live offers to make it a genuinely different page.
const routes = [
  { path: '/p/:brandSlug/:slugId', Component: ProductPage },
  { path: '/brand/:brandSlug', Component: BrandPage },
  { path: '/category/:categorySlug', Component: CategoryPage },
  { path: '/deals', Component: DealsPage },
  { path: '/', Component: App },
];

const element = renderRoute(routes) || React.createElement(App);

ReactDOM.createRoot(document.getElementById('root')).render(
  React.createElement(React.StrictMode, null, element)
);
