import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { matchRecipe } from '../src/recipe-match.js';

const RECIPES_DIR = path.join(os.homedir(), '.browserbridge', 'recipes');

test('matchRecipe returns null for invalid URL', () => {
  assert.equal(matchRecipe('not-a-url'), null);
});

test('matchRecipe returns null for non-existent recipe', () => {
  assert.equal(matchRecipe('https://no-recipe-here-12345.example.com'), null);
});

test('matchRecipe finds exact hostname match', () => {
  const domain = 'recipe-test-exact.example.com';
  const recipeDir = path.join(RECIPES_DIR, domain);
  const recipePath = path.join(recipeDir, 'RECIPE.md');
  fs.mkdirSync(recipeDir, { recursive: true });
  fs.writeFileSync(recipePath, '---\ndomain: recipe-test-exact.example.com\n---\nTest recipe\n');
  try {
    const result = matchRecipe(`https://${domain}/some/path`);
    assert.ok(result);
    assert.equal(result.domain, domain);
    assert.equal(result.path, recipePath);
  } finally {
    fs.rmSync(recipeDir, { recursive: true });
  }
});

test('matchRecipe strips www prefix', () => {
  const domain = 'recipe-test-www.example.com';
  const recipeDir = path.join(RECIPES_DIR, domain);
  const recipePath = path.join(recipeDir, 'RECIPE.md');
  fs.mkdirSync(recipeDir, { recursive: true });
  fs.writeFileSync(recipePath, '---\ndomain: recipe-test-www.example.com\n---\nTest\n');
  try {
    const result = matchRecipe(`https://www.${domain}/`);
    assert.ok(result);
    assert.equal(result.domain, domain);
  } finally {
    fs.rmSync(recipeDir, { recursive: true });
  }
});

test('matchRecipe falls back to parent domain', () => {
  const parent = 'recipe-test-parent.com';
  const recipeDir = path.join(RECIPES_DIR, parent);
  const recipePath = path.join(recipeDir, 'RECIPE.md');
  fs.mkdirSync(recipeDir, { recursive: true });
  fs.writeFileSync(recipePath, '---\ndomain: recipe-test-parent.com\n---\nParent recipe\n');
  try {
    const result = matchRecipe(`https://subdomain.${parent}/page`);
    assert.ok(result);
    assert.equal(result.domain, parent);
  } finally {
    fs.rmSync(recipeDir, { recursive: true });
  }
});
