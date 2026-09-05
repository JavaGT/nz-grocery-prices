#!/usr/bin/env node
/**
 * Scorpio Books collector CLI. Writes validated PriceObservation JSONL to
 * an explicit --out file (never the live archive) or --stdout.
 *
 *   node retailers/scorpio-books/collect.js --stdout --max-pages 3
 */

import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";

await runCollect({ RETAILER, createClient }, import.meta);
