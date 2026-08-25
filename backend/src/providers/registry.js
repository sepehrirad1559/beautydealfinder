import { AmazonProvider } from './AmazonProvider.js';
import { AffiliateFeedProvider } from './AffiliateFeedProvider.js';
import { FEED_SOURCES } from '../config/feedSources.js';

const providers = {
  amazon: new AmazonProvider(),
};

// One AffiliateFeedProvider per configured retailer in
// config/feedSources.js — empty by default, so this loop does nothing
// until a real, approved affiliate feed is added there.
for (const feedConfig of FEED_SOURCES) {
  providers[feedConfig.retailer] = new AffiliateFeedProvider(feedConfig);
}

export function getProvider(name) {
  return providers[String(name || '').toLowerCase()];
}

export function listProviderNames() {
  return Object.keys(providers);
}

export default { getProvider, listProviderNames };
