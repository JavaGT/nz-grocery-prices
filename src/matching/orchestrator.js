import {
  findGtinMatches,
  findSourceIdMatches,
  findFuzzyCandidates,
  MATCHING_ALGORITHM_VERSION,
} from './matcher.js';

export class MatchingOrchestrator {
  #appDb;
  #products;

  constructor(appDb, products) {
    this.#appDb = appDb;
    this.#products = products;
  }

  runAutoMatches() {
    const gtinPairs = findGtinMatches(this.#products);
    const sourceIdPairs = findSourceIdMatches(this.#products);
    return this.#persistMatches([...gtinPairs, ...sourceIdPairs]);
  }

  runFuzzyCandidates(options = {}) {
    const candidates = findFuzzyCandidates(this.#products, options);
    return this.#persistMatches(candidates);
  }

  runAllMatches(options = {}) {
    const auto = this.runAutoMatches();
    const fuzzy = this.runFuzzyCandidates(options);
    return { auto, fuzzy };
  }

  #persistMatches(pairs) {
    const result = { inserted: 0, skipped: 0, errors: [] };

    for (const pair of pairs) {
      try {
        const existing = this.#appDb.getMatchPair(pair.productAId, pair.productBId);

        if (existing) {
          if (existing.provenance === 'user') {
            result.skipped++;
            continue;
          }

          if (existing.review_state === 'confirmed' &&
              existing.input_evidence_hash === pair.evidenceHash) {
            result.skipped++;
            continue;
          }

          if (existing.review_state === 'rejected' &&
              existing.algorithm_version === MATCHING_ALGORITHM_VERSION &&
              existing.input_evidence_hash === pair.evidenceHash) {
            result.skipped++;
            continue;
          }

          this.#appDb.updateMatchPair(existing.id, {
            matchMethod: pair.matchMethod,
            confidence: pair.confidence,
            reviewState: pair.reviewState,
            provenance: pair.provenance,
            inputEvidenceHash: pair.evidenceHash,
          });
          result.inserted++;
        } else {
          this.#appDb.createMatchPair({
            productAId: pair.productAId,
            productBId: pair.productBId,
            matchMethod: pair.matchMethod,
            algorithmVersion: MATCHING_ALGORITHM_VERSION,
            confidence: pair.confidence,
            reviewState: pair.reviewState,
            provenance: pair.provenance,
            inputEvidenceHash: pair.evidenceHash,
          });
          result.inserted++;
        }
      } catch (err) {
        result.errors.push({
          pair: `${pair.productAId}↔${pair.productBId}`,
          error: err.message,
        });
      }
    }

    return result;
  }

  acceptMatch(pairId, reviewer) {
    const pair = this.#appDb.getMatchPairById(pairId);
    if (!pair) throw new Error(`Match pair ${pairId} not found`);
    this.#appDb.updateMatchReview(pairId, 'confirmed', reviewer);
  }

  rejectMatch(pairId, reviewer) {
    const pair = this.#appDb.getMatchPairById(pairId);
    if (!pair) throw new Error(`Match pair ${pairId} not found`);
    this.#appDb.updateMatchReview(pairId, 'rejected', reviewer);
  }
}
