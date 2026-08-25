import { ProviderInterface } from './ProviderInterface.js';
import { syncAffiliateFeed } from '../services/affiliateFeed.js';

// One instance per configured entry in config/feedSources.js — a thin
// wrapper so admin routes can call getProvider('sephora').sync() the same
// way they call getProvider('amazon').sync(), regardless of whether the
// retailer is backed by a real API or an affiliate feed.
export class AffiliateFeedProvider extends ProviderInterface {
  constructor(feedConfig) {
    super(feedConfig.retailer);
    this.feedConfig = feedConfig;
  }

  async sync() {
    return syncAffiliateFeed(this.feedConfig);
  }
}

export default AffiliateFeedProvider;
