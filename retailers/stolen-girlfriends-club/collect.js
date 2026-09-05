#!/usr/bin/env node
/**
 * Stolen Girlfriends Club collector CLI. Writes validated PriceObservation JSONL to an
 * explicit --out file (never the live archive) or --stdout.
 *
 *   node retailers/stolen-girlfriends-club/collect.js --stdout --max-pages 1
 */

import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";

await runCollect({ RETAILER, createClient }, import.meta);
