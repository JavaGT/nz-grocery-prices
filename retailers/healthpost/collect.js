#!/usr/bin/env node
/**
 * HealthPost collector CLI. Writes validated PriceObservation JSONL to an
 * explicit --out file (never the live archive) or --stdout.
 *
 *   node retailers/healthpost/collect.js --stdout --max-pages 1
 *   node retailers/healthpost/collect.js --out /tmp/healthpost.jsonl
 */

import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";

await runCollect({ RETAILER, createClient }, import.meta);
