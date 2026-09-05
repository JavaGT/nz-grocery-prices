#!/usr/bin/env node
/**
 * Unity Books collector CLI. Writes validated PriceObservation JSONL to an
 * explicit --out file (never the live archive) or --stdout.
 * Budget: --page-size bounds the number of PDP fetches (one per book).
 *
 *   node retailers/unity-books/collect.js --stdout --page-size 20
 */

import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";

await runCollect({ RETAILER, createClient }, import.meta);
