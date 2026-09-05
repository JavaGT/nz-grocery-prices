#!/usr/bin/env node
/**
 * Mitre 10 collector CLI. Writes validated PriceObservation JSONL to an
 * explicit --out file (never the live archive) or --stdout.
 *
 * Each product costs one OCC detail request, so budget explicitly:
 * --max-pages bounds sitemap shards, --page-size bounds total product
 * detail fetches.
 *
 *   node retailers/mitre-10/collect.js --stdout --max-pages 1 --page-size 50
 */

import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";

await runCollect({ RETAILER, createClient }, import.meta);
