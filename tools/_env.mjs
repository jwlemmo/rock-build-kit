// Explicit target only: no borrowed credentials or production fallback.
import {loadTarget} from '../scripts/env.mjs';
export function rockEnv(isProd) {
 const env=loadTarget(isProd?'prod':'dev');
 return {BASE:env.ROCK_API_URL.replace(/\/api$/, ''), KEY:env.ROCK_API_KEY};
}
