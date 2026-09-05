#!/usr/bin/env node
/**
 * Commonsense Organics collector CLI. Writes validated PriceObservation
 * JSONL to an explicit --out file (never the live archive) or --stdout.
 * Each product costs one page request: budget with --page-size.
 *
 *   node retailers/commonsense-organics/collect.js --stdout --page-size 25
 */

import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";

await runCollect({ RETAILER, createClient }, import.meta);
