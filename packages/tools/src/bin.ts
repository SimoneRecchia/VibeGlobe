#!/usr/bin/env node
/** Entry point of the `vibeglobe-data` command. */
import { main, processIo } from './cli.js';

process.exitCode = await main(process.argv.slice(2), processIo());
