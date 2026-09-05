#!/usr/bin/env node
/**
 * Page & Blackmore collector CLI. Writes validated PriceObservation JSONL
 * to an explicit --out file (never the live archive) or --stdout.
 *
 *   node retailers/page-blackmore/collect.js --stdout --max-pages 3
 */

import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";

await runCollect({ RETAILER, createClient }, import.meta);
