#!/usr/bin/env node

import { JsonlObservationRepository } from "../src/repository.js";

const index = process.argv.indexOf("--file");
const file = index === -1 ? "data/prices.jsonl" : process.argv[index + 1];
const repository = new JsonlObservationRepository(file);
console.log(JSON.stringify(await repository.compact(), null, 2));
