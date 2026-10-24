#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Entry point of the `vibeglobe-data` command. */
import { main, processIo } from './cli.js';

process.exitCode = await main(process.argv.slice(2), processIo());
