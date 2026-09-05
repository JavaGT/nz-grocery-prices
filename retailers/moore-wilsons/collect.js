#!/usr/bin/env node
/**
 * Moore Wilson's collector CLI. Writes validated PriceObservation JSONL to
 * an explicit --out file (never the live archive) or --stdout. Each product
 * costs one page request: budget with --page-size × --max-pages.
 *
 *   node retailers/moore-wilsons/collect.js --stdout --page-size 25
 */

import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";

await runCollect({ RETAILER, createClient }, import.meta);
