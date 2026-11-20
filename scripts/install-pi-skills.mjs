import { trySyncPiSkills } from '../bin/pi-skills.mjs';

// A dependency install or npx fetch is not a user-level setup request.
if (process.env.npm_config_global === 'true') trySyncPiSkills();
