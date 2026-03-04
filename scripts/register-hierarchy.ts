/**
 * Register Hierarchy Script
 *
 * Registers the sales team hierarchy from a CSV or JSON file.
 *
 * Usage:
 *   tsx scripts/register-hierarchy.ts --file team.csv
 *   tsx scripts/register-hierarchy.ts --file team.json
 *
 * CSV format:
 *   name,role,phone,email,manager_name
 *   "VP Name",vp,+521234567890,vp@company.com,
 *   "Director Name",director,+521234567891,dir@company.com,"VP Name"
 *
 * JSON format:
 *   [{ "name": "...", "role": "...", "phone": "...", "email": "...", "manager_name": "..." }]
 */

import path from 'path';
import { initDatabase } from '../engine/src/db.js';
import { bootstrapCrm } from '../crm/src/bootstrap.js';
import { registerTeamFromFile } from '../crm/src/register.js';

function main(): void {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  if (fileIdx === -1 || !args[fileIdx + 1]) {
    console.error('Usage: tsx scripts/register-hierarchy.ts --file <team.csv|team.json>');
    process.exit(1);
  }

  const filePath = path.resolve(args[fileIdx + 1]);
  console.log(`Registering team from: ${filePath}`);

  // Initialize database and CRM schema
  initDatabase();
  bootstrapCrm();

  // Register team
  const groupsDir = path.join(process.cwd(), 'groups');
  const registered = registerTeamFromFile(filePath, groupsDir);

  console.log(`\nRegistered ${registered.length} team members:`);
  for (const m of registered) {
    console.log(`  ${m.role.padEnd(10)} ${m.name.padEnd(25)} ${m.folder}`);
  }
}

main();
