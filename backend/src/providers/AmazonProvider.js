import { ProviderInterface } from './ProviderInterface.js';
import { syncAmazonProducts } from '../services/amazon.js';

export class AmazonProvider extends ProviderInterface {
  constructor() {
    super('amazon');
  }

  async sync(searchTerms) {
    return syncAmazonProducts(searchTerms);
  }
}

export default AmazonProvider;
