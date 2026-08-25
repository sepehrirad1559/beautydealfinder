// Formal provider plugin interface — same pattern that worked well in
// concertandmatches: admin routes and the sync scheduler call
// provider.sync()/provider.backfillPrices() without knowing which retailer
// they're talking to, so adding a 7th retailer later means writing one new
// class, not touching every call site.
export class ProviderInterface {
  constructor(name) {
    if (new.target === ProviderInterface) {
      throw new Error('ProviderInterface is abstract and cannot be instantiated directly');
    }
    this.name = name;
  }

  // Discover/refresh product listings from this retailer. Returns a result
  // object; concrete providers document their own exact shape, but all
  // include at least { success: boolean }.
  async sync(/* options */) {
    throw new Error(`${this.name}: sync() not implemented`);
  }

  // Re-check price/stock for offers already stored from this provider that
  // are missing or stale. Optional.
  async backfillPrices(/* limit */) {
    return { success: false, error: `${this.name} does not implement backfillPrices()` };
  }
}

export default ProviderInterface;
