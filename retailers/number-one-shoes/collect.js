#!/usr/bin/env node
/**
 * Number One Shoes collector CLI. Writes validated PriceObservation JSONL
 * to an explicit --out file (never the live archive) or --stdout.
 *
 *   node retailers/number-one-shoes/collect.js --stdout --max-pages 2
 */

import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";

await runCollect({ RETAILER, createClient }, import.meta);
