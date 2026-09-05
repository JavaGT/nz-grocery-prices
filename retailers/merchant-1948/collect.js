#!/usr/bin/env node
/**
 * Merchant 1948 collector CLI. Writes validated PriceObservation JSONL to an
 * explicit --out file (never the live archive) or --stdout.
 *
 *   node retailers/merchant-1948/collect.js --stdout --max-pages 1
 */

import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";

await runCollect({ RETAILER, createClient }, import.meta);
