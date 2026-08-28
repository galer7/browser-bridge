// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {{ domain: string, path: string }} RecipeMatch
 */

const RECIPES_DIR = path.join(os.homedir(), '.browserbridge', 'recipes');

/**
 * Match a URL or origin against installed recipes.
 * Tries exact hostname, hostname without www., then parent domain.
 *
 * @param {string} originOrUrl
 * @returns {RecipeMatch | null}
 */
export function matchRecipe(originOrUrl) {
  /** @type {string} */
  let hostname;
  try {
    hostname = new URL(originOrUrl).hostname;
  } catch {
    return null;
  }

  const candidates = [hostname, hostname.replace(/^www\./, '')];
  for (const domain of candidates) {
    const recipePath = path.join(RECIPES_DIR, domain, 'RECIPE.md');
    if (fs.existsSync(recipePath)) {
      return { domain, path: recipePath };
    }
  }

  const parts = hostname.split('.');
  if (parts.length > 2) {
    const parent = parts.slice(-2).join('.');
    const recipePath = path.join(RECIPES_DIR, parent, 'RECIPE.md');
    if (fs.existsSync(recipePath)) {
      return { domain: parent, path: recipePath };
    }
  }

  return null;
}
